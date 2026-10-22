<script lang="ts">
  import {
    getSelectedKeyIndex, assignAction, getRecentActions, getFavoriteActions,
    toggleFavorite, isFavorite,
  } from "../../lib/stores/editor.svelte";
  import type { ActionDef } from "../../lib/stores/editor.svelte";

  type View = "editor" | "plugins" | "profiles" | "settings";
  let { currentView }: { currentView: View } = $props();

  let selectedKey = $derived(getSelectedKeyIndex());
  let recent = $derived(getRecentActions());
  let favorites = $derived(getFavoriteActions());

  function handleClick(action: ActionDef) {
    if (selectedKey !== null) {
      assignAction(selectedKey, action);
    }
  }

  function handleFavToggle(e: Event, actionId: string) {
    e.stopPropagation();
    toggleFavorite(actionId);
  }
</script>

<aside class="sidebar">
  {#if currentView === "editor"}
    {#if favorites.length > 0}
      <div class="sidebar-section">
        <h3 class="sidebar-title">Favorites</h3>
        <div class="action-list">
          {#each favorites as action}
            <button
              class="action-item"
              draggable="true"
              ondragstart={(e) => { e.dataTransfer!.setData("action-id", action.id); e.dataTransfer!.effectAllowed = "copy"; }}
              onclick={() => handleClick(action)}
            >
              <span class="action-icon" style="background: {action.color}22; color: {action.color};">{action.icon}</span>
              <span class="action-label">{action.label}</span>
              <span class="fav-btn active" onclick={(e) => handleFavToggle(e, action.id)} title="Remove favorite">★</span>
            </button>
          {/each}
        </div>
      </div>
    {/if}

    {#if recent.length > 0}
      <div class="sidebar-section">
        <h3 class="sidebar-title">Recent</h3>
        <div class="action-list">
          {#each recent as action}
            <button
              class="action-item"
              draggable="true"
              ondragstart={(e) => { e.dataTransfer!.setData("action-id", action.id); e.dataTransfer!.effectAllowed = "copy"; }}
              onclick={() => handleClick(action)}
            >
              <span class="action-icon" style="background: {action.color}22; color: {action.color};">{action.icon}</span>
              <span class="action-label">{action.label}</span>
              {#if !isFavorite(action.id)}
                <span class="fav-btn" onclick={(e) => handleFavToggle(e, action.id)} title="Add to favorites">☆</span>
              {/if}
            </button>
          {/each}
        </div>
      </div>
    {/if}

    {#if recent.length === 0 && favorites.length === 0}
      <div class="sidebar-section">
        <p class="sidebar-hint">Select a key, then pick an action from the Action tab on the right to get started.</p>
      </div>
    {/if}
  {:else}
    <div class="sidebar-section">
      <p class="sidebar-placeholder">{currentView}</p>
    </div>
  {/if}
</aside>

<style>
  .sidebar {
    width: 180px; min-width: 180px; background: var(--bg-secondary);
    border-right: 1px solid var(--border); overflow-y: auto; padding: 12px;
  }
  .sidebar-section { margin-bottom: 16px; }
  .sidebar-title {
    font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px;
    color: var(--text-muted); margin-bottom: 6px;
  }
  .sidebar-hint { font-size: 12px; color: var(--text-muted); line-height: 1.5; }
  .action-list { display: flex; flex-direction: column; gap: 2px; }
  .action-item {
    display: flex; align-items: center; gap: 6px; padding: 5px 6px;
    border-radius: var(--radius-sm); font-size: 12px; color: var(--text-secondary);
    cursor: pointer; text-align: left; width: 100%;
  }
  .action-item:hover:not(:disabled) { background: var(--bg-tertiary); color: var(--text-primary); }
  .action-item:disabled { opacity: 0.4; cursor: not-allowed; }
  .action-icon {
    width: 24px; height: 24px; border-radius: 5px; display: flex;
    align-items: center; justify-content: center; font-size: 12px; flex-shrink: 0;
  }
  .action-label { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .fav-btn {
    font-size: 12px; color: var(--text-muted); cursor: pointer; padding: 0 2px;
    line-height: 1; flex-shrink: 0;
  }
  .fav-btn:hover { color: var(--warning); }
  .fav-btn.active { color: var(--warning); }
  .sidebar-placeholder { color: var(--text-muted); font-size: 13px; text-transform: capitalize; }
</style>
