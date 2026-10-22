<script lang="ts">
  /**
   * Settings form for any action id. Used for keys, encoder press/rotate and strip gestures.
   * Emits the complete new settings object through `onchange` on every edit.
   */
  import { getScenes } from "../../lib/stores/editor.svelte";
  import VarInput from "./VarInput.svelte";
  import HAEntityPicker from "./HAEntityPicker.svelte";
  import MultiActionEditor from "../../lib/plugins/multi-action/MultiActionEditor.svelte";

  type HAControl = { id: string; domain: string; service: string; attr: string; readAttr?: string; min: number; max: number; step: number };

  let {
    actionId,
    settings,
    onchange,
    serial,
    oncontrolselect,
  }: {
    actionId: string;
    settings: Record<string, string>;
    onchange: (s: Record<string, string>) => void;
    /** Device whose scenes the scene picker lists (defaults to the device being edited). */
    serial?: string;
    /** HA picker: a control (e.g. brightness) was chosen. Encoders use it to bind their value. */
    oncontrolselect?: (control: HAControl) => void;
  } = $props();

  const uid = $props.id();
  const HTTP_METHODS = ["GET", "POST", "PUT", "DELETE"];
  const HA_KEYS = ["ha_entity", "ha_domain", "ha_service", "ha_attr", "ha_control", "ha_service_data"];
  const KNOWN = new Set([
    "none", "command", "hotkey", "launch", "open-url", "http-request", "switch-scene", "back",
    "timer", "counter", "ha-service", "ha-custom", "multi-action",
  ]);

  let scenes = $derived(getScenes());

  function set(key: string, value: string) {
    onchange({ ...settings, [key]: value });
  }

  /** HAEntityPicker hands back only the HA fields it manages; replace those, keep everything else. */
  function setHA(updated: Record<string, string>) {
    const next: Record<string, string> = {};
    for (const [k, v] of Object.entries(settings)) if (!HA_KEYS.includes(k)) next[k] = v;
    onchange({ ...next, ...updated });
  }

  // ── Generic key/value rows (external plugin and unknown actions) ──
  let newKey = $state("");
  let newValue = $state("");

  function renameKey(oldKey: string, nextKey: string) {
    const k = nextKey.trim();
    if (!k || k === oldKey) return;
    const next: Record<string, string> = {};
    for (const [key, v] of Object.entries(settings)) next[key === oldKey ? k : key] = v;
    onchange(next);
  }

  function removeKey(key: string) {
    const next = { ...settings };
    delete next[key];
    onchange(next);
  }

  function addRow() {
    const k = newKey.trim();
    if (!k) return;
    onchange({ ...settings, [k]: newValue });
    newKey = "";
    newValue = "";
  }
</script>

