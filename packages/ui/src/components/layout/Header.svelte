<script lang="ts">
  import { getDevices, getSelectedDevice, selectDevice } from "../../lib/stores/devices.svelte";
  import {
    getScenes, getActiveSceneId, switchScene, createScene, deleteScene, renameScene,
  } from "../../lib/stores/editor.svelte";
  import TriggerEditor from "./TriggerEditor.svelte";

  type View = "editor" | "profiles" | "plugins" | "settings";
  let { currentView = $bindable() }: { currentView: View } = $props();

  const tabs: { id: View; label: string }[] = [
    { id: "editor", label: "Editor" },
    { id: "profiles", label: "Profiles" },
    { id: "plugins", label: "Plugins" },
    { id: "settings", label: "Settings" },
  ];

  let devices = $derived(getDevices());
  let selected = $derived(getSelectedDevice());
  let scenes = $derived(getScenes());
  let activeSceneId = $derived(getActiveSceneId());
  let deviceDropdownOpen = $state(false);

  function handleDeviceSelect(dev: typeof devices[0]) {
    selectDevice(dev);
    deviceDropdownOpen = false;
  }

  let showTriggers = $state(false);
  let editingSceneId = $state<string | null>(null);
  let editName = $state("");

  function startRename(id: string, name: string) {
    editingSceneId = id;
    editName = name;
  }

  function finishRename() {
    if (editingSceneId && editName.trim()) {
      renameScene(editingSceneId, editName.trim());
    }
    editingSceneId = null;
  }

  function handleAddScene() {
    const scene = createScene("New Scene");
    switchScene(scene.id);
  }

  function autoFocus(node: HTMLInputElement) {
    node.focus();
    node.select();
  }
</script>

