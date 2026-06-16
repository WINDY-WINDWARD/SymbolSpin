# Symbol Spin (listLoop) — personal build

A Manifest V3 Chrome extension that auto-rotates the active TradingView chart
through the tickers in your active watchlist on a configurable interval.
**Personal use only** — no payments, no accounts, no analytics, no server.

This is a from-scratch rebuild of the public
[Ticker Loop: Auto-Rotate TradingView](https://chromewebstore.google.com/detail/ticker-loop-auto-rotate-t/npbpdghochipajbfnnmkfplegammomhd?hl=en)
extension, scoped to personal use.

## Features

- **Hands-free rotation** of the active chart through your watchlist.
- **Custom interval** (1–3600s; presets 5/10/30/60s). Pro-tier feature on the
  original — unlocked here.
- **Layout preservation** — only the chart's `symbol` changes. Your timeframe,
  indicators, drawings, and theme all stay intact across rotations.
- **Auto-watchlist detection** from the TradingView DOM.
- **Pause / Resume / Next** controls in the popup.
- **Zero network calls**, zero telemetry.

## Project layout

```
listLoop/
├── manifest.json
├── package.json
├── public/
│   └── icons/{16,32,48,128}.png
└── src/
    ├── background/index.js     # service worker: state + messaging + alarm watchdog
    ├── content/index.js        # injected into tradingview.com: scraper + rotator
    ├── popup/
    │   ├── popup.html
    │   ├── popup.css
    │   └── popup.js
    ├── options/
    │   ├── options.html
    │   ├── options.css
    │   └── options.js
    └── shared/
        ├── constants.js
        └── messaging.js
```

There is no build step. The service worker and content script are loaded as
ES modules (`"type": "module"` in `manifest.json` and `package.json`).

## Install (load unpacked)

1. Open `chrome://extensions`.
2. Toggle **Developer mode** on (top right).
3. Click **Load unpacked**.
4. Select the `listLoop/` directory (the one containing `manifest.json`).

That's it. The extension icon appears in the toolbar.

## Use

1. Open any `*.tradingview.com/chart/` URL (e.g. `in.tradingview.com`,
   `www.tradingview.com`, etc.) with a watchlist active.
2. Click the Symbol Spin icon → **Start**.
3. The chart cycles through your watchlist on the configured interval.

> The extension matches every TradingView subdomain — `in.tradingview.com`,
> `www.tradingview.com`, `pro.tradingview.com`, etc.

### Controls

- **Start / Pause / Resume / Stop** — primary button (state-aware).
- **Next ›** — skip to the next ticker manually. Resets the timer.
- **Rescan** — re-read the watchlist from the DOM.
- **Manual ticker list** — fold-open the panel at the bottom of the popup
  to paste a comma- or newline-separated list. Toggle it on to bypass
  DOM scraping entirely. The list is persisted in `chrome.storage.sync`
  so it survives browser restarts.
- **Interval** — preset dropdown (5s/10s/30s/60s) or custom seconds.
- **Settings** — set default interval and the base chart URL.

### Edge cases handled

- No TradingView tab open → friendly error in popup.
- Watchlist empty / unreadable → friendly error, no rotation.
- User manually changes the URL mid-rotation → auto-pause.
- Service worker terminated by Chrome → state rehydrates from
  `chrome.storage.session`; the content script continues running on its
  own `setInterval`.

## How it works

- **Content script** (`src/content/index.js`) scrapes `[data-symbol]`
  attributes (and a few fallback selectors) from the TradingView DOM, then
  mutates `window.location` to change only the `symbol` query parameter
  on each tick. This is intentionally minimal — the original extension's
  scraping logic isn't public, so this implementation targets the
  publicly observable DOM and degrades gracefully.
- **Popup** talks to the service worker via `chrome.runtime.sendMessage`.
- **Service worker** owns the canonical state in `chrome.storage.session`
  and keeps a `chrome.alarms` watchdog that pings the content script
  every ~30s in case Chrome suspended the tab.

## Verify / lint

```bash
npm run check
```

This runs `node --check` on every JS file (no transpilation needed).

## Privacy

- No data leaves your machine.
- No `fetch`/`XHR` calls to any third party.
- All settings live in `chrome.storage.sync` (Google account storage,
  default Chrome behaviour for sync).
- Runtime state lives in `chrome.storage.session` (device-only).

## Known limitations

- Watchlist scraping is best-effort — TradingView rewrites its DOM
  regularly. The scraper tries multiple selectors (`[data-symbol]`,
  `[data-qa-id="watchlist-row"]`, `[data-role="list-item"]`, anchored
  `/chart?symbol=…` links, and a text-content regex) and falls back to
  the active chart's URL symbol. If a future UI change breaks everything,
  the manual ticker list in the popup is a guaranteed fallback.
- Firefox MV3 support is out of scope.
- No payment integration, no Pro gating — everything is unlocked.

## License

Personal use. No redistribution.
