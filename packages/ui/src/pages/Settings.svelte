<script lang="ts">
  import { invoke } from "@tauri-apps/api/core";
  import { listen } from "@tauri-apps/api/event";
  import { untrack } from "svelte";
  import { enable, disable, isEnabled } from "@tauri-apps/plugin-autostart";
  import { getPluginsWithSettings } from "../lib/stores/plugins.svelte";
  import PluginConfig from "../components/plugin/PluginConfig.svelte";

  interface ApiKeyInfo {
    id: string;
    name: string;
    key_preview: string;
    created_at: string;
  }

  /** Live API key state (get_api_auth_status). */
  interface ApiAuthStatus {
    /** Keys not (fully) loaded from the keychain: the API only accepts loaded keys. */
    locked: boolean;
    /** Keychain error behind the lock; null while the keys are still loading. */
    error: string | null;
  }

  interface PluginStatus {
    uuid: string;
    running: boolean;
    connected: boolean;
    restarts: number;
    error: string | null;
  }

  const API_PORT = 8484;
  const DEFAULT_BIND = "0.0.0.0";

  let error = $state<string | null>(null);

  let keys = $state<ApiKeyInfo[]>([]);
  let keysLoaded = $state(false);
  let authStatus = $state<ApiAuthStatus | null>(null);
  let newKeyName = $state("");
  let generatedKey = $state<string | null>(null);
  let copied = $state(false);

  // App settings (app_settings.json). Other keys in the file (e.g. activeProfile) are preserved on save.
  let minimizeToTray = $state(true);
  let startMinimized = $state(false);
  let startOnBoot = $state(false);
  let apiBind = $state(DEFAULT_BIND);
  let savedApiBind = $state(DEFAULT_BIND);
  let nodePath = $state("");
  let savedNodePath = $state("");
  let pluginStatus = $state<PluginStatus[]>([]);
  let pluginStatusError = $state<string | null>(null);

  function errMsg(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
  }

  async function readAppSettings(): Promise<Record<string, unknown>> {
    const raw = await invoke<string | null>("load_json_file", { filename: "app_settings" });
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("app_settings.json is not a JSON object");
    return parsed as Record<string, unknown>;
  }

  /** Merge `patch` into the current file contents so keys written by other parts of the app survive. */
  async function patchAppSettings(patch: Record<string, unknown>) {
    const current = await readAppSettings();
    const next = { ...current, ...patch };
    for (const [k, v] of Object.entries(patch)) if (v === undefined) delete next[k];
    await invoke("save_json_file", { filename: "app_settings", content: JSON.stringify(next) });
  }

  async function loadAppSettings() {
    try {
      const s = await readAppSettings();
      minimizeToTray = typeof s.minimizeToTray === "boolean" ? s.minimizeToTray : true;
      startMinimized = typeof s.startMinimized === "boolean" ? s.startMinimized : false;
      apiBind = savedApiBind = typeof s.apiBind === "string" && s.apiBind ? s.apiBind : DEFAULT_BIND;
      nodePath = savedNodePath = typeof s.nodePath === "string" ? s.nodePath : "";
    } catch (e) {
      error = `Could not read app settings: ${errMsg(e)}`;
    }
    try {
      startOnBoot = await isEnabled();
    } catch (e) {
      error = `Could not read autostart state: ${errMsg(e)}`;
    }
  }

  async function toggleMinimizeToTray() {
    const next = !minimizeToTray;
    try {
      await invoke("set_minimize_to_tray", { enabled: next });
      await patchAppSettings({ minimizeToTray: next });
      minimizeToTray = next;
    } catch (e) {
      error = `Could not save "Minimize to tray": ${errMsg(e)}`;
    }
  }

  async function toggleStartMinimized() {
    const next = !startMinimized;
    try {
      await patchAppSettings({ startMinimized: next });
      startMinimized = next;
    } catch (e) {
      error = `Could not save "Start minimized": ${errMsg(e)}`;
    }
  }

  async function toggleStartOnBoot() {
    const turningOn = !startOnBoot;
    // Dev builds can't autostart because they need Vite running at localhost:5173.
    if (turningOn && import.meta.env.DEV) {
      const ok = confirm(
        "Autostart won't work from a dev build — the app can't connect to Vite on boot.\n\n" +
        "Run `cargo tauri build` and install the release binary, then enable autostart from there.\n\n" +
        "Enable anyway?"
      );
      if (!ok) return;
    }
    try {
      if (turningOn) await enable();
      else await disable();
    } catch (e) {
      error = `Could not ${turningOn ? "enable" : "disable"} autostart: ${errMsg(e)}`;
    }
    try {
      startOnBoot = await isEnabled();
    } catch (e) {
      error = `Could not read autostart state: ${errMsg(e)}`;
    }
  }

  async function saveApiBind() {
    const value = apiBind.trim();
    if (!value) { apiBind = savedApiBind; return; }
    try {
      await patchAppSettings({ apiBind: value });
      savedApiBind = apiBind = value;
    } catch (e) {
      error = `Could not save API listen address: ${errMsg(e)}`;
    }
  }

  async function saveNodePath() {
    const value = nodePath.trim();
    try {
      await patchAppSettings({ nodePath: value || undefined });
      await invoke("set_node_path", { path: value || null });
      savedNodePath = nodePath = value;
    } catch (e) {
      error = `Could not save Node.js path: ${errMsg(e)}`;
    }
  }

  async function loadPluginStatus() {
    try {
      pluginStatus = await invoke<PluginStatus[]>("get_plugin_status");
      pluginStatusError = null;
    } catch (e) {
      pluginStatusError = errMsg(e);
    }
  }

  async function loadKeys() {
    try {
      authStatus = await invoke<ApiAuthStatus>("get_api_auth_status");
    } catch (e) {
      error = `Could not read API key status: ${errMsg(e)}`;
    }
    try {
      keys = await invoke<ApiKeyInfo[]>("list_api_keys");
      keysLoaded = true;
    } catch (e) {
      error = `Could not list API keys: ${errMsg(e)}`;
    }
    // list_api_keys may have waited on a keychain unlock; the status can have changed meanwhile.
    try {
      authStatus = await invoke<ApiAuthStatus>("get_api_auth_status");
    } catch {}
  }

  async function handleGenerate() {
    const name = newKeyName.trim() || "Default";
    try {
      generatedKey = await invoke<string>("generate_api_key", { name });
      newKeyName = "";
      copied = false;
    } catch (e) {
      error = `Could not generate API key: ${errMsg(e)}`;
    }
    await loadKeys();
  }

  async function handleRevoke(key: ApiKeyInfo) {
    if (!confirm(`Revoke API key "${key.name}"? Tools using it will stop working.`)) return;
    try {
      await invoke("revoke_api_key", { id: key.id });
    } catch (e) {
      error = `Could not revoke API key: ${errMsg(e)}`;
    }
    await loadKeys();
  }

  async function copyKey() {
    if (!generatedKey) return;
    try {
      await navigator.clipboard.writeText(generatedKey);
      copied = true;
    } catch (e) {
      error = `Could not copy to clipboard: ${errMsg(e)}`;
    }
  }

  function dismissKey() {
    generatedKey = null;
  }

  let bindIsLoopback = $derived(savedApiBind === "127.0.0.1" || savedApiBind === "::1" || savedApiBind === "localhost");
  let endpointHost = $derived(bindIsLoopback ? "127.0.0.1" : "YOUR_IP");

  $effect(() => {
    untrack(() => { loadKeys(); loadAppSettings(); loadPluginStatus(); });
    const unlisteners = [
      listen("plugin-connected", () => loadPluginStatus()),
      listen("plugin-disconnected", () => loadPluginStatus()),
    ];
    return () => { for (const u of unlisteners) u.then(fn => fn()); };
  });
