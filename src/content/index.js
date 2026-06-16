// Content script: scrapes the active watchlist, runs the rotation timer,
// and mutates the URL to advance the chart symbol.
//
// Layout preservation: we only change the `symbol` query parameter,
// so timeframe/indicators/drawings are preserved.
//
// NOTE: This file is loaded as a plain (non-module) content script by
// Chrome. ES module imports are not supported in content scripts in
// MV3, so we inline the message constants we need below. Keep these in
// sync with src/shared/constants.js.

// eslint-disable-next-line no-console
console.log("[Symbol Spin] content script file loaded:", new Date().toISOString());

const MSG = {
  PING_CONTENT: "PING_CONTENT",
  BEGIN_ROTATION: "BEGIN_ROTATION",
  PAUSE_ROTATION: "PAUSE_ROTATION",
  RESUME_ROTATION: "RESUME_ROTATION",
  STOP_ROTATION: "STOP_ROTATION",
  NEXT_TICKER: "NEXT_TICKER",
  FORCE_RESCAN: "FORCE_RESCAN",
  ROTATION_TICK: "ROTATION_TICK",
  ROTATION_ERROR: "ROTATION_ERROR",
  CONTENT_READY: "CONTENT_READY",
  WATCHLIST_UPDATED: "WATCHLIST_UPDATED",
  SET_INTERVAL: "SET_INTERVAL",
  SET_MANUAL_LIST: "SET_MANUAL_LIST",
  GET_MANUAL_LIST: "GET_MANUAL_LIST",
  GET_DIAG: "GET_DIAG",
};

// ---------------------------------------------------------------------------
// Runtime state (lives in this content script instance, not in storage).
// ---------------------------------------------------------------------------

const state = {
  running: false,
  intervalMs: 5000,
  watchlist: [],            // active list (DOM-scraped or manual)
  manualList: [],           // user-typed fallback
  manualMode: false,
  currentIndex: 0,
  userNavigated: false,
  baseUrl: "https://www.tradingview.com/chart/",
  timerId: null,
  observer: null,
  countdownId: null,
  nextTickAt: 0,
  diag: {
    url: null,
    counts: { full: 0, rows: 0, links: 0, storage: 0, dataAttr: 0, url: 0 },
    samples: { full: [], rows: [], links: [], storage: [], dataAttr: [], url: null },
    source: null,         // which collector won
    injectedAt: null,
    errors: [],
  },
};

// ---------------------------------------------------------------------------
// Watchlist scraping — defense in depth.
//
// TradingView heavily class-name-hashes its UI. We try many strategies in
// order of confidence; the first one that yields a non-empty list wins.
// ---------------------------------------------------------------------------

function readWatchlist() {
  state.diag.url = window.location.href;

  // 1) `data-symbol-full="NSE:NIFTY"` on watchlist rows is the most
  //    reliable signal — that's the fully-qualified symbol TradingView
  //    itself uses for the row.
  const fromFull = collectFromDataSymbolFull();
  state.diag.counts.full = fromFull.length;
  state.diag.samples.full = fromFull.slice(0, 3);
  if (fromFull.length >= 2) { state.diag.source = "data-symbol-full"; return fromFull; }

  // 2) Watchlist rows: extract by class/role/aria patterns.
  const fromRows = collectFromRows();
  state.diag.counts.rows = fromRows.length;
  state.diag.samples.rows = fromRows.slice(0, 3);
  if (fromRows.length >= 2) { state.diag.source = "rows"; return fromRows; }

  // 3) Anchors to /chart/?symbol=...
  const fromLinks = collectFromLinks();
  state.diag.counts.links = fromLinks.length;
  state.diag.samples.links = fromLinks.slice(0, 3);
  if (fromLinks.length >= 2) { state.diag.source = "links"; return fromLinks; }

  // 4) Window globals like __TV_WATCHLISTS__.
  const fromStorage = collectFromStorage();
  state.diag.counts.storage = fromStorage.length;
  state.diag.samples.storage = fromStorage.slice(0, 3);
  if (fromStorage.length >= 2) { state.diag.source = "storage"; return fromStorage; }

  // 5) Plain [data-symbol] anywhere.
  const fromDataAttr = collectFromDataSymbol();
  state.diag.counts.dataAttr = fromDataAttr.length;
  state.diag.samples.dataAttr = fromDataAttr.slice(0, 3);
  if (fromDataAttr.length >= 2) { state.diag.source = "data-symbol"; return fromDataAttr; }

  // 6) The current ?symbol= URL param.
  const fromUrl = currentSymbolFromUrl();
  state.diag.counts.url = fromUrl ? 1 : 0;
  state.diag.samples.url = fromUrl;
  if (fromUrl) { state.diag.source = "url"; return [fromUrl]; }

  state.diag.source = "none";
  return [];
}

