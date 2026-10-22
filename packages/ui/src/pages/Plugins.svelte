<script lang="ts">
  import { invoke } from "@tauri-apps/api/core";
  import { listen } from "@tauri-apps/api/event";
  import { untrack } from "svelte";
  import { getAllPlugins, isEnabled, togglePlugin } from "../lib/stores/plugins.svelte";
  import PluginConfig from "../components/plugin/PluginConfig.svelte";

  interface PluginStatus {
    uuid: string;
    running: boolean;
    connected: boolean;
    restarts: number;
    error: string | null;
  }

  let configuringId = $state<string | null>(null);
  let errors = $state<Record<string, string>>({});
  let busy = $state<Record<string, boolean>>({});
  let status = $state<Record<string, PluginStatus>>({});
  let statusError = $state<string | null>(null);

  async function refreshStatus() {
    try {
      const list = await invoke<PluginStatus[]>("get_plugin_status");
      const next: Record<string, PluginStatus> = {};
      for (const s of list) next[s.uuid] = s;
      status = next;
      statusError = null;
    } catch (e) {
      statusError = String(e);
    }
  }

  async function handleToggle(id: string) {
    if (busy[id]) return;
    busy[id] = true;
    errors[id] = "";
    try {
      await togglePlugin(id);
    } catch (e) {
      errors[id] = String(e);
    }
    busy[id] = false;
    await refreshStatus();
  }

  function handleConfigure(id: string) {
    configuringId = configuringId === id ? null : id;
  }

  /** Label + style for an external plugin's runtime state, from the backend's view of the process. */
  function externalState(id: string): { label: string; cls: string; detail: string | null } {
    const s = status[id];
    if (!isEnabled(id)) return { label: "Stopped", cls: "stopped", detail: null };
    if (!s) return { label: statusError ? "Unknown" : "Not running", cls: statusError ? "stopped" : "failed", detail: null };
    if (s.error) return { label: "Failed", cls: "failed", detail: s.error };
    if (s.connected) return { label: "Running", cls: "running", detail: null };
    if (s.running) return { label: "Starting", cls: "starting", detail: null };
    return { label: "Not running", cls: "failed", detail: null };
  }

  $effect(() => {
    untrack(() => refreshStatus());
    const unlisteners = [
      listen("plugin-connected", () => refreshStatus()),
      listen("plugin-disconnected", () => refreshStatus()),
    ];
    // Crash/restart transitions don't always produce an event; poll while the page is open.
    const interval = setInterval(() => refreshStatus(), 5000);
    return () => {
      clearInterval(interval);
      for (const u of unlisteners) u.then(fn => fn());
    };
  });
</script>

