// Ergonomic builders for deck files. Every builder returns complete objects in the persisted
// shape (packages/ui/src/lib/types/profile.ts): settings values are strings, ActionDefs are full
// copies of the plugin definitions, keys carry both the canonical `texts`/`icons` arrays and the
// legacy `text`/`icon` mirrors of their first element, and strip gestures always carry their
// `*Settings` object (the store only fires a gesture whose settings object exists).

import type {
  ActionDef, EncoderConfig, IconConfig, KeyAssignment, Scene, SceneTrigger, StripBar, StripConfig,
  StripItem, TextConfig,
} from "../../ui/src/lib/types/profile.ts";
import type { MultiActionStep } from "../../ui/src/lib/plugins/multi-action/steps.ts";
import { serializeSteps } from "../../ui/src/lib/plugins/multi-action/steps.ts";
import { actionDef, haControl, NONE_ACTION, type HaControlSpec } from "./catalog.ts";
import { STRIP_DESIGN_HEIGHT, STRIP_DESIGN_WIDTH } from "./devices.ts";
import { icon as lookupIcon } from "./icons.ts";
import { sceneIdFromSlug } from "./uuid.ts";

// ─── Actions ─────────────────────────────────────────────────

/** An action plus its settings, as stored on keys, encoders and strip gestures. */
export interface ActionSpec {
  action: ActionDef;
  settings: Record<string, string>;
}

/** Marker for a scene reference resolved at build time to the scene id on the same device. */
export const SCENE_REF_PREFIX = "@scene:";

function spec(id: string, settings: Record<string, string> = {}): ActionSpec {
  return { action: actionDef(id), settings: { ...settings } };
}

function entityDomain(entity: string): string {
  const i = entity.indexOf(".");
  if (i <= 0 || i === entity.length - 1) throw new Error(`Invalid Home Assistant entity id "${entity}"`);
  return entity.slice(0, i);
}

/** No action. */
export function none(): ActionSpec {
  return { action: { ...NONE_ACTION }, settings: {} };
}

/**
 * Call any Home Assistant service. `entity` becomes the target (omit or "" for none); `data` is
 * sent as service data (JSON; string values may contain templates, resolved per value).
 */
export function haService(domain: string, service: string, entity?: string, data?: Record<string, unknown>): ActionSpec {
  const settings: Record<string, string> = {
    ha_entity: entity ?? "",
    ha_domain: domain,
    ha_service: service,
    ha_control: service,
    ha_attr: "",
  };
  if (data && Object.keys(data).length > 0) settings.ha_service_data = JSON.stringify(data);
  return spec("ha-service", settings);
}

/** <domain>.toggle on the entity (lights, switches, fans, media players, humidifiers, ...). */
export function haToggle(entity: string): ActionSpec {
  return haService(entityDomain(entity), "toggle", entity);
}

/** Run a script entity (script.turn_on with the script as target). */
export function haScript(entity: string, variables?: Record<string, unknown>): ActionSpec {
  if (entityDomain(entity) !== "script") throw new Error(`haScript needs a script.* entity, got "${entity}"`);
  return variables ? haService("script", "turn_on", entity, { variables }) : haService("script", "turn_on", entity);
}

/**
 * Set a numeric attribute through one of the HA controls (catalog HA_CONTROLS). `value` is a number or
 * template string; omit it on encoders (the rotated value is sent) and on strip tap/swipe (the
 * touch position is mapped onto the control range). A key press needs a value.
 */
export function haAttrControl(entity: string, control: string, value?: number | string): ActionSpec {
  const c = haControl(control);
  const settings: Record<string, string> = {
    ha_entity: entity,
    ha_domain: entityDomain(entity),
    ha_service: c.service,
    ha_control: c.id,
    ha_attr: c.attr,
  };
  if (value !== undefined) settings.value = String(value);
  return spec("ha-service", settings);
}

/** Raw HA WebSocket message, e.g. {domain, service, service_data, target} or {type: "fire_event", ...}. */
export function haCustom(message: Record<string, unknown>): ActionSpec {
  return spec("ha-custom", { ha_custom_json: JSON.stringify(message) });
}

