import { invoke } from "@tauri-apps/api/core";
import type { PluginDef } from "../../stores/plugins.svelte";

const MULTI_ACTION = { id: "multi-action", label: "Multi-Action", icon: "▶▶", color: "#e67e22" };

export const multiActionPluginDef: PluginDef = {
  id: "multi-action",
  name: "Multi-Action",
  description: "Execute multiple actions in sequence with optional delays",
  version: "1.0.0",
  author: "Built-in",
  icon: "▶▶",
  type: "builtin",
  actions: [MULTI_ACTION],
  actionExecutors: {
    "multi-action": async (s) => {
      await invoke("execute_action", { actionType: "multi-action", settings: JSON.stringify(s) });
    },
  },
};