<div class="plugins-page">
  <h2>Plugins</h2>

  <div class="installed-list">
    {#each getAllPlugins() as plugin (plugin.id)}
      {@const enabled = isEnabled(plugin.id)}
      {@const ext = plugin.type === "external" ? externalState(plugin.id) : null}
      <div class="installed-item" class:expanded={configuringId === plugin.id}>
        <div class="plugin-row">
          <div class="plugin-icon">{plugin.icon}</div>
          <div class="plugin-info">
            <div class="plugin-name-row">
              <span class="plugin-name">{plugin.name}</span>
              <span class="plugin-type">{plugin.type === "builtin" ? "Built-in" : "External"}</span>
              {#if ext}
                <span class="plugin-status {ext.cls}">{ext.label}</span>
                {#if status[plugin.id]?.restarts}
                  <span class="plugin-restarts">{status[plugin.id].restarts} restart{status[plugin.id].restarts === 1 ? "" : "s"}</span>
                {/if}
              {/if}
            </div>
            <p class="plugin-desc">{plugin.description}</p>
            <span class="plugin-meta">v{plugin.version} · {plugin.author}</span>
          </div>
          <div class="plugin-actions">
            {#if plugin.hasConfig && enabled}
              <button class="btn-configure" onclick={() => handleConfigure(plugin.id)}>
                {configuringId === plugin.id ? 'Hide' : 'Configure'}
              </button>
            {/if}
            <button
              class="plugin-toggle"
              role="switch"
              aria-checked={enabled}
              aria-label="{enabled ? 'Disable' : 'Enable'} {plugin.name}"
              disabled={busy[plugin.id]}
              onclick={() => handleToggle(plugin.id)}
            >
              <span class="toggle-switch" class:active={enabled}>
                <span class="toggle-knob"></span>
              </span>
            </button>
          </div>
        </div>
        {#if errors[plugin.id]}
          <div class="plugin-error">{errors[plugin.id]}</div>
        {:else if ext?.detail}
          <div class="plugin-error">{ext.detail}</div>
        {/if}
        {#if configuringId === plugin.id}
          <div class="plugin-config-panel">
            <PluginConfig pluginId={plugin.id} pluginName={plugin.name} />
          </div>
        {/if}
      </div>
    {/each}
    {#if getAllPlugins().length === 0}
      <p class="empty">No plugins installed.</p>
    {/if}
  </div>
</div>

<style>
  .plugins-page { padding: 24px; max-width: 800px; margin: 0 auto; }
  h2 { font-size: 20px; color: var(--text-primary); margin-bottom: 16px; }

  .installed-list { display: flex; flex-direction: column; gap: 8px; }
  .installed-item {
    padding: 14px 16px;
    background: var(--bg-secondary);
    border: 1px solid var(--border);
    border-radius: var(--radius);
  }
  .installed-item.expanded { border-color: var(--accent); }
  .plugin-row { display: flex; align-items: center; gap: 14px; }
  .plugin-icon { font-size: 28px; flex-shrink: 0; width: 40px; text-align: center; }
  .plugin-info { flex: 1; min-width: 0; }
  .plugin-name-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .plugin-name { font-size: 14px; font-weight: 500; color: var(--text-primary); }
  .plugin-type { font-size: 10px; color: var(--text-muted); background: var(--bg-tertiary); padding: 1px 6px; border-radius: 8px; }
  .plugin-status { font-size: 10px; padding: 1px 6px; border-radius: 8px; }
  .plugin-status.running { color: var(--success); background: rgba(46,204,113,0.1); }
  .plugin-status.starting { color: var(--warning); background: rgba(245,166,35,0.1); }
  .plugin-status.failed { color: var(--danger); background: rgba(231,76,60,0.1); }
  .plugin-status.stopped { color: var(--text-muted); background: var(--bg-tertiary); }
  .plugin-restarts { font-size: 10px; color: var(--text-muted); }
  .plugin-desc { font-size: 12px; color: var(--text-secondary); margin: 3px 0; line-height: 1.4; }
  .plugin-meta { font-size: 11px; color: var(--text-muted); }
  .plugin-actions { display: flex; align-items: center; gap: 10px; flex-shrink: 0; }
  .btn-configure {
    padding: 5px 12px; border-radius: var(--radius-sm);
    background: var(--bg-tertiary); color: var(--text-secondary);
    font-size: 11px; cursor: pointer; border: 1px solid var(--border);
  }
  .btn-configure:hover { color: var(--accent); border-color: var(--accent); }
  .plugin-toggle { cursor: pointer; padding: 2px; border-radius: 12px; }
  .plugin-toggle:disabled { opacity: 0.5; cursor: progress; }
  .plugin-toggle:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

  .toggle-switch {
    display: block; position: relative; width: 36px; height: 20px;
    background: var(--bg-primary); border-radius: 10px;
    border: 1px solid var(--border); transition: background 0.2s;
  }
  .toggle-switch.active { background: var(--accent); border-color: var(--accent); }
  .toggle-knob {
    position: absolute; top: 2px; left: 2px;
    width: 14px; height: 14px;
    background: var(--text-primary); border-radius: 50%;
    transition: transform 0.2s;
  }
  .toggle-switch.active .toggle-knob { transform: translateX(16px); }

  .plugin-error {
    margin-top: 8px; padding: 6px 10px; border-radius: var(--radius-sm);
    background: rgba(231,76,60,0.1); color: var(--danger); font-size: 12px;
    white-space: pre-wrap; word-break: break-word;
  }
  .plugin-config-panel {
    margin-top: 12px; padding-top: 12px;
    border-top: 1px solid var(--border);
  }

  .empty { color: var(--text-muted); text-align: center; margin-top: 40px; }
</style>