/** A scene reference: a scene slug or a scene built with scene(). */
export type SceneRef = string | SceneSpec;

function sceneRefValue(ref: SceneRef): string {
  return typeof ref === "string" ? SCENE_REF_PREFIX + ref : SCENE_REF_PREFIX + ref.slug;
}

export const nav = {
  /** Push a scene (back returns to the current one). */
  push(ref: SceneRef): ActionSpec {
    return spec("switch-scene", { sceneId: sceneRefValue(ref), mode: "push" });
  },
  /** Switch to a scene without remembering the current one. */
  switch(ref: SceneRef): ActionSpec {
    return spec("switch-scene", { sceneId: sceneRefValue(ref), mode: "switch" });
  },
  /** Return to the previous scene. */
  back(): ActionSpec {
    return spec("back");
  },
};

/** Keyboard shortcut, e.g. hotkey("ctrl+shift+t") or hotkey("F5"). */
export function hotkey(keys: string): ActionSpec {
  const parts = keys.split("+").map(s => s.trim()).filter(Boolean);
  if (parts.length === 0) throw new Error("hotkey() needs a key");
  const key = parts[parts.length - 1];
  return spec("hotkey", { key, modifiers: parts.slice(0, -1).join(", ") });
}

/** Shell command (`sh -c`); substituted variable values are shell-quoted by the app. */
export function command(cmd: string): ActionSpec {
  return spec("command", { command: cmd });
}

/** Launch an application (`sh -c`). */
export function launch(target: string): ActionSpec {
  return spec("launch", { target });
}

export function openUrl(url: string): ActionSpec {
  return spec("open-url", { url });
}

export interface HttpRequestOptions {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  /** "Key: Value" lines. */
  headers?: string;
  body?: string;
}

export function httpRequest(url: string, opts: HttpRequestOptions = {}): ActionSpec {
  return spec("http-request", { url, method: opts.method ?? "POST", headers: opts.headers ?? "", body: opts.body ?? "" });
}

/** Countdown timer shown on the key (seconds). */
export function timer(seconds: number): ActionSpec {
  return spec("timer", { duration: String(seconds) });
}

export function counter(start = 0): ActionSpec {
  return spec("counter", { value: String(start) });
}

export interface MultiStep {
  action: ActionSpec;
  /** Wait after this step, in ms. */
  delayMs?: number;
}

/** Run actions in sequence (each step is an ActionSpec, or {action, delayMs}). */
export function multi(steps: Array<ActionSpec | MultiStep>): ActionSpec {
  const list: MultiActionStep[] = steps.map(s => {
    const step: MultiStep = "settings" in s ? { action: s } : s;
    return {
      actionId: step.action.action.id,
      actionLabel: step.action.action.label,
      settings: { ...step.action.settings },
      delayMs: step.delayMs ?? 0,
    };
  });
  return spec("multi-action", { steps: serializeSteps(list) });
}

// ─── Text, icons, keys ───────────────────────────────────────

/** A text layer; defaults are the UI's (store.defaultTextConfig). */
export function text(content: string, opts: Partial<Omit<TextConfig, "text">> = {}): TextConfig {
  return {
    text: content,
    fontFamily: "sans-serif",
    fontSize: 14,
    fontWeight: "normal",
    fontStyle: "normal",
    color: "#ffffff",
    hAlign: "center",
    vAlign: "middle",
    anchor: "center",
    useAbsolutePos: false,
    ...opts,
  };
}

export { lookupIcon as icon };

/** Template of a Home Assistant variable: ha("light.x", "brightness") → "{{$ha.light.x.brightness}}". */
export function ha(entity: string, attr = "state", filters = ""): string {
  entityDomain(entity);
  return `{{$ha.${entity}.${attr}${filters ? `|${filters}` : ""}}}`;
}

