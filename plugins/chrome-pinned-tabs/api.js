// Shared by the service worker, popup and options page.
// The API key is stored in chrome.storage.local and sent as "Authorization: Bearer <key>".
// Without a key the app only accepts requests while it has no API keys configured.

const OSD_API_BASE = "http://127.0.0.1:8484/api";

async function osdGetApiKey() {
  const { apiKey } = await chrome.storage.local.get("apiKey");
  return typeof apiKey === "string" ? apiKey.trim() : "";
}

/** fetch() against the Open Stream Deck API with the stored key. Returns the Response. */
async function osdFetch(path, init = {}) {
  const key = await osdGetApiKey();
  const headers = { ...(init.headers || {}) };
  if (key) headers["Authorization"] = `Bearer ${key}`;
  return fetch(`${OSD_API_BASE}${path}`, { ...init, headers });
}
