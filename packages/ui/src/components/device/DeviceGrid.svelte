<script lang="ts">
  import { untrack } from "svelte";
  import KeySlot from "./KeySlot.svelte";
  import { getSelectedDevice } from "../../lib/stores/devices.svelte";
  import {
    selectEncoder, getSelectedEncoderIndex, getEncoderConfig, getEncoderResolved, getStripConfig,
    selectStripItem, addStripItem, updateStripItem, store,
  } from "../../lib/stores/editor.svelte";
  import { renderStrip, STRIP_DESIGN_WIDTH, STRIP_DESIGN_HEIGHT } from "../../lib/utils/render-strip";
  import { deviceKeyCount, deviceKeyPixelSize } from "../../lib/types/profile";

  let device = $derived(getSelectedDevice());
  let columns = $derived(device?.columns ?? 5);
  let rows = $derived(device?.rows ?? 3);
  let totalKeys = $derived(device ? deviceKeyCount(device) : columns * rows);
  /** Native key image size: previews render at it, exactly like the hardware sync. */
  let nativeKeySize = $derived(device ? deviceKeyPixelSize(device) : 72);
  /** On-screen size of a key box. */
  let keySize = $derived(nativeKeySize > 0 ? Math.min(nativeKeySize, 96) : 72);
  let hasLcd = $derived(device?.has_lcd_strip ?? false);
  let hasDials = $derived(device?.has_dials ?? false);
  let encoderCount = $derived(device?.encoder_count ?? 0);

  let label = $derived(device?.model ?? "No device");

  // Strip drag state
  let dragItem: string | null = null;
  let dragStartX = 0;
  let dragStartY = 0;
  let dragOrigX = 0;
  let dragOrigY = 0;
  let dragStarted = false;
  const DRAG_THRESHOLD = 3; // px in canvas space before drag activates

  function stripCoords(e: MouseEvent, canvas: HTMLCanvasElement): [number, number] {
    const rect = canvas.getBoundingClientRect();
    return [((e.clientX - rect.left) / rect.width) * STRIP_DESIGN_WIDTH, ((e.clientY - rect.top) / rect.height) * STRIP_DESIGN_HEIGHT];
  }

  function hitItem(sx: number, sy: number) {
    const items = getStripConfig().items;
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i];
      if (sx >= it.x && sx <= it.x + it.w && sy >= it.y && sy <= it.y + it.h) return it;
    }
    return null;
  }

  function onStripMouseDown(e: MouseEvent) {
    const [sx, sy] = stripCoords(e, e.currentTarget as HTMLCanvasElement);
    const it = hitItem(sx, sy);
    if (!it) return;
    dragItem = it.id;
    dragStartX = sx;
    dragStartY = sy;
    dragOrigX = it.x;
    dragOrigY = it.y;
    dragStarted = false;
    e.preventDefault();
  }

  function onStripMouseMove(e: MouseEvent) {
    if (!dragItem) return;
    const [sx, sy] = stripCoords(e, e.currentTarget as HTMLCanvasElement);
    const dx = sx - dragStartX;
    const dy = sy - dragStartY;
    if (!dragStarted && Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD) return;
    dragStarted = true;
    const newX = Math.max(0, Math.min(STRIP_DESIGN_WIDTH, Math.round(dragOrigX + dx)));
    const newY = Math.max(0, Math.min(STRIP_DESIGN_HEIGHT, Math.round(dragOrigY + dy)));
    updateStripItem(dragItem, { x: newX, y: newY });
  }

  function onStripMouseUp() {
    if (dragItem && !dragStarted) {
      // Was a click, not a drag — select the item
      selectStripItem(dragItem);
    } else if (!dragItem) {
      // Click on empty strip area deselects
      if (store.selectedStripItemId) selectStripItem(null);
    }
    dragItem = null;
    dragStarted = false;
  }

  // Strip preview: the same renderer the device sync uses, so preview == device.
  let stripCanvas = $state<HTMLCanvasElement | null>(null);
  let stripVersion = 0;
  $effect(() => {
    const canvas = stripCanvas;
    if (!canvas) return;
    const strip = getStripConfig();
    const selectedItemId = store.selectedStripItemId;
    const version = ++stripVersion;
    // Draw offscreen first so overlapping renders never interleave on the visible canvas.
    const off = document.createElement("canvas");
    off.width = canvas.width; off.height = canvas.height;
    const offCtx = off.getContext("2d");
    if (!offCtx) return;
    // resolveStripInputs runs synchronously inside renderStrip, so the variables it reads are tracked here.
    const done = renderStrip(offCtx, strip, { lookup: store.lookupVar, selectedItemId });
    untrack(() => {
      done.then(() => {
        if (version !== stripVersion) return;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(off, 0, 0);
      }).catch((e) => console.warn("Strip preview failed:", e));
    });
  });

  // Per-device brightness, saved in the profile and re-applied whenever the device is opened.
  let brightness = $derived(device ? (store.getDeviceBrightness(device.serial) ?? 80) : 80);
  let selectedEncoder = $derived(getSelectedEncoderIndex());

  function handleBrightness(e: Event) {
    const serial = device?.serial;
    if (!serial) return;
    void store.setDeviceBrightness(serial, Number((e.target as HTMLInputElement).value));
  }

  function addItem() {
    addStripItem({
      id: crypto.randomUUID(), x: 10, y: 10, w: 180, h: 80, backgroundColor: "#2a2a4a",
      texts: [{ text: "Item", fontFamily: "sans-serif", fontSize: 16, fontWeight: "normal", fontStyle: "normal", color: "#ffffff", hAlign: "center", vAlign: "middle", anchor: "center", useAbsolutePos: false }],
    });
  }
