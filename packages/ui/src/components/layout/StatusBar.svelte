<script lang="ts">
  import { getDevices, getError } from "../../lib/stores/devices.svelte";
  import { store } from "../../lib/stores/store.svelte";

  let devices = $derived(getDevices());
  let error = $derived(getError());
  let loadError = $derived(store.loadError);
  let lastError = $derived(store.lastError);
</script>

<footer class="status-bar">
  {#if loadError}
    <span class="status-item status-error" title={loadError}>Profile not loaded: {loadError} — showing the previous state; nothing was saved.</span>
    <button class="status-dismiss" onclick={() => store.loadError = null} aria-label="Dismiss profile error">×</button>
  {:else if lastError}
    <span class="status-item status-error" title={lastError}>{lastError}</span>
    <button class="status-dismiss" onclick={() => store.lastError = null} aria-label="Dismiss error">×</button>
  {:else if error}
    <span class="status-item status-error">{error}</span>
  {:else if devices.length > 0}
    <span class="status-item status-ok">{devices.length} device{devices.length > 1 ? 's' : ''} connected</span>
  {:else}
    <span class="status-item">No devices connected</span>
  {/if}
  <span class="status-item status-right">v0.1.0</span>
</footer>

<style>
  .status-bar { display: flex; align-items: center; gap: 6px; height: 28px; padding: 0 12px; background: var(--bg-tertiary); border-top: 1px solid var(--border); font-size: 11px; color: var(--text-muted); }
  .status-item { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
  .status-right { margin-left: auto; flex-shrink: 0; }
  .status-ok { color: var(--success); }
  .status-error { color: var(--danger); }
  .status-dismiss { color: var(--danger); font-size: 14px; line-height: 1; padding: 0 4px; flex-shrink: 0; }
</style>
