// Static facts copied from the UI, which cannot be imported in Node because they live in modules
// that import Svelte/Tauri. test/catalog.test.ts parses the source files and fails on drift.
//
// - ACTIONS: the ActionDef constants of each built-in plugin (packages/ui/src/lib/plugins/*/index.ts)
//   plus NONE_ACTION (lib/utils/profile.ts, imported directly).
// - UI_FONTS: the font <select> of components/icon/TextConfig.svelte.
// - HA_CONTROLS: the numeric controls of HAClient.getEntityControls (plugins/homeassistant/client.ts).

import type { ActionDef } from "../../ui/src/lib/types/profile.ts";
import { NONE_ACTION } from "../../ui/src/lib/utils/profile.ts";

export { NONE_ACTION };

export interface CatalogAction {
  def: ActionDef;
  /** Plugin id whose enabled state registers the action (plugins.json key). */
  plugin: string;
  /**
   * Executed by the store dispatcher itself (store.executeAction switch), so it works even when the
   * plugin is disabled; the plugin only adds it to the action picker.
   */
  dispatcherHandled: boolean;
}

function a(id: string, label: string, icon: string, color: string, plugin: string, dispatcherHandled = false): CatalogAction {
  return { def: { id, label, icon, color }, plugin, dispatcherHandled };
}

export const ACTIONS: readonly CatalogAction[] = [
  a("ha-service", "HA Service Call", "🏠", "#03a9f4", "homeassistant"),
  a("ha-custom", "HA Custom JSON", "🏠", "#0288d1", "homeassistant"),
  a("http-request", "HTTP Request", "↗", "#00bcd4", "http-actions"),
  a("switch-scene", "Switch Scene", "⇄", "#ff9800", "navigation", true),
  a("back", "Back (Previous Scene)", "←", "#607d8b", "navigation", true),
  a("hotkey", "Hotkey", "⌨", "#e74c3c", "system-actions"),
  a("launch", "Launch App", "🚀", "#3498db", "system-actions"),
  a("command", "Shell Command", ">_", "#2ecc71", "system-actions"),
  a("open-url", "Open URL", "🔗", "#9b59b6", "system-actions"),
  a("timer", "Timer", "⏱", "#f39c12", "utilities", true),
  a("counter", "Counter", "#", "#e91e63", "utilities", true),
  a("multi-action", "Multi-Action", "▶▶", "#e67e22", "multi-action"),
];

/** Built-in plugin ids (all default to enabled when absent from plugins.json). */
export const BUILTIN_PLUGINS: readonly string[] = [
  "system-actions", "http-actions", "navigation", "utilities", "multi-action", "homeassistant",
];

export function findAction(id: string): CatalogAction | undefined {
  return ACTIONS.find(x => x.def.id === id);
}

/** A fresh copy of the ActionDef for `id` ("none" included); throws on an unknown id. */
export function actionDef(id: string): ActionDef {
  if (id === NONE_ACTION.id) return { ...NONE_ACTION };
  const found = findAction(id);
  if (!found) throw new Error(`Unknown action id "${id}"`);
  return { ...found.def };
}

/** Font families offered by the UI text editor. */
export const UI_FONTS: readonly string[] = [
  "sans-serif", "serif", "monospace", "Roboto", "Inter", "Source Sans 3", "Fira Code", "JetBrains Mono", "Orbitron",
];

/** Smallest font size (px) the validator considers legible on a key or the strip. */
export const MIN_LEGIBLE_FONT_PX = 12;

/** A numeric Home Assistant control an encoder or strip gesture can drive. */
export interface HaControlSpec {
  /** ha_control id used by the UI picker. */
  id: string;
  service: string;
  /** Service-data key written with the value. */
  attr: string;
  /** Attribute that reports the current value when it differs from `attr`. */
  readAttr?: string;
  min: number;
  max: number;
  step: number;
  /** Domains this control applies to (getEntityControls detects it from attributes; these are the usual ones). */
  domains: readonly string[];
  /**
   * True when HAClient.getEntityControls knows the range, which strip tap/swipe gestures need to map
   * a 0..1 ratio onto the value. Encoders send an absolute value and work either way.
   */
  ratioMapping: boolean;
}

/**
 * Same ids, services, attributes and default ranges as HAClient.getEntityControls. Ranges that
 * getEntityControls reads from entity attributes (color temp, temperature, speed step, number
 * min/max/step) carry the fallback values used there.
 */
export const HA_CONTROLS: readonly HaControlSpec[] = [
  { id: "brightness", service: "turn_on", attr: "brightness", min: 0, max: 255, step: 5, domains: ["light"], ratioMapping: true },
  { id: "color_temp", service: "turn_on", attr: "color_temp_kelvin", min: 2000, max: 6500, step: 100, domains: ["light"], ratioMapping: true },
  { id: "volume", service: "volume_set", attr: "volume_level", min: 0, max: 1, step: 0.05, domains: ["media_player"], ratioMapping: true },
  { id: "temperature", service: "set_temperature", attr: "temperature", min: 16, max: 30, step: 0.5, domains: ["climate", "water_heater"], ratioMapping: true },
  { id: "position", service: "set_cover_position", attr: "position", readAttr: "current_position", min: 0, max: 100, step: 5, domains: ["cover"], ratioMapping: true },
  { id: "percentage", service: "set_percentage", attr: "percentage", min: 0, max: 100, step: 10, domains: ["fan"], ratioMapping: true },
  { id: "value", service: "set_value", attr: "value", readAttr: "state", min: 0, max: 100, step: 1, domains: ["number", "input_number"], ratioMapping: true },
  // Not in getEntityControls: humidifier.set_humidity with HA's default 0..100 range
  // (min_humidity/max_humidity). Works on encoders (absolute value); strip ratio gestures fail
  // because the client cannot map a ratio without a known range.
  { id: "humidity", service: "set_humidity", attr: "humidity", min: 0, max: 100, step: 1, domains: ["humidifier"], ratioMapping: false },
];

export function haControl(id: string): HaControlSpec {
  const c = HA_CONTROLS.find(x => x.id === id);
  if (!c) throw new Error(`Unknown HA control "${id}" (known: ${HA_CONTROLS.map(x => x.id).join(", ")})`);
  return c;
}

/** The control for an attribute (ha_attr) in a domain, if any. */
export function haControlForAttr(domain: string, attr: string): HaControlSpec | undefined {
  return HA_CONTROLS.find(c => c.attr === attr && c.domains.includes(domain))
    ?? HA_CONTROLS.find(c => c.attr === attr);
}
