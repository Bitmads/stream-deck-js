// Turn a DeckSpec into per-device scene lists: resolve scene references, collect the Home
// Assistant entities referenced by templates and the plugins the actions need.

import type { Scene } from "../../ui/src/lib/types/profile.ts";
import { extractVariableNames } from "../../ui/src/lib/utils/template.ts";
import { cloneJson } from "../../ui/src/lib/utils/profile.ts";
import { findAction } from "./catalog.ts";
import { findDeviceModel, type DeviceModel } from "./devices.ts";
import { SCENE_REF_PREFIX, type DeckSpec } from "./builders.ts";

export interface BuiltDevice {
  serial: string;
  modelId: string;
  /** undefined when the model id is unknown (reported by validation). */
  model: DeviceModel | undefined;
  /** Deck scenes in deck order. */
  scenes: Scene[];
  /** slug → scene id. */
  slugs: Record<string, string>;
  brightness?: number;
}

export interface BuiltDeck {
  devices: BuiltDevice[];
  /** Every Home Assistant entity referenced by a `ha.<entity>.<attr>` template (plus deck.watch), sorted. */
  watched: string[];
  /** Plugin ids the deck's actions need, sorted. */
  requiredPlugins: string[];
}

/** One action occurrence inside a scene. */
export interface ActionSite {
  path: string;
  actionId: string;
  settings: Record<string, string>;
  /** Where the action fires: key press, encoder rotate/press, strip tap/longPress/swipe, or a multi-action step. */
  kind: "key" | "encoderPress" | "encoderRotate" | "tap" | "longPress" | "swipe" | "step";
}

/** Every action of a scene, including multi-action steps (recursively). Settings objects are live references. */
export function sceneActions(scene: Scene, base: string): ActionSite[] {
  const out: ActionSite[] = [];
  const add = (path: string, actionId: unknown, settings: unknown, kind: ActionSite["kind"]) => {
    const id = typeof actionId === "string" ? actionId : "";
    const s = (settings && typeof settings === "object" ? settings : {}) as Record<string, string>;
    out.push({ path, actionId: id, settings: s, kind });
    if (id === "multi-action") addSteps(path, s.steps);
  };
  const addSteps = (path: string, json: unknown) => {
    if (typeof json !== "string" || json.trim() === "") return;
    let steps: unknown;
    try { steps = JSON.parse(json); } catch { return; }
    if (!Array.isArray(steps)) return;
    steps.forEach((st, i) => {
      if (st && typeof st === "object") {
        const o = st as Record<string, unknown>;
        add(`${path}.steps[${i}]`, o.actionId ?? o.actionType, o.settings, "step");
      }
    });
  };
  for (const [k, key] of Object.entries(scene.keys ?? {})) {
    add(`${base}.keys.${k}`, key?.action?.id, key?.settings, "key");
  }
  for (const [e, enc] of Object.entries(scene.encoders ?? {})) {
    add(`${base}.encoders.${e}.press`, enc?.pressAction?.id, enc?.pressSettings, "encoderPress");
    add(`${base}.encoders.${e}.rotate`, enc?.rotateAction?.id, enc?.rotateSettings, "encoderRotate");
  }
  (scene.strip?.items ?? []).forEach((it, i) => {
    const p = `${base}.strip.items[${i}:${it?.id}]`;
    if (it?.tapAction) add(`${p}.tap`, it.tapAction.id, it.tapSettings, "tap");
    if (it?.longPressAction) add(`${p}.longPress`, it.longPressAction.id, it.longPressSettings, "longPress");
    if (it?.swipeAction) add(`${p}.swipe`, it.swipeAction.id, it.swipeSettings, "swipe");
  });
  return out;
}

/** Visit every string in a JSON value with its path. */
export function walkStrings(value: unknown, path: string, visit: (s: string, path: string) => void): void {
  if (typeof value === "string") { visit(value, path); return; }
  if (Array.isArray(value)) { value.forEach((v, i) => walkStrings(v, `${path}[${i}]`, visit)); return; }
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) walkStrings(v, `${path}.${k}`, visit);
  }
}

const HA_VAR_RE = /^ha\.([a-z0-9_]+\.[a-z0-9_]+)\.(.+)$/;

