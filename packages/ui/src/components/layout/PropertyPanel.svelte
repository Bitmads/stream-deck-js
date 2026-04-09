<script lang="ts">
  import {
    getSelectedKeyIndex, getSelectedEncoderIndex, getKeyAssignment, updateKeySetting,
    setKeyImage, removeKeyImage, setKeyBackgroundColor, setKeyText, setKeyIcon, removeKeyIcon,
    clearKey, defaultTextConfig, assignAction, searchActions, getScenes, toggleFavorite, isFavorite,
    addKeyText, removeKeyText, getKeyTexts, togglePinned, isPinned,
    getEncoderConfig, setEncoderConfig, defaultEncoderConfig,
    getStripConfig, updateStripItem, removeStripItem, getSelectedStripItemId,
  } from "../../lib/stores/editor.svelte";
  import type { TextConfig, ActionDef, EncoderConfig, StripItem } from "../../lib/stores/editor.svelte";
  import TextConfigPanel from "../icon/TextConfig.svelte";
  import IconBrowser from "../icon/IconBrowser.svelte";
  import { ha } from "../../lib/plugins/homeassistant";
  import { resolveTemplate } from "../../lib/stores/variables.svelte";
  import { ACTION_TYPES } from "../../lib/stores/store.svelte";
  import type { MultiActionStep } from "../../lib/plugins/multi-action";
  import VarInput from "../input/VarInput.svelte";

  let selectedKey = $derived(getSelectedKeyIndex());
  let selectedEncoder = $derived(getSelectedEncoderIndex());
  let assignment = $derived(selectedKey !== null ? getKeyAssignment(selectedKey) : undefined);
  let encoderCfg = $derived(selectedEncoder !== null ? (getEncoderConfig(selectedEncoder) || defaultEncoderConfig()) : null);
  let texts = $derived(selectedKey !== null ? getKeyTexts(selectedKey) : []);
  let activeTextIndex = $state(0);
  let isEncoder = $derived(selectedEncoder !== null);
  let stripItemId = $derived(getSelectedStripItemId());
  let stripItem = $derived(() => {
    const id = stripItemId;
    if (!id) return null;
    return getStripConfig().items.find(it => it.id === id) || null;
  });
  let hasSelection = $derived(selectedKey !== null || selectedEncoder !== null || stripItemId !== null);

  let activeTab = $state<"appearance" | "action" | "icons">("appearance");
  let actionQuery = $state("");
  let actionResults = $derived(searchActions(actionQuery));
  let allScenes = $derived(getScenes());
  let actionPickerOpen = $state(false);

  // Encoder: which sub-section (rotate/press)
  let encoderTab = $state<"rotate" | "press">("rotate");
  let gesturePickerOpen = $state<"tap" | "longpress" | "swipe" | null>(null);

  // HA search
  let haEntityQuery = $state("");
  let haEntities = $derived(ha.searchEntities(haEntityQuery));

  // Multi-action
  let maStepPicker = $state<number | null>(null); // index of step being edited, or -1 for new
  let maStepQuery = $state("");
  let maStepResults = $derived(searchActions(maStepQuery));

  function getMultiSteps(a: any): MultiActionStep[] {
    try { return a?.settings?.steps ? JSON.parse(a.settings.steps) : []; } catch { return []; }
  }
  function saveMultiSteps(steps: MultiActionStep[]) {
    handleSettingChange("steps", JSON.stringify(steps));
  }
  function addMultiStep(action: ActionDef) {
    const steps = getMultiSteps(assignment);
    steps.push({ actionId: action.id, actionLabel: action.label, settings: {}, delayMs: 0 });
    saveMultiSteps(steps);
    maStepPicker = null;
    maStepQuery = "";
  }
  function removeMultiStep(idx: number) {
    const steps = getMultiSteps(assignment);
    steps.splice(idx, 1);
    saveMultiSteps(steps);
  }
  function updateMultiStepDelay(idx: number, ms: number) {
    const steps = getMultiSteps(assignment);
    if (steps[idx]) { steps[idx].delayMs = ms; saveMultiSteps(steps); }
  }
  function moveMultiStep(idx: number, dir: -1 | 1) {
    const steps = getMultiSteps(assignment);
    const newIdx = idx + dir;
    if (newIdx < 0 || newIdx >= steps.length) return;
    [steps[idx], steps[newIdx]] = [steps[newIdx], steps[idx]];
    saveMultiSteps(steps);
  }

  // Force Action tab when encoder is selected
  $effect(() => {
    if (isEncoder) activeTab = "action";
    actionPickerOpen = false;
  });

  function handleImageUpload(e: Event) {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file || selectedKey === null) return;
    const reader = new FileReader();
    reader.onload = () => { if (typeof reader.result === "string" && selectedKey !== null) setKeyImage(selectedKey, reader.result, file.name); };
    reader.readAsDataURL(file);
  }
  function handleColorChange(e: Event) { if (selectedKey !== null) setKeyBackgroundColor(selectedKey, (e.target as HTMLInputElement).value); }
  function handleTextChange(config: TextConfig, index: number = activeTextIndex) { if (selectedKey !== null) setKeyText(selectedKey, config, index); }
  function handleAddText() {
    if (selectedKey === null) return;
    const newIdx = texts.length; // index of the about-to-be-added text
    addKeyText(selectedKey);
    // Use setTimeout to ensure derived updates before we set the index
    setTimeout(() => { activeTextIndex = newIdx; }, 0);
  }
  function handleRemoveText(index: number) { if (selectedKey === null) return; removeKeyText(selectedKey, index); if (activeTextIndex >= texts.length - 1) activeTextIndex = Math.max(0, texts.length - 2); }
  function handleIconSelect(setId: string, name: string, body: string, viewBox: string, color: string, size: number) { if (selectedKey !== null) setKeyIcon(selectedKey, { setId, iconName: name, svgBody: body, color, size, viewBox }); }
  function handleIconStyleChange(color: string, size: number) { if (selectedKey === null || !assignment?.icon) return; setKeyIcon(selectedKey, { ...assignment.icon, color, size }); }
  function handleClear() { if (selectedKey !== null) clearKey(selectedKey); }
  function handleSettingChange(key: string, value: string) { if (selectedKey !== null) updateKeySetting(selectedKey, key, value); }
  function handleAssignAction(action: ActionDef) { if (selectedKey !== null) { assignAction(selectedKey, action); actionQuery = ""; actionPickerOpen = false; } }
  function handleEncoderUpdate(partial: Partial<EncoderConfig>) { if (selectedEncoder === null || !encoderCfg) return; setEncoderConfig(selectedEncoder, { ...encoderCfg, ...partial }); }

  // Encoder action helpers
  function getEncAction(): ActionDef | undefined { return encoderTab === "rotate" ? encoderCfg?.rotateAction : encoderCfg?.pressAction; }
  function getEncSettings(): Record<string, string> { return (encoderTab === "rotate" ? encoderCfg?.rotateSettings : encoderCfg?.pressSettings) || {}; }
  function setEncAction(action: ActionDef) {
    if (encoderTab === "rotate") handleEncoderUpdate({ rotateAction: action, rotateSettings: {} });
    else handleEncoderUpdate({ pressAction: action, pressSettings: {} });
    actionPickerOpen = false;
  }
  function updateEncSettings(s: Record<string, string>) {
    if (encoderTab === "rotate") handleEncoderUpdate({ rotateSettings: s });
    else handleEncoderUpdate({ pressSettings: s });
  }
