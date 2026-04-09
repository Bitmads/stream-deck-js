import { executePluginAction } from "../../stores/store.svelte";
import type { PluginDef } from "../../stores/plugins.svelte";

export interface MultiActionStep {
  actionId: string;
  actionLabel: string;
  settings: Record<string, string>;
  delayMs: number;
}

const MULTI_ACTION = { id: "multi-action", label: "Multi-Action", icon: "▶▶", color: "#e67e22" };

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

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
      const stepsJson = s.steps;
      if (!stepsJson) return;
      let steps: MultiActionStep[];
      try { steps = JSON.parse(stepsJson); } catch { return; }
      for (const step of steps) {
        await executePluginAction(step.actionId, step.settings);
        if (step.delayMs > 0) await sleep(step.delayMs);
      }
    },
  },
};
