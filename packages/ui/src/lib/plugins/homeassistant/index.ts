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
