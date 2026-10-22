<script lang="ts">
  import { ACTION_TYPES, store } from "../../stores/store.svelte";
  import type { ActionDef } from "../../stores/store.svelte";
  import HAEntityPicker from "../../../components/input/HAEntityPicker.svelte";
  import VarInput from "../../../components/input/VarInput.svelte";
  import { isExternalAction } from "../external/bridge.svelte";
  import { parseSteps, serializeSteps, type MultiActionStep } from "./steps";

  let { value, onchange }: { value: string; onchange: (json: string) => void } = $props();

  type Field = { key: string; label: string; placeholder?: string; kind?: "text" | "number" | "textarea" | "var" | "varMulti" };

  /** Known settings per built-in action, with the defaults a new step starts with. */
  const KNOWN: Record<string, { fields: Field[]; defaults: Record<string, string> }> = {
    "command": { fields: [{ key: "command", label: "Command", placeholder: "e.g. notify-send hi", kind: "var" }], defaults: { command: "" } },
    "launch": { fields: [{ key: "target", label: "Application", placeholder: "firefox", kind: "var" }], defaults: { target: "" } },
    "hotkey": {
      fields: [
        { key: "key", label: "Key", placeholder: "e.g. F5" },
        { key: "modifiers", label: "Modifiers", placeholder: "ctrl+shift" },
      ],
      defaults: { key: "", modifiers: "" },
    },
    "open-url": { fields: [{ key: "url", label: "URL", placeholder: "https://...", kind: "var" }], defaults: { url: "https://" } },
    "http-request": {
      fields: [
        { key: "url", label: "URL", placeholder: "http://...", kind: "var" },
        { key: "headers", label: "Headers", placeholder: "Key: Value", kind: "textarea" },
        { key: "body", label: "Body", placeholder: '{"key":"val"}', kind: "varMulti" },
      ],
      defaults: { url: "", method: "POST", headers: "", body: "" },
    },
    "switch-scene": { fields: [], defaults: { sceneId: "", mode: "push" } },
    "back": { fields: [], defaults: {} },
    "timer": { fields: [{ key: "duration", label: "Duration (sec)", kind: "number" }], defaults: { duration: "60" } },
    "counter": { fields: [{ key: "value", label: "Start value", kind: "number" }], defaults: { value: "0" } },
    "ha-service": {
      fields: [{ key: "ha_service_data", label: "Service data (JSON, optional)", placeholder: '{"brightness": 128}', kind: "textarea" }],
      defaults: {},
    },
    "ha-custom": {
      fields: [{ key: "ha_custom_json", label: "Custom JSON", placeholder: '{"domain":"light","service":"toggle","target":{"entity_id":"light.living_room"}}', kind: "textarea" }],
      defaults: { ha_custom_json: "" },
    },
  };
  const HA_KEYS = ["ha_entity", "ha_domain", "ha_service", "ha_attr", "ha_control", "value"];
  const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"];

  let parsed = $derived.by((): { steps: MultiActionStep[]; error: string | null } => {
    try { return { steps: parseSteps(value), error: null }; }
    catch (e) { return { steps: [], error: e instanceof Error ? e.message : String(e) }; }
  });
  let steps = $derived(parsed.steps);
  let parseError = $derived(parsed.error);

  let pickerOpen = $state(false);
  let pickerQuery = $state("");
  let expanded = $state<number | null>(null);
  let newKey = $state<Record<number, string>>({});

  let pickable = $derived(ACTION_TYPES.all.filter(a => a.id !== "multi-action" && a.id !== "none"
    && (!pickerQuery.trim() || a.label.toLowerCase().includes(pickerQuery.trim().toLowerCase()) || a.id.includes(pickerQuery.trim().toLowerCase()))));
  let scenes = $derived(store.getScenes());

  function commit(next: MultiActionStep[]) { onchange(serializeSteps(next)); }
  function cloneSteps(): MultiActionStep[] { return steps.map(s => ({ ...s, settings: { ...s.settings } })); }

  function addStep(action: ActionDef) {
    const next = cloneSteps();
    const defaults = KNOWN[action.id]?.defaults ?? {};
    next.push({ actionId: action.id, actionLabel: action.label, settings: { ...defaults }, delayMs: 0 });
    commit(next);
    expanded = next.length - 1;
    pickerOpen = false;
    pickerQuery = "";
  }
  function removeStep(i: number) {
    const next = cloneSteps();
    next.splice(i, 1);
    if (expanded === i) expanded = null;
    commit(next);
  }
  function moveStep(i: number, dir: -1 | 1) {
    const j = i + dir;
    if (j < 0 || j >= steps.length) return;
    const next = cloneSteps();
    [next[i], next[j]] = [next[j], next[i]];
    if (expanded === i) expanded = j; else if (expanded === j) expanded = i;
    commit(next);
  }
  function setDelay(i: number, ms: number) {
    const next = cloneSteps();
    next[i].delayMs = Number.isFinite(ms) && ms > 0 ? Math.round(ms) : 0;
    commit(next);
  }
  function setSetting(i: number, key: string, val: string) {
    const next = cloneSteps();
    next[i].settings[key] = val;
    commit(next);
  }
  function replaceSettings(i: number, settings: Record<string, string>) {
    const next = cloneSteps();
    next[i].settings = { ...settings };
    commit(next);
  }
  function removeSetting(i: number, key: string) {
    const next = cloneSteps();
    delete next[i].settings[key];
    commit(next);
  }
  function renameSetting(i: number, oldKey: string, newName: string) {
    const name = newName.trim();
    if (!name || name === oldKey) return;
    const next = cloneSteps();
    const entries = Object.entries(next[i].settings).map(([k, v]) => [k === oldKey ? name : k, v] as [string, string]);
    next[i].settings = Object.fromEntries(entries);
    commit(next);
  }
  function addSetting(i: number) {
    const name = (newKey[i] ?? "").trim();
    if (!name || name in steps[i].settings) return;
    setSetting(i, name, "");
    newKey = { ...newKey, [i]: "" };
  }

  /** Keys covered by a dedicated control for this action (the rest show as generic rows). */
  function knownKeys(actionId: string): Set<string> {
    const keys = new Set((KNOWN[actionId]?.fields ?? []).map(f => f.key));
    if (actionId === "http-request") keys.add("method");
    if (actionId === "switch-scene") { keys.add("sceneId"); keys.add("mode"); }
    if (actionId === "ha-service") for (const k of HA_KEYS) keys.add(k);
    if (isExternalAction(actionId)) keys.add("pluginSettings");
    return keys;
  }
  function extraSettings(step: MultiActionStep): [string, string][] {
    const known = knownKeys(step.actionId);
    return Object.entries(step.settings).filter(([k]) => !known.has(k));
  }
  function actionFor(id: string): ActionDef | undefined { return ACTION_TYPES.all.find(a => a.id === id); }
  function sceneName(id: string): string { return scenes.find(s => s.id === id)?.name ?? "(missing scene)"; }
