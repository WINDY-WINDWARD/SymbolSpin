// Popup script: pure DOM, no framework.

import { MSG, STORAGE_KEYS } from "../shared/constants.js";

const $ = (id) => document.getElementById(id);
const els = {
  state: $("state-value"),
  source: $("source-value"),
  ticker: $("ticker-value"),
  position: $("position-value"),
  next: $("next-value"),
  bar: $("progress-bar"),
  primary: $("primary-btn"),
  nextBtn: $("next-btn"),
  rescan: $("rescan-btn"),
  interval: $("interval-select"),
  custom: $("interval-custom"),
  messages: $("messages"),
  openTv: $("open-tv"),
  openOptions: $("open-options"),
  manualToggle: $("manual-toggle"),
  manualList: $("manual-list"),
  manualSave: $("manual-save"),
  manualStatus: $("manual-status"),
  diag: $("diag-body"),
};

const state = {
  settings: { intervalMs: 5000, baseUrl: "https://www.tradingview.com/chart/" },
  session: { state: "idle", watchlist: [], currentIndex: 0, lastError: null },
  manual: { list: [], enabled: false },
};

let lastTickRemaining = null;

// ---------------------------------------------------------------------------
// Messaging
// ---------------------------------------------------------------------------

function send(msg) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(msg, (r) => {
        if (chrome.runtime.lastError) {
          resolve(null);
          return;
        }
        resolve(r);
      });
    } catch (_e) {
      resolve(null);
    }
  });
}

function sendTab(tabId, msg) {
  return new Promise((resolve) => {
    try {
      chrome.tabs.sendMessage(tabId, msg, (r) => {
        if (chrome.runtime.lastError) {
          resolve(null);
          return;
        }
        resolve(r);
      });
    } catch (_e) {
      resolve(null);
    }
  });
}

