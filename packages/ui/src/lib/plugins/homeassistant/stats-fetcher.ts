// Publishes Home Assistant long-term statistics of watched sensors as variables:
//
//   ha.<energy sensor>.stats.today / .stats.month   kWh used since local midnight / the 1st (HA's time zone)
//   ha.<power sensor>.stats.avg_24h / .stats.max_24h W over the last 24 h (5-minute statistics)
//   ha.<power sensor>.stats.chart_24h               PNG data URL of the 24 h power curve
//   ha_stats.power_now                              W, sum of all watched power sensors right now
//   ha_stats.energy_today / ha_stats.energy_month   kWh, sums over all watched energy sensors
//
// Sources are the watched sensors with long-term statistics (see stats.ts pickStatSources). Data is
// refreshed after every (re)connect, on watch-list reload and every 5 minutes; power_now follows
// state changes.

import { ha } from "./client";
import { chartGeometry, pickStatSources, statValue, sumStates, summarizeSeries, type StatRow, type StatSources } from "./stats";

const REFRESH_MS = 5 * 60_000;
const POWER_NOW_MS = 3_000;
const CHART_WIDTH = 400;
const CHART_HEIGHT = 60;
const CHART_COLOR = "#b388ff";

type Setter = (name: string, value: string) => void;

/** Draw a 24 h curve (filled area + line) to a PNG data URL; "" when there is nothing to draw. */
function renderChart(values: number[]): string {
  const { points } = chartGeometry(values, CHART_WIDTH, CHART_HEIGHT);
  if (points.length < 2) return "";
  const canvas = document.createElement("canvas");
  canvas.width = CHART_WIDTH;
  canvas.height = CHART_HEIGHT;
  const ctx = canvas.getContext("2d");
  if (!ctx) return "";
  const bottom = CHART_HEIGHT - 1;

  const fill = ctx.createLinearGradient(0, 0, 0, CHART_HEIGHT);
  fill.addColorStop(0, `${CHART_COLOR}99`);
  fill.addColorStop(1, `${CHART_COLOR}00`);
  ctx.beginPath();
  ctx.moveTo(points[0][0], bottom);
  for (const [x, y] of points) ctx.lineTo(x, y);
  ctx.lineTo(points[points.length - 1][0], bottom);
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();

  ctx.beginPath();
  points.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
  ctx.strokeStyle = CHART_COLOR;
  ctx.lineWidth = 2;
  ctx.lineJoin = "round";
  ctx.stroke();
  return canvas.toDataURL("image/png");
}

export class HAStatsFetcher {
  private setVar: Setter;
  private refreshTimer: number | undefined;
  private powerTimer: number | undefined;
  private unsubscribe: (() => void) | null = null;
  private running = false;
  private again = false;
  private lastPowerNow: string | null = null;
  private sources: StatSources = { energy: [], power: [] };

  constructor(setVar: Setter) {
    this.setVar = setVar;
  }

  start() {
    this.stop();
    this.unsubscribe = ha.onStatus((s) => { if (s.connected) this.refresh(); });
    this.refreshTimer = window.setInterval(() => this.refresh(), REFRESH_MS);
    this.powerTimer = window.setInterval(() => this.publishPowerNow(), POWER_NOW_MS);
    this.refresh();
  }

  stop() {
    this.unsubscribe?.();
    this.unsubscribe = null;
    clearInterval(this.refreshTimer);
    clearInterval(this.powerTimer);
    this.refreshTimer = this.powerTimer = undefined;
  }

  /** Fetch all statistics now (coalesces calls made while a fetch is running). */
  async refresh(): Promise<void> {
    if (this.running) { this.again = true; return; }
    if (!ha.connected) return;
    this.running = true;
    try {
      do {
        this.again = false;
        this.sources = pickStatSources(ha.getEntities(), new Set(ha.getWatchedIds()));
        this.publishPowerNow();
        await Promise.all([this.fetchEnergy(), this.fetchPower()]);
      } while (this.again && ha.connected);
    } catch (e) {
      console.warn("[HA] Statistics refresh failed:", e);
    } finally {
      this.running = false;
    }
  }

  private publishPowerNow() {
    const total = sumStates(this.sources.power, (id) => ha.getEntity(id)?.state);
    const value = statValue(total, 1);
    if (value === this.lastPowerNow) return;
    this.lastPowerNow = value;
    this.setVar("ha_stats.power_now", value);
  }

  private async periodChange(id: string, period: "day" | "month"): Promise<number | null> {
    const r = await ha.sendCommand({
      type: "recorder/statistic_during_period", statistic_id: id, calendar: { period }, types: ["change"],
    });
    return typeof r?.change === "number" ? r.change : null;
  }

  private async fetchEnergy() {
    let today = 0, month = 0, any = false;
    for (const id of this.sources.energy) {
      const [d, m] = await Promise.all([this.periodChange(id, "day"), this.periodChange(id, "month")]);
      this.setVar(`ha.${id}.stats.today`, statValue(d, 3));
      this.setVar(`ha.${id}.stats.month`, statValue(m, 3));
      if (d !== null) { today += d; any = true; }
      if (m !== null) { month += m; any = true; }
    }
    this.setVar("ha_stats.energy_today", any ? statValue(today, 3) : "");
    this.setVar("ha_stats.energy_month", any ? statValue(month, 3) : "");
  }

  private async fetchPower() {
    if (!this.sources.power.length) return;
    const end = new Date();
    const start = new Date(end.getTime() - 24 * 3600_000);
    const res: Record<string, StatRow[]> = await ha.sendCommand({
      type: "recorder/statistics_during_period",
      start_time: start.toISOString(), end_time: end.toISOString(),
      statistic_ids: this.sources.power, period: "5minute", types: ["mean", "max"],
    }) ?? {};
    for (const id of this.sources.power) {
      const s = summarizeSeries(res[id]);
      this.setVar(`ha.${id}.stats.avg_24h`, statValue(s.avg, 1));
      this.setVar(`ha.${id}.stats.max_24h`, statValue(s.max, 1));
      this.setVar(`ha.${id}.stats.chart_24h`, renderChart(s.values));
    }
  }
}
