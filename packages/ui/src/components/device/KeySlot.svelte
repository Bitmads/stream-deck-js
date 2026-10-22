<script lang="ts">
  // Editor preview of one key. Preview only: the hardware is driven by lib/stores/device-sync.
  import { untrack } from "svelte";
  import {
    getSelectedKeyIndex, selectKey, getKeyAssignment, getEditorKeyOverride, isPinnedOverlay,
    swapKeys, assignAction, findAction, store,
  } from "../../lib/stores/editor.svelte";
  import { resolveKeyInputs, keyFingerprint, renderResolvedKey, keyDesignSize } from "../../lib/utils/render-key";

  let { keyIndex, size = 72, nativeSize = size }: {
    keyIndex: number;
    /** Displayed box size in CSS px. */
    size?: number;
    /** The device's native key image size; the preview renders at this size like the hardware. */
    nativeSize?: number;
  } = $props();

  let isSelected = $derived(getSelectedKeyIndex() === keyIndex);
  let a = $derived(getKeyAssignment(keyIndex));
  let pinnedOverlay = $derived(a ? isPinnedOverlay(keyIndex) : false);
  let isDragOver = $state(false);

  let previewUrl = $state<string | null>(null);
  let lastFp: string | null = null;
  let renderVersion = 0;

  // Resolve only the inputs this key uses (variables, runtime override) and re-render on change.
  $effect(() => {
    const assignment = a;
    const renderSize = nativeSize > 0 ? nativeSize : size;
    if (!assignment) {
      lastFp = null;
      renderVersion++;
      previewUrl = null;
      return;
    }
    const inputs = resolveKeyInputs(assignment, store.lookupVar, getEditorKeyOverride(keyIndex));
    const fp = keyFingerprint(inputs, renderSize);
    if (fp === lastFp) return;
    lastFp = fp;
    const version = ++renderVersion;
    untrack(() => {
      renderResolvedKey(inputs, renderSize, keyDesignSize(renderSize))
        .then(({ dataUrl }) => { if (version === renderVersion) previewUrl = dataUrl; })
        .catch((e) => console.warn(`Key ${keyIndex} preview failed:`, e));
    });
  });

  function handleDragStart(e: DragEvent) {
    if (!e.dataTransfer) return;
    e.dataTransfer.setData("key-index", String(keyIndex));
    e.dataTransfer.effectAllowed = "move";
  }

  function handleDragOver(e: DragEvent) {
    const dt = e.dataTransfer;
    if (!dt) return;
    // Key swaps move; actions dragged from the sidebar are copied (must match their effectAllowed).
    if (dt.types.includes("action-id")) {
      e.preventDefault();
      dt.dropEffect = "copy";
      isDragOver = true;
    } else if (dt.types.includes("key-index")) {
      e.preventDefault();
      dt.dropEffect = "move";
      isDragOver = true;
    }
  }

  function handleDragLeave() {
    isDragOver = false;
  }

  function handleDrop(e: DragEvent) {
    e.preventDefault();
    isDragOver = false;
    const dt = e.dataTransfer;
    if (!dt) return;

    const fromKey = dt.getData("key-index");
    if (fromKey) {
      swapKeys(Number(fromKey), keyIndex);
      return;
    }

    const actionId = dt.getData("action-id");
    if (actionId) {
      const action = findAction(actionId);
      if (action) {
        if (getSelectedKeyIndex() !== keyIndex) selectKey(keyIndex);
        assignAction(keyIndex, action);
      }
    }
  }
</script>

<button
  class="key-slot"
  class:selected={isSelected}
  class:drag-over={isDragOver}
  style="width:{size}px; height:{size}px; min-width:{size}px; min-height:{size}px;"
  draggable={!!a}
  aria-label="Key {keyIndex}{a && a.action.id !== 'none' ? `: ${a.action.label}` : ''}"
  onclick={() => selectKey(keyIndex)}
  ondragstart={handleDragStart}
  ondragover={handleDragOver}
  ondragleave={handleDragLeave}
  ondrop={handleDrop}
>
  {#if previewUrl}
    <img class="preview" src={previewUrl} alt="" />
  {/if}
  {#if a?.pinned}
    <span class="pin-badge" class:overlay={pinnedOverlay} title={pinnedOverlay ? "Pinned from another scene" : "Pinned"}>
      <svg viewBox="0 0 24 24" width="8" height="8" fill="currentColor" stroke="none">
        <path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z"/>
      </svg>
    </span>
  {/if}
  <span class="key-index">{keyIndex}</span>
</button>

<style>
  .key-slot {
    flex-shrink: 0;
    border-radius: 10px; border: 2px solid #2a2a4a; background: #1a1a2e; padding: 0;
    display: block; position: relative; overflow: hidden; transition: border-color 0.15s; cursor: pointer;
  }
  .key-slot:hover { border-color: var(--accent); }
  .key-slot.selected { border-color: var(--accent); box-shadow: 0 0 0 2px rgba(0, 120, 255, 0.4); }
  .key-slot.drag-over { border-color: var(--success); background: rgba(46, 204, 113, 0.1); }
  .preview { position: absolute; inset: 0; width: 100%; height: 100%; border-radius: 8px; pointer-events: none; }
  .key-index { position: absolute; top: 2px; right: 4px; font-size: 9px; color: rgba(255,255,255,0.3); z-index: 10; pointer-events: none; }
  .pin-badge { position: absolute; top: 2px; left: 3px; color: #f39c12; z-index: 10; pointer-events: none; opacity: 0.8; }
  .pin-badge.overlay { opacity: 0.45; }
</style>
