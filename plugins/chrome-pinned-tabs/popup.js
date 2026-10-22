const API = "http://127.0.0.1:8484/api";

async function init() {
  const statusEl = document.getElementById("status");
  const tabsEl = document.getElementById("tabs");

  // Check API connectivity
  try {
    const res = await fetch(`${API}/health`);
    if (res.ok) {
      statusEl.className = "status ok";
      statusEl.textContent = "Connected to Open Stream Deck";
    } else {
      throw new Error("Not ok");
    }
  } catch {
    statusEl.className = "status err";
    statusEl.textContent = "Cannot reach Open Stream Deck (port 8484)";
    return;
  }

  // Show pinned tabs
  const tabs = await chrome.tabs.query({ pinned: true });
  if (tabs.length === 0) {
    tabsEl.innerHTML = '<div style="color:#6a6a80">No pinned tabs. Pin a tab to see it here.</div>';
    return;
  }

  tabsEl.innerHTML = tabs.map((tab, i) => `
    <div class="tab-item">
      <img src="${tab.favIconUrl || ''}" onerror="this.style.display='none'" />
      <span class="tab-title">${tab.title || tab.url}</span>
      <code style="flex-shrink:0">Key ${i}</code>
    </div>
  `).join("");
}

init();
