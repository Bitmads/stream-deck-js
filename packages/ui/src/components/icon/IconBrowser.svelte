<script lang="ts">
  import indexData from "../../assets/icons/index.json";

  let {
    onSelect,
    onStyleChange,
    currentColor,
    currentSize,
  }: {
    onSelect: (setId: string, name: string, body: string, viewBox: string, color: string, size: number) => void;
    onStyleChange: (color: string, size: number) => void;
    currentColor?: string;
    currentSize?: number;
  } = $props();

  let searchQuery = $state("");
  let activeSet = $state<"all" | string>("all");
  let iconColor = $state(currentColor || "#ffffff");
  let iconSize = $state(currentSize || 48);

  type SetIndex = Record<string, { name: string; count: number }>;
  const setIndex = indexData as SetIndex;
  const setIds = Object.keys(setIndex);

  // Lazy-loaded icon data cache (reactive so UI updates as sets finish loading)
  let loadedSets = $state<Record<string, { icons: Record<string, string>; w: number; h: number }>>({});
  let loadingSetsCount = $state(0);

  async function loadSet(prefix: string) {
    if (loadedSets[prefix]) return;
    loadingSetsCount++;
    try {
      const mod = await import(`../../assets/icons/${prefix}.json`);
      loadedSets[prefix] = mod.default || mod;
    } catch (e) {
      console.error("Failed to load icon set:", prefix, e);
    }
    loadingSetsCount--;
  }

  // Load all sets in background on mount (lazy across multiple frames)
  async function loadAllSetsBackground() {
    for (const id of setIds) {
      if (!loadedSets[id]) {
        await loadSet(id);
        // Yield to browser between loads so the UI stays responsive
        await new Promise(r => setTimeout(r, 0));
      }
    }
  }
  loadAllSetsBackground();

  // Search results across all loaded sets (or just active if filtered)
  let results = $derived(() => {
    const q = searchQuery.toLowerCase().trim();
    const matches: Array<{ setId: string; name: string; body: string; w: number; h: number }> = [];
    const sources = activeSet === "all" ? setIds : [activeSet];
    const limit = 300;

    for (const setId of sources) {
      const set = loadedSets[setId];
      if (!set) continue;
      for (const [name, body] of Object.entries(set.icons)) {
        if (!q || name.toLowerCase().includes(q)) {
          matches.push({ setId, name, body, w: set.w, h: set.h });
          if (matches.length >= limit) return matches;
        }
      }
    }
    return matches;
  });

  function handleSelect(setId: string, name: string, body: string, w: number, h: number) {
    const vb = `0 0 ${w} ${h}`;
    onSelect(setId, name, body, vb, iconColor, iconSize);
  }

  function handleColorChange(e: Event) {
    iconColor = (e.target as HTMLInputElement).value;
    onStyleChange(iconColor, iconSize);
  }

  function handleSizeChange(e: Event) {
    iconSize = Number((e.target as HTMLInputElement).value);
    onStyleChange(iconColor, iconSize);
  }
</script>

<div class="icon-browser">
  <input
    class="search-input"
    type="text"
    placeholder="Search all icons..."
    bind:value={searchQuery}
  />

  <div class="set-tabs">
    <button class="set-tab" class:active={activeSet === "all"} onclick={() => activeSet = "all"}>
      All
    </button>
    {#each setIds as id}
      <button class="set-tab" class:active={activeSet === id} onclick={() => activeSet = id} title="{setIndex[id].name} ({setIndex[id].count})">
        {setIndex[id].name}
      </button>
    {/each}
  </div>

  <div class="icon-controls">
    <div class="control">
      <span>Color</span>
      <input type="color" value={iconColor} oninput={handleColorChange} />
    </div>
    <div class="control">
      <span>Size</span>
      <input type="range" min="16" max="72" value={iconSize} oninput={handleSizeChange} />
      <span class="val">{iconSize}px</span>
    </div>
    {#if loadingSetsCount > 0}
      <span class="loading-badge">Loading {loadingSetsCount} set{loadingSetsCount > 1 ? 's' : ''}…</span>
    {/if}
  </div>

  <div class="icon-grid">
    {#each results() as r (r.setId + ":" + r.name)}
      <button class="icon-cell" title="{r.name} ({setIndex[r.setId]?.name})" onclick={() => handleSelect(r.setId, r.name, r.body, r.w, r.h)}>
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 {r.w} {r.h}"
          width="26" height="26"
          fill="none" stroke={iconColor} stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
        >
          {@html r.body}
        </svg>
        <span class="icon-name">{r.name}</span>
      </button>
    {/each}
    {#if results().length === 0}
      {#if loadingSetsCount > 0}
        <p class="no-results">Loading icons…</p>
      {:else if searchQuery}
        <p class="no-results">No icons match "{searchQuery}"</p>
      {:else}
        <p class="no-results">No icons available</p>
      {/if}
    {/if}
  </div>
</div>

<style>
  .icon-browser { display: flex; flex-direction: column; gap: 6px; }
  .search-input { width: 100%; padding: 7px 10px; border-radius: var(--radius-sm); border: 1px solid var(--border); background: var(--bg-primary); color: var(--text-primary); font-size: 12px; outline: none; }
  .search-input:focus { border-color: var(--accent); }
  .set-tabs { display: flex; gap: 3px; flex-wrap: wrap; }
  .set-tab { padding: 3px 6px; border-radius: var(--radius-sm); font-size: 10px; color: var(--text-muted); cursor: pointer; white-space: nowrap; background: var(--bg-primary); border: 1px solid var(--border); }
  .set-tab:hover { background: var(--bg-tertiary); color: var(--text-primary); }
  .set-tab.active { background: var(--accent); color: white; border-color: var(--accent); }
  .icon-controls { display: flex; gap: 10px; align-items: center; }
  .control { display: flex; align-items: center; gap: 4px; font-size: 11px; color: var(--text-muted); }
  .control input[type="color"] { width: 22px; height: 22px; border: none; border-radius: 4px; cursor: pointer; background: none; padding: 0; }
  .control input[type="range"] { width: 55px; }
  .val { font-size: 10px; }
  .loading-badge { font-size: 10px; color: var(--text-muted); margin-left: auto; font-style: italic; }
  .icon-grid { display: grid; grid-template-columns: repeat(auto-fill, 52px); gap: 3px; max-height: 300px; overflow-y: auto; padding: 2px; }
  .icon-cell { width: 52px; height: 52px; display: flex; flex-direction: column; align-items: center; justify-content: center; border-radius: var(--radius-sm); cursor: pointer; gap: 1px; background: var(--bg-primary); border: 1px solid transparent; }
  .icon-cell:hover { border-color: var(--accent); background: var(--bg-tertiary); }
  .icon-name { font-size: 6px; color: var(--text-muted); max-width: 48px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .no-results { grid-column: 1 / -1; text-align: center; color: var(--text-muted); font-size: 12px; padding: 20px; }
</style>