export interface KeyOptions {
  action?: ActionSpec;
  /** Background color or template (e.g. "{{$ha.light.x.rgb_color|rgb}}"). */
  bg?: string;
  /** Text layers: plain strings use text() defaults. */
  text?: string | TextConfig | Array<string | TextConfig>;
  /** Icons: "set:name" strings use icon() defaults; conditional icons first, a plain one as default. */
  icon?: string | IconConfig | Array<string | IconConfig>;
  /** Image URL (http(s) or data:), may contain templates. */
  imageUrl?: string;
  imageFit?: "fill" | "cover" | "contain" | "none";
  /** Show in every other scene of the device whose slot is empty. */
  pinned?: boolean;
}

function asList<T>(v: T | T[] | undefined): T[] {
  return v === undefined ? [] : Array.isArray(v) ? v : [v];
}

/** A complete key assignment. */
export function key(opts: KeyOptions = {}): KeyAssignment {
  const act = opts.action ?? none();
  const k: KeyAssignment = {
    action: { ...act.action },
    settings: { ...act.settings },
    backgroundColor: opts.bg ?? "#000000",
  };
  const texts = asList(opts.text).map(t => (typeof t === "string" ? text(t) : { ...t }));
  if (texts.length > 0) {
    k.texts = texts;
    k.text = { ...texts[0] };
  }
  const icons = asList(opts.icon).map(i => (typeof i === "string" ? lookupIcon(i) : { ...i }));
  if (icons.length > 0) {
    k.icons = icons;
    k.icon = { ...icons[0] };
  }
  if (opts.imageUrl !== undefined) {
    k.imageUrl = opts.imageUrl;
    k.imageFit = opts.imageFit ?? "cover";
  }
  if (opts.pinned) k.pinned = true;
  return k;
}

// ─── Encoders ────────────────────────────────────────────────

export interface EncoderOptions {
  press?: ActionSpec;
  rotate?: ActionSpec;
  label?: string;
  /** Number or template ("{{$var}}"); a template is updated immediately while rotating. */
  value?: number | string;
  min?: number | string;
  max?: number | string;
  step?: number;
}

export function encoder(opts: EncoderOptions = {}): EncoderConfig {
  const press = opts.press ?? none();
  const rotate = opts.rotate ?? none();
  return {
    pressAction: { ...press.action },
    pressSettings: { ...press.settings },
    rotateAction: { ...rotate.action },
    rotateSettings: { ...rotate.settings },
    label: opts.label ?? "",
    value: String(opts.value ?? 0),
    min: String(opts.min ?? 0),
    max: String(opts.max ?? 100),
    step: opts.step ?? 1,
  };
}

/** Control driven by haDial() for an entity domain when none is given. */
const DIAL_CONTROL_BY_DOMAIN: Record<string, string> = {
  light: "brightness",
  humidifier: "humidity",
  media_player: "volume",
  cover: "position",
  fan: "percentage",
  climate: "temperature",
  number: "value",
  input_number: "value",
};

/** Domains whose entities have a <domain>.toggle service (default dial press action). */
const TOGGLE_DOMAINS = new Set(["light", "humidifier", "media_player", "fan", "cover", "switch", "climate"]);

export interface HaDialOptions {
  /** Control id (HA_CONTROLS); defaults by domain: light brightness, humidifier humidity, media_player volume, ... */
  control?: string;
  label?: string;
  /** Press action; defaults to <domain>.toggle where the domain has one, else none. */
  press?: ActionSpec;
  min?: number | string;
  max?: number | string;
  step?: number;
}

function dialControl(entity: string, control?: string): HaControlSpec {
  const domain = entityDomain(entity);
  const id = control ?? DIAL_CONTROL_BY_DOMAIN[domain];
  if (!id) throw new Error(`haDial: no default control for domain "${domain}"; pass { control }`);
  return haControl(id);
}

/**
 * Encoder bound to a Home Assistant numeric attribute: the value template reads the attribute,
 * rotating sets it (same service/attr/range/step as the UI's HA controls).
 */
