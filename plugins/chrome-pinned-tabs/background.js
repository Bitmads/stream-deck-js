const API_BASE = "http://127.0.0.1:8484/api";
const SYNC_DEBOUNCE_MS = 500;

let syncTimer = null;

// ─── API Helpers ─────────────────────────────────────────────

async function setVariable(name, value) {
  try {
    await fetch(`${API_BASE}/variables/${encodeURIComponent(name)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value: String(value) }),
    });
  } catch (e) {
    // API not available — silently ignore
  }
}

async function clearVariables(prefix, count) {
  for (let i = 0; i < count; i++) {
    try {
      await fetch(`${API_BASE}/variables/${encodeURIComponent(`${prefix}.${i}.title`)}`, { method: "DELETE" });
      await fetch(`${API_BASE}/variables/${encodeURIComponent(`${prefix}.${i}.url`)}`, { method: "DELETE" });
    } catch {}
  }
}

// ─── Tab Sync ────────────────────────────────────────────────

let lastPinnedCount = 0;

async function syncPinnedTabs() {
  try {
    const tabs = await chrome.tabs.query({ pinned: true });

    // Clear old variables if count decreased
    if (tabs.length < lastPinnedCount) {
      await clearVariables("chrome.pinned", lastPinnedCount);
    }
    lastPinnedCount = tabs.length;

    // Set count
    await setVariable("chrome.pinned.count", tabs.length);

    // Set per-tab variables
    for (let i = 0; i < tabs.length; i++) {
      const tab = tabs[i];
      await setVariable(`chrome.pinned.${i}.title`, tab.title || "");
      await setVariable(`chrome.pinned.${i}.url`, tab.url || "");
      await setVariable(`chrome.pinned.${i}.id`, tab.id);

      // Get favicon as data URL if available
      if (tab.favIconUrl) {
        await setVariable(`chrome.pinned.${i}.favicon`, tab.favIconUrl);
      }
    }

    console.log(`[OSD] Synced ${tabs.length} pinned tabs`);
  } catch (e) {
    console.error("[OSD] Sync failed:", e);
  }
}

function debouncedSync() {
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = setTimeout(syncPinnedTabs, SYNC_DEBOUNCE_MS);
}

// ─── Active Tab Sync ─────────────────────────────────────────

async function syncActiveTab() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab) {
      await setVariable("chrome.active.title", tab.title || "");
      await setVariable("chrome.active.url", tab.url || "");
      await setVariable("chrome.active.id", tab.id);
    }
  } catch {}
}

// ─── Tab Focus (called from Stream Deck via message) ─────────

chrome.runtime.onMessageExternal.addListener((request, sender, sendResponse) => {
  if (request.action === "focusTab" && request.tabId) {
    chrome.tabs.update(request.tabId, { active: true });
    chrome.tabs.get(request.tabId, (tab) => {
      if (tab?.windowId) chrome.windows.update(tab.windowId, { focused: true });
    });
    sendResponse({ ok: true });
  }
});

// ─── Event Listeners ─────────────────────────────────────────

chrome.tabs.onCreated.addListener(debouncedSync);
chrome.tabs.onRemoved.addListener(debouncedSync);
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.pinned !== undefined || changeInfo.title) {
    debouncedSync();
  }
  if (changeInfo.status === "complete") {
    syncActiveTab();
  }
});
chrome.tabs.onActivated.addListener(syncActiveTab);

// ─── Initial Sync ────────────────────────────────────────────

syncPinnedTabs();
syncActiveTab();

// Re-sync periodically (in case API was down on startup)
setInterval(syncPinnedTabs, 30000);
setInterval(syncActiveTab, 5000);
