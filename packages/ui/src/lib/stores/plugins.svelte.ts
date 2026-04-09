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

/** Discover external plugins from the backend and register them. */
async function discoverExternalPlugins() {
  try {
    const externals = await invoke<Array<{
      uuid: string; name: string; description: string;
      version: string; author: string;
      actions: Array<{ uuid: string; name: string }>;
    }>>("discover_external_plugins");

    for (const ext of externals) {
      const actions: ActionDef[] = ext.actions.map(a => ({
        id: a.uuid, label: a.name, icon: "🔌", color: "#8e44ad",
      }));

      registerPlugin({
        id: ext.uuid,
        name: ext.name,
        description: ext.description || "External plugin",
        version: ext.version,
        author: ext.author,
        icon: "🔌",
        type: "external",
        actions,
        init: async () => {
          await invoke("start_external_plugin", { uuid: ext.uuid }).catch(() => {});
        },
        destroy: async () => {
          await invoke("stop_external_plugin", { uuid: ext.uuid }).catch(() => {});
        },
      });
    }
  } catch (e) {
    console.warn("External plugin discovery failed:", e);
  }
}

/** Initialize the registry: load persisted states, discover external, enable plugins. */
export async function initPluginRegistry() {
  const saved = await loadPluginStates();
  Object.assign(pluginStates, saved);

  // Discover external plugins from disk
  await discoverExternalPlugins();

  // Enable all plugins that should be active
  for (const def of plugins) {
    if (isEnabled(def.id)) {
      await enablePlugin(def.id);
    }
  }
}
