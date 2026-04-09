<script lang="ts">
  import { getAllPlugins, isEnabled, togglePlugin } from "../lib/stores/plugins.svelte";

  let searchQuery = $state("");
  let activeTab = $state<"installed" | "browse">("installed");

  // Placeholder marketplace data
  const marketplacePlugins = [
    { uuid: "com.example.obs", name: "OBS Studio", author: "Community", description: "Control OBS scenes, recording, streaming", version: "1.0.0", category: "Streaming" },
    { uuid: "com.example.spotify", name: "Spotify", author: "Community", description: "Play/pause, skip, volume control", version: "1.0.0", category: "Music" },
    { uuid: "com.example.hue", name: "Philips Hue", author: "Community", description: "Control smart lights, scenes, brightness", version: "1.0.0", category: "Smart Home" },
    { uuid: "com.example.discord", name: "Discord", author: "Community", description: "Mute, deafen, toggle voice", version: "1.0.0", category: "Communication" },
    { uuid: "com.example.system-monitor", name: "System Monitor", author: "Community", description: "CPU, RAM, GPU usage on keys", version: "1.0.0", category: "System" },
  ];

  let filteredMarketplace = $derived(() => {
    const q = searchQuery.toLowerCase();
    if (!q) return marketplacePlugins;
    return marketplacePlugins.filter(p =>
      p.name.toLowerCase().includes(q) || p.description.toLowerCase().includes(q) || p.category.toLowerCase().includes(q)
    );
  });

  // Force reactivity on toggle
  let toggleCounter = $state(0);

  async function handleToggle(id: string) {
    await togglePlugin(id);
    toggleCounter++;
  }
</script>

<div class="plugins-page">
  <div class="plugins-header">
    <h2>Plugins</h2>
    <div class="plugin-tabs">
      <button class:active={activeTab === "installed"} onclick={() => activeTab = "installed"}>Installed</button>
      <button class:active={activeTab === "browse"} onclick={() => activeTab = "browse"}>Browse</button>
    </div>
  </div>

  {#if activeTab === "browse"}
    <div class="search-bar">
      <input type="text" bind:value={searchQuery} placeholder="Search plugins..." />
    </div>
    <div class="plugin-grid">
      {#each filteredMarketplace() as plugin}
        <div class="plugin-card">
          <div class="pc-header">
            <h3>{plugin.name}</h3>
            <span class="pc-version">v{plugin.version}</span>
          </div>
          <p class="pc-author">by {plugin.author}</p>
          <p class="pc-desc">{plugin.description}</p>
          <div class="pc-footer">
            <span class="pc-category">{plugin.category}</span>
            <button class="pc-install">Install</button>
          </div>
        </div>
      {/each}
    </div>
  {:else}
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
        <p class="empty">No plugins installed. Browse the marketplace to find plugins.</p>
      {/if}
    </div>
    {/key}
  {/if}
</div>

<style>
  .plugins-page { padding: 24px; max-width: 800px; margin: 0 auto; }
  .plugins-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px; }
  .plugins-header h2 { font-size: 20px; color: var(--text-primary); }
  .plugin-tabs { display: flex; gap: 4px; }
  .plugin-tabs button { padding: 6px 14px; border-radius: var(--radius-sm); font-size: 13px; color: var(--text-muted); cursor: pointer; }
  .plugin-tabs button:hover { color: var(--text-primary); background: var(--bg-tertiary); }
  .plugin-tabs button.active { color: var(--accent); background: var(--bg-tertiary); }

  .search-bar { margin-bottom: 16px; }
  .search-bar input { width: 100%; padding: 10px 14px; border-radius: var(--radius); border: 1px solid var(--border); background: var(--bg-secondary); color: var(--text-primary); font-size: 14px; outline: none; }
  .search-bar input:focus { border-color: var(--accent); }

  .plugin-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 12px; }
  .plugin-card { background: var(--bg-secondary); border: 1px solid var(--border); border-radius: var(--radius); padding: 16px; }
  .pc-header { display: flex; align-items: center; justify-content: space-between; }
  .pc-header h3 { font-size: 15px; color: var(--text-primary); }
  .pc-version { font-size: 11px; color: var(--text-muted); }
  .pc-author { font-size: 12px; color: var(--text-muted); margin: 4px 0; }
  .pc-desc { font-size: 13px; color: var(--text-secondary); margin: 8px 0; line-height: 1.4; }
  .pc-footer { display: flex; align-items: center; justify-content: space-between; margin-top: 12px; }
  .pc-category { font-size: 11px; color: var(--accent); background: rgba(0,120,255,0.1); padding: 2px 8px; border-radius: 10px; }
  .pc-install { padding: 5px 14px; border-radius: var(--radius-sm); background: var(--accent); color: white; font-size: 12px; cursor: pointer; }
  .pc-install:hover { background: var(--accent-hover); }

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
