import { describe, it, expect } from "vitest";
import { chartGeometry, pickStatSources, statValue, sumStates, summarizeSeries } from "./stats";

const ent = (entity_id: string, device_class?: string, state_class?: string, state = "1") =>
  ({ entity_id, state, attributes: { device_class, state_class } });

describe("pickStatSources", () => {
  it("picks watched sensors with long-term statistics by kind", () => {
    const all = [
      ent("sensor.p1", "power", "measurement"), ent("sensor.e1", "energy", "total_increasing"),
      ent("sensor.e0", "energy", "total"), ent("sensor.p_unwatched", "power", "measurement"),
      ent("sensor.p_nostats", "power"), ent("sensor.t", "temperature", "measurement"),
      ent("switch.p", "power", "measurement"),
    ];
    const watched = new Set(["sensor.p1", "sensor.e1", "sensor.e0", "sensor.p_nostats", "sensor.t", "switch.p"]);
    expect(pickStatSources(all, watched)).toEqual({ energy: ["sensor.e0", "sensor.e1"], power: ["sensor.p1"] });
  });
});

describe("statValue / sumStates", () => {
  it("rounds and blanks non-finite numbers", () => {
    expect(statValue(99.75099999999998, 3)).toBe("99.751");
    expect(statValue(0.5090000000000146, 1)).toBe("0.5");
    expect(statValue(null, 1)).toBe("");
    expect(statValue(NaN, 1)).toBe("");
  });
  it("sums numeric states only", () => {
    const states: Record<string, string> = { a: "197.3", b: "unavailable", c: "8.6", d: "" };
    expect(sumStates(["a", "b", "c", "d", "missing"], id => states[id])).toBeCloseTo(205.9);
    expect(sumStates(["b", "d"], id => states[id])).toBeNull();
  });
});

describe("summarizeSeries", () => {
  it("drops gaps, averages means and peaks the maxima", () => {
    const s = summarizeSeries([
      { start: 1, mean: 200, max: 220 }, { start: 2, mean: null, max: null }, { start: 3, mean: 100, max: 380 },
    ]);
    expect(s).toEqual({ avg: 150, max: 380, values: [200, 100] });
  });
  it("handles a missing series", () => {
    expect(summarizeSeries(undefined)).toEqual({ avg: null, max: null, values: [] });
  });
});

describe("chartGeometry", () => {
  it("spans the width, starts y at 0 and leaves 10% headroom", () => {
    const g = chartGeometry([0, 50, 100], 104, 64, 2);
    expect(g.top).toBeCloseTo(110);
    expect(g.points.map(p => p[0])).toEqual([2, 52, 102]);
    expect(g.points[0][1]).toBe(62);                      // 0 sits on the bottom edge
    expect(g.points[2][1]).toBeCloseTo(2 + 60 - (100 / 110) * 60, 1);
  });
  it("draws a flat line for an idle plug and a single value across the width", () => {
    expect(chartGeometry([0, 0], 100, 50).points.every(p => p[1] === 48)).toBe(true);
    expect(chartGeometry([5], 100, 50).points.map(p => p[0])).toEqual([2, 98]);
    expect(chartGeometry([], 100, 50).points).toEqual([]);
  });
});
