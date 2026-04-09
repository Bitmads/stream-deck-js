<script lang="ts">
  import { getAllPlugins, isEnabled, togglePlugin } from "../lib/stores/plugins.svelte";

  // Force reactivity on toggle
  let toggleCounter = $state(0);

  async function handleToggle(id: string) {
    await togglePlugin(id);
    toggleCounter++;
  }
</script>

<div class="plugins-page">
  <h2>Plugins</h2>

  {#key toggleCounter}
  <div class="installed-list">
    {#each getAllPlugins() as plugin}
      <div class="installed-item">
        <div class="plugin-icon">{plugin.icon}</div>
        <div class="plugin-info">
          <div class="plugin-name-row">
            <span class="plugin-name">{plugin.name}</span>
            <span class="plugin-type">{plugin.type === "builtin" ? "Built-in" : "External"}</span>
          </div>
          <p class="plugin-desc">{plugin.description}</p>
          <span class="plugin-meta">v{plugin.version} · {plugin.author}</span>
        </div>
        <div class="plugin-toggle" onclick={() => handleToggle(plugin.id)}>
          <div class="toggle-switch" class:active={isEnabled(plugin.id)}>
            <div class="toggle-knob"></div>
          </div>
        </div>
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
    display: flex; align-items: center; gap: 14px;
    padding: 14px 16px;
    background: var(--bg-secondary);
    border: 1px solid var(--border);
    border-radius: var(--radius);
  }
  .plugin-icon { font-size: 28px; flex-shrink: 0; width: 40px; text-align: center; }
  .plugin-info { flex: 1; min-width: 0; }
  .plugin-name-row { display: flex; align-items: center; gap: 8px; }
  .plugin-name { font-size: 14px; font-weight: 500; color: var(--text-primary); }
  .plugin-type { font-size: 10px; color: var(--text-muted); background: var(--bg-tertiary); padding: 1px 6px; border-radius: 8px; }
  .plugin-desc { font-size: 12px; color: var(--text-secondary); margin: 3px 0; line-height: 1.4; }
  .plugin-meta { font-size: 11px; color: var(--text-muted); }
  .plugin-toggle { cursor: pointer; flex-shrink: 0; }

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

  .empty { color: var(--text-muted); text-align: center; margin-top: 40px; }
</style>