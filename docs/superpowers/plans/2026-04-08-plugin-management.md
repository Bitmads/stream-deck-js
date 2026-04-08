# Plugin Management System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a unified plugin management system where plugins (built-in and external) can be enabled/disabled from the Plugins page, with dynamic settings sections on the Settings page.

**Architecture:** A new `plugins.svelte.ts` store is the central registry. Built-in plugins (like HA) register themselves with init/destroy lifecycle hooks and optional settings components. Plugin enabled state is persisted in `plugins.json`. The action registration system gets an `unregisterActionType` function so disabled plugins' actions are removed from the picker.

**Tech Stack:** Svelte 5, TypeScript, Tauri IPC (existing `save_json_file`/`load_json_file`)

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `packages/ui/src/lib/stores/plugins.svelte.ts` | Create | Plugin registry store — register, enable, disable, persist |
| `packages/ui/src/lib/plugins/homeassistant/HASettings.svelte` | Create | Extracted HA settings UI component |
| `packages/ui/src/lib/plugins/homeassistant/index.ts` | Modify | Export `haPluginDef`, add `destroyHAPlugin` |
| `packages/ui/src/lib/stores/store.svelte.ts` | Modify | Add `unregisterActionType`, export it |
| `packages/ui/src/lib/stores/editor.svelte.ts` | Modify | Re-export `unregisterActionType` |
| `packages/ui/src/pages/Plugins.svelte` | Modify | Replace empty list with real plugin cards + toggles |
| `packages/ui/src/pages/Settings.svelte` | Modify | Remove hardcoded HA section, add dynamic plugin sections |
| `packages/ui/src/App.svelte` | Modify | Replace `initHAPlugin()` with `initPluginRegistry()` |

---

### Task 1: Add `unregisterActionType` to the store

**Files:**
- Modify: `packages/ui/src/lib/stores/store.svelte.ts:112-131`
- Modify: `packages/ui/src/lib/stores/editor.svelte.ts:3`

- [ ] **Step 1: Add `unregisterActionType` function**

In `packages/ui/src/lib/stores/store.svelte.ts`, after the existing `registerActionType` function (line 121), add:

```typescript
/** Remove a plugin-registered action type from the picker. */
export function unregisterActionType(actionId: string) {
  const idx = pluginActions.findIndex(a => a.id === actionId);
  if (idx >= 0) pluginActions.splice(idx, 1);
  delete pluginExecutors[actionId];
}
```

- [ ] **Step 2: Re-export from editor.svelte.ts**

In `packages/ui/src/lib/stores/editor.svelte.ts`, change line 3 from:

```typescript
export { ACTION_TYPES, store, registerActionType, executePluginAction } from "./store.svelte";
```

to:

```typescript
export { ACTION_TYPES, store, registerActionType, unregisterActionType, executePluginAction } from "./store.svelte";
```

- [ ] **Step 3: Verify the app still compiles**

Run: `cd packages/ui && npx svelte-check --threshold error 2>&1 | tail -20`
Expected: No new errors.

- [ ] **Step 4: Commit**

```bash
git add packages/ui/src/lib/stores/store.svelte.ts packages/ui/src/lib/stores/editor.svelte.ts
git commit -m "feat: add unregisterActionType for plugin disable support"
```

---

### Task 2: Create the Plugin Registry store

**Files:**
- Create: `packages/ui/src/lib/stores/plugins.svelte.ts`

- [ ] **Step 1: Create the plugin registry store**

Create `packages/ui/src/lib/stores/plugins.svelte.ts`:

