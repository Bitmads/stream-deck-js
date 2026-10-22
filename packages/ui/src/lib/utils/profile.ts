// Pure profile parsing, validation and migration (no Svelte/Tauri), shared by the store and tests.
//
// parseProfileJson() either returns a normalized SavedProfile or throws ProfileFormatError; it never
// returns a partially valid profile, so callers can keep their current state on any error.
// Normalization only fills in missing defaults and coerces values to the types the app relies on
// (settings values are strings, encoder value/min/max are strings, step is a number). Unknown fields
// are preserved untouched, so loading and saving a valid file does not drop data.

import type {
  ActionDef, DeviceConfig, EncoderConfig, KeyAssignment, SavedProfile, Scene, StripConfig,
} from "../types/profile";

export const NONE_ACTION: ActionDef = { id: "none", label: "None", icon: "", color: "#333" };

export class ProfileFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProfileFormatError";
  }
}

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function fail(path: string, msg: string): never {
  throw new ProfileFormatError(`${path}: ${msg}`);
}

export function cloneJson<T>(v: T): T {
  return JSON.parse(JSON.stringify(v));
}

export function newSceneId(): string {
  return globalThis.crypto.randomUUID();
}

export function createEmptyScene(name = "Default", id: string = newSceneId()): Scene {
  return { id, name, keys: {}, triggers: [{ type: "manual" }] };
}

export function createDeviceConfig(): DeviceConfig {
  const scene = createEmptyScene();
  return { scenes: { [scene.id]: scene }, activeSceneId: scene.id };
}

function settingString(v: unknown): string {
  if (typeof v === "string") return v;
  if (v === null || v === undefined) return "";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

function normalizeSettings(v: unknown, path: string): Record<string, string> {
  if (v === undefined || v === null) return {};
  if (!isObj(v)) fail(path, "settings must be an object");
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v)) out[k] = settingString(val);
  return out;
}

function normalizeAction(v: unknown, path: string, required: boolean): ActionDef {
  if (v === undefined || v === null) {
    if (required) fail(path, "missing action");
    return { ...NONE_ACTION };
  }
  if (!isObj(v) || typeof v.id !== "string" || v.id === "") fail(path, "action must be an object with a string id");
  return {
    ...(v as Obj),
    id: v.id,
    label: typeof v.label === "string" ? v.label : v.id,
    icon: typeof v.icon === "string" ? v.icon : "",
    color: typeof v.color === "string" ? v.color : "#333",
  } as ActionDef;
}

function normalizeKey(v: unknown, path: string): KeyAssignment {
  if (!isObj(v)) fail(path, "key must be an object");
  const key = v as unknown as KeyAssignment;
  key.action = normalizeAction(v.action, `${path}.action`, true);
  key.settings = normalizeSettings(v.settings, `${path}.settings`);
  if (typeof v.backgroundColor !== "string") key.backgroundColor = "#000000";
  if (v.texts !== undefined && !Array.isArray(v.texts)) fail(`${path}.texts`, "must be an array");
  if (v.icons !== undefined && !Array.isArray(v.icons)) fail(`${path}.icons`, "must be an array");
  if (v.text !== undefined && v.text !== null && !isObj(v.text)) fail(`${path}.text`, "must be an object");
  if (v.icon !== undefined && v.icon !== null && !isObj(v.icon)) fail(`${path}.icon`, "must be an object");
  return key;
}

function normalizeEncoder(v: unknown, path: string): EncoderConfig {
  if (!isObj(v)) fail(path, "encoder must be an object");
  const enc = v as unknown as EncoderConfig;
  enc.pressAction = normalizeAction(v.pressAction, `${path}.pressAction`, false);
  enc.rotateAction = normalizeAction(v.rotateAction, `${path}.rotateAction`, false);
  enc.pressSettings = normalizeSettings(v.pressSettings, `${path}.pressSettings`);
  enc.rotateSettings = normalizeSettings(v.rotateSettings, `${path}.rotateSettings`);
  enc.label = typeof v.label === "string" ? v.label : "";
  enc.value = v.value === undefined || v.value === null ? "0" : settingString(v.value);
  enc.min = v.min === undefined || v.min === null ? "0" : settingString(v.min);
  enc.max = v.max === undefined || v.max === null ? "100" : settingString(v.max);
  const step = Number(v.step);
  enc.step = Number.isFinite(step) && step !== 0 ? step : 1;
  return enc;
}

