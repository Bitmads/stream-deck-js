<script lang="ts">
  import {
    getSelectedKeyIndex, getSelectedEncoderIndex, getKeyAssignment, setKeySettings,
    setKeyImage, removeKeyImage, setKeyImageUrl, setKeyImageFit, setKeyBackgroundColor, setKeyText, setKeyIcon, removeKeyIcon,
    clearKey, assignAction, searchActions, toggleFavorite, isFavorite,
    addKeyText, removeKeyText, getKeyTexts, togglePinned, isPinned, isPinnedOverlay,
    getKeyIcons, addKeyIcon, removeKeyIconAt,
    getEncoderConfig, setEncoderConfig, defaultEncoderConfig, getDefaultSettings,
    getStripConfig, updateStripItem, removeStripItem, getSelectedStripItemId,
  } from "../../lib/stores/editor.svelte";
  import type { TextConfig, ActionDef, EncoderConfig, StripItem, IconConfig } from "../../lib/stores/editor.svelte";
  import TextConfigPanel from "../icon/TextConfig.svelte";
  import IconBrowser from "../icon/IconBrowser.svelte";
  import ActionSettingsEditor from "../input/ActionSettingsEditor.svelte";
  import { resolveTemplate } from "../../lib/stores/variables.svelte";
  import VarInput from "../input/VarInput.svelte";
  import { iconToSvg } from "../../lib/utils/icon-svg";

  const uid = $props.id();
  /** Image URLs are fetched as you type; wait for a pause first. */
  const URL_DEBOUNCE_MS = 500;
  const FIT_OPTIONS: { v: NonNullable<StripItem["imageFit"]>; l: string }[] = [
    { v: "fill", l: "Stretch" },
    { v: "cover", l: "Cover" },
    { v: "contain", l: "Fit" },
    { v: "none", l: "Original" },
  ];

  let selectedKey = $derived(getSelectedKeyIndex());
  let selectedEncoder = $derived(getSelectedEncoderIndex());
  let assignment = $derived(selectedKey !== null ? getKeyAssignment(selectedKey) : undefined);
  let pinnedOverlay = $derived(selectedKey !== null && assignment ? isPinnedOverlay(selectedKey) : false);
  let encoderCfg = $derived(selectedEncoder !== null ? (getEncoderConfig(selectedEncoder) || defaultEncoderConfig()) : null);
  let texts = $derived(selectedKey !== null ? getKeyTexts(selectedKey) : []);
  let activeTextIndex = $state(0);
  let icons = $derived(selectedKey !== null ? getKeyIcons(selectedKey) : []);
  let activeIconIndex = $state(0);
  let isEncoder = $derived(selectedEncoder !== null);
  let stripItemId = $derived(getSelectedStripItemId());
  let stripItem = $derived.by(() => {
    const id = stripItemId;
    if (!id) return null;
    return getStripConfig().items.find(it => it.id === id) || null;
  });
  let hasSelection = $derived(selectedKey !== null || selectedEncoder !== null || stripItemId !== null);

  let activeTab = $state<"appearance" | "action" | "icons">("appearance");
  let actionQuery = $state("");
  let actionResults = $derived(searchActions(actionQuery));
  let actionPickerOpen = $state(false);

  // Collapsible sections
  let showBackground = $state(true);
  let showText = $state(true);
  let showIcon = $state(true);

  // Encoder: which sub-section (rotate/press)
  let encoderTab = $state<"rotate" | "press">("rotate");
  let gesturePickerOpen = $state<"tap" | "longpress" | "swipe" | null>(null);

  // Selection changed: start at the first label/icon layer of the new key or strip item.
  $effect(() => {
    void selectedKey;
    void selectedEncoder;
    void stripItemId;
    activeTextIndex = 0;
    activeIconIndex = 0;
    actionPickerOpen = false;
    gesturePickerOpen = null;
  });

  // Force Action tab when encoder is selected
  $effect(() => {
    if (isEncoder) activeTab = "action";
  });

  function iconPreview(ic: Pick<IconConfig, "svgBody" | "viewBox" | "color">, px: number): string {
    return iconToSvg(ic, ic.color || "#ffffff", px);
  }

  function readFile(e: Event, done: (dataUrl: string, name: string) => void) {
    const input = e.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => { if (typeof reader.result === "string") done(reader.result, file.name); };
    reader.readAsDataURL(file);
    input.value = "";
  }

  function handleImageUpload(e: Event) {
    const key = selectedKey;
    if (key === null) return;
    readFile(e, (dataUrl, name) => setKeyImage(key, dataUrl, name));
  }
  function handleColorChange(e: Event) { if (selectedKey !== null) setKeyBackgroundColor(selectedKey, (e.currentTarget as HTMLInputElement).value); }
  function handleTextChange(config: TextConfig, index: number = activeTextIndex) { if (selectedKey !== null) setKeyText(selectedKey, config, index); }
  function handleAddText() {
    if (selectedKey === null) return;
    const newIdx = texts.length; // index of the about-to-be-added text
    addKeyText(selectedKey);
    activeTextIndex = newIdx;
  }
  function handleRemoveText(index: number) {
    if (selectedKey === null) return;
    removeKeyText(selectedKey, index);
    if (activeTextIndex >= texts.length - 1) activeTextIndex = Math.max(0, texts.length - 2);
  }
  function handleIconSelect(setId: string, name: string, body: string, viewBox: string, color: string, size: number) {
    if (selectedKey === null) return;
    const existing = icons[activeIconIndex];
    setKeyIcon(selectedKey, { setId, iconName: name, svgBody: body, color, size, viewBox, variable: existing?.variable, value: existing?.value }, activeIconIndex);
  }
  function handleIconStyleChange(color: string, size: number) {
    if (selectedKey === null) return;
    const ic = icons[activeIconIndex];
    if (!ic) return;
    setKeyIcon(selectedKey, { ...ic, color, size }, activeIconIndex);
  }
  function handleAddIcon() {
    if (selectedKey === null) return;
    const newIdx = icons.length;
    addKeyIcon(selectedKey);
    activeIconIndex = newIdx;
  }
  function handleRemoveIconAt(index: number) {
    if (selectedKey === null) return;
    removeKeyIconAt(selectedKey, index);
    if (activeIconIndex >= icons.length - 1) activeIconIndex = Math.max(0, icons.length - 2);
  }
  function handleIconConditionChange(field: "variable" | "value", val: string) {
    if (selectedKey === null) return;
    const ic = icons[activeIconIndex];
    if (!ic) return;
    setKeyIcon(selectedKey, { ...ic, [field]: val }, activeIconIndex);
  }
  function handleClear() { if (selectedKey !== null) clearKey(selectedKey); }
  function handleKeySettings(next: Record<string, string>) { if (selectedKey !== null) setKeySettings(selectedKey, next); }
  function handleAssignAction(action: ActionDef) {
    if (selectedKey === null) return;
    assignAction(selectedKey, action);
    actionQuery = "";
    actionPickerOpen = false;
  }
  function handleEncoderUpdate(partial: Partial<EncoderConfig>) {
    if (selectedEncoder === null || !encoderCfg) return;
    setEncoderConfig(selectedEncoder, { ...encoderCfg, ...partial });
  }

  // Encoder action helpers
  let encAction = $derived(encoderTab === "rotate" ? encoderCfg?.rotateAction : encoderCfg?.pressAction);
  let encSettings = $derived((encoderTab === "rotate" ? encoderCfg?.rotateSettings : encoderCfg?.pressSettings) || {});
  function setEncAction(action: ActionDef) {
    const settings = getDefaultSettings(action.id);
    if (encoderTab === "rotate") handleEncoderUpdate({ rotateAction: action, rotateSettings: settings });
    else handleEncoderUpdate({ pressAction: action, pressSettings: settings });
    actionPickerOpen = false;
  }
  function updateEncSettings(s: Record<string, string>) {
    if (encoderTab === "rotate") handleEncoderUpdate({ rotateSettings: s });
    else handleEncoderUpdate({ pressSettings: s });
  }

  // Strip gestures
  type GestureKey = "tap" | "longpress" | "swipe";
  const GESTURES: { key: GestureKey; label: string; actionField: "tapAction" | "longPressAction" | "swipeAction"; settingsField: "tapSettings" | "longPressSettings" | "swipeSettings"; hint: string }[] = [
    { key: "tap", label: "On Tap", actionField: "tapAction", settingsField: "tapSettings", hint: "Passes ratio (0-1) based on tap x-position within item." },
    { key: "longpress", label: "On Long Press", actionField: "longPressAction", settingsField: "longPressSettings", hint: "" },
    { key: "swipe", label: "On Swipe", actionField: "swipeAction", settingsField: "swipeSettings", hint: "Passes from_ratio, to_ratio, direction, distance." },
  ];

  function setGestureAction(si: StripItem, g: typeof GESTURES[number], action: ActionDef) {
    updateStripItem(si.id, { [g.actionField]: action, [g.settingsField]: getDefaultSettings(action.id) });
    gesturePickerOpen = null;
  }

  function addStripText(si: StripItem) {
    const ts = si.texts ? [...si.texts] : [];
    ts.push({ text: "", fontFamily: "sans-serif", fontSize: 16, fontWeight: "normal", fontStyle: "normal", color: "#ffffff", hAlign: "center", vAlign: "middle", anchor: "center", useAbsolutePos: false });
    updateStripItem(si.id, { texts: ts });
    activeTextIndex = ts.length - 1;
  }

  function removeStripText(si: StripItem, index: number) {
    const ts = (si.texts || []).filter((_, j) => j !== index);
    updateStripItem(si.id, { texts: ts });
    if (activeTextIndex >= ts.length) activeTextIndex = Math.max(0, ts.length - 1);
  }

  function colorInputValue(template: string | undefined, fallback: string): string {
    const v = resolveTemplate(template || fallback);
    return /^#[0-9a-f]{6}$/i.test(v) ? v : fallback;
  }
