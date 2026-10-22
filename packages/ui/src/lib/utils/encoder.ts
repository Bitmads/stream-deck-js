// Pure encoder math (no Svelte/Tauri imports, unit-testable).

/**
 * Rotate a wrapping encoder: positions are min, min+step, ... up to max (inclusive); moving past
 * either end continues from the other end, so a list can be scrolled endlessly.
 */
export function wrapEncoderValue(cur: number, deltaValue: number, min: number, max: number, step: number): number {
  const s = Math.abs(step) || 1;
  if (!(max >= min)) return min;
  const positions = Math.floor((max - min) / s + 1e-9) + 1;
  const idx = Math.round((cur - min) / s);
  const next = (((idx + Math.round(deltaValue / s)) % positions) + positions) % positions;
  return min + next * s;
}
