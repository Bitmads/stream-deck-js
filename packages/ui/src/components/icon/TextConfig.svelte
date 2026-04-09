<script lang="ts">
  import type { TextConfig } from "../../lib/stores/editor.svelte";
  import VarInput from "../input/VarInput.svelte";

  let { config, onChange }: { config: TextConfig; onChange: (c: TextConfig) => void } = $props();

  function update(partial: Partial<TextConfig>) {
    onChange({ ...config, ...partial });
  }
</script>

<div class="text-config">
  <div class="field">
    <span class="lbl">Text <span class="hint">Type {"{{$"} to autocomplete variables</span></span>
    <VarInput
      value={config.text}
      onchange={(v) => update({ text: v })}
      placeholder="Button label..."
      multiline={true}
      rows={3}
    />
  </div>

  <div class="field">
    <span class="lbl">Font</span>
    <select value={config.fontFamily} onchange={(e) => update({ fontFamily: (e.target as HTMLSelectElement).value })}>
      <option value="sans-serif">System Sans-Serif</option>
      <option value="serif">System Serif</option>
      <option value="monospace">System Monospace</option>
      <option value="Roboto">Roboto</option>
      <option value="Inter">Inter</option>
      <option value="Source Sans 3">Source Sans 3</option>
      <option value="Fira Code">Fira Code</option>
      <option value="JetBrains Mono">JetBrains Mono</option>
      <option value="Orbitron">Orbitron</option>
    </select>
  </div>

  <div class="row">
    <div class="field half">
      <span class="lbl">Font Size</span>
      <input type="number" value={config.fontSize} min="6" max="48" oninput={(e) => update({ fontSize: Number((e.target as HTMLInputElement).value) })} />
    </div>
    <div class="field half">
      <span class="lbl">Color</span>
      <div class="color-row">
        <input type="color" value={config.color} oninput={(e) => update({ color: (e.target as HTMLInputElement).value })} />
        <input type="text" value={config.color} class="color-text" oninput={(e) => update({ color: (e.target as HTMLInputElement).value })} />
      </div>
    </div>
  </div>

  <div class="row">
    <div class="field half">
      <span class="lbl">Weight</span>
      <div class="btn-group">
        <button class:active={config.fontWeight === "normal"} onclick={() => update({ fontWeight: "normal" })}>Normal</button>
        <button class:active={config.fontWeight === "bold"} onclick={() => update({ fontWeight: "bold" })}>Bold</button>
      </div>
    </div>
    <div class="field half">
      <span class="lbl">Style</span>
      <div class="btn-group">
        <button class:active={config.fontStyle === "normal"} onclick={() => update({ fontStyle: "normal" })}>Normal</button>
        <button class:active={config.fontStyle === "italic"} onclick={() => update({ fontStyle: "italic" })}>Italic</button>
      </div>
    </div>
  </div>

  <div class="field">
    <span class="lbl">Anchor</span>
    <div class="btn-group">
      <button class:active={config.anchor === "start"} onclick={() => update({ anchor: "start" })}>Start</button>
      <button class:active={config.anchor === "center"} onclick={() => update({ anchor: "center" })}>Center</button>
      <button class:active={config.anchor === "end"} onclick={() => update({ anchor: "end" })}>End</button>
    </div>
  </div>

  <div class="field">
    <span class="lbl">
      <input type="checkbox" checked={config.useAbsolutePos} onchange={(e) => update({ useAbsolutePos: (e.target as HTMLInputElement).checked })} />
      Absolute Position
    </span>
  </div>

  {#if config.useAbsolutePos}
    <div class="row">
      <div class="field half">
        <span class="lbl">X</span>
        <input type="number" value={config.x ?? 0} min="-10" max="100" oninput={(e) => update({ x: Number((e.target as HTMLInputElement).value) })} />
      </div>
      <div class="field half">
        <span class="lbl">Y</span>
        <input type="number" value={config.y ?? 0} min="-10" max="100" oninput={(e) => update({ y: Number((e.target as HTMLInputElement).value) })} />
      </div>
    </div>
  {:else}
    <div class="row">
      <div class="field half">
        <span class="lbl">H-Align</span>
        <div class="btn-group">
          <button class:active={config.hAlign === "left"} onclick={() => update({ hAlign: "left" })}>L</button>
          <button class:active={config.hAlign === "center"} onclick={() => update({ hAlign: "center" })}>C</button>
          <button class:active={config.hAlign === "right"} onclick={() => update({ hAlign: "right" })}>R</button>
        </div>
      </div>
      <div class="field half">
        <span class="lbl">V-Align</span>
        <div class="btn-group">
          <button class:active={config.vAlign === "top"} onclick={() => update({ vAlign: "top" })}>T</button>
          <button class:active={config.vAlign === "middle"} onclick={() => update({ vAlign: "middle" })}>M</button>
          <button class:active={config.vAlign === "bottom"} onclick={() => update({ vAlign: "bottom" })}>B</button>
        </div>
      </div>
    </div>
  {/if}
</div>

<style>
  .text-config { display: flex; flex-direction: column; gap: 8px; }
  .field { display: flex; flex-direction: column; gap: 3px; }
  .lbl { font-size: 11px; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.3px; }
  .hint { text-transform: none; font-size: 9px; opacity: 0.6; letter-spacing: 0; }

  .field textarea,
  .field input[type="text"],
  .field input[type="number"] {
    padding: 6px 8px;
    border-radius: var(--radius-sm);
    border: 1px solid var(--border);
    background: var(--bg-primary);
    color: var(--text-primary);
    font-size: 12px;
    outline: none;
    width: 100%;
    resize: vertical;
  }

  .field textarea:focus,
  .field input:focus { border-color: var(--accent); }

  .row { display: flex; gap: 8px; }
  .half { flex: 1; }

  .color-row { display: flex; gap: 4px; align-items: center; }
  .color-row input[type="color"] { width: 28px; height: 28px; border: none; border-radius: 4px; cursor: pointer; padding: 0; }
  .color-text { flex: 1; }

  .btn-group { display: flex; gap: 2px; }
  .btn-group button {
    flex: 1; padding: 4px; border-radius: var(--radius-sm); font-size: 11px; font-weight: 600;
    color: var(--text-muted); background: var(--bg-primary); border: 1px solid var(--border); cursor: pointer;
  }
  .btn-group button:hover { color: var(--text-primary); }
  .btn-group button.active { background: var(--accent); color: white; border-color: var(--accent); }

  .field select {
    padding: 6px 8px;
    border-radius: var(--radius-sm);
    border: 1px solid var(--border);
    background: var(--bg-primary);
    color: var(--text-primary);
    font-size: 12px;
    outline: none;
    width: 100%;
    cursor: pointer;
  }
  .field select:focus { border-color: var(--accent); }

  .field input[type="checkbox"] { margin-right: 4px; }
</style>
