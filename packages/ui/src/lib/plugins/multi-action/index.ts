import { store, type ActionContext } from "../../stores/store.svelte";
import type { PluginDef } from "../../stores/plugins.svelte";
import { dispatchMultiActionStep, isExternalAction } from "../external/bridge.svelte";
import { MAX_DEPTH, depthOf, parseSteps, stepSettings } from "./steps";

export type { MultiActionStep } from "./steps";
export { parseSteps, serializeSteps } from "./steps";

const MULTI_ACTION = { id: "multi-action", label: "Multi-Action", icon: "▶▶", color: "#e67e22" };

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Run each step through the single action dispatcher (store.executeAction), so navigation,
 * timer/counter and plugin actions all work and templates are resolved per setting value.
 * The `steps` JSON itself is never template-resolved. A failing step does not stop the
 * remaining steps; all failures are reported together afterwards.
 */
async function executeMultiAction(settings: Record<string, string>, ctx?: ActionContext) {
  const depth = depthOf(settings);
  if (depth >= MAX_DEPTH) throw new Error(`Multi-action nesting deeper than ${MAX_DEPTH} levels, aborting`);
  const steps = parseSteps(settings.steps);
  const failures: string[] = [];
  for (const [i, step] of steps.entries()) {
    try {
      if (isExternalAction(step.actionId)) {
        await dispatchMultiActionStep(step.actionId, step.settings, ctx, i);
      } else {
        await store.executeAction(step.actionId, stepSettings(step, depth), ctx);
      }
    } catch (e) {
      failures.push(`step ${i + 1} (${step.actionLabel}): ${e instanceof Error ? e.message : String(e)}`);
    }
    if (step.delayMs > 0) await sleep(step.delayMs);
  }
  if (failures.length > 0) throw new Error(`Multi-action failed: ${failures.join("; ")}`);
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
    "multi-action": executeMultiAction,
  },
};
