import type { PluginDef } from "../../stores/plugins.svelte";

const TIMER_ACTION = { id: "timer", label: "Timer", icon: "⏱", color: "#f39c12" };
const COUNTER_ACTION = { id: "counter", label: "Counter", icon: "#", color: "#e91e63" };

// Timer and counter actions are executed by the store's dispatcher (store.executeAction): they
// display through per-context runtime overrides and are tied to the key that started them.
// The plugin registers the action types so they appear in the picker.

export const utilitiesPluginDef: PluginDef = {
  id: "utilities",
  name: "Utilities",
  description: "Countdown timer and tap counter for Stream Deck keys",
  version: "1.0.0",
  author: "Built-in",
  icon: "⏱",
  type: "builtin",
  actions: [TIMER_ACTION, COUNTER_ACTION],
};