</script>

<aside class="pp">
  <div class="pp-header">
    <h3>{stripItemId ? 'Strip Item' : selectedKey !== null ? `Key ${selectedKey}` : selectedEncoder !== null ? `Encoder ${selectedEncoder}` : 'Properties'}</h3>
    {#if assignment && !stripItemId}
      <button class="pp-clear" onclick={handleClear}>Clear</button>
    {/if}
  </div>

  {#if stripItemId && stripItem}
    <!-- ═══ STRIP ITEM ═══ -->
    {@const si = stripItem}
    <div class="pp-tabs">
      <button class:active={activeTab === "appearance"} onclick={() => { activeTab = "appearance"; gesturePickerOpen = null; }}>Look</button>
      <button class:active={activeTab === "icons"} onclick={() => { activeTab = "icons"; gesturePickerOpen = null; }}>Icons</button>
      <button class:active={activeTab === "action"} onclick={() => { activeTab = "action"; gesturePickerOpen = null; }}>Action</button>
    </div>
    <div class="pp-body">
      {#if activeTab === "appearance"}
        <span class="fl">Position & Size</span>
        <div class="ef-row" style="margin-bottom:6px;">
          <div class="ef sm"><label for="{uid}-sx">X</label><input id="{uid}-sx" type="number" value={si.x} oninput={(e) => updateStripItem(si.id, { x: Number(e.currentTarget.value) })} /></div>
          <div class="ef sm"><label for="{uid}-sy">Y</label><input id="{uid}-sy" type="number" value={si.y} oninput={(e) => updateStripItem(si.id, { y: Number(e.currentTarget.value) })} /></div>
          <div class="ef sm"><label for="{uid}-sw">W</label><input id="{uid}-sw" type="number" value={si.w} oninput={(e) => updateStripItem(si.id, { w: Number(e.currentTarget.value) })} /></div>
          <div class="ef sm"><label for="{uid}-sh">H</label><input id="{uid}-sh" type="number" value={si.h} oninput={(e) => updateStripItem(si.id, { h: Number(e.currentTarget.value) })} /></div>
        </div>
        <label class="fl" for="{uid}-sbg">Background</label>
        <div class="color-row">
          <input type="color" aria-label="Background color picker" value={colorInputValue(si.backgroundColor, '#000000')} oninput={(e) => updateStripItem(si.id, { backgroundColor: e.currentTarget.value })} />
          <input id="{uid}-sbg" type="text" value={si.backgroundColor || ''} placeholder={'#333 or {{$var|rgb}}'} oninput={(e) => updateStripItem(si.id, { backgroundColor: e.currentTarget.value })} />
        </div>
        <span class="fl">Image</span>
        {#if si.imageDataUrl}
          <div class="img-row"><img src={si.imageDataUrl} alt="" style="width:100px;height:50px;border-radius:4px;object-fit:{si.imageFit || 'fill'};" /><button class="sm-btn danger" onclick={() => updateStripItem(si.id, { imageDataUrl: undefined })}>Remove</button></div>
        {:else}
          <label class="sm-btn">Upload<input type="file" accept="image/*" onchange={(e) => readFile(e, (dataUrl) => updateStripItem(si.id, { imageDataUrl: dataUrl }))} hidden /></label>
        {/if}
        <label class="fl" for="{uid}-surl">Image URL <span class="hint-inline">supports {"{{$var}}"}</span></label>
        <VarInput id="{uid}-surl" value={si.imageUrl || ''} placeholder={"https://... or {{$ha.media_player...}}"} debounceMs={URL_DEBOUNCE_MS} onchange={(v) => updateStripItem(si.id, { imageUrl: v || undefined })} />
        {#if si.imageDataUrl || si.imageUrl}
          <span class="fl">Fit</span>
          <div class="mrow" role="group" aria-label="Image fit">
            {#each FIT_OPTIONS as opt}
              <button class:active={(si.imageFit || "fill") === opt.v} onclick={() => updateStripItem(si.id, { imageFit: opt.v })}>{opt.l}</button>
            {/each}
          </div>
        {/if}
        {#if si.icon}
          <span class="fl">Icon</span>
          <div class="img-row">
            <button class="icon-thumb" onclick={() => activeTab = "icons"} aria-label="Change icon">{@html iconPreview(si.icon, 32)}</button>
            <span class="icon-name">{si.icon.iconName}</span>
            <button class="sm-btn danger" onclick={() => updateStripItem(si.id, { icon: undefined })}>Remove</button>
          </div>
        {/if}
        <span class="fl">Bar Indicator</span>
        {#if si.bar}
          {@const bar = si.bar}
          <div class="act-settings">
            <div class="ef-row">
              <div class="ef sm"><label for="{uid}-bv">Value</label><input id="{uid}-bv" type="text" value={bar.value} placeholder={'{{$var}}'} oninput={(e) => updateStripItem(si.id, { bar: { ...bar, value: e.currentTarget.value } })} /></div>
              <div class="ef sm"><label for="{uid}-bmin">Min</label><input id="{uid}-bmin" type="text" value={bar.min} placeholder="0" oninput={(e) => updateStripItem(si.id, { bar: { ...bar, min: e.currentTarget.value } })} /></div>
              <div class="ef sm"><label for="{uid}-bmax">Max</label><input id="{uid}-bmax" type="text" value={bar.max} placeholder="255" oninput={(e) => updateStripItem(si.id, { bar: { ...bar, max: e.currentTarget.value } })} /></div>
            </div>
            <div class="color-row">
              <input type="color" aria-label="Bar color picker" value={colorInputValue(bar.color, '#03a9f4')} oninput={(e) => updateStripItem(si.id, { bar: { ...bar, color: e.currentTarget.value } })} />
              <input type="text" aria-label="Bar color" value={bar.color || '#03a9f4'} placeholder={'color or {{$var|rgb}}'} oninput={(e) => updateStripItem(si.id, { bar: { ...bar, color: e.currentTarget.value } })} />
            </div>
            <div class="mrow" role="group" aria-label="Bar position">
              <button class:active={bar.position === "bottom" || !bar.position} onclick={() => updateStripItem(si.id, { bar: { ...bar, position: "bottom" } })}>Bottom</button>
              <button class:active={bar.position === "left"} onclick={() => updateStripItem(si.id, { bar: { ...bar, position: "left" } })}>Left</button>
              <button class:active={bar.position === "full"} onclick={() => updateStripItem(si.id, { bar: { ...bar, position: "full" } })}>Full</button>
            </div>
            {#if bar.position !== "full"}
              <div class="ef tiny-row"><label for="{uid}-bh">Thickness</label><input id="{uid}-bh" type="number" min="1" max="100" value={bar.height || 8} oninput={(e) => updateStripItem(si.id, { bar: { ...bar, height: Number(e.currentTarget.value) || 8 } })} /></div>
            {/if}
            <button class="sm-btn danger" onclick={() => updateStripItem(si.id, { bar: undefined })}>Remove bar</button>
          </div>
        {:else}
          <button class="sm-btn" onclick={() => updateStripItem(si.id, { bar: { value: "50", min: "0", max: "100", color: "#03a9f4", position: "bottom", height: 8 } })}>+ Add bar</button>
        {/if}

        <div class="text-section">
          <div class="text-head"><span class="fl">Text</span><button class="add-circle" onclick={() => addStripText(si)} aria-label="Add text layer">+</button></div>
          {#if si.texts && si.texts.length > 0}
            <div class="text-chips">
              {#each si.texts as t, i}
                <div class="text-chip" class:active={activeTextIndex === i}>
                  <button class="text-chip-label" onclick={() => activeTextIndex = i}>{t.text ? resolveTemplate(t.text).substring(0, 8) || `${i + 1}` : `${i + 1}`}</button>
                  {#if si.texts.length > 1}
                    <button class="del-x" onclick={() => removeStripText(si, i)} aria-label="Remove text {i + 1}">×</button>
                  {/if}
                </div>
              {/each}
            </div>
            {#if si.texts[activeTextIndex]}
              <TextConfigPanel config={si.texts[activeTextIndex]} onChange={(c) => { const ts = [...(si.texts || [])]; ts[activeTextIndex] = c; updateStripItem(si.id, { texts: ts }); }} />
            {/if}
          {/if}
        </div>
        <button class="sm-btn danger" style="margin-top:10px;" onclick={() => removeStripItem(si.id)}>Delete Item</button>

      {:else if activeTab === "icons"}
        <IconBrowser onSelect={(setId, name, body, viewBox, color, size) => updateStripItem(si.id, { icon: { setId, iconName: name, svgBody: body, color, size, viewBox } })} onStyleChange={(color, size) => { if (si.icon) updateStripItem(si.id, { icon: { ...si.icon, color, size } }); }} currentColor={si.icon?.color} currentSize={si.icon?.size} />

      {:else if activeTab === "action"}
        {#each GESTURES as gesture}
          {@const currentAction = si[gesture.actionField]}
          {@const gs = si[gesture.settingsField] || {}}
          <span class="fl">{gesture.label}</span>
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
              {#each searchActions("") as action (action.id)}
                <button class:active={currentAction?.id === action.id} onclick={() => setGestureAction(si, gesture, action)}>
                  <span style="color:{action.color};">{action.icon}</span> {action.label}
                </button>
              {/each}
            </div>
          {:else if currentAction && currentAction.id !== "none"}
            <div class="enc-settings">
              <ActionSettingsEditor actionId={currentAction.id} settings={gs} onchange={(updated) => updateStripItem(si.id, { [gesture.settingsField]: updated })} />
            </div>
            {#if gesture.hint}<span class="hint-text">{gesture.hint}</span>{/if}
          {/if}
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
      {#if pinnedOverlay}
        <p class="pin-note">Pinned from another scene: edits change the pinned key everywhere it shows.</p>
      {/if}
      <!-- ═══ ACTION TAB ═══ -->
      {#if activeTab === "action"}

        <!-- Encoder fields (only for encoders) -->
        {#if isEncoder && encoderCfg}
          {@const cfg = encoderCfg}
          <div class="enc-fields">
            <div class="ef"><label for="{uid}-elabel">Label</label><input id="{uid}-elabel" type="text" value={cfg.label} oninput={(e) => handleEncoderUpdate({ label: e.currentTarget.value })} placeholder="e.g. Brightness" /></div>
            <div class="ef"><label for="{uid}-evalue">Value</label><input id="{uid}-evalue" type="text" value={cfg.value} placeholder={'50 or {{$ha.entity.attr}}'} oninput={(e) => handleEncoderUpdate({ value: e.currentTarget.value })} /></div>
            <div class="ef-row">
              <div class="ef sm"><label for="{uid}-emin">Min</label><input id="{uid}-emin" type="text" value={cfg.min} placeholder="0" oninput={(e) => handleEncoderUpdate({ min: e.currentTarget.value })} /></div>
              <div class="ef sm"><label for="{uid}-emax">Max</label><input id="{uid}-emax" type="text" value={cfg.max} placeholder="255" oninput={(e) => handleEncoderUpdate({ max: e.currentTarget.value })} /></div>
              <div class="ef tiny"><label for="{uid}-estep">Step</label><input id="{uid}-estep" type="number" value={cfg.step} oninput={(e) => handleEncoderUpdate({ step: Number(e.currentTarget.value) })} /></div>
            </div>
          </div>

          <!-- Rotate / Press toggle -->
          <div class="enc-toggle">
            <button class:active={encoderTab === "rotate"} onclick={() => { encoderTab = "rotate"; actionPickerOpen = false; }}>
              Rotate {#if cfg.rotateAction.id !== "none"}<span class="enc-dot"></span>{/if}
            </button>
            <button class:active={encoderTab === "press"} onclick={() => { encoderTab = "press"; actionPickerOpen = false; }}>
              Press {#if cfg.pressAction.id !== "none"}<span class="enc-dot"></span>{/if}
            </button>
          </div>

          <!-- Encoder action selector -->
          <button class="action-sel" onclick={() => actionPickerOpen = !actionPickerOpen}>
            {#if encAction && encAction.id !== "none"}
              <span style="color:{encAction.color};">{encAction.icon}</span> {encAction.label}
            {:else}
              <span class="sel-none">Select action...</span>
            {/if}
            <span class="sel-arrow">{actionPickerOpen ? '▲' : '▼'}</span>
          </button>

          {#if actionPickerOpen}
            <div class="action-drop">
              {#each searchActions("") as action (action.id)}
                <button class:active={encAction?.id === action.id} onclick={() => setEncAction(action)}>
                  <span style="color:{action.color};">{action.icon}</span> {action.label}
                </button>
              {/each}
            </div>
          {:else if encAction && encAction.id !== "none"}
            <div class="act-settings">
              <ActionSettingsEditor
                actionId={encAction.id}
                settings={encSettings}
                onchange={updateEncSettings}
                oncontrolselect={(c) => { if (encoderTab === "rotate" && (c.readAttr ?? c.attr)) handleEncoderUpdate({ value: `{{$ha.${encSettings.ha_entity}.${c.readAttr ?? c.attr}}}`, min: String(c.min), max: String(c.max), step: c.step }); }}
              />
            </div>
          {/if}

        <!-- Key action (non-encoder) -->
        {:else if selectedKey !== null}
          <button class="action-sel" onclick={() => actionPickerOpen = !actionPickerOpen}>
            {#if assignment && assignment.action.id !== "none"}
              <span style="color:{assignment.action.color};">{assignment.action.icon}</span> {assignment.action.label}
            {:else}
              <span class="sel-none">Select action...</span>
            {/if}
            <span class="sel-arrow">{actionPickerOpen ? '▲' : '▼'}</span>
          </button>

          {#if actionPickerOpen}
            <input class="search-in" type="text" aria-label="Search actions" bind:value={actionQuery} placeholder="Search..." />
            <div class="action-drop">
              {#each actionResults as action (action.id)}
                <div class="action-opt" class:active={assignment?.action.id === action.id}>
                  <button class="action-opt-main" onclick={() => handleAssignAction(action)}>
                    <span style="color:{action.color};">{action.icon}</span> {action.label}
                  </button>
                  <button class="fav" class:active={isFavorite(action.id)} onclick={() => toggleFavorite(action.id)}
                    aria-label="{isFavorite(action.id) ? 'Remove' : 'Add'} {action.label} {isFavorite(action.id) ? 'from' : 'to'} favorites">{isFavorite(action.id) ? '★' : '☆'}</button>
                </div>
              {/each}
            </div>
          {/if}

          {#if assignment && assignment.action.id !== "none" && !actionPickerOpen}
            <div class="act-settings">
              <ActionSettingsEditor actionId={assignment.action.id} settings={assignment.settings} onchange={handleKeySettings} />
            </div>
          {/if}
        {/if}

      <!-- ═══ LOOK TAB ═══ -->
      {:else if activeTab === "appearance" && !isEncoder}
        <button class="pin-btn" class:pinned={selectedKey !== null && isPinned(selectedKey)} onclick={() => { if (selectedKey !== null) togglePinned(selectedKey); }}>
          <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="17" x2="12" y2="22"/><path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z"/></svg>
          {selectedKey !== null && isPinned(selectedKey) ? 'Pinned' : 'Pin'}
        </button>

        <!-- Background & Image -->
        <button class="section-toggle" onclick={() => showBackground = !showBackground}>
          <span>Background & Image</span>
          <span class="section-arrow" class:open={showBackground}></span>
        </button>
        {#if showBackground}
          <div class="section-body">
            <div class="field-group">
              <label class="fl" for="{uid}-kbg">Background</label>
              <div class="color-row">
                <input type="color" aria-label="Background color picker" value={colorInputValue(assignment?.backgroundColor, "#000000")} oninput={handleColorChange} />
                <input id="{uid}-kbg" type="text" value={assignment?.backgroundColor || "#000000"} oninput={handleColorChange} />
              </div>
            </div>
            <div class="field-group">
              <span class="fl">Image</span>
              {#if assignment?.imageDataUrl}
                <div class="img-row"><img src={assignment.imageDataUrl} alt="" /><label class="sm-btn">Change<input type="file" accept="image/*" onchange={handleImageUpload} hidden /></label><button class="sm-btn danger" onclick={() => { if (selectedKey !== null) removeKeyImage(selectedKey); }}>Remove</button></div>
              {:else}<label class="sm-btn">Upload<input type="file" accept="image/*" onchange={handleImageUpload} hidden /></label>{/if}
            </div>
            <div class="field-group">
              <label class="fl" for="{uid}-kurl">Image URL <span class="hint-inline">supports {"{{$var}}"}</span></label>
              <VarInput id="{uid}-kurl" value={assignment?.imageUrl || ''} placeholder="https://..." debounceMs={URL_DEBOUNCE_MS} onchange={(v) => { if (selectedKey !== null) setKeyImageUrl(selectedKey, v); }} />
            </div>
            {#if assignment?.imageDataUrl || assignment?.imageUrl}
              <div class="field-group">
                <span class="fl">Fit</span>
                <div class="mrow" role="group" aria-label="Image fit">
                  {#each FIT_OPTIONS as opt}
                    <button class:active={(assignment?.imageFit || "fill") === opt.v} onclick={() => { if (selectedKey !== null) setKeyImageFit(selectedKey, opt.v); }}>{opt.l}</button>
                  {/each}
                </div>
              </div>
            {/if}
          </div>
        {/if}

        <!-- Icon -->
        {#if icons.length > 0}
          <button class="section-toggle" onclick={() => showIcon = !showIcon}>
            <span>Icon</span>
            <span class="section-arrow" class:open={showIcon}></span>
          </button>
          {#if showIcon}
            <div class="section-body">
              <div class="text-tabs">
                {#each icons as ic, i}
                  <button class="text-tab" class:active={activeIconIndex === i} onclick={() => activeIconIndex = i}>
                    <span class="text-tab-label">
                      {#if ic.svgBody}<span class="icon-inline">{@html iconPreview(ic, 12)}</span>{/if}
                      {ic.iconName || `Icon ${i + 1}`}
                    </span>
                  </button>
                {/each}
                <button class="text-tab text-tab-add" onclick={handleAddIcon} aria-label="Add icon layer">+</button>
              </div>
              {#if icons[activeIconIndex]}
                {@const ic = icons[activeIconIndex]}
                <div class="text-tab-actions">
                  {#if icons.length > 1}
                    <button class="text-tab-action danger" onclick={() => handleRemoveIconAt(activeIconIndex)}>Remove</button>
                  {:else}
                    <button class="text-tab-action danger" onclick={() => { if (selectedKey !== null) removeKeyIcon(selectedKey); }}>Remove</button>
                  {/if}
                </div>
                <div class="img-row">
                  <button class="icon-thumb" onclick={() => activeTab = "icons"} aria-label="Pick icon">
                    {#if ic.svgBody}
                      {@html iconPreview(ic, 32)}
                    {:else}
                      <span style="color:var(--text-muted);font-size:20px;">?</span>
                    {/if}
                  </button>
                  <span class="icon-name">{ic.iconName || 'Pick icon...'}</span>
                </div>
                {#if icons.length > 1}
                  <label class="fl" for="{uid}-icvar">Show when</label>
                  <div class="icon-cond">
                    <VarInput id="{uid}-icvar" value={ic.variable || ''} placeholder={"{{$ha.light.state}}"} onchange={(v) => handleIconConditionChange('variable', v)} />
                    <div class="ef"><label for="{uid}-icval">equals</label><input id="{uid}-icval" type="text" value={ic.value || ''} placeholder="on" oninput={(e) => handleIconConditionChange('value', e.currentTarget.value)} /></div>
                  </div>
                {/if}
              {/if}
            </div>
          {/if}
        {/if}

        <!-- Text -->
        <button class="section-toggle" onclick={() => showText = !showText}>
          <span>Labels</span>
          <span class="section-arrow" class:open={showText}></span>
        </button>
        {#if showText}
          <div class="section-body">
            {#if texts.length > 0}
              <div class="text-tabs">
                {#each texts as t, i}
                  <button class="text-tab" class:active={activeTextIndex === i} class:dim={t.hidden} onclick={() => activeTextIndex = i}>
                    <span class="text-tab-label">{t.text ? resolveTemplate(t.text).substring(0, 10) || `Label ${i + 1}` : `Label ${i + 1}`}</span>
                  </button>
                {/each}
                <button class="text-tab text-tab-add" onclick={handleAddText} aria-label="Add label">+</button>
              </div>
              {#if texts[activeTextIndex]}
                <div class="text-tab-actions">
                  <button class="text-tab-action" onclick={() => { const t = texts[activeTextIndex]; handleTextChange({ ...t, hidden: !t.hidden }, activeTextIndex); }}>
                    {texts[activeTextIndex].hidden ? 'Show' : 'Hide'}
                  </button>
                  {#if texts.length > 1}
                    <button class="text-tab-action danger" onclick={() => handleRemoveText(activeTextIndex)}>Remove</button>
                  {/if}
                </div>
                <TextConfigPanel config={texts[activeTextIndex]} onChange={(c) => handleTextChange(c, activeTextIndex)} />
              {/if}
            {:else}<button class="add-text-btn" onclick={handleAddText}>+ Add text layer</button>{/if}
          </div>
        {/if}

      <!-- ═══ ICONS TAB ═══ -->
      {:else if activeTab === "icons" && !isEncoder}
        <IconBrowser onSelect={handleIconSelect} onStyleChange={handleIconStyleChange} currentColor={icons[activeIconIndex]?.color} currentSize={icons[activeIconIndex]?.size} />
      {/if}
    </div>
  {/if}
</aside>

<style>
  .pp { width: 310px; min-width: 310px; background: var(--bg-primary); border-left: 1px solid var(--border); display: flex; flex-direction: column; }
  .pp-header { padding: 12px 14px; border-bottom: 1px solid var(--border); display: flex; align-items: center; justify-content: space-between; flex-shrink: 0; background: var(--bg-secondary); }
  .pp-header h3 { font-size: 13px; font-weight: 600; color: var(--text-primary); margin: 0; }
  .pp-clear { font-size: 10px; color: var(--danger); padding: 3px 8px; border-radius: var(--radius-sm); cursor: pointer; }
  .pp-clear:hover { background: rgba(239,83,80,0.12); }
  .pp-tabs { display: flex; border-bottom: 1px solid var(--border); flex-shrink: 0; background: var(--bg-secondary); }
  .pp-tabs button { flex: 1; padding: 9px 4px; font-size: 11px; font-weight: 500; color: var(--text-muted); cursor: pointer; text-align: center; border-bottom: 2px solid transparent; transition: color 0.15s; }
  .pp-tabs button:hover { color: var(--text-primary); }
  .pp-tabs button.active { color: var(--accent); border-bottom-color: var(--accent); }
  .pp-body { padding: 14px; overflow-y: auto; flex: 1; min-height: 0; display: flex; flex-direction: column; gap: var(--item-gap); }
  .pp-empty { font-size: 12px; color: var(--text-muted); text-align: center; margin-top: 24px; }
  .fl { display: block; font-size: 10px; text-transform: uppercase; letter-spacing: 0.5px; color: var(--text-muted); margin: 0; font-weight: 500; }
  .field-group { display: flex; flex-direction: column; gap: 4px; }
  .section-toggle {
    display: flex; justify-content: space-between; align-items: center;
    padding: 8px 0;
    border-top: 1px solid var(--border);
    font-size: 11px; font-weight: 600; color: var(--text-secondary);
    cursor: pointer; text-transform: uppercase; letter-spacing: 0.5px;
  }
  .section-toggle:first-child { border-top: none; }
  .section-toggle:hover { color: var(--text-primary); }
  .section-arrow { width: 0; height: 0; border-left: 4px solid transparent; border-right: 4px solid transparent; border-top: 5px solid currentColor; transition: transform 0.15s; }
  .section-arrow.open { transform: rotate(180deg); }
  .section-body { display: flex; flex-direction: column; gap: var(--item-gap); padding-bottom: 4px; }
  input[type="text"], input[type="number"] { width: 100%; min-height: var(--input-h, 34px); padding: 8px 10px; border-radius: var(--radius-sm); border: 1px solid var(--border); background: var(--bg-surface); color: var(--text-primary); font-size: 12px; outline: none; box-sizing: border-box; transition: border-color 0.15s; font-family: inherit; }
  input[type="text"], input[type="number"] { padding: 0 10px; height: var(--input-h, 34px); }
  input:focus { border-color: var(--accent); }
  .search-in { margin-top: 6px; }
  .action-sel { display: flex; align-items: center; gap: 8px; width: 100%; height: 38px; padding: 0 12px; border-radius: var(--radius-sm); border: 1px solid var(--border); background: var(--bg-surface); cursor: pointer; font-size: 12px; color: var(--text-primary); transition: border-color 0.15s; }
  .action-sel:hover { border-color: var(--accent); }
  .sel-none { color: var(--text-muted); }
  .sel-arrow { margin-left: auto; font-size: 8px; color: var(--text-muted); }
  .action-drop { display: flex; flex-direction: column; gap: 1px; margin-top: 4px; max-height: 220px; overflow-y: auto; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--bg-secondary); }
  .action-drop button { display: flex; align-items: center; gap: 8px; padding: 8px 10px; font-size: 12px; color: var(--text-secondary); cursor: pointer; text-align: left; transition: background 0.1s; }
  .action-drop button:hover { background: var(--bg-tertiary); color: var(--text-primary); }
  .action-drop button.active { color: var(--accent); background: var(--accent-subtle); }
  .act-settings { margin-top: 10px; display: flex; flex-direction: column; gap: 8px; }
  .mrow { display: flex; gap: 3px; }
  .mrow button { flex: 1; height: 30px; border-radius: var(--radius-sm); font-size: 11px; font-weight: 600; color: var(--text-muted); background: var(--bg-surface); border: 1px solid var(--border); cursor: pointer; transition: all 0.15s; }
  .mrow button:hover { color: var(--text-primary); border-color: var(--border-light); }
  .mrow button.active { background: var(--accent); color: white; border-color: var(--accent); }
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
  /* Look tab */
  .color-row { display: flex; gap: 6px; align-items: center; }
  .color-row input[type="color"] { width: 34px; height: 34px; border: 1px solid var(--border); border-radius: var(--radius-sm); cursor: pointer; padding: 2px; flex-shrink: 0; background: var(--bg-surface); }
  .color-row input[type="text"] { flex: 1; font-family: monospace; }
  .img-row { display: flex; align-items: center; gap: 8px; margin-top: 4px; }
  .img-row img { width: 48px; height: 48px; border-radius: var(--radius-sm); object-fit: cover; border: 1px solid var(--border); }
  .sm-btn { display: inline-flex; align-items: center; justify-content: center; height: 30px; padding: 0 12px; border-radius: var(--radius-sm); background: var(--bg-surface); border: 1px solid var(--border); color: var(--text-secondary); font-size: 11px; font-weight: 500; cursor: pointer; transition: all 0.15s; }
  .sm-btn:hover { background: var(--accent); color: white; }
  .sm-btn.danger { background: rgba(239,83,80,0.08); color: var(--danger); }
  .sm-btn.danger:hover { background: rgba(239,83,80,0.2); }
  .icon-thumb { background: var(--bg-primary); border-radius: 6px; padding: 4px; cursor: pointer; border: 1px solid var(--border); display: flex; }
  .icon-thumb:hover { border-color: var(--accent); }
  .icon-name { font-size: 10px; color: var(--text-muted); flex: 1; }
  .pin-btn { display: flex; align-items: center; gap: 4px; padding: 4px 8px; border-radius: 4px; font-size: 10px; color: var(--text-muted); background: var(--bg-primary); border: 1px solid var(--border); cursor: pointer; margin-bottom: 6px; }
  .pin-btn:hover { border-color: var(--accent); }
  .pin-btn.pinned { color: var(--warning); border-color: var(--warning); background: rgba(243,156,18,0.06); }
  .text-tabs { display: flex; gap: 3px; flex-wrap: wrap; }
  .text-tab {
    height: 30px; padding: 0 12px;
    border-radius: var(--radius-sm); font-size: 12px; font-weight: 500;
    color: var(--text-muted); background: var(--bg-surface); border: 1px solid var(--border);
    cursor: pointer; transition: all 0.15s;
    display: flex; align-items: center; gap: 4px;
    min-width: 50px; justify-content: center;
  }
  .text-tab:hover { color: var(--text-primary); border-color: var(--border-light); }
  .text-tab.active { color: var(--accent); border-color: var(--accent); background: var(--accent-subtle); }
  .text-tab.dim { opacity: 0.4; }
  .text-tab-add { min-width: 30px; padding: 0; font-size: 16px; font-weight: 600; color: var(--accent); }
  .text-tab-add:hover { background: var(--accent-subtle); border-color: var(--accent); }
  .text-tab-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 80px; }
  .text-tab-actions { display: flex; gap: 4px; }
  .text-tab-action {
    height: 24px; padding: 0 8px;
    border-radius: var(--radius-sm); font-size: 10px; font-weight: 500;
    color: var(--text-muted); background: var(--bg-surface); border: 1px solid var(--border);
    cursor: pointer; transition: all 0.15s;
  }
  .text-tab-action:hover { color: var(--text-primary); }
  .text-tab-action.danger { color: var(--danger); }
  .text-tab-action.danger:hover { background: rgba(239,83,80,0.1); }
  .add-text-btn { width: 100%; height: 34px; border-radius: var(--radius-sm); background: var(--bg-surface); color: var(--text-muted); font-size: 12px; cursor: pointer; text-align: center; border: 1px dashed var(--border); display: flex; align-items: center; justify-content: center; transition: all 0.15s; }
  .add-text-btn:hover { color: var(--accent); border-color: var(--accent); }
  .hint-text { font-size: 9px; color: var(--text-muted); margin-top: 6px; display: block; line-height: 1.4; }
  .hint-inline { font-size: 9px; color: var(--text-muted); text-transform: none; letter-spacing: 0; opacity: 0.6; }

  .icon-cond { display: flex; flex-direction: column; gap: 4px; }
  .action-opt { display: flex; align-items: center; transition: background 0.1s; }
  .action-opt:hover { background: var(--bg-tertiary); }
  .action-drop .action-opt-main { flex: 1; min-width: 0; }
  .action-drop .action-opt-main:hover { background: none; }
  .action-opt.active .action-opt-main { color: var(--accent); }
  .action-opt.active { background: var(--accent-subtle); }
  .action-drop .fav { flex: 0 0 auto; padding: 8px 10px; font-size: 11px; color: var(--text-muted); cursor: pointer; }
  .action-drop .fav:hover, .action-drop .fav.active { color: var(--warning); background: none; }
  .enc-settings { margin-top: 6px; }
  .tiny-row { flex-direction: row; align-items: center; gap: 6px; }
  .tiny-row input { width: 70px; }
  .pin-note { font-size: 10px; color: var(--warning); line-height: 1.4; }
  .icon-inline { display: inline-flex; vertical-align: middle; }
  .text-section { display: flex; flex-direction: column; gap: 6px; margin-top: 4px; }
  .text-head { display: flex; align-items: center; justify-content: space-between; }
  .add-circle { width: 20px; height: 20px; border-radius: 50%; background: var(--accent); color: white; font-size: 13px; font-weight: 700; display: flex; align-items: center; justify-content: center; }
  .text-chips { display: flex; flex-wrap: wrap; gap: 3px; }
  .text-chip { display: flex; align-items: center; border-radius: var(--radius-sm); border: 1px solid var(--border); background: var(--bg-surface); }
  .text-chip.active { border-color: var(--accent); background: var(--accent-subtle); }
  .text-chip-label { height: 26px; padding: 0 8px; font-size: 11px; color: var(--text-muted); max-width: 90px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .text-chip.active .text-chip-label { color: var(--accent); }
  .del-x { height: 26px; padding: 0 6px; font-size: 12px; color: var(--text-muted); }
  .del-x:hover { color: var(--danger); }
</style>

