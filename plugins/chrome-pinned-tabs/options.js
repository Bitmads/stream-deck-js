const input = document.getElementById("apiKey");
const result = document.getElementById("result");

function show(ok, text) {
  result.className = ok ? "ok" : "err";
  result.textContent = text;
}

async function load() {
  input.value = await osdGetApiKey();
}

async function save() {
  await chrome.storage.local.set({ apiKey: input.value.trim() });
  show(true, "Saved");
}

async function test() {
  await save();
  try {
    const res = await osdFetch("/variables/chrome.pinned.count");
    if (res.status === 401) show(false, "Key rejected (401)");
    else if (res.ok || res.status === 404) show(true, "Connected, key accepted");
    else show(false, `Unexpected response: HTTP ${res.status}`);
  } catch {
    show(false, "Cannot reach Open Stream Deck on 127.0.0.1:8484");
  }
}

document.getElementById("save").addEventListener("click", save);
document.getElementById("test").addEventListener("click", test);
load();
