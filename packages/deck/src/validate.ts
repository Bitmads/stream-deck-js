// Deck validation. Nothing in the app validates a profile beyond its JSON shape, so every rule the
// renderer and the action dispatcher rely on is checked here before anything is written.

import type {
  ActionDef, EncoderConfig, IconConfig, KeyAssignment, Scene, StripItem, TextConfig,
} from "../../ui/src/lib/types/profile.ts";
import { walkTemplates, NESTED_MARK, isKnownFilter, isUsableColor } from "../../ui/src/lib/utils/template.ts";
import { pickStatSources } from "../../ui/src/lib/plugins/homeassistant/stats.ts";
import { cloneJson, normalizeProfile } from "../../ui/src/lib/utils/profile.ts";
import { parseSteps } from "../../ui/src/lib/plugins/multi-action/steps.ts";
import { ZERO_WHEN_NULL_ATTRS } from "../../ui/src/lib/plugins/homeassistant/mapping.ts";
import {
  ACTIONS, MIN_LEGIBLE_FONT_PX, NONE_ACTION, UI_FONTS, findAction, haControlForAttr,
} from "./catalog.ts";
import { STRIP_DESIGN_HEIGHT, STRIP_DESIGN_WIDTH, buttonCount, keyCount, type DeviceModel } from "./devices.ts";
import { SCENE_REF_PREFIX } from "./builders.ts";
import { haReferences, sceneActions, walkStrings, type ActionSite, type BuiltDeck, type BuiltDevice } from "./build.ts";

export type IssueLevel = "error" | "warning";

export interface Issue {
  level: IssueLevel;
  path: string;
  message: string;
}

/** Minimal shape of a Home Assistant state object (GET /api/states). */
export interface HaStateLite {
  entity_id: string;
  state: string;
  attributes?: Record<string, unknown>;
}

export interface ValidateOptions {
  /** Scene ids that will exist on each device after the merge (deck scenes are always included). */
  sceneIdsBySerial?: Record<string, string[]>;
  /** Live states (e.g. from --ha-states <file>) to check referenced entities and attributes. */
  haStates?: HaStateLite[];
  /** Contents of plugins.json, to report required plugins that are disabled. */
  pluginStates?: Record<string, { enabled?: boolean }>;
}

class Issues {
  list: Issue[] = [];
  error(path: string, message: string) { this.list.push({ level: "error", path, message }); }
  warn(path: string, message: string) { this.list.push({ level: "warning", path, message }); }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const SAFE_VIEWBOX_RE = /^-?[\d.]+(\s+|,)-?[\d.]+(\s+|,)[\d.]+(\s+|,)[\d.]+$/;

// ─── Templates ───────────────────────────────────────────────

/** Split on unescaped `sep` (template.ts splitEscaped semantics, without unescaping). */
function splitUnescaped(s: string, sep: string): string[] {
  const out: string[] = [];
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\\" && i + 1 < s.length) { cur += s[i] + s[i + 1]; i++; continue; }
    if (s[i] === sep) { out.push(cur); cur = ""; continue; }
    cur += s[i];
  }
  out.push(cur);
  return out;
}

function hasUnescaped(s: string, ch: string): boolean {
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\\") { i++; continue; }
    if (s[i] === ch) return true;
  }
  return false;
}

/** Check template syntax in one string (filters from template.ts, map/replace argument pitfalls). */
export function checkTemplateString(s: string, path: string, issues: Issues): void {
  if (!s.includes("{{")) return;
  const exprs: string[] = [];
  if (!walkTemplates(s, (expr) => exprs.push(expr))) {
    issues.error(path, `Template is not closed by "}}": ${JSON.stringify(s.slice(s.lastIndexOf("{{"), s.lastIndexOf("{{") + 40))}`);
    return;
  }
  for (const expr of exprs) checkExpression(expr, path, issues);
}

