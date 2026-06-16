// Service worker: owns the canonical state, pings content scripts via alarms,
// and brokers messages between popup and the active TradingView tab.

import {
  DEFAULT_SETTINGS,
  MSG,
  STORAGE_KEYS,
  WATCHDOG_ALARM,
  WATCHDOG_PERIOD_MIN,
} from "../shared/constants.js";
import { sendTabMessage } from "../shared/messaging.js";

// ---------------------------------------------------------------------------
// Storage helpers
// ---------------------------------------------------------------------------

async function getSettings() {
  const { [STORAGE_KEYS.settings]: s } = await chrome.storage.sync.get(
    STORAGE_KEYS.settings
  );
  return { ...DEFAULT_SETTINGS, ...(s || {}) };
}

async function setSettings(patch) {
  const current = await getSettings();
  const next = { ...current, ...patch };
  await chrome.storage.sync.set({ [STORAGE_KEYS.settings]: next });
  return next;
}

async function getSession() {
  const { [STORAGE_KEYS.session]: s } = await chrome.storage.session.get(
    STORAGE_KEYS.session
  );
  return (
    s || {
      state: "idle", // idle | running | paused
      watchlist: [],
      currentIndex: 0,
      lastError: null,
    }
  );
}

async function setSession(patch) {
  const current = await getSession();
  const next = { ...current, ...patch };
  await chrome.storage.session.set({ [STORAGE_KEYS.session]: next });
  return next;
}

// ---------------------------------------------------------------------------
// Tab resolution: find a TradingView tab and ping its content script.
// ---------------------------------------------------------------------------

async function findTradingViewTab() {
  let tabs = await chrome.tabs.query({
    url: [
      "https://*.tradingview.com/*",
      "https://tradingview.com/*",
    ],
  });
  if (tabs.length) {
    return tabs.find((t) => t.active) || tabs[0] || null;
  }
  const all = await chrome.tabs.query({});
  const tv = all.filter((t) => {
    try {
      const u = new URL(t.url || "");
      return /(^|\.)tradingview\.com$/.test(u.hostname);
    } catch (_e) {
      return false;
    }
  });
  return tv.find((t) => t.active) || tv[0] || null;
}

async function pingActiveTab() {
  const tab = await findTradingViewTab();
  if (!tab) {
    await setSession({ lastError: "no_tradingview_tab" });
    return null;
  }
  const resp = await sendTabMessage(tab.id, { type: MSG.PING_CONTENT });
  if (!resp) {
    // No listener — content script not injected (likely not on a chart page yet).
    await setSession({ lastError: "content_not_ready" });
    return null;
  }
  return { tab, resp };
}

// ---------------------------------------------------------------------------
// Broadcast status to popup (if open).
// ---------------------------------------------------------------------------

async function broadcastStatus() {
  const settings = await getSettings();
  const session = await getSession();
  try {
    chrome.runtime.sendMessage({
      type: "STATUS_UPDATE",
      payload: { settings, session },
    });
  } catch (_e) {
    // popup not open
  }
}

// ---------------------------------------------------------------------------
// Watchdog alarm: re-pings content script to keep state fresh.
// ---------------------------------------------------------------------------

async function ensureWatchdog() {
  const existing = await chrome.alarms.get(WATCHDOG_ALARM);
  if (!existing) {
    chrome.alarms.create(WATCHDOG_ALARM, {
      periodInMinutes: WATCHDOG_PERIOD_MIN,
    });
  }
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== WATCHDOG_ALARM) return;
  const session = await getSession();
  if (session.state === "idle") return;
  const tab = await findTradingViewTab();
  if (!tab) {
    await setSession({ state: "idle", lastError: "no_tradingview_tab" });
    await broadcastStatus();
    return;
  }
  const resp = await sendTabMessage(tab.id, { type: MSG.PING_CONTENT });
  if (!resp) {
    await setSession({ lastError: "content_not_ready" });
  } else if (session.lastError) {
    await setSession({ lastError: null });
  }
  await broadcastStatus();
});

