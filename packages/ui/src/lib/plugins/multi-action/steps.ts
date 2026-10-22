// Multi-action step model and parsing. Pure module (no Svelte/Tauri imports) for unit tests.

export interface MultiActionStep {
  actionId: string;
  actionLabel: string;
  settings: Record<string, string>;
  delayMs: number;
}

/** Settings key carrying the nesting depth of a multi-action executed as a step. */
export const DEPTH_KEY = "__depth";
export const MAX_DEPTH = 5;

function toSettingString(v: unknown): string {
  if (typeof v === "string") return v;
  if (v === null || v === undefined) return "";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

/**
 * Parse the `steps` setting of a multi-action: a JSON array of
 * {actionId, actionLabel, settings: Record<string,string>, delayMs}.
 * Legacy `actionType` is accepted for actionId; non-string setting values are stringified.
 * Empty input yields no steps. Throws an Error naming the problem on invalid input.
 */
export function parseSteps(json: string | undefined | null): MultiActionStep[] {
  if (json === undefined || json === null || json.trim() === "") return [];
  let raw: unknown;
  try { raw = JSON.parse(json); } catch (e) {
    throw new Error(`Multi-action steps are not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!Array.isArray(raw)) throw new Error("Multi-action steps must be a JSON array");
  return raw.map((item, i) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`Multi-action step ${i + 1} is not an object`);
    }
    const o = item as Record<string, unknown>;
    const actionId = typeof o.actionId === "string" ? o.actionId : typeof o.actionType === "string" ? o.actionType : "";
    if (!actionId) throw new Error(`Multi-action step ${i + 1} has no actionId`);
    const settings: Record<string, string> = {};
    if (o.settings && typeof o.settings === "object" && !Array.isArray(o.settings)) {
      for (const [k, v] of Object.entries(o.settings as Record<string, unknown>)) settings[k] = toSettingString(v);
    }
    const delay = Number(o.delayMs);
    return {
      actionId,
      actionLabel: typeof o.actionLabel === "string" && o.actionLabel ? o.actionLabel : actionId,
      settings,
      delayMs: Number.isFinite(delay) && delay > 0 ? Math.round(delay) : 0,
    };
  });
}

/** Serialize steps for storage in the `steps` setting. */
export function serializeSteps(steps: MultiActionStep[]): string {
  return JSON.stringify(steps.map(s => ({
    actionId: s.actionId,
    actionLabel: s.actionLabel,
    settings: s.settings,
    delayMs: Math.max(0, Math.round(s.delayMs || 0)),
  })));
}

/** Nesting depth carried in a multi-action's settings (0 for a top-level execution). */
export function depthOf(settings: Record<string, string>): number {
  const d = Number(settings[DEPTH_KEY] ?? 0);
  return Number.isInteger(d) && d > 0 ? d : 0;
}

/** Settings for a step: nested multi-actions get depth+1 so the guard is per execution chain. */
export function stepSettings(step: MultiActionStep, depth: number): Record<string, string> {
  if (step.actionId !== "multi-action") return { ...step.settings };
  return { ...step.settings, [DEPTH_KEY]: String(depth + 1) };
}
