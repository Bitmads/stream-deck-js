import { invoke } from "@tauri-apps/api/core";
import { registerActionType, unregisterActionType } from "./store.svelte";
import type { ActionDef, ActionExecutor } from "./store.svelte";
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
  hasConfig?: boolean;
  init?: () => Promise<void>;
  destroy?: () => Promise<void>;
  settingsComponent?: Component;
  actions?: ActionDef[];
  /** Executors receive template-resolved settings and the triggering device/scene/key, if any. */
  actionExecutors?: Record<string, ActionExecutor>;
}

interface PluginState {
  enabled: boolean;
}

// ─── Registry State ──────────────────────────────────────────

const plugins = $state<PluginDef[]>([]);
const pluginStates = $state<Record<string, PluginState>>({});
/** Last init() failure per plugin (runtime only; cleared on a successful enable). */
const pluginErrors = $state<Record<string, string>>({});

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
  }).catch((e) => console.error("Failed to save plugin states:", e));
}

function unregisterPluginActions(id: string) {
  for (const actionId of pluginActionMap[id] || []) unregisterActionType(actionId);
  delete pluginActionMap[id];
}

// ─── Public API ──────────────────────────────────────────────

/** Register a plugin definition. Does not enable it yet. */
export function registerPlugin(def: PluginDef) {
  if (!plugins.find(p => p.id === def.id)) {
    plugins.push(def);
  }
}

/**
 * Enable a plugin: register its actions, call init(), persist.
 * If init() throws, its actions are unregistered, the error is recorded (getPluginError) and rethrown.
 * A plugin that was disabled before stays disabled; one that was already enabled (startup) keeps its
 * persisted state so a transient failure does not turn it off for good.
 */
export async function enablePlugin(id: string) {
  const def = plugins.find(p => p.id === id);
  if (!def) return;
  const wasEnabled = isEnabled(id);

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

  try {
    if (def.init) await def.init();
    delete pluginErrors[id];
  } catch (e) {
    unregisterPluginActions(id);
    pluginErrors[id] = e instanceof Error ? e.message : String(e);
    if (!wasEnabled) pluginStates[id] = { enabled: false };
    throw e;
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
  unregisterPluginActions(id);
  delete pluginErrors[id];

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

/** Error from the plugin's last failed enable, or null. */
export function getPluginError(id: string): string | null {
  return pluginErrors[id] ?? null;
}

/** Get all registered plugins. */
export function getAllPlugins(): PluginDef[] {
  return plugins;
}

/** Get enabled plugins that have a settings component or config schema. */
export function getPluginsWithSettings(): PluginDef[] {
  return plugins.filter(p => isEnabled(p.id) && (p.settingsComponent || p.hasConfig));
}

/** Discover external plugins from the backend and register them. */
async function discoverExternalPlugins() {
  try {
    const externals = await invoke<Array<{
      uuid: string; name: string; description: string;
      version: string; author: string;
      actions: Array<{ uuid: string; name: string }>;
      has_config: boolean;
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
        hasConfig: ext.has_config,
        actions,
        init: async () => {
          await invoke("start_external_plugin", { uuid: ext.uuid });
        },
        destroy: async () => {
          await invoke("stop_external_plugin", { uuid: ext.uuid });
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

  // Enable all plugins that should be active; one failing plugin must not block the others.
  for (const def of plugins) {
    if (isEnabled(def.id)) {
      try {
        await enablePlugin(def.id);
      } catch (e) {
        console.error(`Plugin "${def.id}" failed to start:`, e);
      }
    }
  }
}