// ---------------------------------------------------------------------------
// Message router
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    const msgType = msg && msg.type;
    switch (msgType) {
      case MSG.GET_STATUS: {
        const settings = await getSettings();
        const session = await getSession();
        sendResponse({ ok: true, settings, session });
        break;
      }

      case MSG.START: {
        const session = await getSession();
        if (!session.watchlist || session.watchlist.length === 0) {
          // Try to read the watchlist from the page first.
          const tab = await findTradingViewTab();
          if (!tab) {
            await setSession({ state: "idle", lastError: "no_tradingview_tab" });
            await broadcastStatus();
            sendResponse({ ok: false, error: "no_tradingview_tab" });
            return;
          }
          const resp = await sendTabMessage(tab.id, { type: MSG.FORCE_RESCAN });
          if (!resp || !resp.watchlist || !resp.watchlist.length) {
            await setSession({ state: "idle", lastError: "no_watchlist" });
            await broadcastStatus();
            sendResponse({ ok: false, error: "no_watchlist" });
            return;
          }
          await setSession({
            watchlist: resp.watchlist,
            currentIndex: 0,
            state: "running",
            lastError: null,
          });
        } else {
          await setSession({ state: "running", lastError: null });
        }
        const tab = await findTradingViewTab();
        if (tab) {
          await sendTabMessage(tab.id, { type: MSG.BEGIN_ROTATION });
        }
        await ensureWatchdog();
        await broadcastStatus();
        sendResponse({ ok: true });
        break;
      }

      case MSG.PAUSE: {
        const session = await getSession();
        if (session.state !== "running") {
          sendResponse({ ok: false, error: "not_running" });
          return;
        }
        await setSession({ state: "paused" });
        const tab = await findTradingViewTab();
        if (tab) await sendTabMessage(tab.id, { type: MSG.PAUSE_ROTATION });
        await broadcastStatus();
        sendResponse({ ok: true });
        break;
      }

      case MSG.RESUME: {
        const session = await getSession();
        if (session.state !== "paused") {
          sendResponse({ ok: false, error: "not_paused" });
          return;
        }
        await setSession({ state: "running" });
        const tab = await findTradingViewTab();
        if (tab) await sendTabMessage(tab.id, { type: MSG.RESUME_ROTATION });
        await ensureWatchdog();
        await broadcastStatus();
        sendResponse({ ok: true });
        break;
      }

      case MSG.STOP: {
        await setSession({ state: "idle", lastError: null });
        const tab = await findTradingViewTab();
        if (tab) await sendTabMessage(tab.id, { type: MSG.STOP_ROTATION });
        const a = await chrome.alarms.get(WATCHDOG_ALARM);
        if (a) chrome.alarms.clear(WATCHDOG_ALARM);
        await broadcastStatus();
        sendResponse({ ok: true });
        break;
      }

      case MSG.NEXT: {
        const tab = await findTradingViewTab();
        if (!tab) {
          sendResponse({ ok: false, error: "no_tradingview_tab" });
          return;
        }
        await sendTabMessage(tab.id, { type: MSG.NEXT_TICKER });
        sendResponse({ ok: true });
        break;
      }

      case MSG.SET_INTERVAL: {
        const ms = Math.max(1000, Math.min(3600 * 1000, Math.floor(msg.payload.ms)));
        await setSettings({ intervalMs: ms });
        // Notify content script to update its timer cadence.
        const tab = await findTradingViewTab();
        if (tab) {
          await sendTabMessage(tab.id, {
            type: MSG.SET_INTERVAL,
            payload: { ms },
          });
        }
        await broadcastStatus();
        sendResponse({ ok: true });
        break;
      }

      case MSG.RESCAN: {
        const tab = await findTradingViewTab();
        if (!tab) {
          sendResponse({ ok: false, error: "no_tradingview_tab" });
          return;
        }
        const resp = await sendTabMessage(tab.id, { type: MSG.FORCE_RESCAN });
        if (resp && resp.watchlist) {
          await setSession({ watchlist: resp.watchlist, currentIndex: 0 });
        }
        await broadcastStatus();
        sendResponse({ ok: true, watchlist: (resp && resp.watchlist) || [] });
        break;
      }

      case MSG.SAVE_SETTINGS: {
        const next = await setSettings(msg.payload || {});
        await broadcastStatus();
        sendResponse({ ok: true, settings: next });
        break;
      }

      // --- messages from content script ------------------------------------

      case MSG.CONTENT_READY: {
        // Content script announces itself; opportunistically fetch watchlist.
        const tabId = _sender.tab && _sender.tab.id;
        const resp = await sendTabMessage(tabId, {
          type: MSG.FORCE_RESCAN,
        });
        if (resp && resp.watchlist && resp.watchlist.length) {
          const session = await getSession();
          if (session.watchlist.length !== resp.watchlist.length) {
            await setSession({ watchlist: resp.watchlist });
          }
        }
        sendResponse({ ok: true });
        break;
      }

      case MSG.WATCHLIST_UPDATED: {
        const session = await getSession();
        const newList = (msg.payload && msg.payload.watchlist) || [];
        // If indices were equal, keep position; otherwise reset.
        const index =
          session.currentIndex < newList.length ? session.currentIndex : 0;
        await setSession({ watchlist: newList, currentIndex: index });
        await broadcastStatus();
        sendResponse({ ok: true });
        break;
      }

      case MSG.ROTATION_TICK: {
        const session = await getSession();
        if (msg.payload && typeof msg.payload.index === "number") {
          await setSession({ currentIndex: msg.payload.index });
        }
        await broadcastStatus();
        sendResponse({ ok: true });
        break;
      }

      case MSG.ROTATION_ERROR: {
        await setSession({ state: "idle", lastError: (msg.payload && msg.payload.error) || "rotation_error" });
        await broadcastStatus();
        sendResponse({ ok: true });
        break;
      }

      default:
        sendResponse({ ok: false, error: "unknown_message" });
    }
  })();
  // Keep the message channel open for async sendResponse.
  return true;
});

// On install / startup, clear any stale session.
chrome.runtime.onInstalled.addListener(async () => {
  await chrome.storage.session.set({
    [STORAGE_KEYS.session]: {
      state: "idle",
      watchlist: [],
      currentIndex: 0,
      lastError: null,
    },
  });
});

// On startup, ensure the watchdog is present.
if (chrome.runtime && chrome.runtime.onStartup) {
  chrome.runtime.onStartup.addListener(() => {
    // No-op; alarm is created on START.
  });
}