export function haDial(entity: string, opts: HaDialOptions = {}): EncoderConfig {
  const c = dialControl(entity, opts.control);
  const domain = entityDomain(entity);
  const press = opts.press ?? (TOGGLE_DOMAINS.has(domain) ? haToggle(entity) : none());
  return encoder({
    press,
    rotate: haAttrControl(entity, c.id),
    label: opts.label ?? "",
    value: ha(entity, c.readAttr ?? c.attr),
    min: opts.min ?? c.min,
    max: opts.max ?? c.max,
    step: opts.step ?? c.step,
  });
}

// ─── Touch strip ─────────────────────────────────────────────

/** Width of one encoder-aligned strip panel (800 px / 4 encoders). */
export const PANEL_WIDTH = 200;

export interface BarOptions {
  min?: number | string;
  max?: number | string;
  /** Fill color, supports templates ("{{$ha.light.x.rgb_color|rgb}}"). */
  color?: string;
  position?: StripBar["position"];
  /** Thickness for bottom/left bars. */
  height?: number;
}

export function bar(value: number | string, opts: BarOptions = {}): StripBar {
  return {
    value: String(value),
    min: String(opts.min ?? 0),
    max: String(opts.max ?? 100),
    color: opts.color ?? "#4a9eff",
    position: opts.position ?? "bottom",
    height: opts.height ?? 6,
  };
}

export interface StripItemOptions {
  id?: string;
  bg?: string;
  imageUrl?: string;
  imageFit?: "fill" | "cover" | "contain" | "none";
  icon?: string | IconConfig;
  text?: string | TextConfig | Array<string | TextConfig>;
  bar?: StripBar;
  tap?: ActionSpec;
  longPress?: ActionSpec;
  swipe?: ActionSpec;
}

/** A strip item at an explicit position in the 800x100 design space. */
export function stripItem(rect: { x: number; y: number; w: number; h: number }, opts: StripItemOptions = {}): StripItem {
  const item: StripItem = {
    id: opts.id ?? `item-${rect.x}-${rect.y}-${rect.w}x${rect.h}`,
    x: rect.x, y: rect.y, w: rect.w, h: rect.h,
  };
  if (opts.bg !== undefined) item.backgroundColor = opts.bg;
  if (opts.imageUrl !== undefined) {
    item.imageUrl = opts.imageUrl;
    item.imageFit = opts.imageFit ?? "cover";
  }
  if (opts.icon !== undefined) item.icon = typeof opts.icon === "string" ? lookupIcon(opts.icon) : { ...opts.icon };
  const texts = asList(opts.text).map(t => (typeof t === "string" ? text(t) : { ...t }));
  if (texts.length > 0) item.texts = texts;
  if (opts.bar) item.bar = { ...opts.bar };
  if (opts.tap) { item.tapAction = { ...opts.tap.action }; item.tapSettings = { ...opts.tap.settings }; }
  if (opts.longPress) { item.longPressAction = { ...opts.longPress.action }; item.longPressSettings = { ...opts.longPress.settings }; }
  if (opts.swipe) { item.swipeAction = { ...opts.swipe.action }; item.swipeSettings = { ...opts.swipe.settings }; }
  return item;
}

/** The strip panel above encoder `i` (x = i*200, 200x100). */
export function panel(i: number, opts: StripItemOptions = {}): StripItem {
  if (!Number.isInteger(i) || i < 0 || (i + 1) * PANEL_WIDTH > STRIP_DESIGN_WIDTH) {
    throw new Error(`panel(${i}): index must be 0..${STRIP_DESIGN_WIDTH / PANEL_WIDTH - 1}`);
  }
  return stripItem({ x: i * PANEL_WIDTH, y: 0, w: PANEL_WIDTH, h: STRIP_DESIGN_HEIGHT }, { id: `panel-${i}`, ...opts });
}

export interface HaSliderOptions extends Omit<StripItemOptions, "bar" | "tap" | "swipe"> {
  control?: string;
  barColor?: string;
  barPosition?: StripBar["position"];
}

/**
 * Strip panel `i` as a slider for an HA numeric attribute: a bar shows the value, tap/swipe set it
 * from the touch position, long press toggles (where the domain has a toggle).
 */
