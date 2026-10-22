import type { PluginDef } from "../../stores/plugins.svelte";

const SWITCH_SCENE_ACTION = { id: "switch-scene", label: "Switch Scene", icon: "⇄", color: "#ff9800" };
const BACK_ACTION = { id: "back", label: "Back (Previous Scene)", icon: "←", color: "#607d8b" };

// Navigation actions are executed by the store's dispatcher (store.executeAction), which owns
// the per-device scene stacks and applies them to the device that triggered the action.
// The plugin registers the action types so they appear in the picker.

export const navigationPluginDef: PluginDef = {
  id: "navigation",
  name: "Navigation",
  description: "Switch between scenes and navigate back",
  version: "1.0.0",
  author: "Built-in",
  icon: "⇄",
  type: "builtin",
  actions: [SWITCH_SCENE_ACTION, BACK_ACTION],
};
