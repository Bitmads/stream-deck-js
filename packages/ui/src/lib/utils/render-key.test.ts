import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolveKeyInputs, keyFingerprint, keyDesignSize, resolveImageUrl } from "./render-key";
import { resolveStripInputs, stripFingerprint } from "./render-strip";
import { parseProfileJson } from "./profile";
import type { KeyAssignment, TextConfig } from "../types/profile";
import type { VarLookup } from "./template";

const text = (t: string, extra: Partial<TextConfig> = {}): TextConfig => ({
  text: t, fontFamily: "sans-serif", fontSize: 14, fontWeight: "normal", fontStyle: "normal",
  color: "#ffffff", hAlign: "center", vAlign: "middle", anchor: "center", useAbsolutePos: false, ...extra,
});
const key = (k: Partial<KeyAssignment>): KeyAssignment => ({
  action: { id: "none", label: "None", icon: "", color: "#333" }, settings: {}, backgroundColor: "#000000", ...k,
});

function tracked(vals: Record<string, string>) {
  const read = new Set<string>();
  const lookup: VarLookup = (n) => { read.add(n); return vals[n]; };
  return { lookup, read, vals };
}

const fp = (k: KeyAssignment, vals: Record<string, string>, size = 120) =>
  keyFingerprint(resolveKeyInputs(k, (n) => vals[n]), size);

describe("key fingerprint", () => {
  it("is stable when a variable the key does not use changes (time.*)", () => {
    const k = key({ backgroundColor: "{{$bg}}", texts: [text("{{$t}}")] });
    const a = { bg: "#112233", t: "x", "time.seconds": "01" };
    const b = { ...a, "time.seconds": "02" };
    expect(fp(k, a)).toBe(fp(k, b));
  });

  it("resolution reads only the variables the key uses", () => {
    const k = key({ backgroundColor: "{{$bg|map:on=#f00:*=#000}}", texts: [text("A {{$t}}", { color: "{{$c}}" })] });
    const tr = tracked({ bg: "on", t: "1", c: "#00ff00", "time.seconds": "05" });
    resolveKeyInputs(k, tr.lookup);
    expect([...tr.read].sort()).toEqual(["bg", "c", "t"]);
  });

  it("changes when ANY templated field changes", () => {
    const k = key({
      backgroundColor: "{{$bg|map:on=#dd9800:*=#000000}}",
      imageUrl: "https://ha.example{{$pic}}",
      texts: [text("{{$t}}", { color: "{{$tc}}" })],
      icons: [
        { setId: "s", iconName: "off", svgBody: "<path/>", color: "{{$ic}}", size: 40, viewBox: "0 0 24 24", variable: "{{$sw}}", value: "off" },
        { setId: "s", iconName: "on", svgBody: "<circle/>", color: "#fff", size: 40, viewBox: "0 0 24 24", variable: "{{$sw}}", value: "on" },
      ],
    });
    const base = { bg: "on", pic: "/a.png", t: "hi", tc: "#ffffff", ic: "#ff0000", sw: "off" };
    const f0 = fp(k, base);
    for (const [name, value] of [["bg", "off"], ["pic", "/b.png"], ["t", "yo"], ["tc", "#000000"], ["ic", "#00ff00"], ["sw", "on"]]) {
      expect(fp(k, { ...base, [name]: value }), name).not.toBe(f0);
    }
  });

  it("changes with the output size and with runtime overrides", () => {
    const k = key({ texts: [text("label")] });
    const i = resolveKeyInputs(k, () => undefined);
    expect(keyFingerprint(i, 72)).not.toBe(keyFingerprint(i, 120));
    const o = resolveKeyInputs(k, () => undefined, { title: "0:59" });
    expect(o.texts[0].text).toBe("0:59");
    expect(keyFingerprint(o, 72)).not.toBe(keyFingerprint(i, 72));
  });
});