</script>

<div class="ma">
  {#if parseError}
    <div class="ma-error">{parseError}. Saving changes here replaces the stored steps.</div>
  {/if}

  <div class="ma-steps">
    {#each steps as step, i (i)}
      {@const def = actionFor(step.actionId)}
      <div class="ma-step">
        <div class="ma-step-head">
          <span class="ma-step-num">{i + 1}</span>
          <button class="ma-step-label" onclick={() => expanded = expanded === i ? null : i} title="Edit step settings">
            {#if def}<span style="color:{def.color};">{def.icon}</span>{/if}
            {step.actionLabel}
            {#if !def}<span class="ma-missing">(action unavailable)</span>{/if}
            {#if step.actionId === "switch-scene" && step.settings.sceneId}<span class="ma-sub">→ {sceneName(step.settings.sceneId)}</span>{/if}
          </button>
          <div class="ma-step-btns">
            <button class="ma-btn" onclick={() => moveStep(i, -1)} disabled={i === 0} title="Move up">&#x25B2;</button>
            <button class="ma-btn" onclick={() => moveStep(i, 1)} disabled={i === steps.length - 1} title="Move down">&#x25BC;</button>
            <button class="ma-btn danger" onclick={() => removeStep(i)} title="Remove step">×</button>
          </div>
        </div>

        {#if expanded === i}
          <div class="ma-settings">
            {#each KNOWN[step.actionId]?.fields ?? [] as f (f.key)}
              <div class="field-group"><span class="fl">{f.label}</span>
                {#if f.kind === "var"}
                  <VarInput value={step.settings[f.key] ?? ""} placeholder={f.placeholder} onchange={(v) => setSetting(i, f.key, v)} />
                {:else if f.kind === "varMulti"}
                  <VarInput value={step.settings[f.key] ?? ""} placeholder={f.placeholder} onchange={(v) => setSetting(i, f.key, v)} multiline={true} rows={3} />
                {:else if f.kind === "textarea"}
                  <textarea rows="3" value={step.settings[f.key] ?? ""} placeholder={f.placeholder} oninput={(e) => setSetting(i, f.key, (e.target as HTMLTextAreaElement).value)}></textarea>
                {:else if f.kind === "number"}
                  <input type="number" value={step.settings[f.key] ?? ""} oninput={(e) => setSetting(i, f.key, (e.target as HTMLInputElement).value)} />
                {:else}
                  <input type="text" value={step.settings[f.key] ?? ""} placeholder={f.placeholder} oninput={(e) => setSetting(i, f.key, (e.target as HTMLInputElement).value)} />
                {/if}
              </div>
            {/each}

            {#if step.actionId === "http-request"}
              <div class="mrow">{#each HTTP_METHODS as m}<button class:active={(step.settings.method || "POST") === m} onclick={() => setSetting(i, "method", m)}>{m}</button>{/each}</div>
            {:else if step.actionId === "switch-scene"}
              <div class="field-group"><span class="fl">Scene</span>
                <div class="chips">{#each scenes as scene (scene.id)}<button class="chip" class:active={step.settings.sceneId === scene.id} onclick={() => setSetting(i, "sceneId", scene.id)}>{scene.name}</button>{/each}</div>
                <div class="mrow">
                  <button class:active={(step.settings.mode || "push") === "push"} onclick={() => setSetting(i, "mode", "push")}>Push</button>
                  <button class:active={step.settings.mode === "switch"} onclick={() => setSetting(i, "mode", "switch")}>Switch</button>
                </div>
              </div>
            {:else if step.actionId === "ha-service"}
              <div class="field-group"><span class="fl">Entity</span>
                <HAEntityPicker settings={step.settings} onchange={(updated) => replaceSettings(i, { ...updated, ...(step.settings.ha_service_data && updated.ha_entity ? { ha_service_data: step.settings.ha_service_data } : {}) })} />
              </div>
              {#if step.settings.ha_attr}
                <div class="field-group"><span class="fl">Value for {step.settings.ha_attr}</span>
                  <VarInput value={step.settings.value ?? ""} placeholder="e.g. 128 or {'{{$var}}'}" onchange={(v) => setSetting(i, "value", v)} />
                </div>
              {/if}
            {/if}

            {#if isExternalAction(step.actionId)}
              <div class="field-group"><span class="fl">Plugin settings (JSON object)</span>
                <textarea rows="3" value={step.settings.pluginSettings ?? ""} placeholder={'{"key":"value"}'} oninput={(e) => setSetting(i, "pluginSettings", (e.target as HTMLTextAreaElement).value)}></textarea>
              </div>
            {/if}

            {#if extraSettings(step).length > 0 || !KNOWN[step.actionId]}
              <span class="fl">Other settings</span>
            {/if}
            {#each extraSettings(step) as [k, v] (k)}
              <div class="kv">
                <input class="kv-key" type="text" value={k} onchange={(e) => renameSetting(i, k, (e.target as HTMLInputElement).value)} />
                <input class="kv-val" type="text" value={v} oninput={(e) => setSetting(i, k, (e.target as HTMLInputElement).value)} />
                <button class="ma-btn danger" onclick={() => removeSetting(i, k)} title="Remove setting">×</button>
              </div>
            {/each}
            <div class="kv">
              <input class="kv-key" type="text" placeholder="new setting" value={newKey[i] ?? ""}
                oninput={(e) => newKey = { ...newKey, [i]: (e.target as HTMLInputElement).value }}
                onkeydown={(e) => { if (e.key === "Enter") addSetting(i); }} />
              <button class="ma-btn" onclick={() => addSetting(i)} disabled={!(newKey[i] ?? "").trim()}>+ Add</button>
            </div>
          </div>
        {/if}

        <div class="ma-step-delay">
          <label for="ma-delay-{i}">Delay after</label>
          <input id="ma-delay-{i}" type="number" value={step.delayMs} min="0" step="100" oninput={(e) => setDelay(i, parseInt((e.target as HTMLInputElement).value, 10))} />
          <span>ms</span>
        </div>
      </div>
    {/each}
  </div>

  {#if pickerOpen}
    <input class="search-in" type="text" bind:value={pickerQuery} placeholder="Search action..." />
    <div class="action-drop">
      {#each pickable as action (action.id)}
        <button onclick={() => addStep(action)}>
          <span style="color:{action.color};">{action.icon}</span> {action.label}
        </button>
      {/each}
      <button class="ma-cancel" onclick={() => { pickerOpen = false; pickerQuery = ""; }}>Cancel</button>
    </div>
  {:else}
    <button class="ma-add" onclick={() => { pickerOpen = true; pickerQuery = ""; }}>+ Add Step</button>
  {/if}
</div>

<style>
  .ma { display: flex; flex-direction: column; gap: 4px; }
  .ma-error { font-size: 11px; color: var(--danger); background: rgba(231,76,60,0.1); padding: 6px 8px; border-radius: var(--radius-sm); }
  .ma-steps { display: flex; flex-direction: column; gap: 4px; margin-bottom: 8px; }
  .ma-step { background: var(--bg-primary); border-radius: var(--radius-sm); padding: 8px; border: 1px solid var(--border); }
  .ma-step-head { display: flex; align-items: center; gap: 6px; }
  .ma-step-num { font-size: 10px; color: var(--text-muted); background: var(--bg-tertiary); width: 18px; height: 18px; border-radius: 50%; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
  .ma-step-label { flex: 1; font-size: 12px; color: var(--text-primary); text-align: left; cursor: pointer; display: flex; gap: 6px; align-items: center; min-width: 0; }
  .ma-step-label:hover { color: var(--accent); }
  .ma-sub { color: var(--text-muted); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .ma-missing { color: var(--danger); font-size: 10px; }
  .ma-step-btns { display: flex; gap: 2px; }
  .ma-btn { font-size: 10px; padding: 2px 5px; border-radius: 3px; background: var(--bg-tertiary); color: var(--text-muted); cursor: pointer; }
  .ma-btn:hover { color: var(--text-primary); }
  .ma-btn.danger:hover { color: var(--danger); }
  .ma-btn:disabled { opacity: 0.3; cursor: default; }
  .ma-settings { display: flex; flex-direction: column; gap: 6px; margin-top: 8px; padding-top: 8px; border-top: 1px solid var(--border); }
  .ma-step-delay { display: flex; align-items: center; gap: 4px; margin-top: 4px; }
  .ma-step-delay label { font-size: 10px; color: var(--text-muted); }
  .ma-step-delay input { width: 60px; padding: 2px 4px; font-size: 11px; border-radius: 3px; border: 1px solid var(--border); background: var(--bg-secondary); color: var(--text-primary); }
  .ma-step-delay span { font-size: 10px; color: var(--text-muted); }
  .ma-add { width: 100%; padding: 6px; border-radius: 4px; background: var(--bg-primary); color: var(--text-muted); font-size: 11px; cursor: pointer; text-align: center; border: 1px dashed var(--border); }
  .ma-add:hover { color: var(--accent); border-color: var(--accent); }
  .fl { display: block; font-size: 10px; text-transform: uppercase; letter-spacing: 0.5px; color: var(--text-muted); margin: 0; font-weight: 500; }
  .field-group { display: flex; flex-direction: column; gap: 4px; }
  .search-in { margin-top: 6px; }
  .action-drop { display: flex; flex-direction: column; gap: 1px; margin-top: 4px; max-height: 220px; overflow-y: auto; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--bg-secondary); }
  .action-drop button { display: flex; align-items: center; gap: 8px; padding: 8px 10px; font-size: 12px; color: var(--text-secondary); cursor: pointer; text-align: left; transition: background 0.1s; }
  .action-drop button:hover { background: var(--bg-tertiary); color: var(--text-primary); }
  .action-drop .ma-cancel { color: var(--text-muted); justify-content: center; }
  .mrow { display: flex; gap: 3px; }
  .mrow button { flex: 1; height: 26px; border-radius: var(--radius-sm); font-size: 11px; font-weight: 600; color: var(--text-muted); background: var(--bg-surface); border: 1px solid var(--border); cursor: pointer; transition: all 0.15s; }
  .mrow button:hover { color: var(--text-primary); border-color: var(--border-light); }
  .mrow button.active { background: var(--accent); color: white; border-color: var(--accent); }
  .chips { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 4px; }
  .chip { padding: 4px 9px; border-radius: 12px; font-size: 11px; color: var(--text-secondary); background: var(--bg-surface); border: 1px solid var(--border); cursor: pointer; transition: all 0.15s; }
  .chip:hover { color: var(--text-primary); border-color: var(--border-light); }
  .chip.active { color: white; background: var(--accent); border-color: var(--accent); }
  .kv { display: flex; gap: 4px; align-items: center; }
  .kv-key { width: 40%; }
  .kv-val { flex: 1; min-width: 0; }
</style>
