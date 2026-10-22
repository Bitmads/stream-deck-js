import { store } from "../../stores/store.svelte";
import { resolveTemplate } from "../../stores/variables.svelte";
import { ha, parseJsonObject } from "./client";
import HASettings from "./HASettings.svelte";
import { HAStatsFetcher } from "./stats-fetcher";
import type { PluginDef } from "../../stores/plugins.svelte";

const HA_SERVICE_ACTION = { id: "ha-service", label: "HA Service Call", icon: "🏠", color: "#03a9f4" };
const HA_CUSTOM_ACTION = { id: "ha-custom", label: "HA Custom JSON", icon: "🏠", color: "#0288d1" };

/** Long-term statistics (energy totals, 24h power charts) of watched sensors as variables. */
const statsFetcher = new HAStatsFetcher((name, value) => store.setVariableLocal(name, value));

async function initHAPlugin() {
  // Wire variable setter so HA state changes push into the app store
  ha.setVariableSetter((name, value) => store.setVariableLocal(name, value));

  // Load config + watch list and auto-connect. Watched variables are re-seeded by the
  // client after every successful (re)authentication.
  await ha.loadWatchList();
  const config = await ha.loadConfig();
  statsFetcher.start();
  if (config?.url && config?.token) {
    ha.connect(config.url, config.token);
  }
}

async function destroyHAPlugin() {
  statsFetcher.stop();
  ha.disconnect();
}

/**
 * Re-read the watched-entity list from ha_config.json and re-publish the watched entities'
 * variables (used after a profile reload, contract C1).
 */
export async function reloadHaWatchList(): Promise<void> {
  await ha.loadWatchList();
  ha.syncAllWatchedToVariables();
  void statsFetcher.refresh();
}

/** Resolve {{$var}} templates in every string leaf of a parsed JSON value. */
function resolveJsonTemplates(value: unknown): unknown {
  if (typeof value === "string") return value.includes("{{") ? resolveTemplate(value) : value;
  if (Array.isArray(value)) return value.map(resolveJsonTemplates);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = resolveJsonTemplates(v);
    return out;
  }
  return value;
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
    // Errors (not connected, HA success:false, missing value) propagate to the dispatcher,
    // which surfaces them.
    "ha-service": async (settings) => {
      const s = { ...settings };
      if (s.ha_service_data) {
        // Templates inside the JSON are resolved per string value, after parsing, so a
        // variable containing quotes cannot break the JSON.
        s.ha_service_data = JSON.stringify(resolveJsonTemplates(parseJsonObject(s.ha_service_data, "ha_service_data")));
      }
      await ha.callFromSettings(s);
    },
    "ha-custom": async (settings) => {
      const raw = settings.ha_custom_json;
      if (!raw || !raw.trim()) throw new Error("HA Custom JSON action has no JSON configured");
      const msg = resolveJsonTemplates(parseJsonObject(raw, "HA custom JSON")) as Record<string, any>;
      const type = msg.type ?? "call_service";
      if (type !== "call_service") {
        // Any other HA WebSocket command (e.g. fire_event) is sent as-is.
        await ha.sendCommand({ ...msg, type });
        return;
      }
      if (typeof msg.domain !== "string" || typeof msg.service !== "string" || !msg.domain || !msg.service) {
        throw new Error('HA custom JSON needs "domain" and "service" strings');
      }
      const data = msg.service_data ?? msg.data;
      if (data !== undefined && (typeof data !== "object" || data === null || Array.isArray(data))) {
        throw new Error('"service_data" in HA custom JSON must be an object');
      }
      const target = msg.target;
      if (target !== undefined && (typeof target !== "object" || target === null || Array.isArray(target))) {
        throw new Error('"target" in HA custom JSON must be an object');
      }
      await ha.callService(msg.domain, msg.service, data, target);
    },
  },
};

export { ha } from "./client";
export type { HAControl } from "./client";