</script>

<div class="device-grid-container">
  {#if device}
    <div class="device-frame">
      <!-- Keys -->
      <div
        class="key-grid"
        style="grid-template-columns: repeat({columns}, {keySize}px); grid-template-rows: repeat({rows}, {keySize}px);"
      >
        {#each Array(totalKeys) as _, i (i)}
          <KeySlot keyIndex={i} size={keySize} nativeSize={nativeKeySize} />
        {/each}
      </div>

      <!-- LCD Touchstrip (Stream Deck+) — one 800x100 canvas -->
      {#if hasLcd}
        {@const stripW = columns * (keySize + 8) - 8}
        <div class="lcd-strip" style="width: {stripW}px;">
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <canvas class="lcd-canvas" width={device?.lcd_width || STRIP_DESIGN_WIDTH} height={device?.lcd_height || STRIP_DESIGN_HEIGHT}
            style="width:{stripW}px; height:{stripW * STRIP_DESIGN_HEIGHT / STRIP_DESIGN_WIDTH}px;"
            bind:this={stripCanvas}
            onmousedown={onStripMouseDown}
            onmousemove={onStripMouseMove}
            onmouseup={onStripMouseUp}
            onmouseleave={() => { if (dragItem) { dragItem = null; dragStarted = false; } }}
          ></canvas>
          <button class="strip-add" onclick={addItem} title="Add item" aria-label="Add strip item">+</button>
        </div>
      {/if}

      <!-- Encoder Dials (Stream Deck+) -->
      {#if hasDials && encoderCount > 0}
        <div class="encoder-row" style="width: {columns * (keySize + 8) - 8}px;">
          {#each Array(encoderCount) as _, i}
            {@const cfg = getEncoderConfig(i)}
            {@const enc = getEncoderResolved(i)}
            {@const val = enc.value}
            {@const emin = enc.min}
            {@const emax = enc.max}
            <button
              class="encoder-dial"
              class:encoder-selected={selectedEncoder === i}
              title="Encoder {i}{cfg?.label ? ': ' + cfg.label : ''}"
              onclick={() => selectEncoder(i)}
            >
              <div class="dial-knob">
                <div class="dial-indicator" style="transform: rotate({emax > emin ? ((val - emin) / (emax - emin)) * 270 - 135 : 0}deg);"></div>
              </div>
              <span class="dial-value">{cfg?.label || `E${i}`}: {Math.round(val)}</span>
            </button>
          {/each}
        </div>
      {/if}
    </div>

    <div class="device-controls">
      <span class="device-label">{label}
        ({columns}x{rows}{hasDials ? ` + ${encoderCount} dials` : ''}{hasLcd ? ' + LCD' : ''})
      </span>
      <div class="brightness">
        <span class="brightness-icon">☀</span>
        <input type="range" min="0" max="100" value={brightness} oninput={handleBrightness} aria-label="Brightness" />
        <span class="brightness-val">{brightness}%</span>
      </div>
    </div>
  {:else}
    <div class="no-device">
      <p class="no-device-title">No Stream Deck detected</p>
      <p class="no-device-hint">Connect a device via USB</p>
      <p class="no-device-hint">On Linux, make sure udev rules are configured (see README)</p>
    </div>
  {/if}
</div>

<style>
  .device-grid-container { display: flex; flex-direction: column; align-items: center; gap: 12px; }
  .device-frame { background: #111; border-radius: 16px; padding: 20px; box-shadow: 0 4px 24px rgba(0,0,0,0.5); display: flex; flex-direction: column; align-items: center; gap: 0; }
  .key-grid { display: grid; gap: 8px; }

  /* LCD Touchstrip */
  .lcd-strip { margin-top: 8px; position: relative; }
  .lcd-canvas { border-radius: 6px; border: 1px solid #2a2a4a; cursor: grab; display: block; }
  .lcd-canvas:active { cursor: grabbing; }
  .lcd-canvas:hover { border-color: var(--accent); }
  .strip-add { position: absolute; top: 2px; right: 4px; width: 18px; height: 18px; border-radius: 50%; background: var(--accent); color: white; font-size: 12px; font-weight: 700; cursor: pointer; display: flex; align-items: center; justify-content: center; border: none; opacity: 0.7; }
  .strip-add:hover { opacity: 1; }

  /* Encoder Dials */
  .encoder-row { display: flex; justify-content: space-around; margin-top: 10px; }
  .encoder-dial { display: flex; flex-direction: column; align-items: center; gap: 4px; cursor: pointer; background: none; border: none; padding: 4px; border-radius: 8px; }
  .encoder-dial:hover .dial-knob { border-color: var(--accent); }
  .encoder-dial.encoder-selected .dial-knob { border-color: var(--accent); box-shadow: 0 0 0 2px rgba(0, 120, 255, 0.4), 0 2px 8px rgba(0,0,0,0.4); }
  .dial-knob {
    width: 44px; height: 44px; border-radius: 50%;
    background: linear-gradient(145deg, #2a2a3a, #1a1a2a);
    border: 2px solid #3a3a5a; position: relative;
    box-shadow: 0 2px 8px rgba(0,0,0,0.4), inset 0 1px 2px rgba(255,255,255,0.05);
    transition: border-color 0.15s;
  }
  .dial-indicator {
    position: absolute; top: 4px; left: 50%; width: 3px; height: 10px;
    border-radius: 2px; background: var(--accent); transform-origin: 50% 18px;
  }
  .dial-value { font-size: 9px; color: rgba(255,255,255,0.4); max-width: 60px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  .device-controls { display: flex; align-items: center; gap: 16px; }
  .device-label { font-size: 12px; color: var(--text-muted); }
  .brightness { display: flex; align-items: center; gap: 6px; }
  .brightness-icon { font-size: 14px; color: var(--text-muted); }
  .brightness input[type="range"] { width: 80px; }
  .brightness-val { font-size: 11px; color: var(--text-muted); min-width: 32px; }
  .no-device { text-align: center; padding: 48px; }
  .no-device-title { font-size: 18px; color: var(--text-secondary); margin-bottom: 12px; }
  .no-device-hint { font-size: 13px; color: var(--text-muted); margin-bottom: 4px; }
</style>
