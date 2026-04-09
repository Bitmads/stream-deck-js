import { executePluginAction } from "../../stores/store.svelte";
import { resolveTemplate } from "../../stores/variables.svelte";
import type { PluginDef } from "../../stores/plugins.svelte";

export interface MultiActionStep {
  actionId: string;
  actionLabel: string;
  settings: Record<string, string>;
  delayMs: number;
}

const MULTI_ACTION = { id: "multi-action", label: "Multi-Action", icon: "▶▶", color: "#e67e22" };
const MAX_DEPTH = 5;
let currentDepth = 0;

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
      if (currentDepth >= MAX_DEPTH) {
        console.warn("[Multi-Action] Max nesting depth reached, aborting");
        return;
      }
      const stepsJson = s.steps;
      if (!stepsJson) return;
      let steps: MultiActionStep[];
      try { steps = JSON.parse(stepsJson); } catch { return; }
      currentDepth++;
      try {
        for (const step of steps) {
          // Resolve {{$var}} templates in each step's settings
          const resolved: Record<string, string> = {};
          for (const [k, v] of Object.entries(step.settings)) {
            resolved[k] = resolveTemplate(v);
          }
          await executePluginAction(step.actionId, resolved);
          if (step.delayMs > 0) await sleep(step.delayMs);
        }
      } finally {
        currentDepth--;
      }
    },
  },
};