</script>

<div class="settings-page">
  <h2>Settings</h2>

  {#if error}
    <div class="page-error" role="alert">
      <span>{error}</span>
      <button class="error-dismiss" onclick={() => error = null} aria-label="Dismiss error">×</button>
    </div>
  {/if}

  <div class="settings-section">
    <h3>General</h3>

    <button class="toggle-row" role="switch" aria-checked={minimizeToTray} onclick={toggleMinimizeToTray}>
      <span class="toggle-text">
        <span class="toggle-label">Minimize to tray on close</span>
        <span class="toggle-hint">Keep running in the background when the window is closed</span>
      </span>
      <span class="toggle-switch" class:active={minimizeToTray}><span class="toggle-knob"></span></span>
    </button>

    <button class="toggle-row" role="switch" aria-checked={startMinimized} onclick={toggleStartMinimized}>
      <span class="toggle-text">
        <span class="toggle-label">Start minimized</span>
        <span class="toggle-hint">Launch hidden in the system tray</span>
      </span>
      <span class="toggle-switch" class:active={startMinimized}><span class="toggle-knob"></span></span>
    </button>

    <button class="toggle-row" role="switch" aria-checked={startOnBoot} onclick={toggleStartOnBoot}>
      <span class="toggle-text">
        <span class="toggle-label">Start on boot</span>
        <span class="toggle-hint">Automatically start at login</span>
      </span>
      <span class="toggle-switch" class:active={startOnBoot}><span class="toggle-knob"></span></span>
    </button>
  </div>

  {#each getPluginsWithSettings() as plugin (plugin.id)}
    <div class="settings-section">
      {#if plugin.settingsComponent}
        <plugin.settingsComponent />
      {:else if plugin.hasConfig}
        <PluginConfig pluginId={plugin.id} pluginName={plugin.name} />
      {/if}
    </div>
  {/each}

  <div class="settings-section">
    <h3>External Plugins</h3>
    <p class="hint">External (Stream Deck SDK) plugins run on Node.js. By default the newest suitable Node.js from nvm, Volta, fnm or PATH is used. Set a path to force a specific binary; it applies the next time a plugin starts (turn a running plugin off and on to restart it).</p>
    <label class="field-label" for="node-path">Node.js path for plugins</label>
    <div class="inline-form">
      <input id="node-path" type="text" bind:value={nodePath} placeholder="Auto-detect (e.g. /home/me/.nvm/versions/node/v20.11.0/bin/node)"
        onkeydown={(e) => { if (e.key === "Enter") saveNodePath(); }} />
      <button class="generate-btn" onclick={saveNodePath} disabled={nodePath.trim() === savedNodePath}>Save</button>
    </div>

    <div class="status-head">
      <span class="field-label">Plugin status</span>
      <button class="link-btn" onclick={loadPluginStatus}>Refresh</button>
    </div>
    {#if pluginStatusError}
      <p class="inline-error">Could not read plugin status: {pluginStatusError}</p>
    {:else if pluginStatus.length === 0}
      <p class="no-keys">No external plugins are running.</p>
    {:else}
      <div class="key-list">
        {#each pluginStatus as p (p.uuid)}
          <div class="key-item status-item">
            <div class="key-info">
              <span class="key-name">{p.uuid}</span>
              {#if p.error}
                <span class="badge badge-error">Failed</span>
              {:else if p.connected}
                <span class="badge badge-ok">Connected</span>
              {:else if p.running}
                <span class="badge badge-warn">Starting</span>
              {:else}
                <span class="badge">Stopped</span>
              {/if}
              {#if p.restarts > 0}<span class="key-prev">{p.restarts} restart{p.restarts === 1 ? "" : "s"}</span>{/if}
            </div>
            {#if p.error}<p class="inline-error">{p.error}</p>{/if}
          </div>
        {/each}
      </div>
    {/if}
  </div>

  <div class="settings-section">
    <h3>REST API</h3>
    <p class="hint">External tools such as Home Assistant control the deck through the REST API on port {API_PORT}. It can run shell commands, so access is restricted.</p>

    <div class="api-status" class:open={keysLoaded && keys.length === 0} class:locked={!!(authStatus?.locked && authStatus.error)}>
      {#if authStatus?.locked && authStatus.error}
        <strong>Locked.</strong> The API keys could not be read from the OS keychain, so only <code>/api/health</code> and requests with an already loaded key are accepted. The app keeps retrying; unlock the keychain to restore access. <span class="api-error">{authStatus.error}</span>
        <button class="link-btn" onclick={loadKeys}>Check again</button>
      {:else if authStatus?.locked}
        Loading API keys from the OS keychain…
      {:else if !keysLoaded}
        Checking API access…
      {:else if keys.length === 0}
        <strong>Local only.</strong> No API key exists, so only requests from this computer (localhost) are accepted. Generate a key for Home Assistant or any other device on your network.
      {:else}
        <strong>Key required.</strong> Every endpoint except <code>/api/health</code> needs <code>Authorization: Bearer &lt;key&gt;</code>. Each of the {keys.length} key{keys.length === 1 ? "" : "s"} below is valid.
      {/if}
    </div>

    <label class="field-label" for="api-bind">Listen address</label>
    <div class="inline-form">
      <select id="api-bind" bind:value={apiBind}>
        <option value="0.0.0.0">0.0.0.0 — all network interfaces</option>
        <option value="127.0.0.1">127.0.0.1 — this computer only</option>
        {#if savedApiBind !== "0.0.0.0" && savedApiBind !== "127.0.0.1"}
          <option value={savedApiBind}>{savedApiBind}</option>
        {/if}
      </select>
      <button class="generate-btn" onclick={saveApiBind} disabled={apiBind === savedApiBind}>Save</button>
    </div>
    <p class="hint small">Changes to the listen address apply after restarting the app.</p>
  </div>

  <div class="settings-section">
    <h3>API Keys</h3>
    <p class="hint">Use one key per tool so you can revoke them separately. A key is shown only once, right after you generate it.</p>

    {#if generatedKey}
      <div class="key-reveal">
        <p class="key-warning">Copy this key now — it won't be shown again!</p>
        <div class="key-value">
          <code>{generatedKey}</code>
          <button class="copy-btn" onclick={copyKey}>{copied ? 'Copied!' : 'Copy'}</button>
        </div>
        <p class="key-usage">Use in HTTP headers: <code>Authorization: Bearer {generatedKey.substring(0, 12)}...</code></p>
        <button class="dismiss-btn" onclick={dismissKey}>I've saved it</button>
      </div>
    {/if}

    <div class="key-create">
      <input type="text" aria-label="New API key name" bind:value={newKeyName} placeholder="Key name (e.g. Home Assistant)" onkeydown={(e) => { if (e.key === 'Enter') handleGenerate(); }} />
      <button class="generate-btn" onclick={handleGenerate}>Generate Key</button>
    </div>

    {#if keys.length > 0}
      <div class="key-list">
        {#each keys as key (key.id)}
          <div class="key-item">
            <div class="key-info">
              <span class="key-name">{key.name}</span>
              <code class="key-prev">{key.key_preview}</code>
            </div>
            <button class="revoke-btn" onclick={() => handleRevoke(key)}>Revoke</button>
          </div>
        {/each}
      </div>
    {:else if keysLoaded}
      <p class="no-keys">No API keys yet. Only local requests are accepted.</p>
    {/if}
  </div>

  <div class="settings-section">
    <h3>API Endpoint</h3>
    <p class="hint">External tools can control your Stream Deck at:</p>
    <code class="endpoint">http://{endpointHost}:{API_PORT}/api/</code>
    <p class="hint">Endpoints: <code>/variables</code>, <code>/devices</code>, <code>/actions/execute</code>, <code>/profile/reload</code>, <code>/profile/&lbrace;name&rbrace;</code>, <code>/health</code></p>
  </div>
</div>

<style>
  .settings-page { padding: 24px; max-width: 600px; margin: 0 auto; }
  h2 { font-size: 20px; color: var(--text-primary); margin-bottom: 16px; }
  :global(.settings-section h3) { font-size: 15px; color: var(--text-secondary); margin-bottom: 8px; }
  :global(.settings-section .hint) { font-size: 12px; color: var(--text-muted); line-height: 1.5; margin-bottom: 12px; }
  .settings-section { background: var(--bg-secondary); padding: 16px; border-radius: var(--radius); margin-bottom: 16px; border: 1px solid var(--border); }
  .hint.small { font-size: 11px; margin-top: 6px; }

  .page-error { display: flex; align-items: flex-start; gap: 8px; padding: 10px 12px; margin-bottom: 16px; border-radius: var(--radius-sm); background: rgba(239,83,80,0.1); border: 1px solid var(--danger); color: var(--danger); font-size: 12px; }
  .page-error span { flex: 1; line-height: 1.4; }
  .error-dismiss { font-size: 16px; line-height: 1; color: var(--danger); padding: 0 4px; }
  .inline-error { font-size: 11px; color: var(--danger); margin-top: 4px; line-height: 1.4; }

  .field-label { display: block; font-size: 10px; text-transform: uppercase; letter-spacing: 0.5px; color: var(--text-muted); font-weight: 500; margin-bottom: 4px; }
  .inline-form { display: flex; gap: 8px; margin-bottom: 12px; }
  .inline-form input, .inline-form select { flex: 1; min-width: 0; padding: 8px 12px; border-radius: var(--radius-sm); border: 1px solid var(--border); background: var(--bg-primary); color: var(--text-primary); font-size: 13px; outline: none; font-family: inherit; }
  .inline-form input:focus, .inline-form select:focus { border-color: var(--accent); }
  .status-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 4px; }
  .link-btn { font-size: 11px; color: var(--accent); padding: 2px 6px; border-radius: var(--radius-sm); }
  .link-btn:hover { background: var(--bg-tertiary); }
  .status-item { flex-direction: column; align-items: stretch; }
  .badge { font-size: 10px; padding: 1px 6px; border-radius: 8px; color: var(--text-muted); background: var(--bg-tertiary); }
  .badge-ok { color: var(--success); background: rgba(76,175,124,0.12); }
  .badge-warn { color: var(--warning); background: rgba(245,166,35,0.12); }
  .badge-error { color: var(--danger); background: rgba(239,83,80,0.12); }

  .api-status { font-size: 12px; line-height: 1.5; color: var(--text-secondary); background: var(--bg-primary); border: 1px solid var(--border); border-left: 3px solid var(--success); padding: 10px 12px; border-radius: var(--radius-sm); margin-bottom: 12px; }
  .api-status.open { border-left-color: var(--warning); }
  .api-status.locked { border-left-color: var(--danger); }
  .api-error { display: block; margin-top: 4px; font-size: 11px; color: var(--danger); word-break: break-word; }
  .api-status code { font-size: 11px; background: var(--bg-tertiary); padding: 1px 4px; border-radius: 3px; }

  .key-reveal { background: rgba(46,204,113,0.08); border: 1px solid var(--success); border-radius: var(--radius); padding: 14px; margin-bottom: 12px; }
  .key-warning { font-size: 12px; color: var(--warning); font-weight: 600; margin-bottom: 8px; }
  .key-value { display: flex; gap: 8px; align-items: center; margin-bottom: 8px; }
  .key-value code { flex: 1; font-size: 11px; background: var(--bg-primary); padding: 8px; border-radius: var(--radius-sm); word-break: break-all; color: var(--success); user-select: text; }
  .copy-btn { padding: 6px 14px; border-radius: var(--radius-sm); background: var(--accent); color: white; font-size: 12px; cursor: pointer; white-space: nowrap; }
  .key-usage { font-size: 11px; color: var(--text-muted); }
  .key-usage code { font-size: 10px; background: var(--bg-primary); padding: 2px 4px; border-radius: 2px; }
  .dismiss-btn { margin-top: 8px; padding: 5px 12px; border-radius: var(--radius-sm); background: var(--bg-tertiary); color: var(--text-secondary); font-size: 12px; cursor: pointer; }

  .key-create { display: flex; gap: 8px; margin-bottom: 12px; }
  .key-create input { flex: 1; padding: 8px 12px; border-radius: var(--radius-sm); border: 1px solid var(--border); background: var(--bg-primary); color: var(--text-primary); font-size: 13px; outline: none; }
  .key-create input:focus { border-color: var(--accent); }
  .generate-btn { padding: 8px 16px; border-radius: var(--radius-sm); background: var(--accent); color: white; font-size: 12px; cursor: pointer; white-space: nowrap; }
  .generate-btn:disabled { opacity: 0.5; cursor: default; }

  .key-list { display: flex; flex-direction: column; gap: 6px; }
  .key-item { display: flex; align-items: center; justify-content: space-between; padding: 10px; background: var(--bg-primary); border-radius: var(--radius-sm); }
  .key-info { display: flex; align-items: center; gap: 10px; min-width: 0; }
  .key-name { font-size: 13px; color: var(--text-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .key-prev { font-size: 11px; color: var(--text-muted); background: var(--bg-tertiary); padding: 2px 6px; border-radius: 3px; }
  .revoke-btn { padding: 4px 10px; border-radius: var(--radius-sm); background: rgba(231,76,60,0.1); color: var(--danger); font-size: 11px; cursor: pointer; }
  .revoke-btn:hover { background: rgba(231,76,60,0.2); }
  .no-keys { font-size: 12px; color: var(--text-muted); font-style: italic; }

  .endpoint { display: block; font-size: 13px; background: var(--bg-primary); padding: 8px 12px; border-radius: var(--radius-sm); color: var(--accent); margin-bottom: 8px; user-select: text; }

  .toggle-row {
    display: flex; align-items: center; justify-content: space-between; width: 100%; text-align: left;
    padding: 10px 0; cursor: pointer; user-select: none;
  }
  .toggle-row:not(:last-child) { border-bottom: 1px solid var(--border); }
  .toggle-row:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .toggle-text { display: flex; flex-direction: column; gap: 2px; }
  .toggle-label { font-size: 13px; color: var(--text-primary); }
  .toggle-hint { font-size: 11px; color: var(--text-muted); }
  .toggle-switch {
    position: relative; width: 36px; height: 20px;
    background: var(--bg-primary); border-radius: 10px;
    border: 1px solid var(--border); flex-shrink: 0; transition: background 0.2s;
  }
  .toggle-switch.active { background: var(--accent); border-color: var(--accent); }
  .toggle-knob {
    position: absolute; top: 2px; left: 2px;
    width: 14px; height: 14px;
    background: var(--text-primary); border-radius: 50%; transition: transform 0.2s;
  }
  .toggle-switch.active .toggle-knob { transform: translateX(16px); }
</style>
