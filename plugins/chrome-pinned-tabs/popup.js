function setStatus(ok, text) {
  const statusEl = document.getElementById("status");
  statusEl.className = ok ? "status ok" : "status err";
  statusEl.textContent = text;
}

async function checkApi() {
  try {
    const health = await osdFetch("/health");
    if (!health.ok) throw new Error(`HTTP ${health.status}`);
  } catch {
    setStatus(false, "Cannot reach Open Stream Deck (port 8484)");
    return false;
  }
  // /health is public; an authenticated endpoint tells whether the key is accepted.
  const res = await osdFetch("/variables/chrome.pinned.count");
  if (res.status === 401) {
    setStatus(false, "API key missing or invalid. Set it in the extension options.");
    return false;
  }
  setStatus(true, "Connected to Open Stream Deck");
  return true;
}

function renderTabs(tabs) {
  const tabsEl = document.getElementById("tabs");
  tabsEl.replaceChildren();
  if (tabs.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "No pinned tabs. Pin a tab to see it here.";
    tabsEl.append(empty);
    return;
  }
  tabs.forEach((tab, i) => {
    const row = document.createElement("div");
    row.className = "tab-item";
    if (tab.favIconUrl) {
      const img = document.createElement("img");
      img.src = tab.favIconUrl;
      img.alt = "";
      img.addEventListener("error", () => { img.style.display = "none"; });
      row.append(img);
    }
    const title = document.createElement("span");
    title.className = "tab-title";
    title.textContent = tab.title || tab.url || "";
    const slot = document.createElement("code");
    slot.style.flexShrink = "0";
    slot.textContent = `pinned.${i}`;
    row.append(title, slot);
    tabsEl.append(row);
  });
}

async function init() {
  document.getElementById("options").addEventListener("click", () => chrome.runtime.openOptionsPage());
  if (!(await checkApi())) return;
  renderTabs(await chrome.tabs.query({ pinned: true }));
}

init();
