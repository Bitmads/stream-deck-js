<script lang="ts">
  import { getActiveScene, getActiveSceneId, updateSceneTriggers } from "../../lib/stores/editor.svelte";
  import type { SceneTrigger } from "../../lib/stores/editor.svelte";

  let scene = $derived(getActiveScene());
  let sceneId = $derived(getActiveSceneId());
  let triggers = $derived(scene?.triggers ?? []);

  let { open = $bindable() }: { open: boolean } = $props();

  function addWindowTrigger() {
    if (!sceneId) return;
    updateSceneTriggers(sceneId, [...triggers, { type: "window", app_name: "", window_title: "", priority: 0 }]);
  }

  function removeTrigger(index: number) {
    if (!sceneId) return;
    updateSceneTriggers(sceneId, triggers.filter((_, i) => i !== index));
  }

  function updateTrigger(index: number, partial: Partial<SceneTrigger>) {
    if (!sceneId) return;
    const updated = triggers.map((t, i) => i === index ? { ...t, ...partial } : t);
    updateSceneTriggers(sceneId, updated);
  }
</script>

{#if open && scene}
  <div class="trigger-editor">
    <div class="te-header">
      <h4>Triggers for "{scene.name}"</h4>
      <button class="te-close" onclick={() => open = false}>X</button>
    </div>
    <p class="te-hint">When a trigger matches, this scene activates automatically.</p>

    {#each triggers as trigger, i}
      <div class="trigger-row">
        {#if trigger.type === "window"}
          <div class="trigger-fields">
            <div class="tf">
              <span class="tf-label">App name</span>
              <input class="tf-input" type="text" value={trigger.app_name || ''} placeholder="e.g. phpstorm, firefox, Code" oninput={(e) => updateTrigger(i, { app_name: (e.target as HTMLInputElement).value })} />
            </div>
            <div class="tf">
              <span class="tf-label">Window title</span>
              <input class="tf-input" type="text" value={trigger.window_title || ''} placeholder="regex:.*\.rs$ or keyword" oninput={(e) => updateTrigger(i, { window_title: (e.target as HTMLInputElement).value })} />
            </div>
            <div class="tf">
              <span class="tf-label">Priority</span>
              <input class="tf-input" type="number" value={trigger.priority ?? 0} oninput={(e) => updateTrigger(i, { priority: Number((e.target as HTMLInputElement).value) })} />
            </div>
          </div>
        {:else if trigger.type === "manual"}
          <span class="trigger-type">Manual</span>
        {/if}
        <button class="trigger-remove" onclick={() => removeTrigger(i)}>X</button>
      </div>
    {/each}

    <button class="te-add" onclick={addWindowTrigger}>+ Add Window Trigger</button>
  </div>
{/if}

<style>
  .trigger-editor {
    background: var(--bg-secondary); border: 1px solid var(--border); border-radius: var(--radius);
    padding: 12px; margin: 8px 16px; box-shadow: var(--shadow);
  }
  .te-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px; }
  .te-header h4 { font-size: 13px; color: var(--text-primary); margin: 0; }
  .te-close { font-size: 12px; color: var(--text-muted); cursor: pointer; padding: 2px 6px; }
  .te-close:hover { color: var(--danger); }
  .te-hint { font-size: 11px; color: var(--text-muted); margin-bottom: 8px; }
  .trigger-row { display: flex; gap: 6px; align-items: flex-start; margin-bottom: 8px; padding: 8px; background: var(--bg-primary); border-radius: var(--radius-sm); }
  .trigger-fields { display: flex; flex-direction: column; gap: 4px; flex: 1; }
  .tf { display: flex; align-items: center; gap: 6px; }
  .tf-label { font-size: 10px; color: var(--text-muted); min-width: 70px; text-transform: uppercase; }
  .tf-input { flex: 1; padding: 4px 6px; border-radius: var(--radius-sm); border: 1px solid var(--border); background: var(--bg-secondary); color: var(--text-primary); font-size: 12px; outline: none; }
  .tf-input:focus { border-color: var(--accent); }
  .trigger-type { font-size: 12px; color: var(--text-muted); flex: 1; }
  .trigger-remove { font-size: 11px; color: var(--danger); cursor: pointer; padding: 2px 6px; flex-shrink: 0; }
  .trigger-remove:hover { background: rgba(231,76,60,0.15); border-radius: var(--radius-sm); }
  .te-add { font-size: 12px; color: var(--accent); cursor: pointer; padding: 4px 8px; border-radius: var(--radius-sm); }
  .te-add:hover { background: var(--bg-tertiary); }
</style>