```typescript
import { invoke } from "@tauri-apps/api/core";
import { registerActionType, unregisterActionType } from "./store.svelte";
import type { ActionDef } from "./store.svelte";
import type { Component } from "svelte";

// ─── Types ───────────────────────────────────────────────────

export interface PluginDef {
  id: string;
  name: string;
  description: string;
  version: string;
  author: string;
  icon: string;
  type: "builtin" | "external";
  init?: () => Promise<void>;
  destroy?: () => Promise<void>;
  settingsComponent?: Component;
  actions?: ActionDef[];
  actionExecutors?: Record<string, (settings: Record<string, string>) => Promise<void>>;
}

interface PluginState {
  enabled: boolean;
}

// ─── Registry State ──────────────────────────────────────────

const plugins = $state<PluginDef[]>([]);
const pluginStates = $state<Record<string, PluginState>>({});

// Track which actions belong to which plugin
const pluginActionMap: Record<string, string[]> = {};

// ─── Persistence ─────────────────────────────────────────────

async function loadPluginStates(): Promise<Record<string, PluginState>> {
  try {
    const raw = await invoke<string | null>("load_json_file", { filename: "plugins" });
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

async function savePluginStates() {
  await invoke("save_json_file", {
    filename: "plugins",
    content: JSON.stringify(pluginStates),
  }).catch(() => {});
}

// ─── Public API ──────────────────────────────────────────────

/** Register a plugin definition. Does not enable it yet. */
export function registerPlugin(def: PluginDef) {
  if (!plugins.find(p => p.id === def.id)) {
    plugins.push(def);
  }
}

/** Enable a plugin: call init(), register actions, persist. */
export async function enablePlugin(id: string) {
  const def = plugins.find(p => p.id === id);
  if (!def) return;

  pluginStates[id] = { enabled: true };

  // Register actions
  if (def.actions) {
    const actionIds: string[] = [];
    for (const action of def.actions) {
      const executor = def.actionExecutors?.[action.id];
      registerActionType(action, executor);
      actionIds.push(action.id);
    }
    pluginActionMap[id] = actionIds;
  }

  // Call init
  if (def.init) {
    await def.init();
  }

  await savePluginStates();
}

/** Disable a plugin: call destroy(), unregister actions, persist. */
export async function disablePlugin(id: string) {
  const def = plugins.find(p => p.id === id);
  if (!def) return;

  // Call destroy
  if (def.destroy) {
    await def.destroy();
  }

  // Unregister actions
  const actionIds = pluginActionMap[id] || [];
  for (const actionId of actionIds) {
    unregisterActionType(actionId);
  }
  delete pluginActionMap[id];

  pluginStates[id] = { enabled: false };
  await savePluginStates();
}

/** Toggle a plugin's enabled state. */
export async function togglePlugin(id: string) {
  if (isEnabled(id)) {
    await disablePlugin(id);
  } else {
    await enablePlugin(id);
  }
}

/** Check if a plugin is enabled. Built-in plugins default to enabled. */
export function isEnabled(id: string): boolean {
  if (id in pluginStates) return pluginStates[id].enabled;
  const def = plugins.find(p => p.id === id);
  return def?.type === "builtin"; // builtin defaults enabled, external defaults disabled
}

/** Get all registered plugins. */
export function getAllPlugins(): PluginDef[] {
  return plugins;
}

/** Get enabled plugins that have a settings component. */
export function getPluginsWithSettings(): PluginDef[] {
  return plugins.filter(p => isEnabled(p.id) && p.settingsComponent);
}

/** Initialize the registry: load persisted states, enable plugins. */
export async function initPluginRegistry() {
  const saved = await loadPluginStates();
  Object.assign(pluginStates, saved);

  // Enable all plugins that should be active
  for (const def of plugins) {
    if (isEnabled(def.id)) {
      await enablePlugin(def.id);
    }
  }
}
```

- [ ] **Step 2: Verify the app still compiles**

Run: `cd packages/ui && npx svelte-check --threshold error 2>&1 | tail -20`
Expected: No new errors.

- [ ] **Step 3: Commit**

```bash
git add packages/ui/src/lib/stores/plugins.svelte.ts
git commit -m "feat: add plugin registry store with enable/disable lifecycle"
```

---

### Task 3: Refactor HA plugin to use the registry

**Files:**
- Create: `packages/ui/src/lib/plugins/homeassistant/HASettings.svelte`
- Modify: `packages/ui/src/lib/plugins/homeassistant/index.ts`

- [ ] **Step 1: Create HASettings.svelte**

Extract the Home Assistant settings section from `packages/ui/src/pages/Settings.svelte` (lines 159-204 template, lines 87-113 script) into a new file `packages/ui/src/lib/plugins/homeassistant/HASettings.svelte`:

```svelte
<script lang="ts">
  import { ha } from "./client";

  let watchSearch = $state("");
  let watchedList = $state<string[]>([]);

  function refreshWatched() { watchedList = ha.getWatchedIds(); }

  let haUrl = $state("");
  let haToken = $state("");
  let haConnected = $state(false);
  let haEntityCount = $state(0);

  async function loadHAConfig() {
    const config = await ha.loadConfig();
    if (config) { haUrl = config.url; haToken = config.token; }
    haConnected = ha.connected;
    haEntityCount = ha.getEntities().length;
    refreshWatched();
  }

  async function handleHAConnect() {
    await ha.saveConfig(haUrl, haToken);
    ha.connect(haUrl, haToken);
    setTimeout(() => { haConnected = ha.connected; haEntityCount = ha.getEntities().length; }, 2000);
  }

  function handleHADisconnect() {
    ha.disconnect();
    haConnected = false;
  }

  loadHAConfig();
</script>

<h3>Home Assistant</h3>
<p class="hint">Connect to Home Assistant for real-time service calls via WebSocket. Much faster than HTTP webhooks.</p>

<div class="ha-status" class:connected={haConnected}>
  {haConnected ? `Connected (${haEntityCount} entities)` : 'Not connected'}
</div>

<div class="ha-fields">
  <input class="input" type="text" bind:value={haUrl} placeholder="https://homeassistant.example.com" />
  <input class="input" type="password" bind:value={haToken} placeholder="Long-lived access token" />
  <div class="ha-buttons">
    {#if haConnected}
      <button class="btn-disconnect" onclick={handleHADisconnect}>Disconnect</button>
    {:else}
      <button class="btn-connect" onclick={handleHAConnect}>Connect</button>
    {/if}
  </div>
</div>
<p class="hint">Get a token: HA → Profile (bottom left) → Long-Lived Access Tokens → Create Token</p>

{#if haConnected}
  <h4 style="margin-top:12px; font-size:13px; color:var(--text-secondary);">Watched Entities</h4>
  <p class="hint">Watched entities auto-sync to variables. Use <code>{'{{$ha.<entity_id>.<attr>}}'}</code> in text labels or encoder bindings.</p>
  <input class="input" type="text" bind:value={watchSearch} placeholder="Search entity to watch..." />
  {#if watchSearch.length > 0}
    <div class="watch-results">
      {#each ha.searchEntities(watchSearch).filter(e => !ha.isWatched(e.entity_id)) as ent}
        <button class="watch-item" onclick={() => { ha.addWatch(ent.entity_id); watchSearch = ""; refreshWatched(); }}>
          <span>+ {ent.friendly_name}</span>
          <span style="font-size:9px; color:var(--text-muted);">{ent.entity_id}</span>
        </button>
      {/each}
    </div>
  {/if}
  {#if watchedList.length > 0}
    <div class="watch-list">
      {#each watchedList as id}
        <div class="watch-entry">
          <span class="watch-name">{ha.getEntity(id)?.friendly_name || id}</span>
          <span class="watch-state">{ha.getEntity(id)?.state || '?'}</span>
          <button class="watch-remove" onclick={() => { ha.removeWatch(id); refreshWatched(); }}>×</button>
        </div>
      {/each}
    </div>
  {/if}
{/if}

<style>
  h3 { font-size: 15px; color: var(--text-secondary); margin-bottom: 8px; }
  .hint { font-size: 12px; color: var(--text-muted); line-height: 1.5; margin-bottom: 12px; }
  .ha-status { padding: 6px 12px; border-radius: var(--radius-sm); font-size: 12px; color: var(--danger); background: rgba(231,76,60,0.1); margin-bottom: 10px; }
  .ha-status.connected { color: var(--success); background: rgba(46,204,113,0.1); }
  .ha-fields { display: flex; flex-direction: column; gap: 6px; margin-bottom: 8px; }
  .ha-fields .input { padding: 8px 12px; }
  .ha-buttons { display: flex; gap: 6px; }
  .btn-connect { padding: 8px 16px; border-radius: var(--radius-sm); background: var(--accent); color: white; font-size: 12px; cursor: pointer; }
  .btn-disconnect { padding: 8px 16px; border-radius: var(--radius-sm); background: rgba(231,76,60,0.15); color: var(--danger); font-size: 12px; cursor: pointer; }
  .watch-results { display: flex; flex-direction: column; gap: 2px; margin-top: 4px; max-height: 150px; overflow-y: auto; }
  .watch-item { display: flex; justify-content: space-between; align-items: center; padding: 5px 8px; border-radius: var(--radius-sm); cursor: pointer; font-size: 12px; color: var(--text-secondary); }
  .watch-item:hover { background: var(--bg-tertiary); color: var(--accent); }
  .watch-list { display: flex; flex-direction: column; gap: 3px; margin-top: 8px; }
  .watch-entry { display: flex; align-items: center; gap: 8px; padding: 6px 8px; background: var(--bg-primary); border-radius: var(--radius-sm); font-size: 12px; }
  .watch-name { flex: 1; color: var(--text-primary); }
  .watch-state { font-size: 11px; color: var(--accent); background: rgba(0,120,255,0.1); padding: 1px 6px; border-radius: 8px; }
  .watch-remove { font-size: 14px; color: var(--text-muted); cursor: pointer; padding: 0 4px; }
  .watch-remove:hover { color: var(--danger); }
</style>
```

- [ ] **Step 2: Modify HA index.ts to export a PluginDef**

Replace the contents of `packages/ui/src/lib/plugins/homeassistant/index.ts` with:

```typescript
import { store } from "../../stores/store.svelte";
import { ha } from "./client";
import HASettings from "./HASettings.svelte";
import type { PluginDef } from "../../stores/plugins.svelte";

const HA_SERVICE_ACTION = { id: "ha-service", label: "HA Service Call", icon: "🏠", color: "#03a9f4" };
const HA_CUSTOM_ACTION = { id: "ha-custom", label: "HA Custom JSON", icon: "🏠", color: "#0288d1" };

async function initHAPlugin() {
  // Wire variable setter so HA state changes push into the app store
  ha.setVariableSetter((name, value) => store.setVariableLocal(name, value));

  // Load config, watch list, and auto-connect
  await ha.loadWatchList();
  const config = await ha.loadConfig();
  if (config?.url && config?.token) {
    ha.connect(config.url, config.token);
    setTimeout(() => ha.syncAllWatchedToVariables(), 3000);
  }
}

async function destroyHAPlugin() {
  ha.disconnect();
}

export const haPluginDef: PluginDef = {
  id: "homeassistant",
  name: "Home Assistant",
  description: "Control smart home devices, call services, sync entity states to variables",
  version: "1.0.0",
  author: "Built-in",
  icon: "🏠",
  type: "builtin",
  init: initHAPlugin,
  destroy: destroyHAPlugin,
  settingsComponent: HASettings as any,
  actions: [HA_SERVICE_ACTION, HA_CUSTOM_ACTION],
  actionExecutors: {
    "ha-service": async (settings) => { await ha.callFromSettings(settings); },
    "ha-custom": async (settings) => {
      if (settings.ha_custom_json) {
        try {
          const msg = JSON.parse(settings.ha_custom_json);
          if (!msg.type) msg.type = "call_service";
          await ha.callFromSettings({
            ...settings,
            ha_domain: msg.domain,
            ha_service: msg.service,
            ha_service_data: JSON.stringify(msg.service_data),
            ha_entity: msg.target?.entity_id,
          });
        } catch {}
      }
    },
  },
};

export { ha } from "./client";
```

- [ ] **Step 3: Verify the app still compiles**

Run: `cd packages/ui && npx svelte-check --threshold error 2>&1 | tail -20`
Expected: No new errors.

- [ ] **Step 4: Commit**

```bash
git add packages/ui/src/lib/plugins/homeassistant/HASettings.svelte packages/ui/src/lib/plugins/homeassistant/index.ts
git commit -m "feat: refactor HA plugin to use plugin registry pattern"
```

---

### Task 4: Wire up App.svelte to use the plugin registry

**Files:**
- Modify: `packages/ui/src/App.svelte:17,47`

- [ ] **Step 1: Replace initHAPlugin with initPluginRegistry**

In `packages/ui/src/App.svelte`:

Change the import on line 17 from:

```typescript
import { initHAPlugin } from "./lib/plugins/homeassistant";
```

to:

```typescript
import { registerPlugin, initPluginRegistry } from "./lib/stores/plugins.svelte";
import { haPluginDef } from "./lib/plugins/homeassistant";
```

Change the startup block (lines 44-48) from:

```typescript
    untrack(async () => {
      await initStore();
      initVariables();
      initHAPlugin();
      await refreshDevices();
    });
```

to:

```typescript
    untrack(async () => {
      await initStore();
      initVariables();
      registerPlugin(haPluginDef);
      await initPluginRegistry();
      await refreshDevices();
    });
```

- [ ] **Step 2: Verify the app still compiles**

Run: `cd packages/ui && npx svelte-check --threshold error 2>&1 | tail -20`
Expected: No new errors.

- [ ] **Step 3: Commit**

```bash
git add packages/ui/src/App.svelte
git commit -m "feat: wire app startup to plugin registry"
```

---

### Task 5: Update the Plugins page with real plugin list

**Files:**
- Modify: `packages/ui/src/pages/Plugins.svelte`

- [ ] **Step 1: Rewrite Plugins.svelte**

Replace the contents of `packages/ui/src/pages/Plugins.svelte` with:

```svelte
<script lang="ts">
  import { getAllPlugins, isEnabled, togglePlugin } from "../lib/stores/plugins.svelte";

  let searchQuery = $state("");
  let activeTab = $state<"installed" | "browse">("installed");

  // Placeholder marketplace data
  const marketplacePlugins = [
    { uuid: "com.example.obs", name: "OBS Studio", author: "Community", description: "Control OBS scenes, recording, streaming", version: "1.0.0", category: "Streaming" },
    { uuid: "com.example.spotify", name: "Spotify", author: "Community", description: "Play/pause, skip, volume control", version: "1.0.0", category: "Music" },
    { uuid: "com.example.hue", name: "Philips Hue", author: "Community", description: "Control smart lights, scenes, brightness", version: "1.0.0", category: "Smart Home" },
    { uuid: "com.example.discord", name: "Discord", author: "Community", description: "Mute, deafen, toggle voice", version: "1.0.0", category: "Communication" },
    { uuid: "com.example.system-monitor", name: "System Monitor", author: "Community", description: "CPU, RAM, GPU usage on keys", version: "1.0.0", category: "System" },
  ];

  let filteredMarketplace = $derived(() => {
    const q = searchQuery.toLowerCase();
    if (!q) return marketplacePlugins;
    return marketplacePlugins.filter(p =>
      p.name.toLowerCase().includes(q) || p.description.toLowerCase().includes(q) || p.category.toLowerCase().includes(q)
    );
  });

  // Force reactivity on toggle
  let toggleCounter = $state(0);

  async function handleToggle(id: string) {
    await togglePlugin(id);
    toggleCounter++;
  }
</script>

<div class="plugins-page">
  <div class="plugins-header">
    <h2>Plugins</h2>
    <div class="plugin-tabs">
      <button class:active={activeTab === "installed"} onclick={() => activeTab = "installed"}>Installed</button>
      <button class:active={activeTab === "browse"} onclick={() => activeTab = "browse"}>Browse</button>
    </div>
  </div>

  {#if activeTab === "browse"}
    <div class="search-bar">
      <input type="text" bind:value={searchQuery} placeholder="Search plugins..." />
    </div>
    <div class="plugin-grid">
      {#each filteredMarketplace() as plugin}
        <div class="plugin-card">
          <div class="pc-header">
            <h3>{plugin.name}</h3>
            <span class="pc-version">v{plugin.version}</span>
          </div>
          <p class="pc-author">by {plugin.author}</p>
          <p class="pc-desc">{plugin.description}</p>
          <div class="pc-footer">
            <span class="pc-category">{plugin.category}</span>
            <button class="pc-install">Install</button>
          </div>
        </div>
      {/each}
    </div>
  {:else}
    {#key toggleCounter}
    <div class="installed-list">
      {#each getAllPlugins() as plugin}
        <div class="installed-item">
          <div class="plugin-icon">{plugin.icon}</div>
          <div class="plugin-info">
            <div class="plugin-name-row">
              <span class="plugin-name">{plugin.name}</span>
              <span class="plugin-type">{plugin.type === "builtin" ? "Built-in" : "External"}</span>
            </div>
            <p class="plugin-desc">{plugin.description}</p>
            <span class="plugin-meta">v{plugin.version} · {plugin.author}</span>
          </div>
          <div class="plugin-toggle" onclick={() => handleToggle(plugin.id)}>
            <div class="toggle-switch" class:active={isEnabled(plugin.id)}>
              <div class="toggle-knob"></div>
            </div>
          </div>
        </div>
      {/each}
      {#if getAllPlugins().length === 0}
        <p class="empty">No plugins installed. Browse the marketplace to find plugins.</p>
      {/if}
    </div>
    {/key}
  {/if}
</div>

<style>
  .plugins-page { padding: 24px; max-width: 800px; margin: 0 auto; }
  .plugins-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px; }
  .plugins-header h2 { font-size: 20px; color: var(--text-primary); }
  .plugin-tabs { display: flex; gap: 4px; }
  .plugin-tabs button { padding: 6px 14px; border-radius: var(--radius-sm); font-size: 13px; color: var(--text-muted); cursor: pointer; }
  .plugin-tabs button:hover { color: var(--text-primary); background: var(--bg-tertiary); }
  .plugin-tabs button.active { color: var(--accent); background: var(--bg-tertiary); }

  .search-bar { margin-bottom: 16px; }
  .search-bar input { width: 100%; padding: 10px 14px; border-radius: var(--radius); border: 1px solid var(--border); background: var(--bg-secondary); color: var(--text-primary); font-size: 14px; outline: none; }
  .search-bar input:focus { border-color: var(--accent); }

  .plugin-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 12px; }
  .plugin-card { background: var(--bg-secondary); border: 1px solid var(--border); border-radius: var(--radius); padding: 16px; }
  .pc-header { display: flex; align-items: center; justify-content: space-between; }
  .pc-header h3 { font-size: 15px; color: var(--text-primary); }
  .pc-version { font-size: 11px; color: var(--text-muted); }
  .pc-author { font-size: 12px; color: var(--text-muted); margin: 4px 0; }
  .pc-desc { font-size: 13px; color: var(--text-secondary); margin: 8px 0; line-height: 1.4; }
  .pc-footer { display: flex; align-items: center; justify-content: space-between; margin-top: 12px; }
  .pc-category { font-size: 11px; color: var(--accent); background: rgba(0,120,255,0.1); padding: 2px 8px; border-radius: 10px; }
  .pc-install { padding: 5px 14px; border-radius: var(--radius-sm); background: var(--accent); color: white; font-size: 12px; cursor: pointer; }
  .pc-install:hover { background: var(--accent-hover); }

  .installed-list { display: flex; flex-direction: column; gap: 8px; }
  .installed-item {
    display: flex; align-items: center; gap: 14px;
    padding: 14px 16px;
    background: var(--bg-secondary);
    border: 1px solid var(--border);
    border-radius: var(--radius);
  }
  .plugin-icon { font-size: 28px; flex-shrink: 0; width: 40px; text-align: center; }
  .plugin-info { flex: 1; min-width: 0; }
  .plugin-name-row { display: flex; align-items: center; gap: 8px; }
  .plugin-name { font-size: 14px; font-weight: 500; color: var(--text-primary); }
  .plugin-type { font-size: 10px; color: var(--text-muted); background: var(--bg-tertiary); padding: 1px 6px; border-radius: 8px; }
  .plugin-desc { font-size: 12px; color: var(--text-secondary); margin: 3px 0; line-height: 1.4; }
  .plugin-meta { font-size: 11px; color: var(--text-muted); }
  .plugin-toggle { cursor: pointer; flex-shrink: 0; }

  .toggle-switch {
    position: relative; width: 36px; height: 20px;
    background: var(--bg-primary); border-radius: 10px;
    border: 1px solid var(--border); transition: background 0.2s;
  }
  .toggle-switch.active { background: var(--accent); border-color: var(--accent); }
  .toggle-knob {
    position: absolute; top: 2px; left: 2px;
    width: 14px; height: 14px;
    background: var(--text-primary); border-radius: 50%;
    transition: transform 0.2s;
  }
  .toggle-switch.active .toggle-knob { transform: translateX(16px); }

  .empty { color: var(--text-muted); text-align: center; margin-top: 40px; }
</style>
```