function collectFromDataSymbolFull() {
  // `data-symbol-full` carries the fully-qualified symbol (e.g. "NSE:NIFTY")
  // on every watchlist row. This is the single most reliable source.
  // We also check `data-symbol` for older TradingView markup.
  const seen = new Set();
  const ATTRS = ["data-symbol-full", "data-symbol"];

  for (const attr of ATTRS) {
    const nodes = document.querySelectorAll("[" + attr + "]");
    if (!nodes.length) continue;
    nodes.forEach((n) => {
      const s = (n.getAttribute(attr) || "").trim();
      if (isValidSymbol(s)) seen.add(s);
    });
    if (seen.size >= 2) return Array.from(seen);
  }
  return Array.from(seen);
}

function collectFromDataSymbol() {
  const seen = new Set();
  const nodes = document.querySelectorAll("[data-symbol]");
  nodes.forEach((n) => {
    const s = (n.getAttribute("data-symbol") || "").trim();
    if (s && isValidSymbol(s)) seen.add(s);
  });
  return Array.from(seen);
}

function collectFromRows() {
  // Heuristics for watchlist sidebar rows. TradingView's class names are
  // hashed, so we use a mix of stable test-ids, role attributes, and
  // semantic structure.
  const SELECTORS = [
    '[data-qa-id="watchlist-row"]',
    '[data-role="list-item"]',
    '[data-name="watchlist-row"]',
    ".listRow",
    ".tv-feed-watchlist-row",
    // The symbol is often inside an inner span with data-symbol.
    '[data-test-id="watchlist-row"]',
    '[class*="watchlistRow"]',
  ];

  const seen = new Set();

  for (const sel of SELECTORS) {
    const candidates = document.querySelectorAll(sel);
    if (!candidates.length) continue;
    candidates.forEach((row) => {
      const sym = extractSymbolFromElement(row);
      if (sym) seen.add(sym);
    });
    if (seen.size >= 2) return Array.from(seen);
  }

  // Generic fallback: any element with data-symbol-short-market or
  // a child anchor whose href matches /chart\?symbol=...
  if (!seen.size) {
    document.querySelectorAll("[data-symbol-short]").forEach((n) => {
      const s = (n.getAttribute("data-symbol-short") || "").trim();
      if (s && isValidSymbol(s)) seen.add(s);
    });
  }

  return Array.from(seen);
}

function collectFromLinks() {
  // Some pages list tickers as anchor links to /chart/?symbol=...
  const seen = new Set();
  const anchors = document.querySelectorAll('a[href*="/chart"]');
  anchors.forEach((a) => {
    try {
      const u = new URL(a.getAttribute("href"), window.location.origin);
      const s = u.searchParams.get("symbol");
      if (s && isValidSymbol(s)) seen.add(s);
    } catch (_e) {
      // ignore
    }
  });
  return Array.from(seen);
}

