<script lang="ts">
  import { invoke } from "@tauri-apps/api/core";
  import { enable, disable, isEnabled } from "@tauri-apps/plugin-autostart";
  import { getPluginsWithSettings } from "../lib/stores/plugins.svelte";

  interface ApiKeyInfo {
    id: string;
    name: string;
    key_preview: string;
    created_at: string;
  }

  let keys = $state<ApiKeyInfo[]>([]);
  let newKeyName = $state("");
  let generatedKey = $state<string | null>(null);
  let copied = $state(false);

  // App settings
  let minimizeToTray = $state(true);
  let startMinimized = $state(false);
  let startOnBoot = $state(false);

  async function loadAppSettings() {
    const raw = await invoke<string | null>("load_json_file", { filename: "app_settings" });
    if (raw) {
      const settings = JSON.parse(raw);
      minimizeToTray = settings.minimizeToTray ?? true;
      startMinimized = settings.startMinimized ?? false;
    }
    startOnBoot = await isEnabled();
  }

  async function saveAppSettings() {
    const content = JSON.stringify({ minimizeToTray, startMinimized });
    await invoke("save_json_file", { filename: "app_settings", content });
  }

  async function toggleMinimizeToTray() {
    minimizeToTray = !minimizeToTray;
    await invoke("set_minimize_to_tray", { enabled: minimizeToTray });
    await saveAppSettings();
  }

  async function toggleStartMinimized() {
    startMinimized = !startMinimized;
    await saveAppSettings();
  }

  async function toggleStartOnBoot() {
    startOnBoot = !startOnBoot;
    if (startOnBoot) {
      await enable();
    } else {
      await disable();
    }
  }

  async function loadKeys() {
    keys = await invoke<ApiKeyInfo[]>("list_api_keys");
  }

  async function handleGenerate() {
    const name = newKeyName.trim() || "Default";
    const key = await invoke<string>("generate_api_key", { name });
    generatedKey = key;
    newKeyName = "";
    copied = false;
    await loadKeys();
  }

  async function handleRevoke(id: string) {
    await invoke("revoke_api_key", { id });
    await loadKeys();
  }

  function copyKey() {
    if (generatedKey) {
      navigator.clipboard.writeText(generatedKey);
      copied = true;
    }
  }

  function dismissKey() {
    generatedKey = null;
  }

  loadKeys();
  loadAppSettings();
</script>