<div class="ase">
  {#if actionId === "command"}
    <div class="field">
      <label class="fl" for="{uid}-command">Command</label>
      <VarInput id="{uid}-command" value={settings.command || ""} placeholder="e.g. firefox" onchange={(v) => set("command", v)} />
      <span class="hint">Variable values are inserted shell-quoted.</span>
    </div>
  {:else if actionId === "hotkey"}
    <div class="field">
      <label class="fl" for="{uid}-key">Key</label>
      <input id="{uid}-key" type="text" value={settings.key || ""} placeholder="e.g. F5" oninput={(e) => set("key", e.currentTarget.value)} />
    </div>
    <div class="field">
      <label class="fl" for="{uid}-mods">Modifiers</label>
      <input id="{uid}-mods" type="text" value={settings.modifiers || ""} placeholder="ctrl, shift" oninput={(e) => set("modifiers", e.currentTarget.value)} />
    </div>
  {:else if actionId === "launch"}
    <div class="field">
      <label class="fl" for="{uid}-target">Application</label>
      <VarInput id="{uid}-target" value={settings.target || ""} placeholder="firefox" onchange={(v) => set("target", v)} />
    </div>
  {:else if actionId === "open-url"}
    <div class="field">
      <label class="fl" for="{uid}-url">URL</label>
      <VarInput id="{uid}-url" value={settings.url || ""} placeholder="https://..." onchange={(v) => set("url", v)} />
    </div>
  {:else if actionId === "http-request"}
    <div class="field">
      <label class="fl" for="{uid}-url">URL</label>
      <VarInput id="{uid}-url" value={settings.url || ""} placeholder="http://..." onchange={(v) => set("url", v)} />
    </div>
    <div class="mrow" role="group" aria-label="HTTP method">
      {#each HTTP_METHODS as m}
        <button class:active={(settings.method || "POST") === m} onclick={() => set("method", m)}>{m}</button>
      {/each}
    </div>
    <div class="field">
      <label class="fl" for="{uid}-headers">Headers</label>
      <textarea id="{uid}-headers" value={settings.headers || ""} placeholder="Key: Value" rows="2" oninput={(e) => set("headers", e.currentTarget.value)}></textarea>
    </div>
    <div class="field">
      <label class="fl" for="{uid}-body">Body</label>
      <VarInput id="{uid}-body" value={settings.body || ""} placeholder={'{"key":"val"}'} multiline={true} rows={3} onchange={(v) => set("body", v)} />
    </div>
  {:else if actionId === "switch-scene"}
    <div class="field">
      <span class="fl">Scene</span>
      <div class="chips" role="group" aria-label="Target scene">
        {#each scenes as scene (scene.id)}
          <button class="chip" class:active={settings.sceneId === scene.id} onclick={() => set("sceneId", scene.id)}>{scene.name}</button>
        {/each}
      </div>
      {#if settings.sceneId && !scenes.some((s) => s.id === settings.sceneId)}
        <span class="hint warn">The selected scene no longer exists.</span>
      {/if}
    </div>
    <div class="field">
      <span class="fl">Mode</span>
      <div class="mrow" role="group" aria-label="Navigation mode">
        <button class:active={(settings.mode || "push") === "push"} onclick={() => set("mode", "push")}>Push</button>
        <button class:active={settings.mode === "switch"} onclick={() => set("mode", "switch")}>Switch</button>
      </div>
      <span class="hint">Push remembers the current scene so a Back action returns to it.</span>
    </div>
  {:else if actionId === "back"}
    <span class="hint">Returns to the previously pushed scene.</span>
  {:else if actionId === "timer"}
    <div class="field">
      <label class="fl" for="{uid}-duration">Duration (sec)</label>
      <input id="{uid}-duration" type="number" min="1" value={settings.duration || "60"} oninput={(e) => set("duration", e.currentTarget.value)} />
    </div>
  {:else if actionId === "counter"}
    <div class="field">
      <label class="fl" for="{uid}-value">Start value</label>
      <input id="{uid}-value" type="number" value={settings.value || "0"} oninput={(e) => set("value", e.currentTarget.value)} />
    </div>
  {:else if actionId === "ha-service"}
    <HAEntityPicker {settings} onchange={setHA} {oncontrolselect} />
  {:else if actionId === "ha-custom"}
    <div class="field">
      <label class="fl" for="{uid}-custom">Custom JSON</label>
      <textarea id="{uid}-custom" value={settings.ha_custom_json || ""} rows="4"
        placeholder={'{"domain":"light","service":"toggle","target":{"entity_id":"light.living_room"}}'}
        oninput={(e) => set("ha_custom_json", e.currentTarget.value)}></textarea>
    </div>
  {:else if actionId === "multi-action"}
    <MultiActionEditor value={settings.steps || "[]"} onchange={(json) => set("steps", json)} />
  {/if}

  {#if !KNOWN.has(actionId)}
    <div class="field">
      <span class="fl">Settings</span>
      {#each Object.entries(settings) as [key, value] (key)}
        <div class="kv-row">
          <input type="text" aria-label="Setting name" value={key} onchange={(e) => renameKey(key, e.currentTarget.value)} />
          <input type="text" aria-label="Value of {key}" value={value} oninput={(e) => set(key, e.currentTarget.value)} />
          <button class="kv-del" onclick={() => removeKey(key)} aria-label="Remove setting {key}">×</button>
        </div>
      {/each}
      <div class="kv-row">
        <input type="text" aria-label="New setting name" bind:value={newKey} placeholder="name" onkeydown={(e) => { if (e.key === "Enter") addRow(); }} />
        <input type="text" aria-label="New setting value" bind:value={newValue} placeholder="value" onkeydown={(e) => { if (e.key === "Enter") addRow(); }} />
        <button class="kv-add" onclick={addRow} disabled={!newKey.trim()} aria-label="Add setting">+</button>
      </div>
    </div>
  {/if}
</div>

<style>
  .ase { display: flex; flex-direction: column; gap: 8px; }
  .field { display: flex; flex-direction: column; gap: 4px; }
  .fl { display: block; font-size: 10px; text-transform: uppercase; letter-spacing: 0.5px; color: var(--text-muted); margin: 0; font-weight: 500; }
  .hint { font-size: 10px; color: var(--text-muted); line-height: 1.4; }
  .hint.warn { color: var(--warning); }
  input[type="text"], input[type="number"], textarea { width: 100%; min-height: var(--input-h, 34px); padding: 8px 10px; border-radius: var(--radius-sm); border: 1px solid var(--border); background: var(--bg-surface); color: var(--text-primary); font-size: 12px; outline: none; box-sizing: border-box; transition: border-color 0.15s; font-family: inherit; }
  input[type="text"], input[type="number"] { padding: 0 10px; height: var(--input-h, 34px); }
  input:focus, textarea:focus { border-color: var(--accent); }
  textarea { resize: vertical; line-height: 1.5; }
  .mrow { display: flex; gap: 3px; }
  .mrow button { flex: 1; height: 30px; border-radius: var(--radius-sm); font-size: 11px; font-weight: 600; color: var(--text-muted); background: var(--bg-surface); border: 1px solid var(--border); cursor: pointer; transition: all 0.15s; }
  .mrow button:hover { color: var(--text-primary); border-color: var(--border-light); }
  .mrow button.active { background: var(--accent); color: white; border-color: var(--accent); }
  .chips { display: flex; flex-wrap: wrap; gap: 4px; }
  .chip { padding: 5px 10px; border-radius: 12px; font-size: 11px; color: var(--text-secondary); background: var(--bg-surface); border: 1px solid var(--border); cursor: pointer; transition: all 0.15s; }
  .chip:hover { color: var(--text-primary); border-color: var(--border-light); }
  .chip.active { color: white; background: var(--accent); border-color: var(--accent); }
  .kv-row { display: flex; gap: 4px; align-items: center; }
  .kv-row input { flex: 1; min-width: 0; }
  .kv-del, .kv-add { width: 28px; height: 28px; flex-shrink: 0; border-radius: var(--radius-sm); background: var(--bg-surface); border: 1px solid var(--border); color: var(--text-muted); font-size: 14px; }
  .kv-del:hover { color: var(--danger); border-color: var(--danger); }
  .kv-add:hover:not(:disabled) { color: var(--accent); border-color: var(--accent); }
  .kv-add:disabled { opacity: 0.4; cursor: default; }
</style>
