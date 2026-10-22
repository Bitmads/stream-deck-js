<script lang="ts">
  import { getAllPlugins, isEnabled, togglePlugin } from "../lib/stores/plugins.svelte";
  import PluginConfig from "../components/plugin/PluginConfig.svelte";

  let toggleCounter = $state(0);
  let configuringId = $state<string | null>(null);
  let errors = $state<Record<string, string>>({});

  async function handleToggle(id: string) {
    errors[id] = "";
    try {
      await togglePlugin(id);
    } catch (e) {
      errors[id] = String(e);
    }
    toggleCounter++;
  }

  function handleConfigure(id: string) {
    configuringId = configuringId === id ? null : id;
  }
</script>

<div class="plugins-page">
  <h2>Plugins</h2>

  {#key toggleCounter}
  <div class="installed-list">
    {#each getAllPlugins() as plugin}
      <div class="installed-item" class:expanded={configuringId === plugin.id}>
        <div class="plugin-row">
          <div class="plugin-icon">{plugin.icon}</div>
          <div class="plugin-info">
            <div class="plugin-name-row">
              <span class="plugin-name">{plugin.name}</span>
              <span class="plugin-type">{plugin.type === "builtin" ? "Built-in" : "External"}</span>
              {#if isEnabled(plugin.id) && plugin.type === "external"}
                <span class="plugin-status running">Running</span>
              {:else if plugin.type === "external"}
                <span class="plugin-status stopped">Stopped</span>
              {/if}
            </div>
            <p class="plugin-desc">{plugin.description}</p>
            <span class="plugin-meta">v{plugin.version} · {plugin.author}</span>
          </div>
          <div class="plugin-actions">
            {#if plugin.hasConfig && isEnabled(plugin.id)}
              <button class="btn-configure" onclick={() => handleConfigure(plugin.id)}>
                {configuringId === plugin.id ? 'Hide' : 'Configure'}
              </button>
            {/if}
            <div class="plugin-toggle" onclick={() => handleToggle(plugin.id)}>
              <div class="toggle-switch" class:active={isEnabled(plugin.id)}>
                <div class="toggle-knob"></div>
              </div>
            </div>
          </div>
        </div>
        {#if errors[plugin.id]}
          <div class="plugin-error">{errors[plugin.id]}</div>
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
  {/key}
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
  .plugin-name-row { display: flex; align-items: center; gap: 8px; }
  .plugin-name { font-size: 14px; font-weight: 500; color: var(--text-primary); }
  .plugin-type { font-size: 10px; color: var(--text-muted); background: var(--bg-tertiary); padding: 1px 6px; border-radius: 8px; }
  .plugin-status { font-size: 10px; padding: 1px 6px; border-radius: 8px; }
  .plugin-status.running { color: var(--success); background: rgba(46,204,113,0.1); }
  .plugin-status.stopped { color: var(--text-muted); background: var(--bg-tertiary); }
  .plugin-desc { font-size: 12px; color: var(--text-secondary); margin: 3px 0; line-height: 1.4; }
  .plugin-meta { font-size: 11px; color: var(--text-muted); }
  .plugin-actions { display: flex; align-items: center; gap: 10px; flex-shrink: 0; }
  .btn-configure {
    padding: 5px 12px; border-radius: var(--radius-sm);
    background: var(--bg-tertiary); color: var(--text-secondary);
    font-size: 11px; cursor: pointer; border: 1px solid var(--border);
  }
  .btn-configure:hover { color: var(--accent); border-color: var(--accent); }
  .plugin-toggle { cursor: pointer; }

  .toggle-switch {
    position: relative; width: 36px; height: 20px;
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
  }
  .plugin-config-panel {
    margin-top: 12px; padding-top: 12px;
    border-top: 1px solid var(--border);
  }

  .empty { color: var(--text-muted); text-align: center; margin-top: 40px; }
</style>
