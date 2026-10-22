// Pure helpers for mapping strip/encoder input onto Home Assistant attribute ranges.
// Kept free of Tauri/Svelte imports so they can be unit-tested directly.

export interface ControlRange {
  min: number;
  max: number;
  /** Granularity of the attribute (e.g. 1 for brightness, 0.5 for climate, 0.01 for volume). */
  step: number;
}

/** Number of decimal places in a step value (0.05 → 2, 0.5 → 1, 5 → 0, 1e-3 → 3). */
export function decimalsOf(step: number): number {
  if (!Number.isFinite(step) || step <= 0) return 0;
  const s = String(step);
  const exp = s.match(/e-(\d+)$/i);
  if (exp) return parseInt(exp[1], 10);
  const dot = s.indexOf(".");
  return dot < 0 ? 0 : s.length - dot - 1;
}

/**
 * Snap a raw value to the control's step grid (anchored at min), clamp it to [min, max]
 * and strip floating-point noise to the step's precision. A value at or beyond max returns
 * max exactly, so a full swipe always reaches the top of the range even when max is not on
 * the step grid (e.g. color temp 2000..6535 with step 100).
 */
export function quantize(raw: number, range: ControlRange): number {
  const { min, max } = range;
  if (!Number.isFinite(raw)) return min;
  if (raw >= max) return max;
  if (raw <= min) return min;
  const step = range.step > 0 ? range.step : 1;
  const snapped = min + Math.round((raw - min) / step) * step;
  const decimals = Math.max(decimalsOf(step), decimalsOf(min));
  const clamped = Math.min(max, Math.max(min, snapped));
  return Number(clamped.toFixed(decimals));
}

/** Map a 0..1 ratio (tap/swipe position on the strip) onto the control's range. */
export function ratioToValue(ratio: number, range: ControlRange): number {
  const r = Number.isFinite(ratio) ? Math.max(0, Math.min(1, ratio)) : 0;
  return quantize(range.min + r * (range.max - range.min), range);
}

/**
 * Attributes that represent a numeric level which HA reports as null (or drops entirely)
 * when the entity is off — e.g. a light's brightness while it is off. For these the
 * published variable becomes "0" (off == level 0) so bars, encoders and labels show the
 * real level instead of the last on-value. Every other attribute that becomes null or
 * disappears is published as "" (empty string).
 */
export const ZERO_WHEN_NULL_ATTRS: ReadonlySet<string> = new Set([
  "brightness",
  "volume_level",
  "percentage",
  "current_position",
  "current_tilt_position",
]);

/** Variable value to publish for an attribute that is null or no longer present. */
export function nullAttrValue(attr: string): string {
  return ZERO_WHEN_NULL_ATTRS.has(attr) ? "0" : "";
}

/**
 * Convert an attribute value into the variable string, or null when the attribute is an
 * object (not representable as a single variable).
 */
export function attrToVariable(attr: string, val: unknown): string | null {
  if (val === null || val === undefined) return nullAttrValue(attr);
  if (Array.isArray(val)) return val.join(", ");
  if (typeof val === "object") return null;
  return String(val);
}

/** Parse a numeric setting; returns the original string when it is not a finite number. */
export function parseNumericSetting(value: string): number | string {
  const trimmed = value.trim();
  if (trimmed === "") return value;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : value;
}