function collectFromStorage() {
  // TradingView sometimes stores the active list under window.__TV_WATCHLISTS__
  // or in localStorage. We try a few known keys, plus any global that
  // looks like a list of {symbol, ...}.
  const out = [];
  try {
    // Known globals
    if (window.__TV_WATCHLISTS__ && Array.isArray(window.__TV_WATCHLISTS__)) {
      for (const list of window.__TV_WATCHLISTS__) {
        if (list && Array.isArray(list.symbols)) {
          for (const s of list.symbols) {
            const sym = normalizeSymbol(s);
            if (sym) out.push(sym);
          }
        }
      }
    }
    // Some bundles expose __TV_CACHE__ or similar.
    for (const key of Object.keys(window)) {
      if (key.startsWith("__TV_") && Array.isArray(window[key])) {
        for (const item of window[key]) {
          if (item && typeof item === "object" && item.symbol) {
            const sym = normalizeSymbol(item.symbol, item.exchange);
            if (sym) out.push(sym);
          }
        }
      }
    }
  } catch (_e) {
    // ignore cross-origin / privacy errors
  }
  return Array.from(new Set(out));
}

function extractSymbolFromElement(el) {
  // 1) data-symbol-full on the element or any descendant (e.g. "NSE:NIFTY").
  const full = el.getAttribute && el.getAttribute("data-symbol-full");
  if (full && isValidSymbol(full)) return full.trim();

  const innerFull = el.querySelector("[data-symbol-full]");
  if (innerFull) {
    const v = innerFull.getAttribute("data-symbol-full");
    if (v && isValidSymbol(v)) return v.trim();
  }

  // 2) data-symbol (older markup or other surfaces).
  const direct = el.getAttribute && el.getAttribute("data-symbol");
  if (direct && isValidSymbol(direct)) return direct.trim();

  const inner = el.querySelector("[data-symbol]");
  if (inner) {
    const v = inner.getAttribute("data-symbol");
    if (v && isValidSymbol(v)) return v.trim();
  }

  // 3) data-symbol-short — this is the bare ticker (e.g. "NIFTY").
  //    We try to pair it with a sibling data-symbol-full or fall back to
  //    a generic "X:" prefix. TradingView usually carries both, so the
  //    full path almost always wins; this is the last-resort.
  const ds = el.getAttribute && el.getAttribute("data-symbol-short");
  if (ds && isValidSymbol("X:" + ds)) return "X:" + ds.trim();
  const innerShort = el.querySelector("[data-symbol-short]");
  if (innerShort) {
    const v = innerShort.getAttribute("data-symbol-short");
    if (v && isValidSymbol("X:" + v)) return "X:" + v.trim();
  }

  // 4) Anchor href to /chart/?symbol=...
  const a = el.querySelector && el.querySelector('a[href*="/chart"]');
  if (a) {
    try {
      const u = new URL(a.getAttribute("href"), window.location.origin);
      const s = u.searchParams.get("symbol");
      if (s && isValidSymbol(s)) return s;
    } catch (_e) {
      // ignore
    }
  }

  // 5) Text fallback: scan for "EXCHANGE:TICKER" pattern.
  const text = (el.textContent || "").trim();
  const m = text.match(/\b([A-Z]{1,6}):([A-Z0-9.\-]{1,12})\b/);
  if (m && isValidSymbol(m[1] + ":" + m[2])) return m[1] + ":" + m[2];

  return null;
}

function currentSymbolFromUrl() {
  try {
    const url = new URL(window.location.href);
    const s = url.searchParams.get("symbol");
    return s ? s : null;
  } catch (_e) {
    return null;
  }
}

function isValidSymbol(s) {
  // Accepts "EXCHANGE:TICKER" where:
  //   EXCHANGE: 1-10 chars from [A-Z0-9_-]   (FX_IDC, BITSTAMP, NSE, ...)
  //   TICKER:   1-16 chars from [A-Z0-9._-!] (BRK.B, NIFTY1!, 1HZ75V, ...)
  if (typeof s !== "string") return false;
  return /^[A-Z0-9_\-]{1,10}:[A-Z0-9._\-!]{1,16}$/.test(s);
}

