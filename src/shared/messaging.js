// Tiny helper to send a message and await a response.
// Returns null if the receiver has no listener (e.g. content script not injected).

export function sendMessage(message) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) {
          resolve(null);
          return;
        }
        resolve(response);
      });
    } catch (_e) {
      resolve(null);
    }
  });
}

export function sendTabMessage(tabId, message) {
  return new Promise((resolve) => {
    try {
      chrome.tabs.sendMessage(tabId, message, (response) => {
        if (chrome.runtime.lastError) {
          resolve(null);
          return;
        }
        resolve(response);
      });
    } catch (_e) {
      resolve(null);
    }
  });
}
