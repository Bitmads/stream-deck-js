<script lang="ts">
  import { ha } from "../../lib/plugins/homeassistant";

  let {
    settings,
    onchange,
    oncontrolselect,
  }: {
    settings: Record<string, string>;
    onchange: (updated: Record<string, string>) => void;
    oncontrolselect?: (control: { id: string; domain: string; service: string; attr: string; min: number; max: number; step: number }) => void;
  } = $props();

  let query = $state("");
  let results = $derived(ha.searchEntities(query));

  function selectEntity(entityId: string) {
    onchange({ ha_entity: entityId });
    query = "";
  }

  function clearEntity() {
    onchange({});
  }

  function selectControl(c: { id: string; domain: string; service: string; attr: string; min: number; max: number; step: number }) {
    ha.addWatch(settings.ha_entity);
    onchange({ ...settings, ha_domain: c.domain, ha_service: c.service, ha_control: c.id, ha_attr: c.attr });
    oncontrolselect?.(c);
  }

  function selectService(s: { domain: string; service: string }) {
    onchange({ ...settings, ha_domain: s.domain, ha_service: s.service, ha_control: s.service, ha_attr: "" });
  }
</script>

{#if settings.ha_entity}
  <div class="ha-chip">
    <span>{ha.getEntity(settings.ha_entity)?.friendly_name || settings.ha_entity}</span>
    <button onclick={clearEntity}>×</button>
  </div>
  {@const ctrls = ha.getEntityControls(settings.ha_entity)}
  {@const svcs = ha.getEntityServices(settings.ha_entity)}
  {#if ctrls.length > 0}
    <label class="fl">Control</label>
    <div class="chips">
      {#each ctrls as c}
        <button class="chip" class:active={settings.ha_control === c.id} onclick={() => selectControl(c)}>{c.label}</button>
      {/each}
    </div>
  {/if}
  {#if svcs.length > 0}
    <label class="fl">Service</label>
    <div class="chips">
      {#each svcs as s}
        <button class="chip" class:active={settings.ha_service === s.service && !settings.ha_attr} onclick={() => selectService(s)}>{s.name}</button>
      {/each}
    </div>
  {/if}
{:else}
  <input type="text" bind:value={query} placeholder="Search entity..." />
  {#if query.length > 0}
    <div class="ent-list">
      {#each results as ent}
        <button onclick={() => selectEntity(ent.entity_id)}>
          <span>{ent.friendly_name}</span>
          <span class="ent-d">{ent.domain}</span>
        </button>
      {/each}
    </div>
  {/if}
{/if}

<style>
  .ha-chip { display: flex; align-items: center; gap: 6px; padding: 4px 8px; background: var(--bg-primary); border-radius: var(--radius-sm); font-size: 12px; color: var(--text-primary); margin-bottom: 4px; }
  .ha-chip button { font-size: 14px; color: var(--text-muted); cursor: pointer; padding: 0 2px; }
  .ha-chip button:hover { color: var(--danger); }
  .fl { font-size: 11px; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.3px; margin-bottom: 2px; }
  .chips { display: flex; flex-wrap: wrap; gap: 3px; margin-bottom: 4px; }
  .chip { padding: 3px 8px; border-radius: 10px; font-size: 11px; cursor: pointer; background: var(--bg-primary); color: var(--text-secondary); border: 1px solid var(--border); }
  .chip:hover { color: var(--text-primary); border-color: var(--text-muted); }
  .chip.active { background: var(--accent); color: white; border-color: var(--accent); }
  input[type="text"] { width: 100%; padding: 6px 8px; border-radius: var(--radius-sm); border: 1px solid var(--border); background: var(--bg-primary); color: var(--text-primary); font-size: 12px; outline: none; }
  input:focus { border-color: var(--accent); }
  .ent-list { display: flex; flex-direction: column; gap: 1px; max-height: 150px; overflow-y: auto; margin-top: 4px; }
  .ent-list button { display: flex; justify-content: space-between; padding: 4px 8px; font-size: 11px; cursor: pointer; color: var(--text-secondary); border-radius: var(--radius-sm); }
  .ent-list button:hover { background: var(--bg-tertiary); color: var(--accent); }
  .ent-d { font-size: 9px; color: var(--text-muted); }
</style>