function normalizeSymbol(s, exchange) {
  if (typeof s !== "string") return null;
  const t = s.trim();
  if (!t) return null;
  if (t.includes(":")) return isValidSymbol(t) ? t : null;
  if (exchange && isValidSymbol(exchange + ":" + t)) return exchange + ":" + t;
  // No exchange — use a generic "X:" prefix so TradingView still resolves.
  return isValidSymbol("X:" + t) ? "X:" + t : null;
}

// ---------------------------------------------------------------------------
// URL mutation
// ---------------------------------------------------------------------------

function changeSymbol(newSymbol) {
  // The official auto-rotate extension loads the next symbol by
  // dispatching a synthetic ArrowDown keydown on document.body.
  // TradingView's watchlist has built-in keyboard navigation: ArrowDown
  // moves selection down the list AND loads that symbol on the chart,
  // with no page reload and no URL hack.
  //
  // To reach the *intended* ticker (not just "next in the list"), we
  // compute how many ArrowDown presses we need relative to the current
  // selection, then press them. If the watchlist isn't focused, we
  // press once and TradingView will pick up from where its focus is.
  if (simulateArrowDownToSymbol(newSymbol)) {
    return true;
  }
  // Fallback: if we can't find the row, do nothing (rather than reload).
  return false;
}

function simulateArrowDownToSymbol(targetSymbol) {
  if (!isValidSymbol(targetSymbol)) return false;
  // Find the target row's index in the visible watchlist.
  const rows = Array.from(
    document.querySelectorAll("[data-symbol-full]")
  );
  if (!rows.length) return false;
  // Filter out section-header rows (Forex, Stocks, etc.) — they have
  // no data-symbol-full, so they're already excluded.
  const targetIdx = rows.findIndex(
    (r) => r.getAttribute("data-symbol-full") === targetSymbol
  );
  if (targetIdx < 0) return false;

  // Determine the currently-selected row index (data-active=true) if any.
  let currentIdx = -1;
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].getAttribute("data-active") === "true") {
      currentIdx = i;
      break;
    }
  }

  // Press ArrowDown the right number of times to land on the target.
  let steps;
  if (currentIdx < 0) {
    // No selection — press once. TradingView will select the first
    // active row and load it.
    steps = 1;
  } else if (targetIdx >= currentIdx) {
    steps = targetIdx - currentIdx;
  } else {
    // Wrap around. ArrowDown from last item goes to first, etc.
    steps = rows.length - (currentIdx - targetIdx);
  }
  if (steps <= 0) return true; // already there

  for (let i = 0; i < steps; i++) {
    dispatchArrowDown();
  }
  return true;
}

function dispatchArrowDown() {
  const event = new KeyboardEvent("keydown", {
    key: "ArrowDown",
    code: "ArrowDown",
    keyCode: 40,
    which: 40,
    bubbles: true,
    cancelable: true,
  });
  document.body.dispatchEvent(event);
}

// ---------------------------------------------------------------------------
// Rotation timer (lives in the page context for sub-30s precision).
// ---------------------------------------------------------------------------

function startTimer() {
  stopTimer();
  scheduleNextTick();
  state.countdownId = window.setInterval(() => {
    if (state.running) {
      const remaining = Math.max(0, state.nextTickAt - Date.now());
      safeSend({
        type: MSG.ROTATION_TICK,
        payload: {
          index: state.currentIndex,
          ticker: state.watchlist[state.currentIndex] || null,
          remainingMs: remaining,
        },
      });
    }
  }, 1000);
}

function stopTimer() {
  if (state.timerId) {
    clearTimeout(state.timerId);
    state.timerId = null;
  }
  if (state.countdownId) {
    clearInterval(state.countdownId);
    state.countdownId = null;
  }
}

function scheduleNextTick() {
  state.nextTickAt = Date.now() + state.intervalMs;
  state.timerId = window.setTimeout(() => {
    state.timerId = null;
    if (!state.running) return;
    advance(1);
    if (state.running) scheduleNextTick();
  }, state.intervalMs);
}

