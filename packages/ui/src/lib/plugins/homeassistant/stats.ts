// Pure helpers for Home Assistant long-term statistics (energy totals, 24h power charts).
// Kept free of Tauri/Svelte/DOM imports so they can be unit-tested directly.

/** Minimal entity shape needed to classify statistics sources. */
export interface StatEntity {
  entity_id: string;
  state: string;
  attributes: Record<string, any>;
}

export interface StatSources {
  /** Cumulative energy meters (device_class energy, state_class total/total_increasing). */
  energy: string[];
  /** Instantaneous power sensors (device_class power, state_class measurement). */
  power: string[];
}

/** Watched sensors that have long-term statistics, split by kind (sorted for stable requests). */
export function pickStatSources(entities: Iterable<StatEntity>, watched: Set<string>): StatSources {
  const energy: string[] = [];
  const power: string[] = [];
  for (const e of entities) {
    if (!watched.has(e.entity_id) || !e.entity_id.startsWith("sensor.")) continue;
    const dc = e.attributes?.device_class;
    const sc = e.attributes?.state_class;
    if (dc === "energy" && (sc === "total" || sc === "total_increasing")) energy.push(e.entity_id);
    else if (dc === "power" && sc === "measurement") power.push(e.entity_id);
  }
  return { energy: energy.sort(), power: power.sort() };
}

/** Number as a variable value with at most `decimals` decimals ("" for non-finite). */
export function statValue(n: number | null | undefined, decimals: number): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "";
  const f = 10 ** decimals;
  return String(Math.round(n * f) / f);
}

/** Sum of the numeric states of `ids` (unavailable/unknown skipped); null when none is numeric. */
export function sumStates(ids: string[], getState: (id: string) => string | undefined): number | null {
  let total = 0;
  let any = false;
  for (const id of ids) {
    const s = getState(id);
    if (s === undefined || s.trim() === "") continue;
    const n = Number(s);
    if (!Number.isFinite(n)) continue;
    total += n;
    any = true;
  }
  return any ? total : null;
}

/** One row of recorder/statistics_during_period. */
export interface StatRow { start: number | string; mean?: number | null; max?: number | null; }

export interface SeriesSummary { avg: number | null; max: number | null; values: number[]; }

/** Mean series (gaps dropped), the time-weighted average of the means and the peak of the maxima. */
export function summarizeSeries(rows: StatRow[] | undefined): SeriesSummary {
  const values: number[] = [];
  let peak: number | null = null;
  for (const r of rows ?? []) {
    if (typeof r.mean === "number" && Number.isFinite(r.mean)) values.push(r.mean);
    const m = typeof r.max === "number" && Number.isFinite(r.max) ? r.max : null;
    if (m !== null && (peak === null || m > peak)) peak = m;
  }
  const avg = values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
  if (peak === null && values.length) peak = Math.max(...values);
  return { avg, max: peak, values };
}

export interface ChartGeometry {
  /** Line points in pixel space, left (oldest) to right (newest). */
  points: Array<[number, number]>;
  /** Value at the top edge of the plot. */
  top: number;
}

/**
 * Map a series onto a width x height plot with `pad` px of margin. The y range starts at 0 (so an
 * idle plug lies flat at the bottom) and ends 10 % above the peak; a single value spans the width.
 */
export function chartGeometry(values: number[], width: number, height: number, pad = 2): ChartGeometry {
  const top = Math.max(1, Math.max(0, ...values) * 1.1);
  if (values.length === 0) return { points: [], top };
  const plotW = Math.max(1, width - pad * 2);
  const plotH = Math.max(1, height - pad * 2);
  const series = values.length === 1 ? [values[0], values[0]] : values;
  const points = series.map((v, i): [number, number] => {
    const x = pad + (i / (series.length - 1)) * plotW;
    const y = pad + plotH - (Math.max(0, v) / top) * plotH;
    return [Math.round(x * 10) / 10, Math.round(y * 10) / 10];
  });
  return { points, top };
}
