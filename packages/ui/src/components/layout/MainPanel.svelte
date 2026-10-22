<script lang="ts">
  import DeviceGrid from "../device/DeviceGrid.svelte";
  import Plugins from "../../pages/Plugins.svelte";
  import Profiles from "../../pages/Profiles.svelte";
  import Settings from "../../pages/Settings.svelte";

  type View = "editor" | "plugins" | "profiles" | "settings";
  let { currentView }: { currentView: View } = $props();
</script>

<main class="main-panel" class:centered={currentView === "editor"}>
  {#if currentView === "editor"}
    <DeviceGrid />
  {:else if currentView === "plugins"}
    <Plugins />
  {:else if currentView === "profiles"}
    <Profiles />
  {:else if currentView === "settings"}
    <Settings />
  {/if}
</main>

<style>
  .main-panel { flex: 1; min-width: 0; min-height: 0; overflow-y: auto; padding: 0; }
  .main-panel.centered { display: flex; align-items: center; justify-content: center; padding: 24px; }
</style>