function advance(delta) {
  if (!state.watchlist.length) {
    safeSend({
      type: MSG.ROTATION_ERROR,
      payload: { error: "empty_watchlist" },
    });
    return;
  }
  state.currentIndex =
    (state.currentIndex + delta + state.watchlist.length) %
    state.watchlist.length;
  const symbol = state.watchlist[state.currentIndex];
  changeSymbol(symbol);
  safeSend({
    type: MSG.ROTATION_TICK,
    payload: {
      index: state.currentIndex,
      ticker: symbol,
      remainingMs: state.intervalMs,
    },
  });
}

// ---------------------------------------------------------------------------
// Active watchlist resolution: manual list > DOM scrape
// ---------------------------------------------------------------------------

function resolveActiveList() {
  if (state.manualMode && state.manualList.length) {
    return state.manualList.slice();
  }
  const scraped = readWatchlist();
  if (scraped.length) return scraped;
  // Manual list as last resort even when not in manual mode.
  if (state.manualList.length) return state.manualList.slice();
  return [];
}

// ---------------------------------------------------------------------------
// Watchlist observation
// ---------------------------------------------------------------------------

function startObserver() {
  if (state.observer) return;
  state.observer = new MutationObserver(() => {
    if (state.userNavigated) return;
    if (state.manualMode) return; // manual mode is static
    const next = readWatchlist();
    if (!arraysEqual(next, state.watchlist)) {
      state.watchlist = next;
      if (state.currentIndex >= state.watchlist.length) {
        state.currentIndex = 0;
      }
      safeSend({
        type: MSG.WATCHLIST_UPDATED,
        payload: { watchlist: next },
      });
    }
  });
  state.observer.observe(document.body, {
    childList: true,
    subtree: true,
  });
}

function arraysEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// ---------------------------------------------------------------------------
// User navigation detection: if the user manually changes the URL, pause.
// ---------------------------------------------------------------------------

function installNavGuards() {
  window.addEventListener("popstate", () => {
    if (!state.running) return;
    const expected = state.watchlist[state.currentIndex];
    const actual = currentSymbolFromUrl();
    if (actual && actual !== expected) {
      state.userNavigated = true;
      state.running = false;
      stopTimer();
      safeSend({
        type: MSG.ROTATION_ERROR,
        payload: { error: "user_navigated" },
      });
    }
  });
}

// ---------------------------------------------------------------------------
// Message bridge
// ---------------------------------------------------------------------------

function safeSend(msg) {
  try {
    chrome.runtime.sendMessage(msg, () => {
      // swallow lastError when no receiver
      void chrome.runtime.lastError;
    });
  } catch (_e) {
    // ignore
  }
}

function getSettings() {
  return new Promise((resolve) => {
    try {
      chrome.storage.sync.get("tickerLoop.settings", (r) => {
        resolve(r["tickerLoop.settings"] || {});
      });
    } catch (_e) {
      resolve({});
    }
  });
}

function getManual() {
  return new Promise((resolve) => {
    try {
      chrome.storage.sync.get("tickerLoop.manual", (r) => {
        resolve(r["tickerLoop.manual"] || { list: [], enabled: false });
      });
    } catch (_e) {
      resolve({ list: [], enabled: false });
    }
  });
}

