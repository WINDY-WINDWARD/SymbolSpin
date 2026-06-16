// Options page script.

import {
  DEFAULT_SETTINGS,
  MSG,
  MIN_INTERVAL_MS,
  MAX_INTERVAL_MS,
  STORAGE_KEYS,
} from "../shared/constants.js";

const $ = (id) => document.getElementById(id);

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
    } catch {
      resolve(null);
    }
  });
}

async function load() {
  const resp = await send({ type: MSG.GET_STATUS });
  const settings = (resp && resp.settings) || DEFAULT_SETTINGS;
  $("interval").value = Math.round(settings.intervalMs / 1000);
  $("baseUrl").value = settings.baseUrl || DEFAULT_SETTINGS.baseUrl;
}

$("settings-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const sec = Math.max(
    MIN_INTERVAL_MS / 1000,
    Math.min(MAX_INTERVAL_MS / 1000, parseInt($("interval").value, 10) || 5)
  );
  const baseUrl = $("baseUrl").value.trim() || DEFAULT_SETTINGS.baseUrl;
  const resp = await send({
    type: MSG.SAVE_SETTINGS,
    payload: { intervalMs: sec * 1000, baseUrl },
  });
  const status = $("status");
  if (resp && resp.ok) {
    status.textContent = "Saved.";
    setTimeout(() => (status.textContent = ""), 1500);
  } else {
    status.textContent = "Could not save.";
  }
});

load();
