import { invoke } from "@tauri-apps/api/core";
import type { PluginDef } from "../../stores/plugins.svelte";

const HOTKEY_ACTION = { id: "hotkey", label: "Hotkey", icon: "⌨", color: "#e74c3c" };
const LAUNCH_ACTION = { id: "launch", label: "Launch App", icon: "🚀", color: "#3498db" };
const COMMAND_ACTION = { id: "command", label: "Shell Command", icon: ">_", color: "#2ecc71" };
const OPEN_URL_ACTION = { id: "open-url", label: "Open URL", icon: "🔗", color: "#9b59b6" };

async function executeViaBackend(actionType: string, settings: Record<string, string>) {
  await invoke("execute_action", { actionType, settings: JSON.stringify(settings) });
}

export const systemActionsPluginDef: PluginDef = {
  id: "system-actions",
  name: "System Actions",
  description: "Hotkeys, app launcher, shell commands, and URL opener",
  version: "1.0.0",
  author: "Built-in",
  icon: "⌨",
  type: "builtin",
  actions: [HOTKEY_ACTION, LAUNCH_ACTION, COMMAND_ACTION, OPEN_URL_ACTION],
  actionExecutors: {
    "hotkey": (s) => executeViaBackend("hotkey", s),
    "launch": (s) => executeViaBackend("launch", s),
    "command": (s) => executeViaBackend("command", s),
    "open-url": (s) => executeViaBackend("open-url", s),
  },
};