function checkExpression(rawExpr: string, path: string, issues: Issues): void {
  // Nested templates were evaluated first; show them as "{{…}}" in messages.
  const expr = rawExpr.split(NESTED_MARK).join("{{…}}");
  const show = `{{${expr}}}`;
  if (/[{}]/.test(rawExpr.split(NESTED_MARK).join(""))) issues.error(path, `Stray "{" or "}" inside template expression ${show}`);
  const parts = expr.split("|");
  const name = parts[0].trim().replace(/^\$/, "").trim();
  if (!name) issues.error(path, `Template ${show} has no variable name`);
  let prevArgFilter: string | null = null;
  for (let k = 1; k < parts.length; k++) {
    const seg = parts[k].trim();
    if (seg === "") { issues.warn(path, `Empty filter in ${show}`); prevArgFilter = null; continue; }
    if (!isKnownFilter(seg)) {
      if (prevArgFilter) {
        issues.error(path, `"|" inside the ${prevArgFilter} argument of ${show} splits the filter chain ("|" cannot be escaped)`);
      } else {
        issues.warn(path, `Unknown filter "${seg}" in ${show}: it is only used as fallback text while the variable is missing`);
      }
      prevArgFilter = null;
      continue;
    }
    prevArgFilter = null;
    if (seg.startsWith("map:")) {
      prevArgFilter = "map";
      const arg = seg.slice(4);
      if (!arg) { issues.error(path, `map filter without entries in ${show}`); continue; }
      for (const entry of splitUnescaped(arg, ":")) {
        if (!hasUnescaped(entry, "=")) {
          issues.error(path, `map entry "${entry}" in ${show} has no "=": escape ":" and "=" inside keys/values as "\\:" / "\\="`);
        }
      }
    } else if (seg.startsWith("replace:")) {
      prevArgFilter = "replace";
      const arg = seg.slice(8);
      const re = /^\/(.+)\/([dgimsuy]*)=(.*)$/s.exec(arg);
      if (re) {
        try { new RegExp(re[1], re[2] || "g"); } catch (e) {
          issues.error(path, `Invalid regex in ${show}: ${e instanceof Error ? e.message : String(e)}`);
        }
      } else {
        const eq = splitUnescaped(arg, "=");
        if (eq[0] === "") issues.warn(path, `replace filter with an empty search text does nothing in ${show}`);
        if (eq.length > 2) issues.warn(path, `replace argument of ${show} has more than one unescaped "=": the search text ends at the first one (escape "=" in the search text as "\\=")`);
      }
    } else if (seg.startsWith("default:")) {
      prevArgFilter = "default";
    }
  }
}

// ─── Field checks ────────────────────────────────────────────

function checkColor(v: unknown, path: string, issues: Issues, required: boolean): void {
  if (v === undefined || v === null) { if (required) issues.error(path, "missing color"); return; }
  if (typeof v !== "string") { issues.error(path, "color must be a string"); return; }
  if (v.includes("{{")) return;
  if (!isUsableColor(v)) issues.error(path, `"${v}" is not a usable color (#hex, rgb()/hsl(), CSS name or a template)`);
}

function checkNumberish(v: unknown, path: string, issues: Issues): void {
  if (typeof v !== "string") { issues.error(path, "must be a string (number or template)"); return; }
  if (v.includes("{{")) return;
  if (v.trim() === "" || !Number.isFinite(Number(v))) issues.error(path, `"${v}" is neither a number nor a template`);
}

function checkActionDef(a: unknown, path: string, issues: Issues): string | null {
  if (!isObj(a)) { issues.error(path, "action must be a complete ActionDef object"); return null; }
  for (const f of ["id", "label", "icon", "color"] as const) {
    if (typeof a[f] !== "string") issues.error(`${path}.${f}`, "must be a string");
  }
  const id = typeof a.id === "string" ? a.id : "";
  if (!id) { issues.error(`${path}.id`, "empty action id"); return null; }
  const def: ActionDef | undefined = id === NONE_ACTION.id ? NONE_ACTION : findAction(id)?.def;
  if (!def) {
    issues.error(`${path}.id`, `Unknown action id "${id}" (known: none, ${ACTIONS.map(x => x.def.id).join(", ")})`);
    return id;
  }
  if (a.label !== def.label || a.icon !== def.icon || a.color !== def.color) {
    issues.warn(path, `ActionDef differs from the plugin definition of "${id}" (${JSON.stringify(def)})`);
  }
  return id;
}

