<script lang="ts">
  import { getDevices, getError } from "../../lib/stores/devices.svelte";

  let devices = $derived(getDevices());
  let error = $derived(getError());
</script>

<footer class="status-bar">
  {#if error}
    <span class="status-item status-error">{error}</span>
  {:else if devices.length > 0}
    <span class="status-item status-ok">{devices.length} device{devices.length > 1 ? 's' : ''} connected</span>
  {:else}
    <span class="status-item">No devices connected</span>
  {/if}
  <span class="status-item status-right">v0.1.0</span>
</footer>

<style>
  .status-bar { display: flex; align-items: center; height: 28px; padding: 0 12px; background: var(--bg-tertiary); border-top: 1px solid var(--border); font-size: 11px; color: var(--text-muted); }
  .status-right { margin-left: auto; }
  .status-ok { color: var(--success); }
  .status-error { color: var(--danger); }
</style>