function normalizeStrip(v: unknown, path: string): StripConfig {
  if (!isObj(v)) fail(path, "strip must be an object");
  const strip = v as unknown as StripConfig;
  if (typeof v.backgroundColor !== "string") strip.backgroundColor = "#0a0a1a";
  if (v.items === undefined) strip.items = [];
  else if (!Array.isArray(v.items)) fail(`${path}.items`, "must be an array");
  const seen = new Set<string>();
  strip.items.forEach((it, i) => {
    const p = `${path}.items[${i}]`;
    if (!isObj(it)) fail(p, "item must be an object");
    for (const f of ["x", "y", "w", "h"] as const) {
      const n = Number((it as unknown as Obj)[f]);
      if (!Number.isFinite(n)) fail(`${p}.${f}`, "must be a number");
      it[f] = n;
    }
    if (typeof it.id !== "string" || !it.id || seen.has(it.id)) it.id = newSceneId();
    seen.add(it.id);
    if (it.texts !== undefined && !Array.isArray(it.texts)) fail(`${p}.texts`, "must be an array");
    for (const g of ["tap", "longPress", "swipe"] as const) {
      const a = (it as unknown as Obj)[`${g}Action`];
      if (a !== undefined) (it as unknown as Obj)[`${g}Action`] = normalizeAction(a, `${p}.${g}Action`, false);
      const s = (it as unknown as Obj)[`${g}Settings`];
      if (s !== undefined) (it as unknown as Obj)[`${g}Settings`] = normalizeSettings(s, `${p}.${g}Settings`);
    }
    if (it.bar !== undefined) {
      if (!isObj(it.bar)) fail(`${p}.bar`, "must be an object");
      const bar = it.bar as unknown as Obj;
      for (const f of ["value", "min", "max", "color"]) if (bar[f] !== undefined) bar[f] = settingString(bar[f]);
    }
  });
  return strip;
}

function normalizeScene(v: unknown, id: string, path: string): Scene {
  if (!isObj(v)) fail(path, "scene must be an object");
  const scene = v as unknown as Scene;
  scene.id = id;
  if (typeof v.name !== "string") scene.name = "Scene";
  if (v.keys === undefined) scene.keys = {};
  else if (!isObj(v.keys)) fail(`${path}.keys`, "must be an object");
  for (const [k, key] of Object.entries(scene.keys)) {
    if (!/^\d+$/.test(k)) fail(`${path}.keys.${k}`, "key index must be a non-negative integer");
    scene.keys[k] = normalizeKey(key, `${path}.keys.${k}`);
  }
  if (v.encoders !== undefined && v.encoders !== null) {
    if (!isObj(v.encoders)) fail(`${path}.encoders`, "must be an object");
    for (const [k, enc] of Object.entries(v.encoders)) scene.encoders![k] = normalizeEncoder(enc, `${path}.encoders.${k}`);
  } else if (v.encoders === null) {
    delete scene.encoders;
  }
  if (v.strip !== undefined && v.strip !== null) scene.strip = normalizeStrip(v.strip, `${path}.strip`);
  else if (v.strip === null) delete scene.strip;
  if (v.triggers === undefined) scene.triggers = [{ type: "manual" }];
  else if (!Array.isArray(v.triggers)) fail(`${path}.triggers`, "must be an array");
  else if (!v.triggers.every(isObj)) fail(`${path}.triggers`, "every trigger must be an object");
  return scene;
}

function normalizeScenes(v: unknown, path: string): Record<string, Scene> {
  if (!isObj(v)) fail(path, "scenes must be an object");
  const scenes = v as Record<string, Scene>;
  for (const [id, s] of Object.entries(scenes)) scenes[id] = normalizeScene(s, id, `${path}.${id}`);
  return scenes;
}

