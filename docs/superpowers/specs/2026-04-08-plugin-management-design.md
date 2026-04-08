# Plugin Management System — Design Spec

## Problem

Plugins (like Home Assistant) register actions but don't appear in the Plugins page. Users can't enable/disable them or manage their settings. HA settings are hardcoded in Settings.svelte regardless of whether the plugin is active.

## Goals

- Unified plugin list on the Plugins page showing both built-in and external plugins
- Enable/disable toggle per plugin with state persisted across restarts
- Plugin settings appear as dynamic sections on the Settings page, only when the plugin is enabled
- Home Assistant refactored to use the plugin system as the reference implementation
- Disabled plugins' actions hidden from the action picker but existing key assignments preserved

## Non-Goals

- Plugin marketplace / install from remote (keep existing browse tab as placeholder)
- Plugin dependency management
- Per-plugin sandboxing or permissions

---

## Architecture

### Plugin Registry (`packages/ui/src/lib/stores/plugins.svelte.ts`)

Central store managing all plugins. Reactive via Svelte 5 runes.

```typescript
interface PluginDef {
  id: string;                // "homeassistant", "com.example.obs"
  name: string;
  description: string;
  version: string;
  author: string;
  icon: string;
  type: "builtin" | "external";
  // Builtin only:
  init?: () => Promise<void>;
  destroy?: () => Promise<void>;
  settingsComponent?: Component;
  // External only:
  manifest?: PluginManifest;
}

interface PluginState {
  enabled: boolean;
}
```

**State persistence**: `plugins.json` file via existing `save_json_file`/`load_json_file` Tauri commands. Schema: `Record<string, PluginState>`.

**Default state**: Built-in plugins default to enabled on first launch (no `plugins.json` entry = enabled). External plugins default to disabled.

### Key Methods

- `registerPlugin(def: PluginDef)` — Adds a plugin to the registry. Called at app startup by each built-in plugin module and by the external plugin discovery.
- `enablePlugin(id: string)` — Calls `init()` for builtin, starts process for external. Registers actions. Persists state.
- `disablePlugin(id: string)` — Calls `destroy()` for builtin, stops process for external. Unregisters actions from picker. Persists state.
- `isEnabled(id: string): boolean` — Check enabled state.
- `getEnabledPlugins(): PluginDef[]` — For Settings page to render dynamic sections.
- `getAllPlugins(): PluginDef[]` — For Plugins page to render the full list.

### Action Registration Changes

Currently `registerActionType()` adds to a global `pluginActions` array with no way to remove. Changes needed:

- Add `unregisterActionType(id: string)` to remove actions from the picker.
- `registerActionType` stays as-is — plugins call it during `init()`.
- On disable, the registry calls `unregisterActionType` for each action the plugin registered.
- Key assignments referencing those actions remain in scene data. The action just won't execute (executor not found = silent no-op, which is already the behavior).

Track which actions belong to which plugin: `pluginActionMap: Record<pluginId, string[]>` (maps plugin ID to list of action IDs it registered).

---

## UI Changes

### Plugins Page (`packages/ui/src/pages/Plugins.svelte`)

Replace the current empty "Installed" tab with a unified plugin list.

Each plugin card:
- Left: icon + name + description + version/author line
- Right: enable/disable toggle switch (same style as Settings page toggles)
- Type badge: "Built-in" or "External" (small, muted)
- No settings button — settings live on Settings page

Keep the existing "Browse" tab as-is (placeholder marketplace).

### Settings Page (`packages/ui/src/pages/Settings.svelte`)

Section order:
1. General (static)
2. Dynamic plugin settings sections — one per enabled plugin that has a `settingsComponent`
3. API Keys (static)
4. API Endpoint (static)

Each plugin settings section:
- Uses the plugin's `settingsComponent` Svelte component
- Section title = plugin name
- Wrapped in the same `.settings-section` container as other sections

When a plugin is disabled, its section disappears. No special transition needed.

---

## Home Assistant Refactor

### New file: `packages/ui/src/lib/plugins/homeassistant/HASettings.svelte`

Extract the entire "Home Assistant" section from Settings.svelte into this component. Contains: URL/token inputs, connection status, connect/disconnect buttons, watched entities search and list. All the existing logic moves here — `haUrl`, `haToken`, `haConnected`, `loadHAConfig`, `handleHAConnect`, `handleHADisconnect`, watched entity management.

### Modified: `packages/ui/src/lib/plugins/homeassistant/index.ts`

```typescript
import HASettings from "./HASettings.svelte";

export const haPluginDef: PluginDef = {
  id: "homeassistant",
  name: "Home Assistant",
  description: "Control smart home devices, call services, sync entity states to variables",
  version: "1.0.0",
  author: "Built-in",
  icon: "🏠",
  type: "builtin",
  init: initHAPlugin,       // existing function
  destroy: destroyHAPlugin,  // new function
  settingsComponent: HASettings,
};

export async function destroyHAPlugin() {
  ha.disconnect();
  // Actions get unregistered by the plugin registry via unregisterActionType
}
```

### Modified: `packages/ui/src/App.svelte`

Replace direct `initHAPlugin()` call with plugin registry initialization:

```typescript
import { initPluginRegistry } from "./lib/stores/plugins.svelte";

// In startup effect:
await initPluginRegistry();  // discovers plugins, inits enabled ones
```

---

## External Plugin Integration

### Discovery

On startup, the plugin registry invokes `invoke("list_plugins")` (existing Tauri command that calls `PluginManager::list_discovered()`). Each discovered manifest becomes a `PluginDef` with `type: "external"`.

### Enable/Disable

- Enable: `invoke("start_plugin", { uuid })` — starts the subprocess
- Disable: `invoke("stop_plugin", { uuid })` — kills the subprocess

External plugins register actions via their manifest's `actions` array. On enable, these get added to the action picker. On disable, they get removed.

### Settings

External plugins don't have a `settingsComponent`. Their settings are managed through the Property Inspector protocol (already implemented via `PropertyInspector.svelte` iframe). No changes needed here.

---

## Startup Flow

1. Load `plugins.json` from disk
2. Register all built-in plugin definitions (HA, future ones)
3. Discover external plugins via `invoke("list_plugins")`
4. Register external plugin definitions
5. For each plugin where state is enabled (or default-enabled): call `enablePlugin()`
6. `enablePlugin` calls `init()` / starts process, registers actions

---

## File Changes Summary

| File | Change |
|------|--------|
| `packages/ui/src/lib/stores/plugins.svelte.ts` | **New** — Plugin registry store |
| `packages/ui/src/lib/plugins/homeassistant/HASettings.svelte` | **New** — Extracted HA settings component |
| `packages/ui/src/lib/plugins/homeassistant/index.ts` | **Modified** — Export `haPluginDef`, add `destroyHAPlugin` |
| `packages/ui/src/lib/stores/store.svelte.ts` | **Modified** — Add `unregisterActionType`, `pluginActionMap` tracking |
| `packages/ui/src/pages/Plugins.svelte` | **Modified** — Real installed plugin list with toggles |
| `packages/ui/src/pages/Settings.svelte` | **Modified** — Remove hardcoded HA section, add dynamic plugin sections |
| `packages/ui/src/App.svelte` | **Modified** — Use `initPluginRegistry()` instead of direct `initHAPlugin()` |
