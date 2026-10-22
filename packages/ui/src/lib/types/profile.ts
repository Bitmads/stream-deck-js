// Persisted profile model (profile_<name>.json) and related shared types.
//
// Plain TypeScript with no Svelte runes or runtime imports, so Node tooling
// (deck generators, validators, tests) can import it directly.
//
// File shape:
//   { name, devices: { <serial>: { scenes: { <id>: Scene }, activeSceneId } }, favorites, recent }
// Legacy single-device files carry top-level `scenes` / `activeSceneId` instead of `devices`;
// they are migrated onto the first bound device on load.

export interface ActionDef { id: string; label: string; icon: string; color: string; }

export interface TextConfig {
  text: string; fontFamily: string; fontSize: number;
  fontWeight: "normal" | "bold"; fontStyle: "normal" | "italic"; color: string;
  hAlign: "left" | "center" | "right"; vAlign: "top" | "middle" | "bottom";
  /** Only used with useAbsolutePos: where the text attaches to (x, y). */
  anchor: "start" | "center" | "end"; hidden?: boolean;
  wrap?: "none" | "word" | "char";
  shadow?: { color: string; blur: number; offsetX: number; offsetY: number };
  stroke?: { color: string; width: number };
  x?: number; y?: number; useAbsolutePos: boolean;
}

export interface IconConfig {
  setId: string; iconName: string; svgBody: string; color: string; size: number; viewBox: string;
  /** Conditional icon: full template (e.g. "{{$ha.x.state}}") compared to `value`. */
  variable?: string; value?: string;
}

export interface KeyAssignment {
  action: ActionDef; settings: Record<string, string>; backgroundColor: string;
  imagePath?: string; imageDataUrl?: string; imageUrl?: string; imageFit?: "fill" | "cover" | "contain" | "none";
  /** Legacy single text layer; `texts` is canonical (text mirrors texts[0]). */
  text?: TextConfig; texts?: TextConfig[];
  /** Legacy single icon; `icons` is canonical (icon mirrors icons[0]). */
  icon?: IconConfig; icons?: IconConfig[];
  /** Shown in every other scene of the same device whose slot is empty (render-time overlay, never copied). */
  pinned?: boolean;
}

export interface SceneTrigger {
  type: "window" | "manual";
  app_name?: string; window_title?: string; priority?: number;
  mode?: "push" | "switch";
}

export interface EncoderConfig {
  pressAction: ActionDef; pressSettings: Record<string, string>;
  rotateAction: ActionDef; rotateSettings: Record<string, string>;
  label: string;
  value: string;  // number or {{$var}}
  min: string;    // number or {{$var}}
  max: string;    // number or {{$var}}
  step: number;
}

export interface StripBar {
  value: string;     // {{$var}} or number — current value
  min: string;       // min range
  max: string;       // max range
  color: string;     // fill color, supports {{$var|rgb}}
  position: "bottom" | "full" | "left";  // where the bar renders
  height: number;    // bar thickness in px (bottom/left positions)
}

export interface StripItem {
  id: string;
  x: number; y: number; w: number; h: number;
  // Visual (same concepts as KeyAssignment)
  backgroundColor?: string;  // {{$var|rgb}} supported
  imageDataUrl?: string;
  imageUrl?: string;
  imageFit?: "fill" | "cover" | "contain" | "none";
  icon?: IconConfig;
  texts?: TextConfig[];
  // Bar indicator (progress fill)
  bar?: StripBar;
  // Gesture actions
  tapAction?: ActionDef;
  tapSettings?: Record<string, string>;
  longPressAction?: ActionDef;
  longPressSettings?: Record<string, string>;
  swipeAction?: ActionDef;
  swipeSettings?: Record<string, string>;
}

export interface StripConfig {
  backgroundColor: string;
  items: StripItem[];
}

export interface Scene {
  id: string; name: string; keys: Record<string, KeyAssignment>;
  encoders?: Record<string, EncoderConfig>; strip?: StripConfig; triggers: SceneTrigger[];
}

export interface DeviceConfig {
  scenes: Record<string, Scene>; activeSceneId: string | null;
  /** Display brightness 0-100, applied whenever the device is opened. Unset = leave the device as is. */
  brightness?: number;
}

export interface SavedProfile {
  name: string;
  devices?: Record<string, DeviceConfig>;
  /** Legacy single-device format. */
  scenes?: Record<string, Scene>;
  /** Legacy single-device format. */
  activeSceneId?: string | null;
  favorites: string[]; recent: string[];
}

/** Device as reported by the backend `list_devices` command. key_size is the native key pixel size. */
export interface DeviceInfo {
  serial: string; model: string; model_id: string; columns: number; rows: number;
  key_size: number; has_lcd_strip: boolean; has_dials: boolean;
  encoder_count: number; lcd_width: number; lcd_height: number;
  /** Native key image size (same as key_size; 0 when keys have no display). */
  key_pixel_size?: number;
  /** Number of display keys (columns * rows). */
  key_count?: number;
  /** Extra touch buttons reported as key indices key_count.. (Neo). */
  touch_button_count?: number;
  /** False for models whose keys have no display (Pedal). */
  has_key_display?: boolean;
  image_format?: string;
  /** Non-touch info screen (Neo), 0 when absent. */
  info_lcd_width?: number;
  info_lcd_height?: number;
  /** Changes whenever the backend (re)opens the device's HID handle; a change means a full repaint. */
  open_generation?: number;
}

/** Native key pixel size of a device (0 when its keys have no display). */
export function deviceKeyPixelSize(d: DeviceInfo): number {
  if (d.has_key_display === false) return 0;
  return d.key_pixel_size ?? d.key_size ?? 0;
}

/** Number of display keys of a device. */
export function deviceKeyCount(d: DeviceInfo): number {
  return d.key_count ?? d.columns * d.rows;
}

/** Elgato-style controller kinds used in plugin contexts. */
export type ControllerKind = "Keypad" | "Encoder";

/** Non-persisted per-context display state (external plugins, timers, counters). */
export interface RuntimeOverride {
  title?: string;
  image?: string;
  state?: number;
  flash?: "ok" | "alert";
}
