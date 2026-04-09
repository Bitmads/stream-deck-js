<script lang="ts">
  import { ha } from "./client";

  let watchSearch = $state("");
  let watchedList = $state<string[]>([]);

  function refreshWatched() { watchedList = ha.getWatchedIds(); }

  let haUrl = $state("");
  let haToken = $state("");
  let haConnected = $state(false);
  let haEntityCount = $state(0);

  async function loadHAConfig() {
    const config = await ha.loadConfig();
    if (config) { haUrl = config.url; haToken = config.token; }
    haConnected = ha.connected;
    haEntityCount = ha.getEntities().length;
    refreshWatched();
  }

  async function handleHAConnect() {
    await ha.saveConfig(haUrl, haToken);
    ha.connect(haUrl, haToken);
    setTimeout(() => { haConnected = ha.connected; haEntityCount = ha.getEntities().length; }, 2000);
  }

  function handleHADisconnect() {
    ha.disconnect();
    haConnected = false;
  }

  loadHAConfig();
</script>

<h3>Home Assistant</h3>
<p class="hint">Connect to Home Assistant for real-time service calls via WebSocket. Much faster than HTTP webhooks.</p>

<div class="ha-status" class:connected={haConnected}>
  {haConnected ? `Connected (${haEntityCount} entities)` : 'Not connected'}
</div>

<div class="ha-fields">
  <input class="input" type="text" bind:value={haUrl} placeholder="https://homeassistant.example.com" />
  <input class="input" type="password" bind:value={haToken} placeholder="Long-lived access token" />
  <div class="ha-buttons">
    {#if haConnected}
      <button class="btn-disconnect" onclick={handleHADisconnect}>Disconnect</button>
    {:else}
      <button class="btn-connect" onclick={handleHAConnect}>Connect</button>
    {/if}
  </div>
</div>
<p class="hint">Get a token: HA → Profile (bottom left) → Long-Lived Access Tokens → Create Token</p>

{#if haConnected}
  <h4 style="margin-top:12px; font-size:13px; color:var(--text-secondary);">Watched Entities</h4>
  <p class="hint">Watched entities auto-sync to variables. Use <code>{'{{$ha.<entity_id>.<attr>}}'}</code> in text labels or encoder bindings.</p>
  <input class="input" type="text" bind:value={watchSearch} placeholder="Search entity to watch..." />
  {#if watchSearch.length > 0}
    <div class="watch-results">
      {#each ha.searchEntities(watchSearch).filter(e => !ha.isWatched(e.entity_id)) as ent}
        <button class="watch-item" onclick={() => { ha.addWatch(ent.entity_id); watchSearch = ""; refreshWatched(); }}>
          <span>+ {ent.friendly_name}</span>
          <span style="font-size:9px; color:var(--text-muted);">{ent.entity_id}</span>
        </button>
      {/each}
    </div>
  {/if}
  {#if watchedList.length > 0}
    <div class="watch-list">
      {#each watchedList as id}
        <div class="watch-entry">
          <span class="watch-name">{ha.getEntity(id)?.friendly_name || id}</span>
          <span class="watch-state">{ha.getEntity(id)?.state || '?'}</span>
          <button class="watch-remove" onclick={() => { ha.removeWatch(id); refreshWatched(); }}>×</button>
        </div>
      {/each}
    </div>
  {/if}
{/if}

<style>
  h3 { font-size: 15px; color: var(--text-secondary); margin-bottom: 8px; }
  .hint { font-size: 12px; color: var(--text-muted); line-height: 1.5; margin-bottom: 12px; }
  .ha-status { padding: 6px 12px; border-radius: var(--radius-sm); font-size: 12px; color: var(--danger); background: rgba(231,76,60,0.1); margin-bottom: 10px; }
  .ha-status.connected { color: var(--success); background: rgba(46,204,113,0.1); }
  .ha-fields { display: flex; flex-direction: column; gap: 6px; margin-bottom: 8px; }
  .ha-fields .input { padding: 8px 12px; }
  .ha-buttons { display: flex; gap: 6px; }
  .btn-connect { padding: 8px 16px; border-radius: var(--radius-sm); background: var(--accent); color: white; font-size: 12px; cursor: pointer; }
  .btn-disconnect { padding: 8px 16px; border-radius: var(--radius-sm); background: rgba(231,76,60,0.15); color: var(--danger); font-size: 12px; cursor: pointer; }
  .watch-results { display: flex; flex-direction: column; gap: 2px; margin-top: 4px; max-height: 150px; overflow-y: auto; }
  .watch-item { display: flex; justify-content: space-between; align-items: center; padding: 5px 8px; border-radius: var(--radius-sm); cursor: pointer; font-size: 12px; color: var(--text-secondary); }
  .watch-item:hover { background: var(--bg-tertiary); color: var(--accent); }
  .watch-list { display: flex; flex-direction: column; gap: 3px; margin-top: 8px; }
  .watch-entry { display: flex; align-items: center; gap: 8px; padding: 6px 8px; background: var(--bg-primary); border-radius: var(--radius-sm); font-size: 12px; }
  .watch-name { flex: 1; color: var(--text-primary); }
  .watch-state { font-size: 11px; color: var(--accent); background: rgba(0,120,255,0.1); padding: 1px 6px; border-radius: 8px; }
  .watch-remove { font-size: 14px; color: var(--text-muted); cursor: pointer; padding: 0 4px; }
  .watch-remove:hover { color: var(--danger); }
</style>
