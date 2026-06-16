// Shared constants for the Symbol Spin extension.

export const DEFAULT_INTERVAL_MS = 5000;
export const MIN_INTERVAL_MS = 1000;
export const MAX_INTERVAL_MS = 3600 * 1000;
export const WATCHDOG_ALARM = "ticker-loop-watchdog";
export const WATCHDOG_PERIOD_MIN = 0.5; // Chrome's effective minimum is ~1 min, but we try 30s
export const DEFAULT_BASE_URL = "https://www.tradingview.com/chart/";

export const STORAGE_KEYS = {
  settings: "tickerLoop.settings",
  session: "tickerLoop.session",
};

export const DEFAULT_SETTINGS = {
  intervalMs: DEFAULT_INTERVAL_MS,
  baseUrl: DEFAULT_BASE_URL,
};

export const MSG = {
  // popup -> background
  GET_STATUS: "GET_STATUS",
  START: "START",
  PAUSE: "PAUSE",
  RESUME: "RESUME",
  STOP: "STOP",
  NEXT: "NEXT",
  SET_INTERVAL: "SET_INTERVAL",
  RESCAN: "RESCAN",
  SET_MANUAL_LIST: "SET_MANUAL_LIST",
  GET_MANUAL_LIST: "GET_MANUAL_LIST",
  GET_DIAG: "GET_DIAG",
  // background -> content
  PING_CONTENT: "PING_CONTENT",
  BEGIN_ROTATION: "BEGIN_ROTATION",
  PAUSE_ROTATION: "PAUSE_ROTATION",
  RESUME_ROTATION: "RESUME_ROTATION",
  STOP_ROTATION: "STOP_ROTATION",
  NEXT_TICKER: "NEXT_TICKER",
  FORCE_RESCAN: "FORCE_RESCAN",
  // content -> background
  CONTENT_READY: "CONTENT_READY",
  WATCHLIST_UPDATED: "WATCHLIST_UPDATED",
  ROTATION_TICK: "ROTATION_TICK",
  ROTATION_ERROR: "ROTATION_ERROR",
  // settings page -> background
  SAVE_SETTINGS: "SAVE_SETTINGS",
};