describe("key input resolution", () => {
  it("resolves text color and falls back on invalid colors (never the background)", () => {
    const k = key({ texts: [text("x", { color: "{{$c|map:on=#00ff00:*=nonsense}}" })] });
    expect(resolveKeyInputs(k, (n) => ({ c: "on" } as Record<string, string>)[n]).texts[0].color).toBe("#00ff00");
    expect(resolveKeyInputs(k, (n) => ({ c: "off" } as Record<string, string>)[n]).texts[0].color).toBe("#ffffff");
  });
  it("missing variables never render filter names", () => {
    const k = key({ text: text("{{$ha.sensor.t.state|f2c|round1}}°C"), backgroundColor: "{{$ha.light.x.rgb_color|rgb}}" });
    const i = resolveKeyInputs(k, () => undefined);
    expect(i.texts.map(t => t.text)).toEqual(["°C"]);
    expect(i.background).toBe("#000000");
  });
  it("hidden and empty layers are dropped; title override fills the first layer or adds one", () => {
    const k = key({ texts: [text("{{$missing}}"), text("b", { hidden: true }), text("c")] });
    expect(resolveKeyInputs(k, () => undefined).texts.map(t => t.text)).toEqual(["c"]);
    const bare = key({});
    expect(resolveKeyInputs(bare, () => undefined, { title: "5" }).texts.map(t => t.text)).toEqual(["5"]);
  });
  it("image override replaces the background image; data URLs win over URLs", () => {
    const k = key({ imageDataUrl: "data:image/png;base64,AA==", imageUrl: "https://x.example/a.png" });
    expect(resolveKeyInputs(k, () => undefined).image).toBe("data:image/png;base64,AA==");
    expect(resolveKeyInputs(k, () => undefined, { image: "data:image/png;base64,BB==" }).image).toBe("data:image/png;base64,BB==");
  });
  it("image URLs with missing variables or incomplete URLs are skipped", () => {
    expect(resolveImageUrl("https://ha.example{{$pic}}", () => undefined)).toBe("");
    expect(resolveImageUrl("https://", () => undefined)).toBe("");
    expect(resolveImageUrl("htt", () => undefined)).toBe("");
    expect(resolveImageUrl("https://ha.example/x.png", () => undefined)).toBe("https://ha.example/x.png");
  });
  it("design size is capped at 96 (Plus renders 96-unit layouts at 120 px)", () => {
    expect(keyDesignSize(120)).toBe(96);
    expect(keyDesignSize(72)).toBe(72);
    expect(keyDesignSize(80)).toBe(80);
  });
});

describe("strip fingerprint", () => {
  it("tracks imageUrl, bar min/max and strip background; ignores unrelated variables", () => {
    const strip = {
      backgroundColor: "{{$sbg}}",
      items: [{ id: "a", x: 0, y: 0, w: 200, h: 100, imageUrl: "https://h.example{{$pic}}",
        bar: { value: "{{$v}}", min: "{{$mn}}", max: "{{$mx}}", color: "#fff", position: "bottom" as const, height: 8 } }],
    };
    const base = { sbg: "#000000", pic: "/a.png", v: "50", mn: "0", mx: "100", "time.seconds": "1" };
    const f = (o: Record<string, string>) => stripFingerprint(resolveStripInputs(strip, (n) => o[n]), 800, 100);
    const f0 = f(base);
    expect(f({ ...base, "time.seconds": "2" })).toBe(f0);
    for (const [k, v] of [["sbg", "#111111"], ["pic", "/b.png"], ["mx", "200"], ["mn", "10"], ["v", "60"]]) {
      expect(f({ ...base, [k]: v }), k).not.toBe(f0);
    }
  });
});

describe("live-profile fixture", () => {
  const profile = parseProfileJson(readFileSync(new URL("./__fixtures__/profile_default.redacted.json", import.meta.url), "utf8"));
  const scene = Object.values(profile.devices!.TESTSERIAL01.scenes)[0];

  it("no key depends on time.* variables", () => {
    for (const [idx, k] of Object.entries(scene.keys)) {
      const tr = tracked({});
      resolveKeyInputs(k, tr.lookup);
      expect([...tr.read].some(n => n.startsWith("time.")), `key ${idx}`).toBe(false);
    }
  });
  it("key 2 (legacy text only) renders the unit, not 'f2c|round1', before HA syncs", () => {
    const i = resolveKeyInputs(scene.keys["2"], () => undefined);
    expect(i.texts.map(t => t.text)).toEqual(["°C"]);
  });
  it("key 3 background follows binary_sensor.test_tv", () => {
    const k = scene.keys["3"];
    const on = resolveKeyInputs(k, (n) => (n === "ha.binary_sensor.test_tv.state" ? "on" : undefined));
    const off = resolveKeyInputs(k, (n) => (n === "ha.binary_sensor.test_tv.state" ? "off" : undefined));
    expect(on.background).toBe("#dd9800");
    expect(off.background).toBe("#000000");
  });
});
