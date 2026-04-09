<script lang="ts">
  import { getAllVariables } from "../../lib/stores/variables.svelte";

  let {
    value = "",
    placeholder = "",
    onchange,
    multiline = false,
    rows = 1,
  }: {
    value: string;
    placeholder?: string;
    onchange: (value: string) => void;
    multiline?: boolean;
    rows?: number;
  } = $props();

  let showSuggestions = $state(false);
  let query = $state("");
  let cursorPos = $state(0);
  let inputEl = $state<HTMLInputElement | HTMLTextAreaElement | null>(null);

  let suggestions = $derived(() => {
    if (!showSuggestions || !query) return [];
    const vars = getAllVariables();
    const q = query.toLowerCase();
    return Object.keys(vars)
      .filter(k => k.toLowerCase().includes(q))
      .slice(0, 12)
      .map(k => ({ name: k, value: vars[k] }));
  });

  function handleInput(e: Event) {
    const el = e.target as HTMLInputElement | HTMLTextAreaElement;
    const val = el.value;
    cursorPos = el.selectionStart || 0;
    onchange(val);

    // Check if cursor is inside a {{ }} block being typed
    const before = val.substring(0, cursorPos);
    const openIdx = before.lastIndexOf("{{");
    const closeIdx = before.lastIndexOf("}}");

    if (openIdx > closeIdx) {
      // Inside an open {{ — extract partial variable name
      const partial = before.substring(openIdx + 2).replace(/^\$/, "");
      query = partial;
      showSuggestions = true;
    } else {
      showSuggestions = false;
    }
  }

  function insertVariable(name: string) {
    const el = inputEl;
    if (!el) return;

    const val = value;
    const before = val.substring(0, cursorPos);
    const openIdx = before.lastIndexOf("{{");

    if (openIdx >= 0) {
      const after = val.substring(cursorPos);
      // Check if there's a closing }} after cursor
      const closeAfter = after.indexOf("}}");
      const afterClean = closeAfter >= 0 ? after.substring(closeAfter + 2) : after;
      const newVal = val.substring(0, openIdx) + `{{$${name}}}` + afterClean;
      onchange(newVal);
    }

    showSuggestions = false;
    query = "";
    // Refocus
    requestAnimationFrame(() => el.focus());
  }

  function handleKeyDown(e: KeyboardEvent) {
    if (e.key === "Escape" && showSuggestions) {
      showSuggestions = false;
      e.preventDefault();
    }
  }

  function handleBlur() {
    // Delay to allow click on suggestion
    setTimeout(() => { showSuggestions = false; }, 150);
  }
</script>

<div class="var-input-wrap">
  {#if multiline}
    <textarea
      bind:this={inputEl}
      {value}
      {placeholder}
      {rows}
      oninput={handleInput}
      onkeydown={handleKeyDown}
      onblur={handleBlur}
    ></textarea>
  {:else}
    <input
      bind:this={inputEl}
      type="text"
      {value}
      {placeholder}
      oninput={handleInput}
      onkeydown={handleKeyDown}
      onblur={handleBlur}
    />
  {/if}
  {#if showSuggestions && suggestions().length > 0}
    <div class="var-suggestions">
      {#each suggestions() as s}
        <button class="var-item" onmousedown={() => insertVariable(s.name)}>
          <span class="var-name">${s.name}</span>
          <span class="var-val">{s.value.length > 30 ? s.value.substring(0, 30) + '...' : s.value}</span>
        </button>
      {/each}
    </div>
  {/if}
</div>

<style>
  .var-input-wrap { position: relative; width: 100%; }
  .var-input-wrap textarea,
  .var-input-wrap input[type="text"] {
    width: 100%;
    padding: 6px 8px;
    border-radius: var(--radius-sm);
    border: 1px solid var(--border);
    background: var(--bg-primary);
    color: var(--text-primary);
    font-size: 12px;
    outline: none;
    resize: vertical;
  }
  .var-input-wrap textarea:focus,
  .var-input-wrap input:focus { border-color: var(--accent); }

  .var-suggestions {
    position: absolute;
    top: 100%;
    left: 0;
    right: 0;
    z-index: 100;
    background: var(--bg-secondary);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    max-height: 180px;
    overflow-y: auto;
    box-shadow: 0 4px 12px rgba(0,0,0,0.3);
  }
  .var-item {
    display: flex;
    justify-content: space-between;
    align-items: center;
    width: 100%;
    padding: 5px 8px;
    font-size: 11px;
    cursor: pointer;
    text-align: left;
    border-bottom: 1px solid var(--border);
  }
  .var-item:last-child { border-bottom: none; }
  .var-item:hover { background: var(--bg-tertiary); }
  .var-name { color: var(--accent); font-family: monospace; }
  .var-val { color: var(--text-muted); font-size: 10px; max-width: 50%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