- [ ] **Step 2: Verify the app still compiles**

Run: `cd packages/ui && npx svelte-check --threshold error 2>&1 | tail -20`
Expected: No new errors.

- [ ] **Step 3: Commit**

```bash
git add packages/ui/src/pages/Plugins.svelte
git commit -m "feat: show installed plugins with enable/disable toggles"
```

---

### Task 6: Update Settings page with dynamic plugin sections

**Files:**
- Modify: `packages/ui/src/pages/Settings.svelte`

- [ ] **Step 1: Remove hardcoded HA section, add dynamic plugin sections**

Replace the full contents of `packages/ui/src/pages/Settings.svelte` with:

```svelte
<script lang="ts">
  import { invoke } from "@tauri-apps/api/core";
  import { enable, disable, isEnabled } from "@tauri-apps/plugin-autostart";
  import { getPluginsWithSettings } from "../lib/stores/plugins.svelte";

  interface ApiKeyInfo {
    id: string;
    name: string;
    key_preview: string;
    created_at: string;
  }

  let keys = $state<ApiKeyInfo[]>([]);
  let newKeyName = $state("");
  let generatedKey = $state<string | null>(null);
  let copied = $state(false);

  // App settings
  let minimizeToTray = $state(true);
  let startMinimized = $state(false);
  let startOnBoot = $state(false);

  async function loadAppSettings() {
    const raw = await invoke<string | null>("load_json_file", { filename: "app_settings" });
    if (raw) {
      const settings = JSON.parse(raw);
      minimizeToTray = settings.minimizeToTray ?? true;
      startMinimized = settings.startMinimized ?? false;
    }
    startOnBoot = await isEnabled();
  }

  async function saveAppSettings() {
    const content = JSON.stringify({ minimizeToTray, startMinimized });
    await invoke("save_json_file", { filename: "app_settings", content });
  }

  async function toggleMinimizeToTray() {
    minimizeToTray = !minimizeToTray;
    await invoke("set_minimize_to_tray", { enabled: minimizeToTray });
    await saveAppSettings();
  }

  async function toggleStartMinimized() {
    startMinimized = !startMinimized;
    await saveAppSettings();
  }

  async function toggleStartOnBoot() {
    startOnBoot = !startOnBoot;
    if (startOnBoot) {
      await enable();
    } else {
      await disable();
    }
  }

  async function loadKeys() {
    keys = await invoke<ApiKeyInfo[]>("list_api_keys");
  }

  async function handleGenerate() {
    const name = newKeyName.trim() || "Default";
    const key = await invoke<string>("generate_api_key", { name });
    generatedKey = key;
    newKeyName = "";
    copied = false;
    await loadKeys();
  }

  async function handleRevoke(id: string) {
    await invoke("revoke_api_key", { id });
    await loadKeys();
  }

  function copyKey() {
    if (generatedKey) {
      navigator.clipboard.writeText(generatedKey);
      copied = true;
    }
  }

  function dismissKey() {
    generatedKey = null;
  }

  loadKeys();
  loadAppSettings();
</script>

<div class="settings-page">
  <h2>Settings</h2>

  <div class="settings-section">
    <h3>General</h3>

    <label class="toggle-row" onclick={toggleMinimizeToTray}>
      <div class="toggle-text">
        <span class="toggle-label">Minimize to tray on close</span>
        <span class="toggle-hint">Keep running in the background when the window is closed</span>
      </div>
      <div class="toggle-switch" class:active={minimizeToTray}>
        <div class="toggle-knob"></div>
      </div>
    </label>

    <label class="toggle-row" onclick={toggleStartMinimized}>
      <div class="toggle-text">
        <span class="toggle-label">Start minimized</span>
        <span class="toggle-hint">Launch hidden in the system tray</span>
      </div>
      <div class="toggle-switch" class:active={startMinimized}>
        <div class="toggle-knob"></div>
      </div>
    </label>

    <label class="toggle-row" onclick={toggleStartOnBoot}>
      <div class="toggle-text">
        <span class="toggle-label">Start on boot</span>
        <span class="toggle-hint">Automatically start at login</span>
      </div>
      <div class="toggle-switch" class:active={startOnBoot}>
        <div class="toggle-knob"></div>
      </div>
    </label>
  </div>

  {#each getPluginsWithSettings() as plugin}
    <div class="settings-section">
      <svelte:component this={plugin.settingsComponent} />
    </div>
  {/each}

  <div class="settings-section">
    <h3>API Keys</h3>
    <p class="hint">API keys protect the REST API (port 8484) from unauthorized access. External tools like Home Assistant need a key to control your Stream Deck.</p>

    {#if generatedKey}
      <div class="key-reveal">
        <p class="key-warning">Copy this key now — it won't be shown again!</p>
        <div class="key-value">
          <code>{generatedKey}</code>
          <button class="copy-btn" onclick={copyKey}>{copied ? 'Copied!' : 'Copy'}</button>
        </div>
        <p class="key-usage">Use in HTTP headers: <code>Authorization: Bearer {generatedKey.substring(0, 12)}...</code></p>
        <button class="dismiss-btn" onclick={dismissKey}>I've saved it</button>
      </div>
    {/if}

    <div class="key-create">
      <input type="text" bind:value={newKeyName} placeholder="Key name (e.g. Home Assistant)" onkeydown={(e) => { if (e.key === 'Enter') handleGenerate(); }} />
      <button class="generate-btn" onclick={handleGenerate}>Generate Key</button>
    </div>

    {#if keys.length > 0}
      <div class="key-list">
        {#each keys as key}
          <div class="key-item">
            <div class="key-info">
              <span class="key-name">{key.name}</span>
              <code class="key-prev">{key.key_preview}</code>
            </div>
            <button class="revoke-btn" onclick={() => handleRevoke(key.id)}>Revoke</button>
          </div>
        {/each}
      </div>
    {:else}
      <p class="no-keys">No API keys configured. The API is currently open (no authentication required).</p>
    {/if}
  </div>

  <div class="settings-section">
    <h3>API Endpoint</h3>
    <p class="hint">External tools can control your Stream Deck at:</p>
    <code class="endpoint">http://YOUR_IP:8484/api/</code>
    <p class="hint">Endpoints: <code>/variables</code>, <code>/devices</code>, <code>/actions/execute</code>, <code>/health</code></p>
  </div>
</div>

<style>
  .settings-page { padding: 24px; max-width: 600px; margin: 0 auto; }
  h2 { font-size: 20px; color: var(--text-primary); margin-bottom: 16px; }
  :global(.settings-section h3) { font-size: 15px; color: var(--text-secondary); margin-bottom: 8px; }
  :global(.settings-section .hint) { font-size: 12px; color: var(--text-muted); line-height: 1.5; margin-bottom: 12px; }
  .settings-section { background: var(--bg-secondary); padding: 16px; border-radius: var(--radius); margin-bottom: 16px; border: 1px solid var(--border); }

  .key-reveal { background: rgba(46,204,113,0.08); border: 1px solid var(--success); border-radius: var(--radius); padding: 14px; margin-bottom: 12px; }
  .key-warning { font-size: 12px; color: var(--warning); font-weight: 600; margin-bottom: 8px; }
  .key-value { display: flex; gap: 8px; align-items: center; margin-bottom: 8px; }
  .key-value code { flex: 1; font-size: 11px; background: var(--bg-primary); padding: 8px; border-radius: var(--radius-sm); word-break: break-all; color: var(--success); }
  .copy-btn { padding: 6px 14px; border-radius: var(--radius-sm); background: var(--accent); color: white; font-size: 12px; cursor: pointer; white-space: nowrap; }
  .key-usage { font-size: 11px; color: var(--text-muted); }
  .key-usage code { font-size: 10px; background: var(--bg-primary); padding: 2px 4px; border-radius: 2px; }
  .dismiss-btn { margin-top: 8px; padding: 5px 12px; border-radius: var(--radius-sm); background: var(--bg-tertiary); color: var(--text-secondary); font-size: 12px; cursor: pointer; }

  .key-create { display: flex; gap: 8px; margin-bottom: 12px; }
  .key-create input { flex: 1; padding: 8px 12px; border-radius: var(--radius-sm); border: 1px solid var(--border); background: var(--bg-primary); color: var(--text-primary); font-size: 13px; outline: none; }
  .key-create input:focus { border-color: var(--accent); }
  .generate-btn { padding: 8px 16px; border-radius: var(--radius-sm); background: var(--accent); color: white; font-size: 12px; cursor: pointer; white-space: nowrap; }

  .key-list { display: flex; flex-direction: column; gap: 6px; }
  .key-item { display: flex; align-items: center; justify-content: space-between; padding: 10px; background: var(--bg-primary); border-radius: var(--radius-sm); }
  .key-info { display: flex; align-items: center; gap: 10px; }
  .key-name { font-size: 13px; color: var(--text-primary); }
  .key-prev { font-size: 11px; color: var(--text-muted); background: var(--bg-tertiary); padding: 2px 6px; border-radius: 3px; }
  .revoke-btn { padding: 4px 10px; border-radius: var(--radius-sm); background: rgba(231,76,60,0.1); color: var(--danger); font-size: 11px; cursor: pointer; }
  .revoke-btn:hover { background: rgba(231,76,60,0.2); }
  .no-keys { font-size: 12px; color: var(--text-muted); font-style: italic; }

  .endpoint { display: block; font-size: 13px; background: var(--bg-primary); padding: 8px 12px; border-radius: var(--radius-sm); color: var(--accent); margin-bottom: 8px; }

  .toggle-row {
    display: flex; align-items: center; justify-content: space-between;
    padding: 10px 0; cursor: pointer; user-select: none;
  }
  .toggle-row:not(:last-child) { border-bottom: 1px solid var(--border); }
  .toggle-text { display: flex; flex-direction: column; gap: 2px; }
  .toggle-label { font-size: 13px; color: var(--text-primary); }
  .toggle-hint { font-size: 11px; color: var(--text-muted); }
  .toggle-switch {
    position: relative; width: 36px; height: 20px;
    background: var(--bg-primary); border-radius: 10px;
    border: 1px solid var(--border); flex-shrink: 0; transition: background 0.2s;
  }
  .toggle-switch.active { background: var(--accent); border-color: var(--accent); }
  .toggle-knob {
    position: absolute; top: 2px; left: 2px;
    width: 14px; height: 14px;
    background: var(--text-primary); border-radius: 50%; transition: transform 0.2s;
  }
  .toggle-switch.active .toggle-knob { transform: translateX(16px); }
</style>
```