async function findTradingViewTab() {
  // First try the strict pattern (HTTPS, all subdomains).
  let tabs = await chrome.tabs.query({
    url: [
      "https://*.tradingview.com/*",
      "https://tradingview.com/*",
    ],
  });
  if (tabs.length) {
    return tabs.find((t) => t.active) || tabs[0] || null;
  }
  // Fallback: search by hostname for http://, IPs, or any other weirdness.
  const all = await chrome.tabs.query({});
  const tv = all.filter((t) => {
    try {
      const u = new URL(t.url || "");
      return /(^|\.)tradingview\.com$/.test(u.hostname);
    } catch (_e) {
      return false;
    }
  });
  if (tv.length) {
    return tv.find((t) => t.active) || tv[0] || null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Manual list parsing
// ---------------------------------------------------------------------------

function parseManualList(text) {
  if (!text) return [];
  const tokens = text
    .split(/[\s,;\n]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const seen = new Set();
  const out = [];
  for (const t of tokens) {
    const sym = t.toUpperCase().includes(":")
      ? t.toUpperCase()
      : "X:" + t.toUpperCase();
    if (!seen.has(sym)) {
      seen.add(sym);
      out.push(sym);
    }
  }
  return out;
}

// Same validator as the content script, kept in sync.
function isValidSymbol(s) {
  return typeof s === "string" && /^[A-Z0-9_\-]{1,10}:[A-Z0-9._\-!]{1,16}$/.test(s);
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

function render() {
  const { session, settings, manual } = state;
  const total = session.watchlist.length;
  const idx = session.currentIndex;
  const ticker = total ? session.watchlist[idx] : "—";

  els.state.textContent = labelForState(session.state);
  els.state.dataset.state = session.state;
  els.source.textContent = total
    ? manual.enabled
      ? "manual"
      : "scraped"
    : "—";
  els.ticker.textContent = ticker || "—";
  els.position.textContent = total ? `${idx + 1} / ${total}` : "0 / 0";
  els.next.textContent = formatRemaining(lastTickRemaining, session.state);

  if (session.state === "running" && lastTickRemaining != null && settings.intervalMs) {
    const elapsed = settings.intervalMs - lastTickRemaining;
    const pct = Math.max(0, Math.min(100, (elapsed / settings.intervalMs) * 100));
    els.bar.style.width = `${pct}%`;
  } else {
    els.bar.style.width = "0%";
  }

  els.primary.textContent = labelForPrimary(session.state);
  els.nextBtn.disabled = session.state === "idle";

  if (session.lastError) {
    els.messages.textContent = messageForError(session.lastError);
  } else {
    els.messages.textContent = "";
  }

  syncIntervalUI(settings.intervalMs);
}

function labelForState(s) {
  switch (s) {
    case "running":
      return "Rotating";
    case "paused":
      return "Paused";
    default:
      return "Idle";
  }
}

function labelForPrimary(s) {
  switch (s) {
    case "running":
      return "Pause";
    case "paused":
      return "Resume";
    default:
      return "Start";
  }
}

function messageForError(err) {
  switch (err) {
    case "no_tradingview_tab":
      return "Open a TradingView tab first.";
    case "no_watchlist":
    case "empty_watchlist":
      return "Couldn't find a watchlist. Add a manual list or open one on TradingView and rescan.";
    case "content_not_ready":
      return "TradingView page not ready. Try again in a moment.";
    case "user_navigated":
      return "Paused: you changed the chart manually.";
    default:
      return "Error: " + err;
  }
}

function formatRemaining(ms, sessionState) {
  if (sessionState !== "running" || ms == null) return "—";
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${s}s`;
}

function syncIntervalUI(intervalMs) {
  const opts = Array.from(els.interval.options).map((o) => o.value);
  if (opts.includes(String(intervalMs))) {
    els.interval.value = String(intervalMs);
    els.custom.hidden = true;
  } else {
    els.interval.value = "custom";
    els.custom.hidden = false;
    els.custom.value = String(Math.round(intervalMs / 1000));
  }
}

// ---------------------------------------------------------------------------
// Status refresh
// ---------------------------------------------------------------------------

async function refresh() {
  const resp = await send({ type: MSG.GET_STATUS });
  if (resp && resp.ok) {
    state.settings = resp.settings;
    state.session = resp.session;
  }
  // Also fetch the manual list + diag from the content script.
  const tab = await findTradingViewTab();
  if (tab) {
    const r = await sendTab(tab.id, { type: MSG.GET_MANUAL_LIST });
    if (r && r.ok) {
      state.manual.list = r.list || [];
      state.manual.enabled = !!r.enabled;
      syncManualUI();
    }
    const d = await sendTab(tab.id, { type: MSG.GET_DIAG });
    if (d && d.ok) {
      renderDiag(d.diag);
    } else {
      // Content script didn't respond — surface the tab URL so we know
      // what page it was.
      renderDiag({
        errors: ["no_response"],
        url: tab.url,
        tabId: tab.id,
      });
    }
  } else {
    renderDiag({ errors: ["no_tradingview_tab"] });
  }
  render();
}

function renderDiag(diag) {
  if (!diag) {
    els.diag.textContent = "no diag available";
    return;
  }
  const lines = [];
  if (diag.errors && diag.errors.length) {
    lines.push("errors: " + diag.errors.join(", "));
  }
  if (diag.tabId !== undefined) lines.push("tabId: " + diag.tabId);
  if (diag.url) lines.push("tab url: " + diag.url);
  if (diag.injectedAt) lines.push("injected: " + diag.injectedAt);
  lines.push("source: " + (diag.source || "?"));
  if (diag.counts) {
    const c = diag.counts;
    lines.push(
      "counts: full=" + c.full +
      " rows=" + c.rows +
      " links=" + c.links +
      " storage=" + c.storage +
      " dataAttr=" + c.dataAttr +
      " url=" + c.url
    );
  }
  if (diag.samples) {
    const s = diag.samples;
    if (s.full && s.full.length) lines.push("full[0..2]: " + JSON.stringify(s.full));
    if (s.rows && s.rows.length) lines.push("rows[0..2]: " + JSON.stringify(s.rows));
    if (s.links && s.links.length) lines.push("links[0..2]: " + JSON.stringify(s.links));
    if (s.storage && s.storage.length) lines.push("storage[0..2]: " + JSON.stringify(s.storage));
    if (s.dataAttr && s.dataAttr.length) lines.push("dataAttr[0..2]: " + JSON.stringify(s.dataAttr));
    if (s.url) lines.push("url: " + s.url);
  }
  els.diag.textContent = lines.join("\n");
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === "STATUS_UPDATE") {
    state.settings = msg.payload.settings;
    state.session = msg.payload.session;
    render();
  } else if (msg && msg.type === MSG.ROTATION_TICK) {
    if (msg.payload) {
      state.session.currentIndex = msg.payload.index;
      lastTickRemaining = msg.payload.remainingMs;
    }
    render();
  }
});

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------

els.primary.addEventListener("click", async () => {
  const s = state.session.state;
  if (s === "running") {
    await send({ type: MSG.PAUSE });
  } else if (s === "paused") {
    await send({ type: MSG.RESUME });
  } else {
    await send({ type: MSG.START });
  }
  refresh();
});

els.nextBtn.addEventListener("click", async () => {
  await send({ type: MSG.NEXT });
  refresh();
});

els.rescan.addEventListener("click", async () => {
  const r = await send({ type: MSG.RESCAN });
  if (r && r.watchlist) state.session.watchlist = r.watchlist;
  refresh();
});

function changeInterval(ms) {
  return send({ type: MSG.SET_INTERVAL, payload: { ms } });
}

els.interval.addEventListener("change", async () => {
  if (els.interval.value === "custom") {
    els.custom.hidden = false;
    els.custom.focus();
    return;
  }
  els.custom.hidden = true;
  const ms = parseInt(els.interval.value, 10);
  if (!Number.isNaN(ms)) {
    await changeInterval(ms);
    refresh();
  }
});

els.custom.addEventListener("change", async () => {
  const sec = Math.max(1, Math.min(3600, parseInt(els.custom.value, 10) || 5));
  els.custom.value = String(sec);
  await changeInterval(sec * 1000);
  refresh();
});

els.openTv.addEventListener("click", (e) => {
  e.preventDefault();
  const url = state.settings.baseUrl || "https://www.tradingview.com/chart/";
  chrome.tabs.create({ url });
});

els.openOptions.addEventListener("click", (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

// ---------------------------------------------------------------------------
// Manual list
// ---------------------------------------------------------------------------

function syncManualUI() {
  if (els.manualToggle.checked !== state.manual.enabled) {
    els.manualToggle.checked = state.manual.enabled;
  }
  const text = state.manual.list.join(", ");
  if (document.activeElement !== els.manualList) {
    els.manualList.value = text;
  }
}

function flashManualStatus(text, kind) {
  els.manualStatus.textContent = text;
  if (kind) {
    els.manualStatus.dataset.kind = kind;
  } else {
    delete els.manualStatus.dataset.kind;
  }
  setTimeout(() => {
    els.manualStatus.textContent = "";
    delete els.manualStatus.dataset.kind;
  }, 1500);
}

els.manualSave.addEventListener("click", async () => {
  const list = parseManualList(els.manualList.value);
  const enabled = els.manualToggle.checked;
  if (enabled && !list.length) {
    flashManualStatus("Add at least one ticker", "error");
    return;
  }
  const tab = await findTradingViewTab();
  if (!tab) {
    flashManualStatus("Open a TradingView tab first", "error");
    return;
  }
  const r = await sendTab(tab.id, {
    type: MSG.SET_MANUAL_LIST,
    payload: { list, enabled },
  });
  if (r && r.ok) {
    state.manual.list = list;
    state.manual.enabled = enabled;
    state.session.watchlist = r.watchlist || [];
    flashManualStatus("Saved");
    render();
  } else {
    flashManualStatus("Save failed", "error");
  }
});

els.manualToggle.addEventListener("change", async () => {
  // Re-save with the new toggle state and current textarea.
  await els.manualSave.click();
});

// Initial paint + poll as a safety net.
refresh();
setInterval(refresh, 1000);