</script>

<aside class="pp">
  <div class="pp-header">
    <h3>{stripItemId ? 'Strip Item' : selectedKey !== null ? `Key ${selectedKey}` : selectedEncoder !== null ? `Encoder ${selectedEncoder}` : 'Properties'}</h3>
    {#if assignment}
      <button class="pp-clear" onclick={handleClear}>Clear</button>
    {/if}
  </div>

  {#if stripItemId && stripItem()}
    <!-- ═══ STRIP ITEM ═══ -->
    {@const si = stripItem()}
    <div class="pp-tabs">
      <button class:active={activeTab === "appearance"} onclick={() => { activeTab = "appearance"; gesturePickerOpen = null; }}>Look</button>
      <button class:active={activeTab === "icons"} onclick={() => { activeTab = "icons"; gesturePickerOpen = null; }}>Icons</button>
      <button class:active={activeTab === "action"} onclick={() => { activeTab = "action"; gesturePickerOpen = null; }}>Action</button>
    </div>
    <div class="pp-body">
      {#if activeTab === "appearance"}
        <label class="fl">Position & Size</label>
        <div class="ef-row" style="margin-bottom:6px;">
          <div class="ef sm"><label>X</label><input type="number" value={si.x} oninput={(e) => updateStripItem(si.id, { x: Number((e.target as HTMLInputElement).value) })} /></div>
          <div class="ef sm"><label>Y</label><input type="number" value={si.y} oninput={(e) => updateStripItem(si.id, { y: Number((e.target as HTMLInputElement).value) })} /></div>
          <div class="ef sm"><label>W</label><input type="number" value={si.w} oninput={(e) => updateStripItem(si.id, { w: Number((e.target as HTMLInputElement).value) })} /></div>
          <div class="ef sm"><label>H</label><input type="number" value={si.h} oninput={(e) => updateStripItem(si.id, { h: Number((e.target as HTMLInputElement).value) })} /></div>
        </div>
        <label class="fl">Background</label>
        <div class="color-row">
          <input type="color" value={resolveTemplate(si.backgroundColor || '#000000').startsWith('#') ? resolveTemplate(si.backgroundColor || '#000000') : '#000000'} oninput={(e) => updateStripItem(si.id, { backgroundColor: (e.target as HTMLInputElement).value })} />
          <input type="text" value={si.backgroundColor || ''} placeholder={'#333 or {{$var|rgb}}'} oninput={(e) => updateStripItem(si.id, { backgroundColor: (e.target as HTMLInputElement).value })} />
        </div>
        <label class="fl">Image</label>
        {#if si.imageDataUrl}
          <div class="img-row"><img src={si.imageDataUrl} alt="" style="width:100px;height:50px;border-radius:4px;" /><button class="sm-btn danger" onclick={() => updateStripItem(si.id, { imageDataUrl: undefined })}>Remove</button></div>
        {:else}
          <label class="sm-btn">Upload<input type="file" accept="image/*" onchange={(e) => { const f=(e.target as HTMLInputElement).files?.[0]; if(!f)return; const r=new FileReader(); r.onload=()=>{if(typeof r.result==="string") updateStripItem(si.id,{imageDataUrl:r.result})}; r.readAsDataURL(f); }} hidden /></label>
        {/if}
        {#if si.icon}
          <label class="fl">Icon</label>
          <div class="img-row"><button class="icon-thumb" onclick={() => activeTab="icons"}><svg viewBox={si.icon.viewBox} width="32" height="32" fill="none" stroke={si.icon.color} stroke-width="2" stroke-linecap="round" stroke-linejoin="round">{@html si.icon.svgBody}</svg></button><span class="icon-name">{si.icon.iconName}</span><button class="sm-btn danger" onclick={() => updateStripItem(si.id, { icon: undefined })}>Remove</button></div>
        {/if}
        <label class="fl">Bar Indicator</label>
        {#if si.bar}
          <div class="act-settings">
            <div class="ef-row">
              <div class="ef sm"><label>Value</label><input type="text" value={si.bar.value} placeholder={'{{$var}}'} oninput={(e) => updateStripItem(si.id, { bar: { ...si.bar!, value: (e.target as HTMLInputElement).value } })} /></div>
              <div class="ef sm"><label>Min</label><input type="text" value={si.bar.min} placeholder="0" oninput={(e) => updateStripItem(si.id, { bar: { ...si.bar!, min: (e.target as HTMLInputElement).value } })} /></div>
              <div class="ef sm"><label>Max</label><input type="text" value={si.bar.max} placeholder="255" oninput={(e) => updateStripItem(si.id, { bar: { ...si.bar!, max: (e.target as HTMLInputElement).value } })} /></div>
            </div>
            <div class="color-row">
              <input type="color" value={resolveTemplate(si.bar.color || '#03a9f4').startsWith('#') ? resolveTemplate(si.bar.color || '#03a9f4') : '#03a9f4'} oninput={(e) => updateStripItem(si.id, { bar: { ...si.bar!, color: (e.target as HTMLInputElement).value } })} />
              <input type="text" value={si.bar.color || '#03a9f4'} placeholder={'color or {{$var|rgb}}'} oninput={(e) => updateStripItem(si.id, { bar: { ...si.bar!, color: (e.target as HTMLInputElement).value } })} />
            </div>
            <div class="mrow">
              <button class:active={si.bar.position === "bottom" || !si.bar.position} onclick={() => updateStripItem(si.id, { bar: { ...si.bar!, position: "bottom" } })}>Bottom</button>
              <button class:active={si.bar.position === "full"} onclick={() => updateStripItem(si.id, { bar: { ...si.bar!, position: "full" } })}>Full</button>
            </div>
            <button class="sm-btn danger" onclick={() => updateStripItem(si.id, { bar: undefined })}>Remove bar</button>
          </div>
        {:else}
          <button class="sm-btn" onclick={() => updateStripItem(si.id, { bar: { value: "50", min: "0", max: "100", color: "#03a9f4", position: "bottom", height: 8 } })}>+ Add bar</button>
        {/if}

        <div class="text-section">
          <div class="text-head"><label class="fl" style="margin:0;">Text</label><button class="add-circle" onclick={() => { const ts=si.texts?[...si.texts]:[]; ts.push({text:"",fontFamily:"sans-serif",fontSize:16,fontWeight:"normal",fontStyle:"normal",color:"#ffffff",hAlign:"center",vAlign:"middle",anchor:"center",useAbsolutePos:false}); updateStripItem(si.id,{texts:ts}); }}>+</button></div>
          {#if si.texts && si.texts.length > 0}
            <div class="text-chips">{#each si.texts as t,i}<button class="text-chip" class:active={activeTextIndex===i} onclick={() => activeTextIndex=i}>{t.text ? resolveTemplate(t.text).substring(0,8)||`${i+1}` : `${i+1}`}{#if si.texts && si.texts.length>1}<span class="del-x" onclick={(e)=>{e.stopPropagation(); updateStripItem(si.id,{texts:si.texts!.filter((_:any,j:number)=>j!==i)})}}>×</span>{/if}</button>{/each}</div>
            {#if si.texts[activeTextIndex]}<TextConfigPanel config={si.texts[activeTextIndex]} onChange={(c) => { const ts=[...(si.texts||[])]; ts[activeTextIndex]=c; updateStripItem(si.id,{texts:ts}); }} />{/if}
          {/if}
        </div>
        <button class="sm-btn danger" style="margin-top:10px;" onclick={() => removeStripItem(si.id)}>Delete Item</button>

      {:else if activeTab === "icons"}
        <IconBrowser onSelect={(setId, name, body, viewBox, color, size) => updateStripItem(si.id, { icon: { setId, iconName: name, svgBody: body, color, size, viewBox } })} onStyleChange={(color, size) => { if (si.icon) updateStripItem(si.id, { icon: { ...si.icon, color, size } }); }} currentColor={si.icon?.color} currentSize={si.icon?.size} />

      {:else if activeTab === "action"}
        {#each [
          { key: "tap", label: "On Tap", actionField: "tapAction", settingsField: "tapSettings", hint: "Passes ratio (0-1) based on tap x-position within item." },
          { key: "longpress", label: "On Long Press", actionField: "longPressAction", settingsField: "longPressSettings", hint: "" },
          { key: "swipe", label: "On Swipe", actionField: "swipeAction", settingsField: "swipeSettings", hint: "Passes from_ratio, to_ratio, direction, distance." }
        ] as gesture}
          {@const currentAction = (si as any)[gesture.actionField]}
          <label class="fl">{gesture.label}</label>
          <button class="action-sel" onclick={() => gesturePickerOpen = gesturePickerOpen === gesture.key ? null : gesture.key}>
            {#if currentAction && currentAction.id !== "none"}
              <span style="color:{currentAction.color};">{currentAction.icon}</span> {currentAction.label}
            {:else}
              <span class="sel-none">None</span>
            {/if}
            <span class="sel-arrow">{gesturePickerOpen === gesture.key ? '▲' : '▼'}</span>
          </button>
          {#if gesturePickerOpen === gesture.key}
            <div class="action-drop">
              {#each searchActions("") as action}
                <button class:active={currentAction?.id === action.id} onclick={() => { updateStripItem(si.id, { [gesture.actionField]: action, [gesture.settingsField]: {} }); gesturePickerOpen = null; }}>
                  <span style="color:{action.color};">{action.icon}</span> {action.label}
                </button>
              {/each}
            </div>
          {:else if currentAction?.id === "ha-service"}
            {@const gs = ((si as any)[gesture.settingsField] || {}) as Record<string, string>}
            <div class="enc-settings">
              {#if gs.ha_entity}
                <div class="ha-chip"><span>{ha.getEntity(gs.ha_entity)?.friendly_name || gs.ha_entity}</span><button onclick={() => updateStripItem(si.id, { [gesture.settingsField]: {} })}>×</button></div>
                {@const ctrls = ha.getEntityControls(gs.ha_entity)}
                {@const svcs = ha.getEntityServices(gs.ha_entity)}
                {#if ctrls.length > 0}
                  <label class="fl">Control</label>
                  <div class="chips">{#each ctrls as c}<button class="chip" class:active={gs.ha_control===c.id} onclick={() => { ha.addWatch(gs.ha_entity); updateStripItem(si.id, { [gesture.settingsField]: {...gs, ha_domain:c.domain, ha_service:c.service, ha_control:c.id, ha_attr:c.attr} }); }}>{c.label}</button>{/each}</div>
                {/if}
                {#if svcs.length > 0}
                  <label class="fl">Service</label>
                  <div class="chips">{#each svcs as s}<button class="chip" class:active={gs.ha_service===s.service && !gs.ha_attr} onclick={() => updateStripItem(si.id, { [gesture.settingsField]: {...gs, ha_domain:s.domain, ha_service:s.service, ha_control:s.service, ha_attr:""} })}>{s.name}</button>{/each}</div>
                {/if}
              {:else}
                <input type="text" bind:value={haEntityQuery} placeholder="Search entity..." />
                {#if haEntityQuery.length > 0}
                  <div class="ent-list">{#each haEntities as ent}<button onclick={() => { updateStripItem(si.id, { [gesture.settingsField]: {ha_entity:ent.entity_id} }); haEntityQuery=""; }}><span>{ent.friendly_name}</span><span class="ent-d">{ent.domain}</span></button>{/each}</div>
                {/if}
              {/if}
            </div>
          {:else if currentAction?.id === "http-request"}
            {@const gs = ((si as any)[gesture.settingsField] || {}) as Record<string, string>}
            <div class="enc-settings">
              <input type="text" value={gs.url || ''} placeholder="URL..." oninput={(e) => updateStripItem(si.id, { [gesture.settingsField]: {...gs, url: (e.target as HTMLInputElement).value} })} />
              <div class="mrow">{#each ["GET","POST","PUT","DELETE"] as m}<button class:active={(gs.method||'POST')===m} onclick={() => updateStripItem(si.id, { [gesture.settingsField]: {...gs, method:m} })}>{m}</button>{/each}</div>
              <textarea value={gs.body || ''} placeholder={'{"key":"val"}'} oninput={(e) => updateStripItem(si.id, { [gesture.settingsField]: {...gs, body: (e.target as HTMLTextAreaElement).value} })} rows="2"></textarea>
            </div>
          {:else if currentAction?.id === "command"}
            {@const gs = ((si as any)[gesture.settingsField] || {}) as Record<string, string>}
            <input type="text" value={gs.command || ''} placeholder="command..." oninput={(e) => updateStripItem(si.id, { [gesture.settingsField]: {...gs, command: (e.target as HTMLInputElement).value} })} />
          {/if}
          {#if gesture.hint && currentAction?.id !== "none"}<span class="hint-text">{gesture.hint}</span>{/if}
        {/each}
      {/if}
    </div>

  {:else if !hasSelection}
    <div class="pp-body"><p class="pp-empty">Select a key, encoder, or strip item</p></div>
  {:else}
    <!-- Tab bar: hide Look/Icons for encoders -->
    <div class="pp-tabs">
      {#if !isEncoder}
        <button class:active={activeTab === "appearance"} onclick={() => activeTab = "appearance"}>Look</button>
        <button class:active={activeTab === "icons"} onclick={() => activeTab = "icons"}>Icons</button>
      {/if}
      <button class:active={activeTab === "action"} onclick={() => activeTab = "action"}>Action</button>
    </div>

    <div class="pp-body">
      <!-- ═══ ACTION TAB ═══ -->
      {#if activeTab === "action"}

        <!-- Encoder fields (only for encoders) -->
        {#if isEncoder && encoderCfg}
          <div class="enc-fields">
            <div class="ef"><label>Label</label><input type="text" value={encoderCfg.label} oninput={(e) => handleEncoderUpdate({ label: (e.target as HTMLInputElement).value })} placeholder="e.g. Brightness" /></div>
            <div class="ef"><label>Value</label><input type="text" value={encoderCfg.value} placeholder={'50 or {{$ha.entity.attr}}'} oninput={(e) => handleEncoderUpdate({ value: (e.target as HTMLInputElement).value })} /></div>
            <div class="ef-row">
              <div class="ef sm"><label>Min</label><input type="text" value={encoderCfg.min} placeholder="0" oninput={(e) => handleEncoderUpdate({ min: (e.target as HTMLInputElement).value })} /></div>
              <div class="ef sm"><label>Max</label><input type="text" value={encoderCfg.max} placeholder="255" oninput={(e) => handleEncoderUpdate({ max: (e.target as HTMLInputElement).value })} /></div>
              <div class="ef tiny"><label>Step</label><input type="number" value={encoderCfg.step} oninput={(e) => handleEncoderUpdate({ step: Number((e.target as HTMLInputElement).value) })} /></div>
            </div>
          </div>

          <!-- Rotate / Press toggle -->
          <div class="enc-toggle">
            <button class:active={encoderTab === "rotate"} onclick={() => { encoderTab = "rotate"; actionPickerOpen = false; }}>
              Rotate {#if encoderCfg.rotateAction.id !== "none"}<span class="enc-dot"></span>{/if}
            </button>
            <button class:active={encoderTab === "press"} onclick={() => { encoderTab = "press"; actionPickerOpen = false; }}>
              Press {#if encoderCfg.pressAction.id !== "none"}<span class="enc-dot"></span>{/if}
            </button>
          </div>

          <!-- Encoder action selector -->
          {@const ea = getEncAction()}
          {@const es = getEncSettings()}
          <button class="action-sel" onclick={() => actionPickerOpen = !actionPickerOpen}>
            {#if ea && ea.id !== "none"}
              <span style="color:{ea.color};">{ea.icon}</span> {ea.label}
            {:else}
              <span class="sel-none">Select action...</span>
            {/if}
            <span class="sel-arrow">{actionPickerOpen ? '▲' : '▼'}</span>
          </button>

          {#if actionPickerOpen}
            <div class="action-drop">
              {#each searchActions("") as action}
                <button class:active={ea?.id === action.id} onclick={() => setEncAction(action)}>
                  <span style="color:{action.color};">{action.icon}</span> {action.label}
                </button>
              {/each}
            </div>
          {/if}

          <!-- Encoder action settings -->
          {#if ea && ea.id !== "none" && !actionPickerOpen}
            <div class="act-settings">
              {#if ea.id === "http-request"}
                <input type="text" value={es.url || ''} placeholder="URL..." oninput={(e) => updateEncSettings({ ...es, url: (e.target as HTMLInputElement).value })} />
                <div class="mrow">{#each ["GET","POST","PUT","DELETE"] as m}<button class:active={(es.method||'POST')===m} onclick={() => updateEncSettings({...es,method:m})}>{m}</button>{/each}</div>
                <textarea value={es.body || ''} placeholder={'{"key":"val"}'} oninput={(e) => updateEncSettings({...es, body: (e.target as HTMLTextAreaElement).value})} rows="2"></textarea>
              {:else if ea.id === "ha-service"}
                {#if es.ha_entity}
                  <div class="ha-chip"><span>{ha.getEntity(es.ha_entity)?.friendly_name || es.ha_entity}</span><button onclick={() => updateEncSettings({})}>×</button></div>
                  {@const controls = ha.getEntityControls(es.ha_entity)}
                  {@const services = ha.getEntityServices(es.ha_entity)}
                  {#if encoderTab === "rotate" && controls.length > 0}
                    <label class="fl">Control</label>
                    <div class="chips">{#each controls as c}<button class="chip" class:active={es.ha_control===c.id} onclick={() => { ha.addWatch(es.ha_entity); updateEncSettings({...es, ha_domain:c.domain, ha_service:c.service, ha_control:c.id, ha_attr:c.attr}); if(c.attr && encoderCfg) handleEncoderUpdate({value:`{{$ha.${es.ha_entity}.${c.attr}}}`, min:String(c.min), max:String(c.max), step:c.step}); }}>{c.label}</button>{/each}</div>
                  {/if}
                  {#if services.length > 0}
                    <label class="fl">Service</label>
                    <div class="chips">{#each services as s}<button class="chip" class:active={es.ha_service===s.service && !es.ha_attr} onclick={() => updateEncSettings({...es, ha_domain:s.domain, ha_service:s.service, ha_control:s.service, ha_attr:""})}>{s.name}</button>{/each}</div>
                  {/if}
                {:else}
                  <input type="text" bind:value={haEntityQuery} placeholder="Search entity..." />
                  {#if haEntityQuery.length > 0}
                    <div class="ent-list">{#each haEntities as ent}<button onclick={() => { updateEncSettings({ha_entity:ent.entity_id}); haEntityQuery=""; }}><span>{ent.friendly_name}</span><span class="ent-d">{ent.domain}</span></button>{/each}</div>
                  {/if}
                {/if}
              {:else if ea.id === "command"}
                <input type="text" value={es.command||''} placeholder="command..." oninput={(e) => updateEncSettings({...es, command:(e.target as HTMLInputElement).value})} />
              {/if}
            </div>
          {/if}

        <!-- Key action (non-encoder) -->
        {:else if assignment !== undefined}
          <button class="action-sel" onclick={() => actionPickerOpen = !actionPickerOpen}>
            {#if assignment.action.id !== "none"}
              <span style="color:{assignment.action.color};">{assignment.action.icon}</span> {assignment.action.label}
            {:else}
              <span class="sel-none">Select action...</span>
            {/if}
            <span class="sel-arrow">{actionPickerOpen ? '▲' : '▼'}</span>
          </button>

          {#if actionPickerOpen}
            <input class="search-in" type="text" bind:value={actionQuery} placeholder="Search..." />
            <div class="action-drop">
              {#each actionResults as action}
                <button class:active={assignment.action.id === action.id} onclick={() => handleAssignAction(action)}>
                  <span style="color:{action.color};">{action.icon}</span> {action.label}
                  <span class="fav" class:active={isFavorite(action.id)} onclick={(e) => { e.stopPropagation(); toggleFavorite(action.id); }}>{isFavorite(action.id) ? '★' : '☆'}</span>
                </button>
              {/each}
            </div>
          {/if}

          {#if assignment.action.id !== "none" && !actionPickerOpen}
            <div class="act-settings">
              {#if assignment.action.id === "command"}
                <label class="fl">Command</label>
                <VarInput value={assignment.settings.command||''} placeholder="e.g. firefox" onchange={(v) => handleSettingChange('command', v)} />
              {:else if assignment.action.id === "hotkey"}
                <label class="fl">Key</label>
                <input type="text" value={assignment.settings.key||''} placeholder="e.g. F5" oninput={(e) => handleSettingChange('key', (e.target as HTMLInputElement).value)} />
                <label class="fl">Modifiers</label>
                <input type="text" value={assignment.settings.modifiers||''} placeholder="ctrl, shift" oninput={(e) => handleSettingChange('modifiers', (e.target as HTMLInputElement).value)} />
              {:else if assignment.action.id === "launch"}
                <label class="fl">Application</label>
                <VarInput value={assignment.settings.target||''} placeholder="firefox" onchange={(v) => handleSettingChange('target', v)} />
              {:else if assignment.action.id === "open-url"}
                <label class="fl">URL</label>
                <VarInput value={assignment.settings.url||''} placeholder="https://..." onchange={(v) => handleSettingChange('url', v)} />
              {:else if assignment.action.id === "http-request"}
                <label class="fl">URL</label>
                <VarInput value={assignment.settings.url||''} placeholder="http://..." onchange={(v) => handleSettingChange('url', v)} />
                <div class="mrow">{#each ["GET","POST","PUT","DELETE"] as m}<button class:active={(assignment.settings.method||'POST')===m} onclick={() => handleSettingChange('method',m)}>{m}</button>{/each}</div>
                <label class="fl">Headers</label>
                <textarea value={assignment.settings.headers||''} placeholder="Key: Value" oninput={(e) => handleSettingChange('headers', (e.target as HTMLTextAreaElement).value)} rows="2"></textarea>
                <label class="fl">Body</label>
                <VarInput value={assignment.settings.body||''} placeholder={'{"key":"val"}'} onchange={(v) => handleSettingChange('body', v)} multiline={true} rows={3} />
              {:else if assignment.action.id === "switch-scene"}
                <label class="fl">Scene</label>
                <div class="chips">{#each allScenes as scene}<button class="chip" class:active={assignment.settings.sceneId===scene.id} onclick={() => handleSettingChange('sceneId',scene.id)}>{scene.name}</button>{/each}</div>
                <div class="mrow" style="margin-top:4px;"><button class:active={(assignment.settings.mode||'push')==='push'} onclick={() => handleSettingChange('mode','push')}>Push</button><button class:active={assignment.settings.mode==='switch'} onclick={() => handleSettingChange('mode','switch')}>Switch</button></div>
              {:else if assignment.action.id === "timer"}
                <label class="fl">Duration (sec)</label>
                <input type="number" value={assignment.settings.duration||'60'} oninput={(e) => handleSettingChange('duration', (e.target as HTMLInputElement).value)} />
              {:else if assignment.action.id === "counter"}
                <label class="fl">Start value</label>
                <input type="number" value={assignment.settings.value||'0'} oninput={(e) => handleSettingChange('value', (e.target as HTMLInputElement).value)} />
              {:else if assignment.action.id === "ha-service"}
                {#if assignment.settings.ha_entity}
                  <div class="ha-chip"><span>{ha.getEntity(assignment.settings.ha_entity)?.friendly_name || assignment.settings.ha_entity}</span><button onclick={() => { handleSettingChange('ha_entity', ''); handleSettingChange('ha_domain', ''); handleSettingChange('ha_service', ''); handleSettingChange('ha_attr', ''); handleSettingChange('ha_control', ''); }}>×</button></div>
                  {@const ctrls = ha.getEntityControls(assignment.settings.ha_entity)}
                  {@const svcs = ha.getEntityServices(assignment.settings.ha_entity)}
                  {#if ctrls.length > 0}
                    <label class="fl">Control</label>
                    <div class="chips">{#each ctrls as c}<button class="chip" class:active={assignment.settings.ha_control===c.id} onclick={() => { ha.addWatch(assignment.settings.ha_entity); handleSettingChange('ha_domain', c.domain); handleSettingChange('ha_service', c.service); handleSettingChange('ha_control', c.id); handleSettingChange('ha_attr', c.attr); }}>{c.label}</button>{/each}</div>
                  {/if}
                  {#if svcs.length > 0}
                    <label class="fl">Service</label>
                    <div class="chips">{#each svcs as s}<button class="chip" class:active={assignment.settings.ha_service===s.service && !assignment.settings.ha_attr} onclick={() => { handleSettingChange('ha_domain', s.domain); handleSettingChange('ha_service', s.service); handleSettingChange('ha_control', s.service); handleSettingChange('ha_attr', ''); }}>{s.name}</button>{/each}</div>
                  {/if}
                {:else}
                  <input type="text" bind:value={haEntityQuery} placeholder="Search entity..." />
                  {#if haEntityQuery.length > 0}
                    <div class="ent-list">{#each haEntities as ent}<button onclick={() => { handleSettingChange('ha_entity', ent.entity_id); haEntityQuery = ""; }}><span>{ent.friendly_name}</span><span class="ent-d">{ent.domain}</span></button>{/each}</div>
                  {/if}
                {/if}
              {:else if assignment.action.id === "ha-custom"}
                <label class="fl">Custom JSON</label>
                <textarea value={assignment.settings.ha_custom_json||''} placeholder={'{"domain":"light","service":"toggle","target":{"entity_id":"light.living_room"}}'} oninput={(e) => handleSettingChange('ha_custom_json', (e.target as HTMLTextAreaElement).value)} rows="4"></textarea>
              {:else if assignment.action.id === "multi-action"}
                {@const steps = getMultiSteps(assignment)}
                <div class="ma-steps">
                  {#each steps as step, i}
                    <div class="ma-step">
                      <div class="ma-step-head">
                        <span class="ma-step-num">{i + 1}</span>
                        <span class="ma-step-label">{step.actionLabel}</span>
                        <div class="ma-step-btns">
                          <button class="ma-btn" onclick={() => moveMultiStep(i, -1)} disabled={i === 0}>&#x25B2;</button>
                          <button class="ma-btn" onclick={() => moveMultiStep(i, 1)} disabled={i === steps.length - 1}>&#x25BC;</button>
                          <button class="ma-btn danger" onclick={() => removeMultiStep(i)}>×</button>
                        </div>
                      </div>
                      <div class="ma-step-delay">
                        <label>Delay after</label>
                        <input type="number" value={step.delayMs} min="0" step="100" oninput={(e) => updateMultiStepDelay(i, parseInt((e.target as HTMLInputElement).value) || 0)} />
                        <span>ms</span>
                      </div>
                    </div>
                  {/each}
                </div>
                {#if maStepPicker !== null}
                  <input class="search-in" type="text" bind:value={maStepQuery} placeholder="Search action..." />
                  <div class="action-drop">
                    {#each maStepResults.filter(a => a.id !== "multi-action") as action}
                      <button onclick={() => addMultiStep(action)}>
                        <span style="color:{action.color};">{action.icon}</span> {action.label}
                      </button>
                    {/each}
                  </div>
                {:else}
                  <button class="ma-add" onclick={() => { maStepPicker = -1; maStepQuery = ""; }}>+ Add Step</button>
                {/if}
              {/if}
            </div>
          {/if}
        {/if}

      <!-- ═══ LOOK TAB ═══ -->
      {:else if activeTab === "appearance" && !isEncoder}
        <button class="pin-btn" class:pinned={selectedKey !== null && isPinned(selectedKey)} onclick={() => { if (selectedKey !== null) togglePinned(selectedKey); }}>
          <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="17" x2="12" y2="22"/><path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z"/></svg>
          {selectedKey !== null && isPinned(selectedKey) ? 'Pinned' : 'Pin'}
        </button>
        <label class="fl">Background</label>
        <div class="color-row"><input type="color" value={assignment?.backgroundColor||"#000000"} oninput={handleColorChange} /><input type="text" value={assignment?.backgroundColor||"#000000"} oninput={handleColorChange} /></div>
        <label class="fl">Image</label>
        {#if assignment?.imageDataUrl}
          <div class="img-row"><img src={assignment.imageDataUrl} alt="" /><label class="sm-btn">Change<input type="file" accept="image/*" onchange={handleImageUpload} hidden /></label><button class="sm-btn danger" onclick={() => { if (selectedKey !== null) removeKeyImage(selectedKey); }}>Remove</button></div>
        {:else}<label class="sm-btn">Upload<input type="file" accept="image/*" onchange={handleImageUpload} hidden /></label>{/if}
        {#if assignment?.icon}
          <label class="fl">Icon</label>
          <div class="img-row"><button class="icon-thumb" onclick={() => activeTab="icons"}><svg viewBox={assignment.icon.viewBox} width="32" height="32" fill="none" stroke={assignment.icon.color} stroke-width="2" stroke-linecap="round" stroke-linejoin="round">{@html assignment.icon.svgBody}</svg></button><span class="icon-name">{assignment.icon.iconName}</span><button class="sm-btn danger" onclick={() => { if (selectedKey !== null) removeKeyIcon(selectedKey); }}>Remove</button></div>
        {/if}
        <div class="text-section">
          <div class="text-head"><label class="fl" style="margin:0;">Text</label><button class="add-circle" onclick={handleAddText}>+</button></div>
          {#if texts.length > 0}
            <div class="text-chips">
              {#each texts as t, i}
                <button class="text-chip" class:active={activeTextIndex===i} class:dim={t.hidden} onclick={() => activeTextIndex=i}>
                  <svg class="eye-icon" onclick={(e) => { e.stopPropagation(); handleTextChange({...t, hidden:!t.hidden}, i); }} viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" stroke-width="2">
                    {#if t.hidden}<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/>
                    {:else}<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>{/if}
                  </svg>
                  {t.text ? resolveTemplate(t.text).substring(0, 8) || `${i+1}` : `${i+1}`}
                  {#if texts.length > 1}
                    <span class="del-x" onclick={(e) => { e.stopPropagation(); handleRemoveText(i); }}>×</span>
                  {/if}
                </button>
              {/each}
            </div>
            {#if texts[activeTextIndex]}<TextConfigPanel config={texts[activeTextIndex]} onChange={(c) => handleTextChange(c, activeTextIndex)} />{/if}
          {:else}<button class="add-text-btn" onclick={handleAddText}>+ Add text</button>{/if}
        </div>

      <!-- ═══ ICONS TAB ═══ -->
      {:else if activeTab === "icons" && !isEncoder}
        <IconBrowser onSelect={handleIconSelect} onStyleChange={handleIconStyleChange} currentColor={assignment?.icon?.color} currentSize={assignment?.icon?.size} />
      {/if}
    </div>
  {/if}
</aside>

<style>
  .pp { width: 300px; min-width: 300px; background: var(--bg-secondary); border-left: 1px solid var(--border); display: flex; flex-direction: column; }
  .pp-header { padding: 8px 12px; border-bottom: 1px solid var(--border); display: flex; align-items: center; justify-content: space-between; flex-shrink: 0; }
  .pp-header h3 { font-size: 13px; font-weight: 600; color: var(--text-secondary); margin: 0; }
  .pp-clear { font-size: 10px; color: var(--danger); padding: 2px 6px; border-radius: 4px; cursor: pointer; }
  .pp-clear:hover { background: rgba(231,76,60,0.12); }
  .pp-tabs { display: flex; border-bottom: 1px solid var(--border); flex-shrink: 0; }
  .pp-tabs button { flex: 1; padding: 6px; font-size: 11px; color: var(--text-muted); cursor: pointer; text-align: center; border-bottom: 2px solid transparent; }
  .pp-tabs button:hover { color: var(--text-primary); }
  .pp-tabs button.active { color: var(--accent); border-bottom-color: var(--accent); }
  .pp-body { padding: 10px; overflow-y: auto; flex: 1; min-height: 0; }
  .pp-empty { font-size: 12px; color: var(--text-muted); text-align: center; margin-top: 24px; }
  .fl { display: block; font-size: 10px; text-transform: uppercase; letter-spacing: 0.3px; color: var(--text-muted); margin: 8px 0 3px; }
  .fl:first-child { margin-top: 0; }
  input[type="text"], input[type="number"], textarea { width: 100%; padding: 6px 8px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg-primary); color: var(--text-primary); font-size: 11px; outline: none; box-sizing: border-box; }
  input:focus, textarea:focus { border-color: var(--accent); }
  textarea { resize: vertical; font-family: monospace; font-size: 10px; }
  .search-in { margin-top: 4px; }
  .action-sel { display: flex; align-items: center; gap: 6px; width: 100%; padding: 7px 10px; border-radius: 6px; border: 1px solid var(--border); background: var(--bg-primary); cursor: pointer; font-size: 12px; color: var(--text-primary); }
  .action-sel:hover { border-color: var(--accent); }
  .sel-none { color: var(--text-muted); }
  .sel-arrow { margin-left: auto; font-size: 8px; color: var(--text-muted); }
  .action-drop { display: flex; flex-direction: column; gap: 1px; margin-top: 4px; max-height: 200px; overflow-y: auto; border: 1px solid var(--border); border-radius: 6px; background: var(--bg-primary); }
  .action-drop button { display: flex; align-items: center; gap: 6px; padding: 6px 8px; font-size: 11px; color: var(--text-secondary); cursor: pointer; text-align: left; }
  .action-drop button:hover { background: var(--bg-tertiary); color: var(--text-primary); }
  .action-drop button.active { color: var(--accent); background: var(--bg-tertiary); }
  .fav { margin-left: auto; font-size: 11px; color: var(--text-muted); cursor: pointer; }
  .fav:hover, .fav.active { color: var(--warning); }
  .act-settings { margin-top: 8px; display: flex; flex-direction: column; gap: 2px; }
  .mrow { display: flex; gap: 2px; }
  .mrow button { flex: 1; padding: 4px; border-radius: 4px; font-size: 10px; font-weight: 600; color: var(--text-muted); background: var(--bg-primary); border: 1px solid var(--border); cursor: pointer; }
  .mrow button:hover { color: var(--text-primary); }
  .mrow button.active { background: var(--accent); color: white; border-color: var(--accent); }
  .chips { display: flex; flex-wrap: wrap; gap: 3px; margin-top: 2px; }
  .chip { padding: 3px 8px; border-radius: 10px; font-size: 10px; color: var(--text-muted); background: var(--bg-primary); border: 1px solid var(--border); cursor: pointer; }
  .chip:hover { color: var(--text-primary); border-color: var(--text-muted); }
  .chip.active { color: white; background: var(--accent); border-color: var(--accent); }
  /* Encoder */
  .enc-fields { display: flex; flex-direction: column; gap: 4px; margin-bottom: 8px; }
  .ef { display: flex; flex-direction: column; gap: 2px; }
  .ef label { font-size: 9px; text-transform: uppercase; color: var(--text-muted); letter-spacing: 0.3px; }
  .ef-row { display: flex; gap: 4px; }
  .ef.sm { flex: 1; }
  .ef.tiny { width: 50px; flex-shrink: 0; }
  .enc-toggle { display: flex; border: 1px solid var(--border); border-radius: 6px; overflow: hidden; margin-bottom: 8px; }
  .enc-toggle button { flex: 1; padding: 7px 4px; font-size: 11px; color: var(--text-muted); cursor: pointer; text-align: center; position: relative; }
  .enc-toggle button { border-right: 1px solid var(--border); }
  .enc-toggle button:last-child { border-right: none; }
  .enc-toggle button.active { background: var(--bg-tertiary); color: var(--text-primary); }
  .enc-dot { display: inline-block; width: 6px; height: 6px; border-radius: 50%; background: var(--accent); margin-left: 4px; vertical-align: middle; }
  /* HA */
  .ha-chip { display: flex; align-items: center; justify-content: space-between; padding: 5px 8px; background: var(--bg-tertiary); border-radius: 6px; font-size: 11px; color: var(--accent); margin-bottom: 4px; }
  .ha-chip button { font-size: 14px; color: var(--text-muted); cursor: pointer; line-height: 1; }
  .ha-chip button:hover { color: var(--danger); }
  .ent-list { display: flex; flex-direction: column; gap: 1px; margin-top: 4px; max-height: 150px; overflow-y: auto; border: 1px solid var(--border); border-radius: 6px; }
  .ent-list button { display: flex; justify-content: space-between; padding: 5px 8px; font-size: 11px; color: var(--text-secondary); cursor: pointer; }
  .ent-list button:hover { background: var(--bg-tertiary); color: var(--text-primary); }
  .ent-d { font-size: 9px; color: var(--text-muted); }
  /* Look tab */
  .color-row { display: flex; gap: 6px; align-items: center; }
  .color-row input[type="color"] { width: 28px; height: 28px; border: none; border-radius: 5px; cursor: pointer; padding: 0; flex-shrink: 0; }
  .color-row input[type="text"] { flex: 1; font-family: monospace; }
  .img-row { display: flex; align-items: center; gap: 6px; margin-top: 4px; }
  .img-row img { width: 48px; height: 48px; border-radius: 6px; object-fit: cover; border: 1px solid var(--border); }
  .sm-btn { display: inline-block; padding: 3px 8px; border-radius: 4px; background: var(--bg-tertiary); color: var(--text-secondary); font-size: 10px; cursor: pointer; }
  .sm-btn:hover { background: var(--accent); color: white; }
  .sm-btn.danger { background: rgba(231,76,60,0.1); color: var(--danger); }
  .sm-btn.danger:hover { background: rgba(231,76,60,0.25); }
  .icon-thumb { background: var(--bg-primary); border-radius: 6px; padding: 4px; cursor: pointer; border: 1px solid var(--border); display: flex; }
  .icon-thumb:hover { border-color: var(--accent); }
  .icon-name { font-size: 10px; color: var(--text-muted); flex: 1; }
  .pin-btn { display: flex; align-items: center; gap: 4px; padding: 4px 8px; border-radius: 4px; font-size: 10px; color: var(--text-muted); background: var(--bg-primary); border: 1px solid var(--border); cursor: pointer; margin-bottom: 6px; }
  .pin-btn:hover { border-color: var(--accent); }
  .pin-btn.pinned { color: var(--warning); border-color: var(--warning); background: rgba(243,156,18,0.06); }
  .text-section { margin-top: 4px; }
  .text-head { display: flex; align-items: center; justify-content: space-between; }
  .add-circle { width: 18px; height: 18px; border-radius: 50%; background: var(--accent); color: white; font-size: 12px; font-weight: 700; cursor: pointer; display: flex; align-items: center; justify-content: center; border: none; }
  .text-chips { display: flex; gap: 2px; margin: 4px 0 6px; flex-wrap: wrap; }
  .text-chip { padding: 2px 6px; border-radius: 4px; font-size: 10px; color: var(--text-muted); background: var(--bg-primary); border: 1px solid var(--border); cursor: pointer; display: flex; align-items: center; gap: 3px; }
  .text-chip:hover { border-color: var(--text-muted); }
  .text-chip.active { color: var(--accent); border-color: var(--accent); }
  .text-chip.dim { opacity: 0.4; }
  .eye-icon { cursor: pointer; flex-shrink: 0; }
  .eye-icon:hover { opacity: 0.7; }
  .del-x { font-size: 11px; color: var(--text-muted); cursor: pointer; margin-left: 1px; line-height: 1; }
  .del-x:hover { color: var(--danger); }
  .add-text-btn { width: 100%; padding: 6px; border-radius: 4px; background: var(--bg-primary); color: var(--text-muted); font-size: 11px; cursor: pointer; text-align: center; border: 1px dashed var(--border); }
  .add-text-btn:hover { color: var(--accent); border-color: var(--accent); }
  .hint-text { font-size: 9px; color: var(--text-muted); margin-top: 6px; display: block; line-height: 1.4; }

  .ma-steps { display: flex; flex-direction: column; gap: 4px; margin-bottom: 8px; }
  .ma-step { background: var(--bg-primary); border-radius: var(--radius-sm); padding: 8px; border: 1px solid var(--border); }
  .ma-step-head { display: flex; align-items: center; gap: 6px; }
  .ma-step-num { font-size: 10px; color: var(--text-muted); background: var(--bg-tertiary); width: 18px; height: 18px; border-radius: 50%; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
  .ma-step-label { flex: 1; font-size: 12px; color: var(--text-primary); }
  .ma-step-btns { display: flex; gap: 2px; }
  .ma-btn { font-size: 10px; padding: 2px 5px; border-radius: 3px; background: var(--bg-tertiary); color: var(--text-muted); cursor: pointer; }
  .ma-btn:hover { color: var(--text-primary); }
  .ma-btn.danger:hover { color: var(--danger); }
  .ma-btn:disabled { opacity: 0.3; cursor: default; }
  .ma-step-delay { display: flex; align-items: center; gap: 4px; margin-top: 4px; }
  .ma-step-delay label { font-size: 10px; color: var(--text-muted); }
  .ma-step-delay input { width: 60px; padding: 2px 4px; font-size: 11px; border-radius: 3px; border: 1px solid var(--border); background: var(--bg-secondary); color: var(--text-primary); }
  .ma-step-delay span { font-size: 10px; color: var(--text-muted); }
  .ma-add { width: 100%; padding: 6px; border-radius: 4px; background: var(--bg-primary); color: var(--text-muted); font-size: 11px; cursor: pointer; text-align: center; border: 1px dashed var(--border); }
  .ma-add:hover { color: var(--accent); border-color: var(--accent); }
</style>