function checkSettings(s: unknown, path: string, issues: Issues, required: boolean): void {
  if (s === undefined) { if (required) issues.error(path, "missing settings object"); return; }
  if (!isObj(s)) { issues.error(path, "settings must be an object"); return; }
  for (const [k, v] of Object.entries(s)) {
    if (typeof v !== "string") issues.error(`${path}.${k}`, `setting values must be strings (got ${typeof v})`);
  }
}

function checkText(t: unknown, path: string, issues: Issues): void {
  if (!isObj(t)) { issues.error(path, "text layer must be an object"); return; }
  const tc = t as unknown as TextConfig;
  if (typeof tc.text !== "string") issues.error(`${path}.text`, "must be a string");
  if (typeof tc.fontFamily !== "string" || !UI_FONTS.includes(tc.fontFamily)) {
    issues.error(`${path}.fontFamily`, `"${tc.fontFamily}" is not in the UI font list (${UI_FONTS.join(", ")})`);
  }
  if (typeof tc.fontSize !== "number" || !(tc.fontSize > 0)) issues.error(`${path}.fontSize`, "must be a positive number");
  else if (!tc.hidden && tc.fontSize < MIN_LEGIBLE_FONT_PX) {
    issues.warn(`${path}.fontSize`, `${tc.fontSize}px is hard to read on the device (minimum ${MIN_LEGIBLE_FONT_PX}px)`);
  }
  if (!["normal", "bold"].includes(tc.fontWeight)) issues.error(`${path}.fontWeight`, `invalid "${tc.fontWeight}"`);
  if (!["normal", "italic"].includes(tc.fontStyle)) issues.error(`${path}.fontStyle`, `invalid "${tc.fontStyle}"`);
  if (!["left", "center", "right"].includes(tc.hAlign)) issues.error(`${path}.hAlign`, `invalid "${tc.hAlign}"`);
  if (!["top", "middle", "bottom"].includes(tc.vAlign)) issues.error(`${path}.vAlign`, `invalid "${tc.vAlign}"`);
  if (!["start", "center", "end"].includes(tc.anchor)) issues.error(`${path}.anchor`, `invalid "${tc.anchor}"`);
  if (typeof tc.useAbsolutePos !== "boolean") issues.error(`${path}.useAbsolutePos`, "must be a boolean");
  if (tc.wrap !== undefined && !["none", "word", "char"].includes(tc.wrap)) issues.error(`${path}.wrap`, `invalid "${tc.wrap}"`);
  checkColor(tc.color, `${path}.color`, issues, true);
  if (tc.shadow) checkColor(tc.shadow.color, `${path}.shadow.color`, issues, true);
  if (tc.stroke) checkColor(tc.stroke.color, `${path}.stroke.color`, issues, true);
}

function checkIcon(ic: unknown, path: string, issues: Issues): void {
  if (!isObj(ic)) { issues.error(path, "icon must be an object"); return; }
  const c = ic as unknown as IconConfig;
  for (const f of ["setId", "iconName", "svgBody", "viewBox"] as const) {
    if (typeof c[f] !== "string") issues.error(`${path}.${f}`, "must be a string");
  }
  if (!c.svgBody) issues.error(`${path}.svgBody`, "empty icon body (the icon is never drawn)");
  if (typeof c.viewBox === "string" && !SAFE_VIEWBOX_RE.test(c.viewBox.trim())) {
    issues.error(`${path}.viewBox`, `"${c.viewBox}" is not a plain "minX minY w h" viewBox (the renderer falls back to 0 0 24 24)`);
  }
  if (typeof c.size !== "number" || !(c.size > 0)) issues.error(`${path}.size`, "must be a positive number");
  checkColor(c.color, `${path}.color`, issues, true);
  if (c.variable !== undefined) {
    if (typeof c.variable !== "string" || !c.variable.includes("{{")) {
      issues.warn(`${path}.variable`, `conditional icon variable should be a full template such as "{{$ha.x.state}}" (a bare name resolves to itself)`);
    }
    if (typeof c.value !== "string") issues.error(`${path}.value`, "conditional icon needs a string value");
  }
}

