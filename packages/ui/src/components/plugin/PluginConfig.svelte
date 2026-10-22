<script lang="ts">
  import { invoke } from "@tauri-apps/api/core";

  let { pluginId, pluginName }: { pluginId: string; pluginName: string } = $props();

  let schema = $state<any>(null);
  let config = $state<Record<string, any>>({});
  let saving = $state(false);
  let error = $state("");

  async function load() {
    try {
      const schemaJson = await invoke<string>("get_plugin_config_schema", { uuid: pluginId });
      schema = JSON.parse(schemaJson);
    } catch {
      schema = null;
    }
    try {
      const configJson = await invoke<string>("read_plugin_config", { uuid: pluginId });
      config = JSON.parse(configJson);
    } catch {
      config = {};
    }
  }

  async function save() {
    saving = true;
    error = "";
    try {
      await invoke("write_plugin_config", { uuid: pluginId, config: JSON.stringify(config) });
    } catch (e) {
      error = String(e);
    }
    saving = false;
  }

  function updateField(key: string, value: any) {
    config = { ...config, [key]: value };
  }

  let tagInputs = $state<Record<string, string>>({});

  function addTag(key: string) {
    const val = (tagInputs[key] || "").trim().toUpperCase();
    if (!val) return;
    const arr = Array.isArray(config[key]) ? [...config[key]] : [];
    if (!arr.includes(val)) {
      arr.push(val);
      updateField(key, arr);
    }
    tagInputs[key] = "";
  }

  function removeTag(key: string, item: string) {
    const arr = Array.isArray(config[key]) ? config[key].filter((v: string) => v !== item) : [];
    updateField(key, arr);
  }

  load();
</script>

<h3>{pluginName}</h3>

{#if schema?.properties}
  {#each Object.entries(schema.properties) as [key, field]}
    {@const f = field as any}
    <div class="cfg-field">
      <label class="cfg-label">{f.title || key}</label>
      {#if f.description}
        <p class="cfg-hint">{f.description}</p>
      {/if}
      {#if f.type === "array"}
        <div class="tag-list">
          {#each (Array.isArray(config[key]) ? config[key] : []) as item}
            <span class="tag">{item}<button class="tag-remove" onclick={() => removeTag(key, item)}>&times;</button></span>
          {/each}
        </div>
        <div class="tag-add">
          <input type="text" bind:value={tagInputs[key]} placeholder={f.placeholder || "Add..."} onkeydown={(e) => { if (e.key === "Enter") { e.preventDefault(); addTag(key); }}} />
          <button class="tag-add-btn" onclick={() => addTag(key)}>Add</button>
        </div>
      {:else if f.type === "boolean"}
        <label class="cfg-toggle">
          <input type="checkbox" checked={!!config[key]} onchange={(e) => updateField(key, (e.target as HTMLInputElement).checked)} />
          <span>{config[key] ? "Enabled" : "Disabled"}</span>
        </label>
      {:else if f.type === "number" || f.type === "integer"}
        <input type="number" value={config[key] ?? f.default ?? 0} min={f.minimum} max={f.maximum} oninput={(e) => updateField(key, Number((e.target as HTMLInputElement).value))} />
      {:else if f.enum}
        <select value={config[key] ?? f.default ?? ""} onchange={(e) => updateField(key, (e.target as HTMLSelectElement).value)}>
          {#each f.enum as opt}
            <option value={opt}>{opt}</option>
          {/each}
        </select>
      {:else}
        <input type={f.format === "password" ? "password" : "text"} value={config[key] ?? f.default ?? ""} placeholder={f.placeholder || ""} oninput={(e) => updateField(key, (e.target as HTMLInputElement).value)} />
      {/if}
    </div>
  {/each}

  <button class="cfg-save" onclick={save} disabled={saving}>
    {saving ? "Saving..." : "Save"}
  </button>
  {#if error}<p class="cfg-error">{error}</p>{/if}
{:else}
  <p class="cfg-hint">No configuration available for this plugin.</p>
{/if}

<style>
  h3 { font-size: 15px; color: var(--text-secondary); margin-bottom: 8px; }
  .cfg-field { display: flex; flex-direction: column; gap: 4px; margin-bottom: var(--item-gap, 11px); }
  .cfg-label { font-size: 10px; text-transform: uppercase; letter-spacing: 0.5px; color: var(--text-muted); font-weight: 500; }
  .cfg-hint { font-size: 12px; color: var(--text-muted); line-height: 1.5; margin: 0; }
  .cfg-toggle { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--text-secondary); cursor: pointer; }
  .cfg-toggle input[type="checkbox"] { accent-color: var(--accent); width: 14px; height: 14px; }

  input[type="text"], input[type="password"], input[type="number"], select {
    width: 100%; height: var(--input-h, 34px); padding: 0 10px;
    border-radius: var(--radius-sm); border: 1px solid var(--border);
    background: var(--bg-surface); color: var(--text-primary);
    font-size: 12px; font-family: inherit; outline: none;
    transition: border-color 0.15s;
  }
  input:focus, select:focus { border-color: var(--accent); }
  select {
    appearance: none; -webkit-appearance: none;
    background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23585874' stroke-width='2'><polyline points='6 9 12 15 18 9'/></svg>");
    background-repeat: no-repeat; background-position: right 8px center; background-size: 12px;
    padding-right: 28px;
  }
  select option { background: var(--bg-secondary); color: var(--text-primary); }

  .cfg-save {
    height: 34px; padding: 0 20px;
    border-radius: var(--radius-sm); background: var(--accent); color: white;
    font-size: 12px; font-weight: 500; cursor: pointer; border: none;
    transition: background 0.15s;
  }
  .cfg-save:hover { background: var(--accent-hover); }
  .cfg-save:disabled { opacity: 0.6; cursor: default; }
  .cfg-error { font-size: 11px; color: var(--danger); margin-top: 4px; }

  .tag-list { display: flex; flex-wrap: wrap; gap: 5px; }
  .tag {
    display: flex; align-items: center; gap: 4px;
    padding: 3px 8px; border-radius: 12px;
    background: var(--accent); color: white;
    font-size: 12px; font-weight: 500;
  }
  .tag-remove {
    background: none; border: none; color: rgba(255,255,255,0.7);
    font-size: 14px; cursor: pointer; padding: 0 2px; line-height: 1;
  }
  .tag-remove:hover { color: white; }
  .tag-add { display: flex; gap: 6px; margin-top: 4px; }
  .tag-add input { flex: 1; }
  .tag-add-btn {
    height: var(--input-h, 34px); padding: 0 14px;
    border-radius: var(--radius-sm); background: var(--bg-tertiary);
    color: var(--text-secondary); font-size: 12px; cursor: pointer;
    border: 1px solid var(--border);
  }
  .tag-add-btn:hover { color: var(--accent); border-color: var(--accent); }
</style>