<header class="header">
  <div class="logo">
    <span class="logo-text">Open Stream Deck</span>
  </div>
  <nav class="tabs">
    {#each tabs as tab}
      <button class="tab" class:active={currentView === tab.id} onclick={() => (currentView = tab.id)}>
        {tab.label}
      </button>
    {/each}
  </nav>
  <div class="header-actions">
    {#if devices.length > 1}
      <div class="device-dropdown">
        <button class="device-selector" onclick={() => deviceDropdownOpen = !deviceDropdownOpen}>
          <span class="device-dot"></span>
          {selected?.model || 'Select device'}
          <span class="dropdown-arrow">{deviceDropdownOpen ? '▲' : '▼'}</span>
        </button>
        {#if deviceDropdownOpen}
          <div class="device-menu">
            {#each devices as dev}
              <button
                class="device-option"
                class:active={selected?.serial === dev.serial}
                onclick={() => handleDeviceSelect(dev)}
              >
                {dev.model}
                <span class="device-serial">{dev.serial.substring(0, 8)}</span>
              </button>
            {/each}
          </div>
        {/if}
      </div>
    {:else if selected}
      <span class="device-indicator connected"><span class="device-dot"></span> {selected.model}</span>
    {:else}
      <span class="device-indicator">No device</span>
    {/if}
  </div>
</header>

{#if currentView === "editor"}
  <div class="scene-bar">
    <div class="scene-tabs">
      {#each scenes as scene}
        <button
          class="scene-tab"
          class:active={activeSceneId === scene.id}
          onclick={() => switchScene(scene.id)}
          ondblclick={() => startRename(scene.id, scene.name)}
        >
          {#if editingSceneId === scene.id}
            <input
              class="scene-rename"
              type="text"
              bind:value={editName}
              onblur={finishRename}
              onkeydown={(e) => { if (e.key === 'Enter') finishRename(); if (e.key === 'Escape') editingSceneId = null; }}
              use:autoFocus
            />
          {:else}
            {scene.name}
          {/if}
        </button>
      {/each}
      <button class="scene-add" onclick={handleAddScene} title="New scene">+</button>
    </div>
    <button class="scene-triggers-btn" onclick={() => showTriggers = !showTriggers}>
      {showTriggers ? 'Hide' : 'Triggers'}
    </button>
    {#if activeSceneId && scenes.length > 1}
      <button class="scene-delete" onclick={() => { if (activeSceneId) deleteScene(activeSceneId); }}>Delete</button>
    {/if}
  </div>
  <TriggerEditor bind:open={showTriggers} />
{/if}

<style>
  .header {
    display: flex; align-items: center; height: 48px; padding: 0 16px;
    background: var(--bg-secondary); border-bottom: 1px solid var(--border); gap: 24px;
  }
  .logo-text { font-weight: 700; font-size: 15px; white-space: nowrap; }
  .tabs { display: flex; gap: 4px; }
  .tab {
    padding: 8px 16px; border-radius: var(--radius-sm); font-size: 13px;
    color: var(--text-secondary); transition: all 0.15s;
  }
  .tab:hover { color: var(--text-primary); background: var(--bg-tertiary); }
  .tab.active { color: var(--accent); background: var(--bg-tertiary); }
  .header-actions { margin-left: auto; }
  .device-indicator { font-size: 12px; color: var(--text-muted); display: flex; align-items: center; gap: 6px; }
  .device-indicator.connected { color: var(--success); }
  .device-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--success); display: inline-block; flex-shrink: 0; }
  .device-dropdown { position: relative; }
  .device-selector {
    display: flex; align-items: center; gap: 6px; padding: 4px 10px;
    border-radius: var(--radius-sm); font-size: 12px; color: var(--success);
    cursor: pointer; background: var(--bg-tertiary); border: 1px solid var(--border);
  }
  .device-selector:hover { border-color: var(--accent); }
  .dropdown-arrow { font-size: 8px; color: var(--text-muted); }
  .device-menu {
    position: absolute; right: 0; top: 100%; margin-top: 4px; min-width: 220px;
    background: var(--bg-secondary); border: 1px solid var(--border); border-radius: var(--radius);
    box-shadow: var(--shadow); z-index: 100; overflow: hidden;
  }
  .device-option {
    display: flex; align-items: center; justify-content: space-between; width: 100%;
    padding: 8px 12px; font-size: 12px; color: var(--text-secondary); cursor: pointer; text-align: left;
  }
  .device-option:hover { background: var(--bg-tertiary); color: var(--text-primary); }
  .device-option.active { color: var(--accent); }
  .device-serial { font-size: 10px; color: var(--text-muted); font-family: monospace; }

  .scene-bar {
    display: flex; align-items: center; height: 36px; padding: 0 16px;
    background: var(--bg-primary); border-bottom: 1px solid var(--border); gap: 8px;
  }
  .scene-tabs { display: flex; gap: 2px; flex: 1; overflow-x: auto; }
  .scene-tab {
    padding: 4px 12px; border-radius: var(--radius-sm); font-size: 12px;
    color: var(--text-muted); white-space: nowrap; cursor: pointer;
    border: 1px solid transparent;
  }
  .scene-tab:hover { color: var(--text-primary); background: var(--bg-secondary); }
  .scene-tab.active { color: var(--accent); background: var(--bg-secondary); border-color: var(--accent); }
  .scene-rename {
    background: transparent; border: none; border-bottom: 1px solid var(--accent);
    color: var(--accent); font-size: 12px; padding: 0; width: 80px; outline: none; border-radius: 0;
  }
  .scene-add {
    padding: 4px 10px; border-radius: var(--radius-sm); font-size: 14px;
    color: var(--text-muted); cursor: pointer;
  }
  .scene-add:hover { color: var(--accent); background: var(--bg-secondary); }
  .scene-triggers-btn {
    font-size: 11px; color: var(--accent); padding: 3px 8px;
    border-radius: var(--radius-sm); cursor: pointer; white-space: nowrap;
  }
  .scene-triggers-btn:hover { background: var(--bg-tertiary); }
  .scene-delete {
    font-size: 11px; color: var(--danger); padding: 3px 8px;
    border-radius: var(--radius-sm); cursor: pointer; white-space: nowrap;
  }
  .scene-delete:hover { background: rgba(231,76,60,0.15); }
</style>
