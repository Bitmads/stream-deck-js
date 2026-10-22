importScripts("api.js");

const SYNC_DEBOUNCE_MS = 500;
const PER_TAB_FIELDS = ["title", "url", "id", "favicon"];

let syncTimer = null;
let lastError = "";

// ─── API Helpers ─────────────────────────────────────────────

function reportStatus(res) {
  if (res.ok) {
    if (lastError) console.log("[OSD] API reachable again");
    lastError = "";
    return;
  }
  const msg = res.status === 401
    ? "API rejected the request (401): set a valid API key in the extension options"
    : `API error: HTTP ${res.status}`;
  if (msg !== lastError) console.warn(`[OSD] ${msg}`);
  lastError = msg;
}

async function setVariable(name, value) {
  try {
    const res = await osdFetch(`/variables/${encodeURIComponent(name)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value: String(value) }),
    });
    reportStatus(res);
  } catch {
    if (lastError !== "unreachable") console.warn("[OSD] Open Stream Deck API not reachable");
    lastError = "unreachable";
  }
}

async function deleteVariable(name) {
  try {
    const res = await osdFetch(`/variables/${encodeURIComponent(name)}`, { method: "DELETE" });
    // 404 just means it was never set.
    if (res.status !== 404) reportStatus(res);
  } catch {}
}

// ─── Tab Sync ────────────────────────────────────────────────

async function getLastPinnedCount() {
  const { lastPinnedCount } = await chrome.storage.session.get("lastPinnedCount");
  return typeof lastPinnedCount === "number" ? lastPinnedCount : 0;
}

async function syncPinnedTabs() {
  try {
    const tabs = await chrome.tabs.query({ pinned: true });
    const previousCount = await getLastPinnedCount();

    await setVariable("chrome.pinned.count", tabs.length);

    for (let i = 0; i < tabs.length; i++) {
      const tab = tabs[i];
      await setVariable(`chrome.pinned.${i}.title`, tab.title || "");
      await setVariable(`chrome.pinned.${i}.url`, tab.url || "");
      await setVariable(`chrome.pinned.${i}.id`, tab.id);
      if (tab.favIconUrl) await setVariable(`chrome.pinned.${i}.favicon`, tab.favIconUrl);
      else await deleteVariable(`chrome.pinned.${i}.favicon`);
    }

    // Remove every variable of slots that no longer have a pinned tab.
    for (let i = tabs.length; i < previousCount; i++) {
      for (const field of PER_TAB_FIELDS) await deleteVariable(`chrome.pinned.${i}.${field}`);
    }
    await chrome.storage.session.set({ lastPinnedCount: tabs.length });
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
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (tab) {
      await setVariable("chrome.active.title", tab.title || "");
      await setVariable("chrome.active.url", tab.url || "");
      await setVariable("chrome.active.id", tab.id);
    }
  } catch {}
}

// ─── Event Listeners ─────────────────────────────────────────

chrome.tabs.onCreated.addListener(debouncedSync);
chrome.tabs.onRemoved.addListener(debouncedSync);
chrome.tabs.onMoved.addListener(debouncedSync);
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.pinned !== undefined || (tab.pinned && (changeInfo.title || changeInfo.url || changeInfo.favIconUrl))) {
    debouncedSync();
  }
  if (tab.active && (changeInfo.title || changeInfo.url || changeInfo.status === "complete")) {
    syncActiveTab();
  }
});
chrome.tabs.onActivated.addListener(syncActiveTab);
chrome.windows.onFocusChanged.addListener(syncActiveTab);

// A new or changed API key: push everything again right away.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.apiKey) {
    syncPinnedTabs();
    syncActiveTab();
  }
});

// Periodic re-sync (covers the app starting after the browser). MV3 service workers are
// suspended when idle, so this uses chrome.alarms instead of setInterval.
chrome.alarms.create("osd-resync", { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "osd-resync") {
    syncPinnedTabs();
    syncActiveTab();
  }
});

chrome.runtime.onStartup.addListener(() => { syncPinnedTabs(); syncActiveTab(); });
chrome.runtime.onInstalled.addListener(() => { syncPinnedTabs(); syncActiveTab(); });