// ─── Actions ─────────────────────────────────────────────────

/** Settings as strings (non-string values are reported by checkSettings; coerced here so checks never throw). */
function settingStrings(settings: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!isObj(settings)) return out;
  for (const [k, v] of Object.entries(settings)) out[k] = typeof v === "string" ? v : v == null ? "" : String(v);
  return out;
}

function checkActionSettings(site: ActionSite, sceneIds: Set<string>, issues: Issues): void {
  const s = settingStrings(site.settings);
  const p = site.path;
  switch (site.actionId) {
    case "switch-scene": {
      const id = s.sceneId ?? "";
      if (!id) issues.error(p, "switch-scene without sceneId");
      else if (id.startsWith(SCENE_REF_PREFIX)) issues.error(p, `Scene reference "${id.slice(SCENE_REF_PREFIX.length)}" does not match any scene slug on this device`);
      else if (!sceneIds.has(id)) issues.error(p, `Scene ${id} does not exist on this device`);
      if (s.mode !== undefined && s.mode !== "push" && s.mode !== "switch") issues.error(p, `mode must be "push" or "switch" (got "${s.mode}")`);
      break;
    }
    case "ha-service": {
      if (!s.ha_domain) issues.error(p, "ha-service without ha_domain");
      if (!s.ha_service) issues.error(p, "ha-service without ha_service");
      const entDomain = (s.ha_entity ?? "").split(".")[0];
      if (s.ha_entity && s.ha_domain && entDomain !== s.ha_domain && s.ha_domain !== "homeassistant") {
        issues.warn(p, `entity ${s.ha_entity} is not in domain "${s.ha_domain}"`);
      }
      if (s.ha_service_data) {
        try {
          const d = JSON.parse(s.ha_service_data);
          if (!isObj(d)) issues.error(p, "ha_service_data must be a JSON object");
        } catch (e) {
          issues.error(p, `ha_service_data is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
        }
      } else if (s.ha_attr) {
        const hasValue = (s.value ?? "").trim() !== "";
        const ctrl = haControlForAttr(entDomain, s.ha_attr);
        if (site.kind === "tap" || site.kind === "swipe") {
          if (!hasValue && !ctrl?.ratioMapping) {
            issues.error(p, `strip ${site.kind} on ${s.ha_entity}.${s.ha_attr}: the app cannot map a touch position onto this attribute (no HA control range); set a fixed value`);
          }
        } else if (site.kind === "key" || site.kind === "longPress" || site.kind === "step") {
          if (!hasValue) issues.error(p, `HA control "${s.ha_attr}" needs a value here (only encoders and strip tap/swipe supply one)`);
        }
      }
      break;
    }
    case "ha-custom": {
      try {
        const msg = JSON.parse(s.ha_custom_json ?? "");
        if (!isObj(msg)) issues.error(p, "ha_custom_json must be a JSON object");
        else if ((msg.type ?? "call_service") === "call_service" && (typeof msg.domain !== "string" || typeof msg.service !== "string")) {
          issues.error(p, 'ha_custom_json call_service needs "domain" and "service" strings');
        }
      } catch (e) {
        issues.error(p, `ha_custom_json is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
      }
      break;
    }
    case "multi-action": {
      try { parseSteps(s.steps); } catch (e) { issues.error(p, e instanceof Error ? e.message : String(e)); }
      break;
    }
    case "hotkey":
      if (!s.key) issues.error(p, "hotkey without key");
      break;
    case "command":
      if (!s.command) issues.error(p, "command without command");
      break;
    case "launch":
      if (!s.target) issues.error(p, "launch without target");
      break;
    case "open-url":
      if (!s.url) issues.error(p, "open-url without url");
      break;
    case "http-request":
      if (!/^https?:\/\//i.test(s.url ?? "") && !(s.url ?? "").startsWith("{{")) issues.error(p, "http-request url must start with http:// or https://");
      if (s.method !== undefined && !["GET", "POST", "PUT", "DELETE"].includes(s.method)) issues.warn(p, `method "${s.method}" is sent as POST`);
      break;
    case "timer":
    case "counter":
      if (site.kind !== "key" && site.kind !== "step") issues.error(p, `${site.actionId} needs a key to display on`);
      break;
  }
}

// ─── Scene ───────────────────────────────────────────────────

function checkKey(k: KeyAssignment, path: string, model: DeviceModel | undefined, issues: Issues): void {
  if (!isObj(k)) { issues.error(path, "key must be an object"); return; }
  checkActionDef(k.action, `${path}.action`, issues);
  checkSettings(k.settings, `${path}.settings`, issues, true);
  checkColor(k.backgroundColor, `${path}.backgroundColor`, issues, true);
  if (k.texts !== undefined && !Array.isArray(k.texts)) issues.error(`${path}.texts`, "must be an array");
  if (k.icons !== undefined && !Array.isArray(k.icons)) issues.error(`${path}.icons`, "must be an array");
  const texts = Array.isArray(k.texts) && k.texts.length ? k.texts : k.text ? [k.text] : [];
  texts.forEach((t, i) => checkText(t, `${path}.texts[${i}]`, issues));
  if (Array.isArray(k.texts) && k.texts.length && !k.text) issues.warn(`${path}.text`, "legacy text mirror of texts[0] is missing");
  const icons = Array.isArray(k.icons) && k.icons.length ? k.icons : k.icon ? [k.icon] : [];
  icons.forEach((ic, i) => checkIcon(ic, `${path}.icons[${i}]`, issues));
  if (Array.isArray(k.icons) && k.icons.length && !k.icon) issues.warn(`${path}.icon`, "legacy icon mirror of icons[0] is missing");
  if (icons.length > 0 && icons.every(ic => ic.variable)) {
    issues.warn(`${path}.icons`, "every icon is conditional: add an unconditional icon as the default");
  }
  if (k.imageFit !== undefined && !["fill", "cover", "contain", "none"].includes(k.imageFit)) issues.error(`${path}.imageFit`, `invalid "${k.imageFit}"`);
  if (model && model.keyPixelSize === 0 && (texts.length || icons.length || k.imageUrl || k.imageDataUrl)) {
    issues.warn(path, `${model.id} keys have no display: visuals are never shown`);
  }
}

function checkEncoder(e: EncoderConfig, path: string, issues: Issues): void {
  if (!isObj(e)) { issues.error(path, "encoder must be an object"); return; }
  checkActionDef(e.pressAction, `${path}.pressAction`, issues);
  checkActionDef(e.rotateAction, `${path}.rotateAction`, issues);
  checkSettings(e.pressSettings, `${path}.pressSettings`, issues, true);
  checkSettings(e.rotateSettings, `${path}.rotateSettings`, issues, true);
  if (typeof e.label !== "string") issues.error(`${path}.label`, "must be a string");
  checkNumberish(e.value, `${path}.value`, issues);
  checkNumberish(e.min, `${path}.min`, issues);
  checkNumberish(e.max, `${path}.max`, issues);
  if (typeof e.step !== "number" || !Number.isFinite(e.step) || e.step === 0) issues.error(`${path}.step`, "must be a non-zero number");
}

function checkStripItem(it: StripItem, path: string, issues: Issues): void {
  if (!isObj(it)) { issues.error(path, "strip item must be an object"); return; }
  for (const f of ["x", "y", "w", "h"] as const) {
    if (typeof it[f] !== "number" || !Number.isFinite(it[f])) issues.error(`${path}.${f}`, "must be a number");
  }
  if (it.w <= 0 || it.h <= 0) issues.error(path, "w and h must be positive");
  if (it.x < 0 || it.y < 0 || it.x + it.w > STRIP_DESIGN_WIDTH || it.y + it.h > STRIP_DESIGN_HEIGHT) {
    issues.error(path, `item (${it.x},${it.y} ${it.w}x${it.h}) is outside the ${STRIP_DESIGN_WIDTH}x${STRIP_DESIGN_HEIGHT} strip`);
  }
  if (it.backgroundColor !== undefined) checkColor(it.backgroundColor, `${path}.backgroundColor`, issues, false);
  if (it.icon !== undefined) {
    checkIcon(it.icon, `${path}.icon`, issues);
    if (it.icon.variable) issues.warn(`${path}.icon.variable`, "strip items have a single icon: conditions are ignored");
  }
  if (it.texts !== undefined) {
    if (!Array.isArray(it.texts)) issues.error(`${path}.texts`, "must be an array");
    else it.texts.forEach((t, i) => checkText(t, `${path}.texts[${i}]`, issues));
  }
  if (it.bar !== undefined) {
    checkNumberish(it.bar.value, `${path}.bar.value`, issues);
    checkNumberish(it.bar.min, `${path}.bar.min`, issues);
    checkNumberish(it.bar.max, `${path}.bar.max`, issues);
    checkColor(it.bar.color, `${path}.bar.color`, issues, true);
    if (!["bottom", "full", "left"].includes(it.bar.position)) issues.error(`${path}.bar.position`, `invalid "${it.bar.position}"`);
    if (typeof it.bar.height !== "number" || !(it.bar.height > 0)) issues.error(`${path}.bar.height`, "must be a positive number");
  }
  for (const g of ["tap", "longPress", "swipe"] as const) {
    const act = it[`${g}Action`];
    const set = it[`${g}Settings`];
    if (act !== undefined) {
      checkActionDef(act, `${path}.${g}Action`, issues);
      if (set === undefined) issues.error(`${path}.${g}Settings`, `missing: the ${g} gesture only fires when its settings object exists`);
    }
    if (set !== undefined) checkSettings(set, `${path}.${g}Settings`, issues, false);
  }
}

function checkScene(scene: Scene, dev: BuiltDevice, sceneIds: Set<string>, issues: Issues): void {
  const base = `${dev.serial}/${scene.name}(${scene.id})`;
  const model = dev.model;
  if (typeof scene.name !== "string" || !scene.name) issues.error(`${base}.name`, "scene needs a name");
  if (!Array.isArray(scene.triggers)) issues.error(`${base}.triggers`, "must be an array");
  else {
    scene.triggers.forEach((t, i) => {
      const p = `${base}.triggers[${i}]`;
      if (t.type !== "window" && t.type !== "manual") issues.error(p, `unknown trigger type "${t.type}"`);
      if (t.type === "window") {
        if (!t.app_name?.trim() && !t.window_title?.trim()) issues.warn(p, "window trigger without app_name/window_title never fires");
        for (const pat of [t.app_name, t.window_title]) {
          if (pat?.startsWith("regex:")) {
            try { new RegExp(pat.slice(6), "i"); } catch (e) { issues.error(p, `invalid regex "${pat}": ${e instanceof Error ? e.message : String(e)}`); }
          }
        }
      }
    });
  }

  for (const [k, key] of Object.entries(scene.keys ?? {})) {
    const p = `${base}.keys.${k}`;
    if (!/^\d+$/.test(k)) { issues.error(p, "key index must be a non-negative integer"); continue; }
    const idx = Number(k);
    if (model) {
      if (idx >= buttonCount(model)) issues.error(p, `key ${idx} does not exist on ${model.id} (${model.columns}x${model.rows}${model.touchButtonCount ? ` + ${model.touchButtonCount} touch buttons` : ""})`);
      else if (idx >= keyCount(model)) issues.warn(p, `key ${idx} is a touch button without display on ${model.id}`);
    }
    checkKey(key, p, model, issues);
  }

  if (scene.encoders) {
    for (const [e, enc] of Object.entries(scene.encoders)) {
      const p = `${base}.encoders.${e}`;
      if (!/^\d+$/.test(e)) { issues.error(p, "encoder index must be a non-negative integer"); continue; }
      if (model && Number(e) >= model.encoderCount) issues.error(p, `encoder ${e} does not exist on ${model.id} (${model.encoderCount} encoders)`);
      checkEncoder(enc, p, issues);
    }
  }

  if (scene.strip) {
    const p = `${base}.strip`;
    if (model && !model.hasLcdStrip) issues.error(p, `${model.id} has no touch strip`);
    checkColor(scene.strip.backgroundColor, `${p}.backgroundColor`, issues, true);
    if (!Array.isArray(scene.strip.items)) issues.error(`${p}.items`, "must be an array");
    else {
      const ids = new Set<string>();
      scene.strip.items.forEach((it, i) => {
        const ip = `${p}.items[${i}]`;
        if (typeof it?.id !== "string" || !it.id) issues.error(`${ip}.id`, "strip item needs an id");
        else if (ids.has(it.id)) issues.error(`${ip}.id`, `duplicate strip item id "${it.id}"`);
        else ids.add(it.id);
        checkStripItem(it, ip, issues);
      });
    }
  }

  for (const site of sceneActions(scene, base)) {
    if (site.kind === "step") {
      if (!site.actionId) issues.error(site.path, "multi-action step without actionId");
      else if (site.actionId !== NONE_ACTION.id && !findAction(site.actionId)) issues.error(site.path, `Unknown action id "${site.actionId}"`);
      checkSettings(site.settings, `${site.path}.settings`, issues, false);
    }
    checkActionSettings(site, sceneIds, issues);
  }

  walkStrings(withoutMirrors(scene), base, (s, path) => checkTemplateString(s, path, issues));
}

// ─── Deck ────────────────────────────────────────────────────

/** Copy of a scene without the legacy text/icon mirrors that equal texts[0]/icons[0] (reported once). */
function withoutMirrors(scene: Scene): Scene {
  const copy = cloneJson(scene);
  for (const k of Object.values(copy.keys ?? {})) {
    if (!isObj(k)) continue;
    if (k.text && Array.isArray(k.texts) && JSON.stringify(k.text) === JSON.stringify(k.texts[0])) delete k.text;
    if (k.icon && Array.isArray(k.icons) && JSON.stringify(k.icon) === JSON.stringify(k.icons[0])) delete k.icon;
  }
  return copy;
}

function checkHaStates(built: BuiltDeck, states: HaStateLite[], issues: Issues): void {
  const byId = new Map(states.map(s => [s.entity_id, s]));
  /** Missing entity → first path that references it and the number of references (reported once). */
  const missing = new Map<string, { path: string; count: number }>();
  const noteMissing = (entity: string, path: string) => {
    const m = missing.get(entity);
    if (m) m.count++;
    else missing.set(entity, { path, count: 1 });
  };
  const attrWarned = new Set<string>();
  for (const dev of built.devices) {
    for (const scene of dev.scenes) {
      for (const r of haReferences(withoutMirrors(scene), `${dev.serial}/${scene.name}`)) {
        const st = byId.get(r.entity);
        if (!st) { noteMissing(r.entity, r.path); continue; }
        if (r.attr === "state" || r.attr === "friendly_name") continue;
        if (r.attr.startsWith("stats.")) { checkStatsAttr(r.entity, r.attr, st, r.path, issues); continue; }
        const attrs = st.attributes ?? {};
        const once = `${scene.id}|${r.entity}|${r.attr}`;
        if (attrWarned.has(once)) continue;
        attrWarned.add(once);
        if (!(r.attr in attrs)) {
          const why = ZERO_WHEN_NULL_ATTRS.has(r.attr) ? " (reported as 0 while the entity is off)" : "";
          issues.warn(r.path, `${r.entity} currently has no attribute "${r.attr}"${why}`);
        } else if (isObj(attrs[r.attr])) {
          issues.error(r.path, `${r.entity}.${r.attr} is an object: object attributes are never published as variables`);
        }
      }
      for (const site of sceneActions(scene, `${dev.serial}/${scene.name}`)) {
        const ent = settingStrings(site.settings).ha_entity;
        if ((site.actionId === "ha-service") && ent && !ent.includes("{{") && !byId.has(ent)) noteMissing(ent, site.path);
      }
    }
  }
  for (const id of built.watched) {
    if (!byId.has(id) && !missing.has(id)) noteMissing(id, `watch.${id}`);
  }
  for (const [entity, m] of missing) {
    issues.error(m.path, `Home Assistant entity ${entity} does not exist${m.count > 1 ? ` (${m.count} references)` : ""}`);
  }
}

export function validateDeck(built: BuiltDeck, opts: ValidateOptions = {}): Issue[] {
  const issues = new Issues();
  const serials = new Set<string>();
  for (const dev of built.devices) {
    const dp = dev.serial || "(device)";
    if (!dev.serial) issues.error(dp, "device needs a serial");
    if (serials.has(dev.serial)) issues.error(dp, `device ${dev.serial} is defined twice`);
    serials.add(dev.serial);
    if (!dev.model) issues.error(dp, `unknown device model "${dev.modelId}"`);
    if (dev.brightness !== undefined && (!Number.isFinite(dev.brightness) || dev.brightness < 0 || dev.brightness > 100)) {
      issues.error(`${dp}.brightness`, "must be 0-100");
    }
    if (dev.scenes.length === 0) issues.warn(dp, "device has no scenes");
    const ids = new Set<string>();
    for (const sc of dev.scenes) {
      if (typeof sc.id !== "string" || !sc.id) issues.error(dp, `scene "${sc.name}" has no id`);
      else if (/^\d+$/.test(sc.id)) issues.error(dp, `scene id "${sc.id}" is integer-like: JavaScript would reorder it before other scenes`);
      if (ids.has(sc.id)) issues.error(dp, `scene id ${sc.id} is used twice`);
      ids.add(sc.id);
    }
    const sceneIds = new Set<string>([...ids, ...(opts.sceneIdsBySerial?.[dev.serial] ?? [])]);
    for (const sc of dev.scenes) checkScene(sc, dev, sceneIds, issues);

    // The app normalizes profiles on load: deck output must already be in normalized form.
    const probe = { name: "probe", devices: { [dev.serial || "probe"]: { scenes: Object.fromEntries(dev.scenes.map(s => [s.id, cloneJson(s)])), activeSceneId: dev.scenes[0]?.id ?? null } }, favorites: [], recent: [] };
    const before = JSON.stringify(probe.devices);
    try {
      const normalized = normalizeProfile(cloneJson(probe));
      if (JSON.stringify(normalized.devices) !== before) issues.warn(dp, "the app would normalize (change) these scenes on load");
    } catch (e) {
      issues.error(dp, `the app would reject this profile: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  for (const id of built.watched) {
    if (!/^[a-z0-9_]+\.[a-z0-9_]+$/.test(id)) issues.error(`watch.${id}`, `"${id}" is not a valid entity id`);
  }
  if (opts.haStates) checkHaStates(built, opts.haStates, issues);
  if (opts.pluginStates) {
    for (const p of built.requiredPlugins) {
      if (opts.pluginStates[p]?.enabled === false) {
        const onlyDispatcher = ACTIONS.filter(a => a.plugin === p).every(a => a.dispatcherHandled);
        issues.warn(`plugins.${p}`, onlyDispatcher
          ? `plugin "${p}" is disabled (its actions still run, but cannot be picked in the editor)`
          : `plugin "${p}" is disabled: its actions do nothing until it is enabled`);
      }
    }
  }
  return issues.list;
}

export function hasErrors(issues: Issue[]): boolean {
  return issues.some(i => i.level === "error");
}

/** Synthetic `stats.*` attributes published by the app's HA statistics fetcher (stats-fetcher.ts). */
const ENERGY_STATS = new Set(["stats.today", "stats.month"]);
const POWER_STATS = new Set(["stats.avg_24h", "stats.max_24h", "stats.chart_24h"]);

function checkStatsAttr(entity: string, attr: string, st: { attributes?: Record<string, any> }, path: string, issues: Issues): void {
  const src = pickStatSources([{ entity_id: entity, state: "", attributes: st.attributes ?? {} }], new Set([entity]));
  if (ENERGY_STATS.has(attr)) {
    if (!src.energy.length) issues.error(path, `${entity}.${attr}: only energy sensors (device_class energy, state_class total/total_increasing) get ${attr}`);
  } else if (POWER_STATS.has(attr)) {
    if (!src.power.length) issues.error(path, `${entity}.${attr}: only power sensors (device_class power, state_class measurement) get ${attr}`);
  } else {
    issues.error(path, `${entity}.${attr}: unknown statistics attribute (known: ${[...ENERGY_STATS, ...POWER_STATS].join(", ")})`);
  }
}
