import { describe, it, expect, vi, beforeEach } from "vitest";

// Fake HA client: responses are whole result messages, exactly as client.send() resolves them.
const h = vi.hoisted(() => {
  const entities = [
    { entity_id: "sensor.p1", state: "205.3", attributes: { device_class: "power", state_class: "measurement" } },
    { entity_id: "sensor.p2", state: "unavailable", attributes: { device_class: "power", state_class: "measurement" } },
    { entity_id: "sensor.e1", state: "729", attributes: { device_class: "energy", state_class: "total_increasing" } },
  ];
  const sent: any[] = [];
  const ha = {
    connected: true,
    getEntities: () => entities,
    getEntity: (id: string) => entities.find(e => e.entity_id === id),
    getWatchedIds: () => entities.map(e => e.entity_id),
    onStatus: () => () => {},
    sendCommand: async (msg: any) => {
      sent.push(msg);
      if (msg.type === "recorder/statistic_during_period") {
        return { id: 1, type: "result", success: true, result: { change: msg.calendar.period === "day" ? 0.456 : 101.988 } };
      }
      return {
        id: 2, type: "result", success: true,
        result: { "sensor.p1": [{ start: 1, mean: 200, max: 220 }, { start: 2, mean: 210, max: 283 }] },
      };
    },
  };
  return { ha, sent };
});
vi.mock("./client", () => ({ ha: h.ha }));

import { HAStatsFetcher } from "./stats-fetcher";

beforeEach(() => {
  // Minimal canvas: the chart is drawn, then exported as a PNG data URL.
  const ctx = new Proxy({}, { get: (_t, k) => (k === "createLinearGradient" ? () => ({ addColorStop() {} }) : () => {}) });
  (globalThis as any).document = {
    createElement: () => ({ width: 0, height: 0, getContext: () => ctx, toDataURL: () => "data:image/png;base64,AAAA" }),
  };
});

describe("HAStatsFetcher", () => {
  it("publishes statistics from HA result messages", async () => {
    const vars: Record<string, string> = {};
    const f = new HAStatsFetcher((n, v) => { vars[n] = v; });
    await f.refresh();
    expect(vars["ha.sensor.e1.stats.today"]).toBe("0.456");
    expect(vars["ha.sensor.e1.stats.month"]).toBe("101.988");
    expect(vars["ha_stats.energy_today"]).toBe("0.456");
    expect(vars["ha_stats.energy_month"]).toBe("101.988");
    expect(vars["ha.sensor.p1.stats.avg_24h"]).toBe("205");
    expect(vars["ha.sensor.p1.stats.max_24h"]).toBe("283");
    expect(vars["ha.sensor.p1.stats.chart_24h"]).toBe("data:image/png;base64,AAAA");
    expect(vars["ha.sensor.p2.stats.chart_24h"]).toBe("");      // no data → no chart
    expect(vars["ha_stats.power_now"]).toBe("205.3");           // unavailable sensor skipped
    const series = h.sent.find(m => m.type === "recorder/statistics_during_period");
    expect(series.statistic_ids).toEqual(["sensor.p1", "sensor.p2"]);
    expect(series.period).toBe("5minute");
  });
});