/** Split an HA variable name "ha.<domain>.<object>.<attr>" into entity and attribute. */
export function parseHaVariable(name: string): { entity: string; attr: string } | null {
  const m = HA_VAR_RE.exec(name);
  return m ? { entity: m[1], attr: m[2] } : null;
}

/** HA references in all template strings of a value. */
export function haReferences(value: unknown, base: string): Array<{ entity: string; attr: string; path: string }> {
  const refs: Array<{ entity: string; attr: string; path: string }> = [];
  walkStrings(value, base, (s, path) => {
    for (const name of extractVariableNames(s)) {
      const r = parseHaVariable(name);
      if (r) refs.push({ ...r, path });
    }
  });
  return refs;
}

/** Replace "@scene:<slug>" in a switch-scene settings object (in place). */
function resolveRef(settings: Record<string, string>, slugs: Record<string, string>): void {
  const v = settings.sceneId;
  if (typeof v === "string" && v.startsWith(SCENE_REF_PREFIX)) {
    const id = slugs[v.slice(SCENE_REF_PREFIX.length)];
    if (id) settings.sceneId = id;
  }
}

/** Resolve scene references in a multi-action steps JSON string (recursively). */
function resolveStepsJson(json: string, slugs: Record<string, string>): string {
  let steps: unknown;
  try { steps = JSON.parse(json); } catch { return json; }
  if (!Array.isArray(steps)) return json;
  let changed = false;
  for (const st of steps) {
    if (!st || typeof st !== "object") continue;
    const o = st as Record<string, unknown>;
    const s = o.settings as Record<string, string> | undefined;
    if (!s || typeof s !== "object") continue;
    const id = o.actionId ?? o.actionType;
    if (id === "switch-scene") {
      const before = s.sceneId;
      resolveRef(s, slugs);
      if (s.sceneId !== before) changed = true;
    } else if (id === "multi-action" && typeof s.steps === "string") {
      const next = resolveStepsJson(s.steps, slugs);
      if (next !== s.steps) { s.steps = next; changed = true; }
    }
  }
  return changed ? JSON.stringify(steps) : json;
}

function resolveSceneRefs(scene: Scene, slugs: Record<string, string>): void {
  const fix = (actionId: string | undefined, settings: Record<string, string> | undefined) => {
    if (!settings) return;
    if (actionId === "switch-scene") resolveRef(settings, slugs);
    else if (actionId === "multi-action" && typeof settings.steps === "string") settings.steps = resolveStepsJson(settings.steps, slugs);
  };
  for (const k of Object.values(scene.keys)) fix(k.action?.id, k.settings);
  for (const e of Object.values(scene.encoders ?? {})) {
    fix(e.pressAction?.id, e.pressSettings);
    fix(e.rotateAction?.id, e.rotateSettings);
  }
  for (const it of scene.strip?.items ?? []) {
    fix(it.tapAction?.id, it.tapSettings);
    fix(it.longPressAction?.id, it.longPressSettings);
    fix(it.swipeAction?.id, it.swipeSettings);
  }
}

export function buildDeck(deck: DeckSpec): BuiltDeck {
  const watched = new Set<string>(deck.watch ?? []);
  const plugins = new Set<string>();
  const devices: BuiltDevice[] = deck.devices.map(d => {
    const slugs: Record<string, string> = {};
    for (const s of d.scenes) slugs[s.slug] = s.scene.id;
    const scenes = d.scenes.map(s => {
      const sc = cloneJson(s.scene);
      resolveSceneRefs(sc, slugs);
      return sc;
    });
    for (const sc of scenes) {
      for (const r of haReferences(sc, sc.id)) watched.add(r.entity);
      for (const site of sceneActions(sc, sc.id)) {
        const found = findAction(site.actionId);
        if (found) plugins.add(found.plugin);
      }
    }
    const built: BuiltDevice = { serial: d.serial, modelId: d.model, model: findDeviceModel(d.model), scenes, slugs };
    if (d.brightness !== undefined) built.brightness = d.brightness;
    return built;
  });
  return { devices, watched: [...watched].sort(), requiredPlugins: [...plugins].sort() };
}
