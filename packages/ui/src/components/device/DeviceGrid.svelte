<script lang="ts">
  import { invoke } from "@tauri-apps/api/core";
  import KeySlot from "./KeySlot.svelte";
  import { getSelectedDevice } from "../../lib/stores/devices.svelte";
  import { selectEncoder, getSelectedEncoderIndex, getEncoderConfig, getEncoderResolved, getStripConfig, selectStripItem, addStripItem } from "../../lib/stores/editor.svelte";
  import type { StripItem } from "../../lib/stores/editor.svelte";

  let device = $derived(getSelectedDevice());
  let columns = $derived(device?.columns ?? 5);
  let rows = $derived(device?.rows ?? 3);
  let totalKeys = $derived(columns * rows);
  let keySize = $derived(device?.key_size ? Math.min(device.key_size, 96) : 72);
  let hasLcd = $derived(device?.has_lcd_strip ?? false);
  let hasDials = $derived(device?.has_dials ?? false);
  let encoderCount = $derived(device?.encoder_count ?? 0);
  let lcdWidth = $derived(device?.lcd_width ?? 0);
  let lcdHeight = $derived(device?.lcd_height ?? 0);
  import { store } from "../../lib/stores/store.svelte";
  import { updateStripItem } from "../../lib/stores/editor.svelte";

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
    return [((e.clientX - rect.left) / rect.width) * 800, ((e.clientY - rect.top) / rect.height) * 100];
  }

  function onStripMouseDown(e: MouseEvent) {
    const canvas = e.target as HTMLCanvasElement;
    const [sx, sy] = stripCoords(e, canvas);
    for (let i = stripCfg.items.length - 1; i >= 0; i--) {
      const it = stripCfg.items[i];
      if (sx >= it.x && sx <= it.x + it.w && sy >= it.y && sy <= it.y + it.h) {
        dragItem = it.id;
        dragStartX = sx;
        dragStartY = sy;
        dragOrigX = it.x;
        dragOrigY = it.y;
        dragStarted = false;
        e.preventDefault();
        return;
      }
    }
  }

  function onStripMouseMove(e: MouseEvent) {
    if (!dragItem) return;
    const canvas = e.target as HTMLCanvasElement;
    const [sx, sy] = stripCoords(e, canvas);
    const dx = sx - dragStartX;
    const dy = sy - dragStartY;
    if (!dragStarted && Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD) return;
    dragStarted = true;
    const newX = Math.max(0, Math.min(800, Math.round(dragOrigX + dx)));
    const newY = Math.max(0, Math.min(100, Math.round(dragOrigY + dy)));
    updateStripItem(dragItem, { x: newX, y: newY });
  }

  function onStripMouseUp(e: MouseEvent) {
    if (dragItem && !dragStarted) {
      // Was a click, not a drag — select the item
      selectStripItem(dragItem);
    } else if (!dragItem) {
      // Clicked empty area — deselect
      selectStripItem(null);
    }
    dragItem = null;
    dragStarted = false;
  }
  let brightness = $state(80);
  let selectedEncoder = $derived(getSelectedEncoderIndex());
  // Include varRevision so strip re-renders when variables change
  let stripCfg = $derived({ ...getStripConfig(), _varRev: store.varRevision, _sel: store.selectedStripItemId });

  function renderStrip(canvas: HTMLCanvasElement, cfg: any) {
    function draw() {
      const ctx = canvas.getContext("2d")!;
      const bg = store.resolveTemplate(cfg.backgroundColor || "#0a0a1a");
      ctx.fillStyle = (bg.startsWith("#") || bg.startsWith("rgb")) ? bg : "#0a0a1a";
      ctx.fillRect(0, 0, 800, 100);
      for (const item of cfg.items || []) {
        ctx.save();
        ctx.beginPath(); ctx.roundRect(item.x, item.y, item.w, item.h, 4); ctx.clip();
        // Background
        if (item.backgroundColor) {
          const c = store.resolveTemplate(item.backgroundColor);
          ctx.fillStyle = (c.startsWith("#") || c.startsWith("rgb")) ? c : "#333";
          ctx.fillRect(item.x, item.y, item.w, item.h);
        }
        // Bar
        if (item.bar) {
          const val = store.resolveNumber(item.bar.value, 0);
          const mn = store.resolveNumber(item.bar.min, 0);
          const mx = store.resolveNumber(item.bar.max, 100);
          const ratio = mx > mn ? Math.max(0, Math.min(1, (val - mn) / (mx - mn))) : 0;
          const bc = store.resolveTemplate(item.bar.color || "#03a9f4");
          const barC = (bc.startsWith("#") || bc.startsWith("rgb")) ? bc : "#03a9f4";
          if (item.bar.position === "full") {
            ctx.fillStyle = barC; ctx.fillRect(item.x, item.y, item.w * ratio, item.h);
          } else {
            const bh = item.bar.height || 8;
            ctx.fillStyle = "rgba(255,255,255,0.1)";
            ctx.beginPath(); ctx.roundRect(item.x + 4, item.y + item.h - bh - 4, item.w - 8, bh, 3); ctx.fill();
            ctx.fillStyle = barC;
            ctx.beginPath(); ctx.roundRect(item.x + 4, item.y + item.h - bh - 4, (item.w - 8) * ratio, bh, 3); ctx.fill();
          }
        }
        // Image
        if (item.imageDataUrl) {
          const img = new Image(); img.src = item.imageDataUrl;
          if (img.complete) ctx.drawImage(img, item.x, item.y, item.w, item.h);
        }
        // Icon
        if (item.icon) {
          const sz = Math.min(item.icon.size || 48, item.h - 4);
          const color = item.icon.color || "#fff";
          const svgStr = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${item.icon.viewBox}" width="${sz}" height="${sz}"><style>*{fill:none;stroke:${color};stroke-width:2;stroke-linecap:round;stroke-linejoin:round;}</style>${item.icon.svgBody}</svg>`;
          const svgImg = new Image(); svgImg.src = `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(svgStr)))}`;
          if (svgImg.complete) ctx.drawImage(svgImg, item.x + (item.w - sz) / 2, item.y + (item.h - sz) / 2, sz, sz);
        }
        // Text layers
        for (const t of item.texts || []) {
          if (!t?.text || t.hidden) continue;
          const text = store.resolveTemplate(t.text);
          const color = store.resolveTemplate(t.color || "#fff");
          ctx.fillStyle = (color.startsWith("#") || color.startsWith("rgb")) ? color : "#fff";
          const wt = t.fontWeight === "bold" ? "bold " : "";
          const st = t.fontStyle === "italic" ? "italic " : "";
          ctx.font = `${st}${wt}${t.fontSize || 14}px ${t.fontFamily || "sans-serif"}`;
          let tx: number, ty: number;
          if (t.useAbsolutePos) { tx = item.x + (t.x || 0); ty = item.y + (t.y || 0); }
          else {
            tx = t.hAlign === "left" ? item.x + 4 : t.hAlign === "right" ? item.x + item.w - 4 : item.x + item.w / 2;
            ty = t.vAlign === "top" ? item.y + (t.fontSize || 14) : t.vAlign === "bottom" ? item.y + item.h - 4 : item.y + item.h / 2;
          }
          ctx.textAlign = t.hAlign === "left" ? "left" : t.hAlign === "right" ? "right" : "center";
          ctx.textBaseline = t.vAlign === "top" ? "top" : t.vAlign === "bottom" ? "bottom" : "middle";
          ctx.fillText(text, tx, ty, item.w - 8);
        }
        ctx.restore();
        // Selected highlight (outside clip)
        if (item.id === store.selectedStripItemId) {
          ctx.strokeStyle = "#0078ff"; ctx.lineWidth = 2;
          ctx.strokeRect(item.x, item.y, item.w, item.h);
        }
      }
    }
    draw();
    // Re-draw after images load (async)
    setTimeout(draw, 100);
    return { update(newCfg: any) { cfg = newCfg; draw(); setTimeout(draw, 100); } };
  }

  function handleBrightness(e: Event) {
    brightness = Number((e.target as HTMLInputElement).value);
    invoke("set_brightness", { percent: brightness }).catch(() => {});
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
        {#each Array(totalKeys) as _, i}
          <KeySlot keyIndex={i} size={keySize} />
        {/each}
      </div>

      <!-- LCD Touchstrip (Stream Deck+) — one 800x100 canvas -->
      {#if hasLcd}
        {@const stripW = columns * (keySize + 8) - 8}
        <div class="lcd-strip" style="width: {stripW}px;">
          <canvas class="lcd-canvas" width="800" height="100" style="width:{stripW}px; height:{stripW * 100/800}px;"
            use:renderStrip={stripCfg}
            onmousedown={onStripMouseDown}
            onmousemove={onStripMouseMove}
            onmouseup={onStripMouseUp}
            onmouseleave={onStripMouseUp}
          ></canvas>
          <button class="strip-add" onclick={() => addStripItem({ id: crypto.randomUUID(), x: 10, y: 10, w: 180, h: 80, backgroundColor: "#2a2a4a", texts: [{ text: "Item", fontFamily: "sans-serif", fontSize: 16, fontWeight: "normal", fontStyle: "normal", color: "#ffffff", hAlign: "center", vAlign: "middle", anchor: "center", useAbsolutePos: false }] })} title="Add item">+</button>
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
        <input type="range" min="0" max="100" value={brightness} oninput={handleBrightness} />
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