<div class="settings-page">
  <h2>Settings</h2>

  <div class="settings-section">
    <h3>General</h3>

    <label class="toggle-row" onclick={toggleMinimizeToTray}>
      <div class="toggle-text">
        <span class="toggle-label">Minimize to tray on close</span>
        <span class="toggle-hint">Keep running in the background when the window is closed</span>
      </div>
      <div class="toggle-switch" class:active={minimizeToTray}>
        <div class="toggle-knob"></div>
      </div>
    </label>

    <label class="toggle-row" onclick={toggleStartMinimized}>
      <div class="toggle-text">
        <span class="toggle-label">Start minimized</span>
        <span class="toggle-hint">Launch hidden in the system tray</span>
      </div>
      <div class="toggle-switch" class:active={startMinimized}>
        <div class="toggle-knob"></div>
      </div>
    </label>

    <label class="toggle-row" onclick={toggleStartOnBoot}>
      <div class="toggle-text">
        <span class="toggle-label">Start on boot</span>
        <span class="toggle-hint">Automatically start at login</span>
      </div>
      <div class="toggle-switch" class:active={startOnBoot}>
        <div class="toggle-knob"></div>
      </div>
    </label>
  </div>

  {#each getPluginsWithSettings() as plugin}
    <div class="settings-section">
      <svelte:component this={plugin.settingsComponent} />
    </div>
  {/each}

  <div class="settings-section">
    <h3>API Keys</h3>
    <p class="hint">API keys protect the REST API (port 8484) from unauthorized access. External tools like Home Assistant need a key to control your Stream Deck.</p>

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
      <input type="text" bind:value={newKeyName} placeholder="Key name (e.g. Home Assistant)" onkeydown={(e) => { if (e.key === 'Enter') handleGenerate(); }} />
      <button class="generate-btn" onclick={handleGenerate}>Generate Key</button>
    </div>

    {#if keys.length > 0}
      <div class="key-list">
        {#each keys as key}
          <div class="key-item">
            <div class="key-info">
              <span class="key-name">{key.name}</span>
              <code class="key-prev">{key.key_preview}</code>
            </div>
            <button class="revoke-btn" onclick={() => handleRevoke(key.id)}>Revoke</button>
          </div>
        {/each}
      </div>
    {:else}
      <p class="no-keys">No API keys configured. The API is currently open (no authentication required).</p>
    {/if}
  </div>

  <div class="settings-section">
    <h3>API Endpoint</h3>
    <p class="hint">External tools can control your Stream Deck at:</p>
    <code class="endpoint">http://YOUR_IP:8484/api/</code>
    <p class="hint">Endpoints: <code>/variables</code>, <code>/devices</code>, <code>/actions/execute</code>, <code>/health</code></p>
  </div>
</div>

<style>
  .settings-page { padding: 24px; max-width: 600px; margin: 0 auto; }
  h2 { font-size: 20px; color: var(--text-primary); margin-bottom: 16px; }
  :global(.settings-section h3) { font-size: 15px; color: var(--text-secondary); margin-bottom: 8px; }
  :global(.settings-section .hint) { font-size: 12px; color: var(--text-muted); line-height: 1.5; margin-bottom: 12px; }
  .settings-section { background: var(--bg-secondary); padding: 16px; border-radius: var(--radius); margin-bottom: 16px; border: 1px solid var(--border); }

  .key-reveal { background: rgba(46,204,113,0.08); border: 1px solid var(--success); border-radius: var(--radius); padding: 14px; margin-bottom: 12px; }
  .key-warning { font-size: 12px; color: var(--warning); font-weight: 600; margin-bottom: 8px; }
  .key-value { display: flex; gap: 8px; align-items: center; margin-bottom: 8px; }
  .key-value code { flex: 1; font-size: 11px; background: var(--bg-primary); padding: 8px; border-radius: var(--radius-sm); word-break: break-all; color: var(--success); }
  .copy-btn { padding: 6px 14px; border-radius: var(--radius-sm); background: var(--accent); color: white; font-size: 12px; cursor: pointer; white-space: nowrap; }
  .key-usage { font-size: 11px; color: var(--text-muted); }
  .key-usage code { font-size: 10px; background: var(--bg-primary); padding: 2px 4px; border-radius: 2px; }
  .dismiss-btn { margin-top: 8px; padding: 5px 12px; border-radius: var(--radius-sm); background: var(--bg-tertiary); color: var(--text-secondary); font-size: 12px; cursor: pointer; }

  .key-create { display: flex; gap: 8px; margin-bottom: 12px; }
  .key-create input { flex: 1; padding: 8px 12px; border-radius: var(--radius-sm); border: 1px solid var(--border); background: var(--bg-primary); color: var(--text-primary); font-size: 13px; outline: none; }
  .key-create input:focus { border-color: var(--accent); }
  .generate-btn { padding: 8px 16px; border-radius: var(--radius-sm); background: var(--accent); color: white; font-size: 12px; cursor: pointer; white-space: nowrap; }

  .key-list { display: flex; flex-direction: column; gap: 6px; }
  .key-item { display: flex; align-items: center; justify-content: space-between; padding: 10px; background: var(--bg-primary); border-radius: var(--radius-sm); }
  .key-info { display: flex; align-items: center; gap: 10px; }
  .key-name { font-size: 13px; color: var(--text-primary); }
  .key-prev { font-size: 11px; color: var(--text-muted); background: var(--bg-tertiary); padding: 2px 6px; border-radius: 3px; }
  .revoke-btn { padding: 4px 10px; border-radius: var(--radius-sm); background: rgba(231,76,60,0.1); color: var(--danger); font-size: 11px; cursor: pointer; }
  .revoke-btn:hover { background: rgba(231,76,60,0.2); }
  .no-keys { font-size: 12px; color: var(--text-muted); font-style: italic; }

  .endpoint { display: block; font-size: 13px; background: var(--bg-primary); padding: 8px 12px; border-radius: var(--radius-sm); color: var(--accent); margin-bottom: 8px; }

  .toggle-row {
    display: flex; align-items: center; justify-content: space-between;
    padding: 10px 0; cursor: pointer; user-select: none;
  }
  .toggle-row:not(:last-child) { border-bottom: 1px solid var(--border); }
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
