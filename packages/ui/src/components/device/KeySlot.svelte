<script lang="ts">
  import { invoke } from "@tauri-apps/api/core";
  import { getSelectedKeyIndex, selectKey, getKeyAssignment, swapKeys, assignAction, findAction } from "../../lib/stores/editor.svelte";
  import { renderKeyToDataUrl } from "../../lib/utils/render-key";
  import { getVariable, extractVariableNames } from "../../lib/stores/variables.svelte";

  let { keyIndex, size = 72, serial = "" }: { keyIndex: number; size?: number; serial?: string } = $props();

  let isSelected = $derived(getSelectedKeyIndex() === keyIndex);
  let a = $derived(getKeyAssignment(keyIndex));
  let isDragOver = $state(false);

  let previewUrl = $state<string | null>(null);
  let renderVersion = 0;
  let deviceSyncTimer: number | undefined;
  let hadAssignment = false;

  // Build a string of resolved variable values used by this key — changes trigger re-render
  let usedVarValues = $derived(() => {
    if (!a) return "";
    const allTexts = a.texts?.length ? a.texts : (a.text ? [a.text] : []);
    const names = new Set<string>();
    for (const t of allTexts) {
      if (t?.text) for (const n of extractVariableNames(t.text)) names.add(n);
    }
    if (names.size === 0) return "";
    return [...names].map(n => getVariable(n)).join("|");
  });

  // Single render pipeline: update preview AND push to device
  $effect(() => {
    const currentA = a;
    void usedVarValues(); // track only variables this key uses
    const version = ++renderVersion;
    if (currentA) {
      hadAssignment = true;
      renderKeyToDataUrl(currentA, size).then((url) => {
        if (version === renderVersion) {
          previewUrl = url;
          // Debounced device push to avoid flooding
          clearTimeout(deviceSyncTimer);
          deviceSyncTimer = window.setTimeout(() => {
            if (renderVersion === version) {
              invoke("send_rendered_image", { serial, keyIndex, imageData: url }).catch(() => {});
            }
          }, 150);
        }
      });
    } else {
      previewUrl = null;
      clearTimeout(deviceSyncTimer);
      // Only clear the device if the key WAS previously assigned (user cleared it).
      // Don't clear on initial mount when scenes haven't loaded yet.
      if (hadAssignment) {
        invoke("clear_key", { serial, keyIndex }).catch(() => {});
      }
    }
  });

  function handleDragStart(e: DragEvent) {
    e.dataTransfer!.setData("key-index", String(keyIndex));
    e.dataTransfer!.effectAllowed = "move";
  }

  function handleDragOver(e: DragEvent) {
    e.preventDefault();
    // Accept key swaps and action drops
    if (e.dataTransfer!.types.includes("key-index") || e.dataTransfer!.types.includes("action-id")) {
      e.dataTransfer!.dropEffect = "move";
      isDragOver = true;
    }
  }

  function handleDragLeave() {
    isDragOver = false;
  }

  function handleDrop(e: DragEvent) {
    e.preventDefault();
    isDragOver = false;

    const fromKey = e.dataTransfer!.getData("key-index");
    if (fromKey) {
      swapKeys(Number(fromKey), keyIndex);
      return;
    }

    const actionId = e.dataTransfer!.getData("action-id");
    if (actionId) {
      const action = findAction(actionId);
      if (action) {
        selectKey(keyIndex);
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
    <span class="pin-badge">
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
</style>