- [ ] **Step 2: Verify the app still compiles**

Run: `cd packages/ui && npx svelte-check --threshold error 2>&1 | tail -20`
Expected: No new errors.

- [ ] **Step 3: Commit**

```bash
git add packages/ui/src/pages/Settings.svelte
git commit -m "feat: dynamic plugin settings sections on Settings page"
```

---

### Task 7: Manual smoke test

- [ ] **Step 1: Build and run the app**

Run: `cd /media/nvme4tb/DEV/stream-deck-js && cargo tauri dev 2>&1 | head -30`

- [ ] **Step 2: Verify Plugins page**

Navigate to Plugins tab. Confirm:
- Home Assistant appears in the Installed list with icon, name, description, version
- Toggle is ON by default
- Toggling OFF disables the plugin

- [ ] **Step 3: Verify Settings page**

Navigate to Settings tab. Confirm:
- Home Assistant settings section appears between General and API Keys
- Toggle HA OFF on Plugins page, return to Settings — HA section is gone
- Toggle HA back ON — HA section reappears

- [ ] **Step 4: Verify action picker**

Select a key. Confirm:
- With HA enabled: "HA Service Call" and "HA Custom JSON" appear in action list
- With HA disabled: those actions are not in the list
- Existing key assignments with HA actions remain configured

- [ ] **Step 5: Commit any fixes**

If any issues were found and fixed, commit them:

```bash
git add -A
git commit -m "fix: plugin management smoke test fixes"
```
