<script lang="ts">
  import { untrack } from "svelte";
  import {
    getActiveProfileName, loadProfile, createProfile, deleteProfile, listProfiles,
    getScenes,
  } from "../lib/stores/editor.svelte";

  /** Same character set the backend accepts for profile file names. */
  function sanitizeProfileName(name: string): string {
    return name.trim().replace(/[^A-Za-z0-9_-]/g, "_");
  }

  let profiles = $state<string[]>([]);
  let activeProfile = $derived(sanitizeProfileName(getActiveProfileName()));
  let scenes = $derived(getScenes());
  let newProfileName = $state("");
  let error = $state<string | null>(null);
  let sanitizedNew = $derived(sanitizeProfileName(newProfileName));

  async function refresh() {
    try {
      profiles = await listProfiles();
    } catch (e) {
      error = `Could not list profiles: ${String(e)}`;
    }
  }

  async function handleCreate() {
    error = null;
    const name = sanitizedNew;
    if (!name || /^_+$/.test(name)) { error = "Enter a profile name using letters, digits, '-' or '_'."; return; }
    await refresh();
    if (profiles.includes(name)) { error = `A profile named "${name}" already exists. Load it or pick another name.`; return; }
    try {
      await createProfile(name);
      newProfileName = "";
    } catch (e) {
      error = `Could not create profile: ${String(e)}`;
    }
    await refresh();
  }

  async function handleSwitch(name: string) {
    error = null;
    try {
      await loadProfile(name);
    } catch (e) {
      error = `Could not load profile "${name}": ${String(e)}`;
    }
  }

  async function handleDelete(name: string) {
    if (name === activeProfile) return; // can't delete active
    if (!confirm(`Delete profile "${name}"? This cannot be undone.`)) return;
    error = null;
    try {
      await deleteProfile(name);
    } catch (e) {
      error = `Could not delete profile "${name}": ${String(e)}`;
    }
    await refresh();
  }

  $effect(() => { untrack(() => refresh()); });
</script>

<div class="profiles-page">
  <h2>Profiles</h2>
  <p class="hint">A profile stores all your scenes, key assignments, and triggers. Switch between profiles for different setups.</p>

  <div class="active-section">
    <h3>Active: {activeProfile}</h3>
    <p class="scene-count">{scenes.length} scene{scenes.length !== 1 ? 's' : ''}</p>
  </div>

  {#if error}
    <p class="error" role="alert">{error}</p>
  {/if}

  <div class="create-block">
  <div class="create-section">
    <input type="text" aria-label="New profile name" bind:value={newProfileName} placeholder="New profile name..." onkeydown={(e) => { if (e.key === 'Enter') handleCreate(); }} />
    <button class="create-btn" onclick={handleCreate} disabled={!newProfileName.trim()}>Create</button>
  </div>
  {#if newProfileName.trim() && sanitizedNew !== newProfileName.trim()}
    <p class="name-hint">Will be saved as <code>{sanitizedNew}</code></p>
  {/if}
  </div>

  <div>
    <h3>Saved Profiles</h3>
    {#if profiles.length === 0}
      <p class="empty">No saved profiles yet. Changes auto-save to the active profile.</p>
    {:else}
      {#each profiles as name (name)}
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
  .error { font-size: 12px; color: var(--danger); background: rgba(239,83,80,0.1); border-radius: var(--radius-sm); padding: 8px 10px; margin-bottom: 12px; }
  .create-block { margin-bottom: 24px; }
  .create-section { display: flex; gap: 8px; }
  .create-section input { flex: 1; padding: 10px 14px; border-radius: var(--radius-sm); border: 1px solid var(--border); background: var(--bg-secondary); color: var(--text-primary); font-size: 14px; outline: none; }
  .create-section input:focus { border-color: var(--accent); }
  .create-btn { padding: 10px 20px; border-radius: var(--radius-sm); background: var(--accent); color: white; font-size: 13px; cursor: pointer; }
  .create-btn:hover { opacity: 0.9; }
  .create-btn:disabled { opacity: 0.5; cursor: default; }
  .name-hint { font-size: 11px; color: var(--text-muted); margin-top: 6px; }
  .name-hint code { background: var(--bg-tertiary); padding: 1px 4px; border-radius: 3px; }
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
