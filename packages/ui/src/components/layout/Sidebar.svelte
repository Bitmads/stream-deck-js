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

  function handleDragStart(e: DragEvent, action: ActionDef) {
    if (!e.dataTransfer) return;
    e.dataTransfer.setData("action-id", action.id);
    e.dataTransfer.effectAllowed = "copy";
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
          {#each favorites as action (action.id)}
            <div class="action-row">
              <button
                class="action-item"
                draggable="true"
                ondragstart={(e) => handleDragStart(e, action)}
                onclick={() => handleClick(action)}
                title={selectedKey === null ? "Select a key first, or drag onto a key" : `Assign to key ${selectedKey}`}
              >
                <span class="action-icon" style="background: {action.color}22; color: {action.color};">{action.icon}</span>
                <span class="action-label">{action.label}</span>
              </button>
              <button class="fav-btn active" onclick={(e) => handleFavToggle(e, action.id)} title="Remove favorite" aria-label="Remove {action.label} from favorites">★</button>
            </div>
          {/each}
        </div>
      </div>
    {/if}

    {#if recent.length > 0}
      <div class="sidebar-section">
        <h3 class="sidebar-title">Recent</h3>
        <div class="action-list">
          {#each recent as action (action.id)}
            <div class="action-row">
              <button
                class="action-item"
                draggable="true"
                ondragstart={(e) => handleDragStart(e, action)}
                onclick={() => handleClick(action)}
                title={selectedKey === null ? "Select a key first, or drag onto a key" : `Assign to key ${selectedKey}`}
              >
                <span class="action-icon" style="background: {action.color}22; color: {action.color};">{action.icon}</span>
                <span class="action-label">{action.label}</span>
              </button>
              {#if !isFavorite(action.id)}
                <button class="fav-btn" onclick={(e) => handleFavToggle(e, action.id)} title="Add to favorites" aria-label="Add {action.label} to favorites">☆</button>
              {/if}
            </div>
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
  .action-row { display: flex; align-items: center; border-radius: var(--radius-sm); }
  .action-row:hover { background: var(--bg-tertiary); }
  .action-item {
    display: flex; align-items: center; gap: 6px; padding: 5px 6px;
    border-radius: var(--radius-sm); font-size: 12px; color: var(--text-secondary);
    cursor: pointer; text-align: left; flex: 1; min-width: 0;
  }
  .action-item:hover { color: var(--text-primary); }
  .action-icon {
    width: 24px; height: 24px; border-radius: 5px; display: flex;
    align-items: center; justify-content: center; font-size: 12px; flex-shrink: 0;
  }
  .action-label { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .fav-btn {
    font-size: 12px; color: var(--text-muted); cursor: pointer; padding: 0 6px;
    line-height: 1; flex-shrink: 0;
  }
  .fav-btn:hover { color: var(--warning); }
  .fav-btn.active { color: var(--warning); }
  .sidebar-placeholder { color: var(--text-muted); font-size: 13px; text-transform: capitalize; }
</style>