function setManual(list, enabled) {
  return new Promise((resolve) => {
    try {
      chrome.storage.sync.set(
        { "tickerLoop.manual": { list, enabled } },
        () => resolve()
      );
    } catch (_e) {
      resolve();
    }
  });
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    const settings = await getSettings();
    state.intervalMs = settings.intervalMs || state.intervalMs;
    state.baseUrl = settings.baseUrl || state.baseUrl;

    // Hydrate manual list on first message (cheap, sync API).
    if (!state.manualHydrated) {
      const m = await getManual();
      state.manualList = m.list || [];
      state.manualMode = !!m.enabled;
      state.manualHydrated = true;
    }

    const msgType = msg && msg.type;
    switch (msgType) {
      case MSG.PING_CONTENT: {
        sendResponse({
          ok: true,
          watchlist: state.watchlist,
          currentIndex: state.currentIndex,
          running: state.running,
          userNavigated: state.userNavigated,
          manualMode: state.manualMode,
        });
        break;
      }
      case MSG.FORCE_RESCAN: {
        const next = resolveActiveList();
        state.watchlist = next;
        if (state.currentIndex >= next.length) state.currentIndex = 0;
        sendResponse({ ok: true, watchlist: next });
        break;
      }
      case MSG.SET_MANUAL_LIST: {
        const list = (msg.payload && msg.payload.list) || [];
        const mode = !!(msg.payload && msg.payload.enabled);
        state.manualList = list.slice();
        state.manualMode = mode;
        await setManual(state.manualList, state.manualMode);
        const next = resolveActiveList();
        state.watchlist = next;
        if (state.currentIndex >= next.length) state.currentIndex = 0;
        sendResponse({ ok: true, watchlist: next, manualMode: mode });
        break;
      }
      case MSG.GET_MANUAL_LIST: {
        sendResponse({
          ok: true,
          list: state.manualList,
          enabled: state.manualMode,
        });
        break;
      }
      case MSG.GET_DIAG: {
        // Re-run a scrape so the counts reflect the live DOM.
        readWatchlist();
        sendResponse({ ok: true, diag: state.diag });
        break;
      }
      case MSG.BEGIN_ROTATION: {
        const next = resolveActiveList();
        state.watchlist = next;
        state.userNavigated = false;
        if (!next.length) {
          sendResponse({ ok: false, error: "empty_watchlist" });
          return;
        }
        state.running = true;
        startTimer();
        // Jump immediately to the current symbol (in case of resume).
        changeSymbol(state.watchlist[state.currentIndex]);
        sendResponse({ ok: true });
        break;
      }
      case MSG.PAUSE_ROTATION: {
        state.running = false;
        stopTimer();
        sendResponse({ ok: true });
        break;
      }
      case MSG.RESUME_ROTATION: {
        if (!state.watchlist.length) {
          sendResponse({ ok: false, error: "empty_watchlist" });
          return;
        }
        state.userNavigated = false;
        state.running = true;
        startTimer();
        sendResponse({ ok: true });
        break;
      }
      case MSG.STOP_ROTATION: {
        state.running = false;
        stopTimer();
        sendResponse({ ok: true });
        break;
      }
      case MSG.NEXT_TICKER: {
        if (!state.watchlist.length) {
          sendResponse({ ok: false, error: "empty_watchlist" });
          return;
        }
        advance(1);
        if (state.running) scheduleNextTick();
        sendResponse({ ok: true });
        break;
      }
      case MSG.SET_INTERVAL: {
        const ms = Math.max(
          1000,
          Math.min(3600 * 1000, Math.floor((msg.payload && msg.payload.ms) || 5000))
        );
        state.intervalMs = ms;
        if (state.running) scheduleNextTick();
        sendResponse({ ok: true });
        break;
      }
      default:
        sendResponse({ ok: false, error: "unknown_message" });
    }
  })();
  return true;
});

// ---------------------------------------------------------------------------
// (Sniffer removed — keyboard simulation handles symbol switching now.)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function boot() {
  // Hydrate manual list from storage so it survives page reloads.
  const m = await getManual();
  state.manualList = m.list || [];
  state.manualMode = !!m.enabled;
  state.manualHydrated = true;
  state.diag.injectedAt = new Date().toISOString();
  state.diag.url = window.location.href;

  // Always try a scrape at boot, but don't overwrite a manual list.
  if (!state.manualMode) {
    state.watchlist = readWatchlist();
  } else {
    state.watchlist = state.manualList.slice();
  }
  startObserver();
  installNavGuards();
  safeSend({ type: MSG.CONTENT_READY });

  // Helpful in DevTools console.
  // eslint-disable-next-line no-console
  console.log(
    "[Symbol Spin] content script booted. diag:",
    JSON.parse(JSON.stringify(state.diag)),
    "watchlist size:",
    state.watchlist.length
  );
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot, { once: true });
} else {
  boot();
}