function normalizeDevice(v: unknown, path: string): DeviceConfig {
  if (!isObj(v)) fail(path, "device config must be an object");
  const dev = v as unknown as DeviceConfig;
  dev.scenes = normalizeScenes(v.scenes ?? {}, `${path}.scenes`);
  const ids = Object.keys(dev.scenes);
  if (typeof v.activeSceneId !== "string" || !dev.scenes[v.activeSceneId]) dev.activeSceneId = ids[0] ?? null;
  if (v.brightness !== undefined && (typeof v.brightness !== "number" || !Number.isFinite(v.brightness) || v.brightness < 0 || v.brightness > 100)) {
    fail(`${path}.brightness`, "must be a number from 0 to 100");
  }
  return dev;
}

function stringArray(v: unknown, path: string): string[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) fail(path, "must be an array");
  return v.filter((x): x is string => typeof x === "string");
}

/**
 * Validate and normalize an already-parsed profile object (mutates and returns it).
 * Throws ProfileFormatError on a shape error.
 */
export function normalizeProfile(data: unknown, fallbackName = "default"): SavedProfile {
  if (!isObj(data)) fail("profile", "must be a JSON object");
  const p = data as unknown as SavedProfile;
  if (typeof data.name !== "string" || !data.name) p.name = fallbackName;
  if (data.devices !== undefined && data.devices !== null) {
    if (!isObj(data.devices)) fail("devices", "must be an object");
    for (const [serial, dev] of Object.entries(data.devices)) p.devices![serial] = normalizeDevice(dev, `devices.${serial}`);
  } else {
    p.devices = {};
  }
  // Legacy single-device layout (may coexist with `devices` while not yet bound to a device).
  if (data.scenes !== undefined && data.scenes !== null) {
    p.scenes = normalizeScenes(data.scenes, "scenes");
    const ids = Object.keys(p.scenes);
    if (typeof data.activeSceneId !== "string" || !p.scenes[data.activeSceneId]) p.activeSceneId = ids[0] ?? null;
  } else {
    delete p.scenes;
    delete p.activeSceneId;
  }
  p.favorites = stringArray(data.favorites, "favorites");
  p.recent = stringArray(data.recent, "recent");
  return p;
}

/** Parse + validate profile JSON text. Throws ProfileFormatError (with a readable message) on any problem. */
export function parseProfileJson(json: string, fallbackName = "default"): SavedProfile {
  let data: unknown;
  try { data = JSON.parse(json); }
  catch (e) { throw new ProfileFormatError(`Invalid JSON: ${(e as Error).message}`); }
  return normalizeProfile(data, fallbackName);
}

/** True when the profile carries a legacy single-device layout (top-level scenes). */
export function isLegacyProfile(p: SavedProfile): boolean {
  return !!p.scenes;
}

/** Legacy profile → its scenes as one DeviceConfig (assigned to the first device that binds). */
export function legacyDeviceConfig(p: SavedProfile): DeviceConfig | null {
  if (!p.scenes) return null;
  const ids = Object.keys(p.scenes);
  const active = p.activeSceneId && p.scenes[p.activeSceneId] ? p.activeSceneId : (ids[0] ?? null);
  return { scenes: p.scenes, activeSceneId: active };
}

/** Build the on-disk representation. */
export function serializeProfile(
  name: string,
  devices: Record<string, DeviceConfig>,
  favorites: string[],
  recent: string[],
  pendingLegacy?: DeviceConfig | null,
): string {
  const data: SavedProfile = { name, devices: cloneJson(devices), favorites: [...favorites], recent: [...recent] };
  // A legacy layout that has not been bound to a device yet is kept in its legacy slot, not dropped.
  if (pendingLegacy) {
    data.scenes = cloneJson(pendingLegacy.scenes);
    data.activeSceneId = pendingLegacy.activeSceneId;
  }
  return JSON.stringify(data);
}
