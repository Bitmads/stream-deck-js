import { invoke } from "@tauri-apps/api/core";
import type { PluginDef } from "../../stores/plugins.svelte";

const HTTP_REQUEST_ACTION = { id: "http-request", label: "HTTP Request", icon: "↗", color: "#00bcd4" };

export const httpActionsPluginDef: PluginDef = {
  id: "http-actions",
  name: "HTTP Actions",
  description: "Send HTTP requests to any URL with custom method, headers, and body",
  version: "1.0.0",
  author: "Built-in",
  icon: "↗",
  type: "builtin",
  actions: [HTTP_REQUEST_ACTION],
  actionExecutors: {
    "http-request": async (s) => {
      await invoke("execute_action", { actionType: "http-request", settings: JSON.stringify(s) });
    },
  },
};