export function haSlider(i: number, entity: string, opts: HaSliderOptions = {}): StripItem {
  const c = dialControl(entity, opts.control);
  const domain = entityDomain(entity);
  const { control: _c, barColor, barPosition, ...rest } = opts;
  return panel(i, {
    longPress: TOGGLE_DOMAINS.has(domain) ? haToggle(entity) : undefined,
    ...rest,
    bar: bar(ha(entity, c.readAttr ?? c.attr), { min: c.min, max: c.max, color: barColor, position: barPosition ?? "full" }),
    tap: haAttrControl(entity, c.id),
    swipe: haAttrControl(entity, c.id),
  });
}

export function strip(items: StripItem[], opts: { bg?: string } = {}): StripConfig {
  return { backgroundColor: opts.bg ?? "#0a0a1a", items: items.map(it => ({ ...it })) };
}

// ─── Scenes, devices, deck ───────────────────────────────────

export interface WindowTriggerOptions {
  /** Case-insensitive substring of the app name, or "regex:<pattern>". */
  app?: string;
  /** Case-insensitive substring of the window title, or "regex:<pattern>". */
  title?: string;
  /** Highest priority wins when several scenes match. */
  priority?: number;
  mode?: "push" | "switch";
}

/** Switch to the scene when the focused window matches (at least one of app/title). */
export function windowTrigger(opts: WindowTriggerOptions): SceneTrigger {
  if (!opts.app?.trim() && !opts.title?.trim()) throw new Error("window trigger needs app and/or title (an empty trigger never fires)");
  const t: SceneTrigger = { type: "window" };
  if (opts.app) t.app_name = opts.app;
  if (opts.title) t.window_title = opts.title;
  if (opts.priority !== undefined) t.priority = opts.priority;
  if (opts.mode) t.mode = opts.mode;
  return t;
}

export function manual(): SceneTrigger {
  return { type: "manual" };
}

export interface SceneOptions {
  /** Explicit scene id (e.g. to replace an existing scene in place); default uuidv5(slug). */
  id?: string;
  name?: string;
  /** Key index → assignment. */
  keys?: Record<number, KeyAssignment>;
  /** Encoder index → config. */
  encoders?: Record<number, EncoderConfig>;
  strip?: StripConfig;
  triggers?: SceneTrigger[];
}

export interface SceneSpec {
  slug: string;
  scene: Scene;
}

const SLUG_RE = /^[a-z0-9][a-z0-9_-]*$/;

export function scene(slug: string, opts: SceneOptions = {}): SceneSpec {
  if (!SLUG_RE.test(slug)) throw new Error(`Scene slug "${slug}" must match ${SLUG_RE}`);
  const s: Scene = {
    id: opts.id ?? sceneIdFromSlug(slug),
    name: opts.name ?? slug,
    keys: {},
    triggers: (opts.triggers ?? [manual()]).map(t => ({ ...t })),
  };
  for (const [i, k] of Object.entries(opts.keys ?? {})) s.keys[String(i)] = k;
  if (opts.encoders) {
    s.encoders = {};
    for (const [i, e] of Object.entries(opts.encoders)) s.encoders[String(i)] = e;
  }
  if (opts.strip) s.strip = opts.strip;
  return { slug, scene: s };
}

export interface DeviceSpec {
  serial: string;
  /** Device model id (devices.ts), e.g. "plus", "xl", "mk2". */
  model: string;
  /** Deck order: becomes the device's scene order (the first scene is the window-trigger fallback). */
  scenes: SceneSpec[];
  /** Display brightness 0-100; unset leaves the stored value. */
  brightness?: number;
}

export function device(serial: string, model: string, scenes: SceneSpec[], opts: { brightness?: number } = {}): DeviceSpec {
  const d: DeviceSpec = { serial, model, scenes };
  if (opts.brightness !== undefined) d.brightness = opts.brightness;
  return d;
}

export interface DeckSpec {
  devices: DeviceSpec[];
  /** Extra Home Assistant entities to watch (variables), besides those referenced by templates. */
  watch?: string[];
}

/** Identity helper for typed deck files: `export default defineDeck({ devices: [...] })`. */
export function defineDeck(deck: DeckSpec): DeckSpec {
  return deck;
}
