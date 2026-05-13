<script lang="ts">
  import type { TextConfig } from "../../lib/stores/editor.svelte";
  import VarInput from "../input/VarInput.svelte";

  let { config, onChange }: { config: TextConfig; onChange: (c: TextConfig) => void } = $props();

  let showEffects = $state(!!config.stroke || !!config.shadow);
  let showLayout = $state(false);

  function update(partial: Partial<TextConfig>) {
    onChange({ ...config, ...partial });
  }
</script>

<div class="tc">
  <!-- Text Content -->
  <div class="tc-field">
    <span class="tc-label">Text <span class="tc-hint">Type {"{{$"} for variables</span></span>
    <VarInput
      value={config.text}
      onchange={(v) => update({ text: v })}
      placeholder="Button label..."
      multiline={true}
      rows={3}
    />
  </div>

  <!-- Font Row: family + size -->
  <div class="tc-row">
    <div class="tc-field" style="flex:2;">
      <span class="tc-label">Font</span>
      <select value={config.fontFamily} onchange={(e) => update({ fontFamily: (e.target as HTMLSelectElement).value })}>
        <option value="sans-serif">System Sans</option>
        <option value="serif">System Serif</option>
        <option value="monospace">Monospace</option>
        <option value="Roboto">Roboto</option>
        <option value="Inter">Inter</option>
        <option value="Source Sans 3">Source Sans 3</option>
        <option value="Fira Code">Fira Code</option>
        <option value="JetBrains Mono">JetBrains Mono</option>
        <option value="Orbitron">Orbitron</option>
      </select>
    </div>
    <div class="tc-field" style="flex:1;">
      <span class="tc-label">Size</span>
      <input type="number" value={config.fontSize} min="6" max="48" oninput={(e) => update({ fontSize: Number((e.target as HTMLInputElement).value) })} />
    </div>
  </div>

  <!-- Color + Weight + Style row -->
  <div class="tc-row">
    <div class="tc-field" style="flex:1;">
      <span class="tc-label">Color</span>
      <div class="tc-color">
        <input type="color" value={config.color} oninput={(e) => update({ color: (e.target as HTMLInputElement).value })} />
        <input type="text" value={config.color} oninput={(e) => update({ color: (e.target as HTMLInputElement).value })} />
      </div>
    </div>
    <div class="tc-field" style="flex:1;">
      <span class="tc-label">Style</span>
      <div class="tc-chips">
        <button class:active={config.fontWeight === "bold"} onclick={() => update({ fontWeight: config.fontWeight === "bold" ? "normal" : "bold" })} title="Bold">B</button>
        <button class:active={config.fontStyle === "italic"} onclick={() => update({ fontStyle: config.fontStyle === "italic" ? "normal" : "italic" })} title="Italic"><em>I</em></button>
      </div>
    </div>
  </div>

  <!-- Wrap -->
  <div class="tc-field">
    <span class="tc-label">Wrap</span>
    <div class="tc-chips wide">
      <button class:active={(config.wrap || "none") === "none"} onclick={() => update({ wrap: "none" })}>None</button>
      <button class:active={config.wrap === "word"} onclick={() => update({ wrap: "word" })}>Word</button>
      <button class:active={config.wrap === "char"} onclick={() => update({ wrap: "char" })}>Char</button>
    </div>
  </div>

  <!-- Effects Section -->
  <button class="tc-section-toggle" onclick={() => showEffects = !showEffects}>
    <span>Effects</span>
    <span class="tc-arrow" class:open={showEffects}></span>
  </button>

  {#if showEffects}
    <div class="tc-section">
      <!-- Stroke -->
      <label class="tc-toggle">
        <input type="checkbox" checked={!!config.stroke} onchange={(e) => update({ stroke: (e.target as HTMLInputElement).checked ? { color: "#000000", width: 2 } : undefined })} />
        <span>Text Stroke</span>
      </label>
      {#if config.stroke}
        <div class="tc-row">
          <div class="tc-field" style="flex:0 0 34px;">
            <span class="tc-label">Color</span>
            <input type="color" value={config.stroke.color} style="width:34px; height:var(--input-h,34px); border:1px solid var(--border); border-radius:var(--radius-sm); padding:2px; background:var(--bg-surface); cursor:pointer;" oninput={(e) => update({ stroke: { ...config.stroke!, color: (e.target as HTMLInputElement).value } })} />
          </div>
          <div class="tc-field" style="flex:1;">
            <span class="tc-label">Hex</span>
            <input type="text" value={config.stroke.color} oninput={(e) => update({ stroke: { ...config.stroke!, color: (e.target as HTMLInputElement).value } })} />
          </div>
          <div class="tc-field" style="flex:0 0 60px;">
            <span class="tc-label">Width</span>
            <input type="number" value={config.stroke.width} min="1" max="10" oninput={(e) => update({ stroke: { ...config.stroke!, width: Number((e.target as HTMLInputElement).value) } })} />
          </div>
        </div>
      {/if}

      <!-- Shadow -->
      <label class="tc-toggle">
        <input type="checkbox" checked={!!config.shadow} onchange={(e) => update({ shadow: (e.target as HTMLInputElement).checked ? { color: "#000000", blur: 4, offsetX: 1, offsetY: 1 } : undefined })} />
        <span>Shadow / Glow</span>
      </label>
      {#if config.shadow}
        <div class="tc-row">
          <div class="tc-field" style="flex:0 0 34px;">
            <span class="tc-label">Color</span>
            <input type="color" value={config.shadow.color} style="width:34px; height:var(--input-h,34px); border:1px solid var(--border); border-radius:var(--radius-sm); padding:2px; background:var(--bg-surface); cursor:pointer;" oninput={(e) => update({ shadow: { ...config.shadow!, color: (e.target as HTMLInputElement).value } })} />
          </div>
          <div class="tc-field" style="flex:1;">
            <span class="tc-label">Blur</span>
            <input type="number" value={config.shadow.blur} min="0" max="20" oninput={(e) => update({ shadow: { ...config.shadow!, blur: Number((e.target as HTMLInputElement).value) } })} />
          </div>
          <div class="tc-field" style="flex:1;">
            <span class="tc-label">X</span>
            <input type="number" value={config.shadow.offsetX} min="-10" max="10" oninput={(e) => update({ shadow: { ...config.shadow!, offsetX: Number((e.target as HTMLInputElement).value) } })} />
          </div>
          <div class="tc-field" style="flex:1;">
            <span class="tc-label">Y</span>
            <input type="number" value={config.shadow.offsetY} min="-10" max="10" oninput={(e) => update({ shadow: { ...config.shadow!, offsetY: Number((e.target as HTMLInputElement).value) } })} />
          </div>
        </div>
      {/if}
    </div>
  {/if}

  <!-- Layout Section -->
  <button class="tc-section-toggle" onclick={() => showLayout = !showLayout}>
    <span>Layout</span>
    <span class="tc-arrow" class:open={showLayout}></span>
  </button>

  {#if showLayout}
    <div class="tc-section">
      <div class="tc-field">
        <span class="tc-label">Anchor</span>
        <div class="tc-chips wide">
          <button class:active={config.anchor === "start"} onclick={() => update({ anchor: "start" })}>Start</button>
          <button class:active={config.anchor === "center"} onclick={() => update({ anchor: "center" })}>Center</button>
          <button class:active={config.anchor === "end"} onclick={() => update({ anchor: "end" })}>End</button>
        </div>
      </div>

      <label class="tc-toggle">
        <input type="checkbox" checked={config.useAbsolutePos} onchange={(e) => update({ useAbsolutePos: (e.target as HTMLInputElement).checked })} />
        <span>Absolute Position</span>
      </label>

      {#if config.useAbsolutePos}
        <div class="tc-row">
          <div class="tc-field" style="flex:1;">
            <span class="tc-label">X</span>
            <input type="number" value={config.x ?? 0} min="-10" max="100" oninput={(e) => update({ x: Number((e.target as HTMLInputElement).value) })} />
          </div>
          <div class="tc-field" style="flex:1;">
            <span class="tc-label">Y</span>
            <input type="number" value={config.y ?? 0} min="-10" max="100" oninput={(e) => update({ y: Number((e.target as HTMLInputElement).value) })} />
          </div>
        </div>
      {:else}
        <div class="tc-row">
          <div class="tc-field" style="flex:1;">
            <span class="tc-label">H-Align</span>
            <div class="tc-chips wide">
              <button class:active={config.hAlign === "left"} onclick={() => update({ hAlign: "left" })}>L</button>
              <button class:active={config.hAlign === "center"} onclick={() => update({ hAlign: "center" })}>C</button>
              <button class:active={config.hAlign === "right"} onclick={() => update({ hAlign: "right" })}>R</button>
            </div>
          </div>
          <div class="tc-field" style="flex:1;">
            <span class="tc-label">V-Align</span>
            <div class="tc-chips wide">
              <button class:active={config.vAlign === "top"} onclick={() => update({ vAlign: "top" })}>T</button>
              <button class:active={config.vAlign === "middle"} onclick={() => update({ vAlign: "middle" })}>M</button>
              <button class:active={config.vAlign === "bottom"} onclick={() => update({ vAlign: "bottom" })}>B</button>
            </div>
          </div>
        </div>
      {/if}
    </div>
  {/if}
</div>

<style>
  .tc { display: flex; flex-direction: column; gap: var(--item-gap, 10px); }

  .tc-field { display: flex; flex-direction: column; gap: 4px; }
  .tc-label { font-size: 10px; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.5px; font-weight: 500; }
  .tc-hint { text-transform: none; font-size: 9px; opacity: 0.5; letter-spacing: 0; font-weight: 400; }

  .tc-row { display: flex; gap: 8px; align-items: flex-end; }

  /* Inputs */
  .tc select,
  .tc input[type="text"],
  .tc input[type="number"] {
    appearance: none; -webkit-appearance: none;
    height: var(--input-h, 34px);
    padding: 0 10px;
    border-radius: var(--radius-sm);
    border: 1px solid var(--border);
    background: var(--bg-surface);
    color: var(--text-primary);
    font-size: 12px;
    outline: none;
    width: 100%;
    transition: border-color 0.15s;
  }
  .tc select { padding-right: 28px; background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%235c5a65' stroke-width='2'><polyline points='6 9 12 15 18 9'/></svg>"); background-repeat: no-repeat; background-position: right 8px center; background-size: 12px; }
  .tc select option { background: var(--bg-secondary); color: var(--text-primary); }
  .tc input:focus, .tc select:focus { border-color: var(--accent); }

  /* Color picker */
  .tc-color { display: flex; gap: 6px; align-items: center; }
  .tc-color input[type="color"] { width: 34px; height: 34px; border: 1px solid var(--border); border-radius: var(--radius-sm); cursor: pointer; padding: 2px; background: var(--bg-surface); flex-shrink: 0; }
  .tc-color input[type="text"] { flex: 1; }

  /* Chip buttons */
  .tc-chips { display: flex; gap: 3px; }
  .tc-chips.wide { flex: 1; }
  .tc-chips button {
    flex: 1; height: 30px;
    border-radius: var(--radius-sm); font-size: 11px; font-weight: 600;
    color: var(--text-muted); background: var(--bg-surface); border: 1px solid var(--border);
    cursor: pointer; transition: all 0.15s;
  }
  .tc-chips button:hover { color: var(--text-primary); border-color: var(--border-light); }
  .tc-chips button.active { background: var(--accent); color: white; border-color: var(--accent); }

  /* Section toggles */
  .tc-section-toggle {
    display: flex; justify-content: space-between; align-items: center;
    padding: 8px 0; margin-top: 2px;
    border-top: 1px solid var(--border);
    font-size: 11px; font-weight: 600; color: var(--text-secondary);
    cursor: pointer; text-transform: uppercase; letter-spacing: 0.5px;
  }
  .tc-section-toggle:hover { color: var(--text-primary); }
  .tc-arrow { width: 0; height: 0; border-left: 4px solid transparent; border-right: 4px solid transparent; border-top: 5px solid currentColor; transition: transform 0.15s; }
  .tc-arrow.open { transform: rotate(180deg); }

  .tc-section { display: flex; flex-direction: column; gap: var(--item-gap, 10px); padding-bottom: 4px; }

  /* Toggle checkbox */
  .tc-toggle {
    display: flex; align-items: center; gap: 6px;
    font-size: 10px; font-weight: 500; text-transform: uppercase; letter-spacing: 0.5px;
    color: var(--text-muted); cursor: pointer;
  }
  .tc-toggle input[type="checkbox"] { accent-color: var(--accent); width: 14px; height: 14px; }

  .tc input[type="number"] { -moz-appearance: textfield; }
</style>
