// Elgato Stream Deck SDK wire format: pure builders/parsers used by the external plugin bridge.
// No Svelte/Tauri imports so this module can be unit-tested directly.

export type Controller = "Keypad" | "Encoder";

export interface Coordinates {
  column: number;
  row: number;
}

/** Runtime override patch understood by the store (contract C4). */
export interface OverridePatch {
  title?: string;
  image?: string;
  state?: number;
  flash?: "ok" | "alert";
}

export type KeyEventName = "keyDown" | "keyUp";
export type DialEventName = "dialRotate" | "dialDown" | "dialUp";

export interface ActionRef {
  /** Action UUID from the plugin manifest (Actions[].UUID). */
  action: string;
  /** `${serial}:${sceneId}:${controller}:${index}` */
  context: string;
  /** Device id sent to plugins: the deck serial. */
  device: string;
  settings: Record<string, unknown>;
  coordinates: Coordinates;
}

/** Keypad coordinates for a key index on a deck with `columns` columns (row-major). */
export function keyCoordinates(index: number, columns: number): Coordinates {
  const cols = columns > 0 ? columns : 1;
  return { column: index % cols, row: Math.floor(index / cols) };
}

/** Encoder coordinates: dials sit in one row, column = encoder index. */
export function encoderCoordinates(index: number): Coordinates {
  return { column: index, row: 0 };
}

export function buildKeyEvent(event: KeyEventName, ref: ActionRef, opts: { state?: number; isInMultiAction?: boolean } = {}) {
  const payload: Record<string, unknown> = {
    settings: ref.settings,
    coordinates: ref.coordinates,
    isInMultiAction: opts.isInMultiAction ?? false,
  };
  if (opts.state !== undefined) payload.state = opts.state;
  return { event, action: ref.action, context: ref.context, device: ref.device, payload };
}

export function buildAppearEvent(event: "willAppear" | "willDisappear", ref: ActionRef, controller: Controller, state?: number) {
  const payload: Record<string, unknown> = {
    settings: ref.settings,
    coordinates: ref.coordinates,
    controller,
    isInMultiAction: false,
  };
  if (controller === "Keypad") payload.state = state ?? 0;
  return { event, action: ref.action, context: ref.context, device: ref.device, payload };
}

export function buildDialEvent(event: DialEventName, ref: ActionRef, ticks?: number) {
  const payload: Record<string, unknown> = {
    settings: ref.settings,
    coordinates: ref.coordinates,
    controller: "Encoder",
  };
  if (event === "dialRotate") {
    payload.ticks = Math.trunc(ticks ?? 0);
    payload.pressed = false;
  }
  return { event, action: ref.action, context: ref.context, device: ref.device, payload };
}

export function buildDidReceiveSettings(ref: ActionRef, state?: number) {
  const payload: Record<string, unknown> = {
    settings: ref.settings,
    coordinates: ref.coordinates,
    isInMultiAction: false,
  };
  if (state !== undefined) payload.state = state;
  return { event: "didReceiveSettings", action: ref.action, context: ref.context, device: ref.device, payload };
}

export interface PluginMessage {
  event: string;
  context?: string;
  action?: string;
  payload?: any;
}

/** Parse a raw plugin → host JSON message. Returns null when it is not a JSON object with an event. */
export function parsePluginMessage(raw: string): PluginMessage | null {
  let msg: unknown;
  try { msg = JSON.parse(raw); } catch { return null; }
  if (!msg || typeof msg !== "object" || Array.isArray(msg)) return null;
  const m = msg as Record<string, unknown>;
  if (typeof m.event !== "string") return null;
  return {
    event: m.event,
    context: typeof m.context === "string" ? m.context : undefined,
    action: typeof m.action === "string" ? m.action : undefined,
    payload: m.payload,
  };
}

/**
 * Map a visual plugin command onto a runtime override patch.
 * Empty/absent title or image resets that field to the user's configured appearance
 * (patch value `undefined`). Returns null for commands that are not visual overrides.
 */
export function commandToOverride(event: string, payload: any): OverridePatch | null {
  switch (event) {
    case "setTitle": {
      const title = payload?.title;
      return { title: typeof title === "string" && title !== "" ? title : undefined };
    }
    case "setImage": {
      const image = payload?.image;
      return { image: typeof image === "string" && image !== "" ? normalizeImage(image) : undefined };
    }
    case "setState": {
      const state = Number(payload?.state);
      return Number.isInteger(state) && state >= 0 ? { state } : null;
    }
    case "showOk": return { flash: "ok" };
    case "showAlert": return { flash: "alert" };
    default: return null;
  }
}

/**
 * Elgato plugins send either a data URL or a raw SVG string ("<svg ...>") for setImage.
 * Normalize raw SVG to a data URL so it can be drawn like any other image.
 */
export function normalizeImage(image: string): string {
  const trimmed = image.trim();
  if (trimmed.startsWith("<svg") || trimmed.startsWith("<?xml")) {
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(trimmed)}`;
  }
  return trimmed;
}

/** Plugin settings must be a JSON object; anything else is treated as empty settings. */
export function asSettingsObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
