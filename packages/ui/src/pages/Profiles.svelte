<script lang="ts">
  import {
    getActiveProfileName, loadProfile, createProfile, deleteProfile, listProfiles,
    getScenes,
  } from "../lib/stores/editor.svelte";

  let profiles = $state<string[]>([]);
  let activeProfile = $derived(getActiveProfileName());
  let scenes = $derived(getScenes());
  let newProfileName = $state("");

  async function refresh() {
    profiles = await listProfiles();
  }

  refresh();

  async function handleCreate() {
    const name = newProfileName.trim();
    if (!name) return;
    await createProfile(name);
    newProfileName = "";
    await refresh();
  }

  async function handleSwitch(name: string) {
    await loadProfile(name);
  }

  async function handleDelete(name: string) {
    if (name === activeProfile) return; // can't delete active
    await deleteProfile(name);
    await refresh();
  }
</script>

<div class="profiles-page">
  <h2>Profiles</h2>
  <p class="hint">A profile stores all your scenes, key assignments, and triggers. Switch between profiles for different setups.</p>

  <div class="active-section">
    <h3>Active: {activeProfile}</h3>
    <p class="scene-count">{scenes.length} scene{scenes.length !== 1 ? 's' : ''}</p>
  </div>

  <div class="create-section">
    <input type="text" bind:value={newProfileName} placeholder="New profile name..." onkeydown={(e) => { if (e.key === 'Enter') handleCreate(); }} />
    <button class="create-btn" onclick={handleCreate}>Create</button>
  </div>

  <div class="profile-list">
    <h3>Saved Profiles</h3>
    {#if profiles.length === 0}
      <p class="empty">No saved profiles yet. Changes auto-save to the active profile.</p>
    {:else}
      {#each profiles as name}
        <div class="profile-item" class:active={name === activeProfile}>
          <span class="profile-name">{name}</span>
          {#if name === activeProfile}
            <span class="active-badge">Active</span>
          {:else}
            <button class="switch-btn" onclick={() => handleSwitch(name)}>Load</button>
            <button class="delete-btn" onclick={() => handleDelete(name)}>Delete</button>
          {/if}
        </div>
      {/each}
    {/if}
  </div>
</div>

<style>
  .profiles-page { padding: 24px; max-width: 600px; margin: 0 auto; }
  h2 { font-size: 20px; color: var(--text-primary); margin-bottom: 8px; }
  h3 { font-size: 14px; color: var(--text-secondary); margin-bottom: 8px; }
  .hint { font-size: 13px; color: var(--text-muted); margin-bottom: 20px; line-height: 1.5; }
  .active-section { background: var(--bg-secondary); padding: 16px; border-radius: var(--radius); margin-bottom: 20px; border: 1px solid var(--accent); }
  .scene-count { font-size: 12px; color: var(--text-muted); margin-top: 4px; }
  .create-section { display: flex; gap: 8px; margin-bottom: 24px; }
  .create-section input { flex: 1; padding: 10px 14px; border-radius: var(--radius-sm); border: 1px solid var(--border); background: var(--bg-secondary); color: var(--text-primary); font-size: 14px; outline: none; }
  .create-section input:focus { border-color: var(--accent); }
  .create-btn { padding: 10px 20px; border-radius: var(--radius-sm); background: var(--accent); color: white; font-size: 13px; cursor: pointer; }
  .create-btn:hover { opacity: 0.9; }
  .profile-list { }
  .empty { font-size: 13px; color: var(--text-muted); margin-top: 8px; }
  .profile-item { display: flex; align-items: center; gap: 8px; padding: 12px; background: var(--bg-secondary); border-radius: var(--radius-sm); margin-bottom: 6px; border: 1px solid var(--border); }
  .profile-item.active { border-color: var(--accent); }
  .profile-name { flex: 1; font-size: 14px; color: var(--text-primary); }
  .active-badge { font-size: 11px; color: var(--accent); background: rgba(0,120,255,0.1); padding: 3px 10px; border-radius: 10px; }
  .switch-btn { padding: 4px 12px; border-radius: var(--radius-sm); background: var(--bg-tertiary); color: var(--text-secondary); font-size: 12px; cursor: pointer; }
  .switch-btn:hover { background: var(--accent); color: white; }
  .delete-btn { padding: 4px 12px; border-radius: var(--radius-sm); background: rgba(231,76,60,0.1); color: var(--danger); font-size: 12px; cursor: pointer; }
  .delete-btn:hover { background: rgba(231,76,60,0.2); }
</style>
