import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  parseProfileJson, normalizeProfile, serializeProfile, legacyDeviceConfig, isLegacyProfile,
  ProfileFormatError, cloneJson,
} from "./profile";

const fixtureText = readFileSync(new URL("./__fixtures__/profile_default.redacted.json", import.meta.url), "utf8");
const PLUS = "TESTSERIAL01";
const OTHER = "TESTSERIAL02";

describe("fixture (redacted live profile)", () => {
  it("contains no secrets or embedded images", () => {
    expect(fixtureText).not.toMatch(/data:/);
    expect(fixtureText).not.toMatch(/token=(?!REDACTED)/);
  });

  it("loads with both devices, scenes, keys, encoders and strip", () => {
    const p = parseProfileJson(fixtureText);
    expect(p.name).toBe("default");
    expect(Object.keys(p.devices!)).toEqual([PLUS, OTHER]);
    const plus = p.devices![PLUS];
    const scene = plus.scenes[plus.activeSceneId!];
    expect(Object.keys(scene.keys)).toEqual(["0", "1", "2", "3", "4", "5", "6", "7"]);
    expect(scene.encoders!["0"].step).toBe(5);
    expect(scene.encoders!["0"].value).toBe("{{$ha.light.test_bulb_1.brightness}}");
    expect(scene.strip!.items).toHaveLength(4);
    const other = p.devices![OTHER];
    expect(other.scenes[other.activeSceneId!].keys["14"].pinned).toBe(true);
    expect(p.recent).toContain("ha-service");
  });

  it("normalization preserves every field of a valid file (load → save → load is lossless)", () => {
    const original = JSON.parse(fixtureText);
    const p = parseProfileJson(fixtureText);
    const saved = JSON.parse(serializeProfile(p.name, p.devices!, p.favorites, p.recent));
    expect(saved).toEqual(original);
  });

  it("keeps unknown/legacy fields such as the orphan text strip item", () => {
    const p = parseProfileJson(fixtureText);
    const scene = Object.values(p.devices![PLUS].scenes)[0];
    const orphan = scene.strip!.items[0] as unknown as Record<string, unknown>;
    expect(orphan.type).toBe("text");
    expect(orphan.text).toBe("Text");
  });
});

describe("validation", () => {
  const bad: [string, string][] = [
    ["not JSON", "{"],
    ["array", "[]"],
    ["devices not an object", JSON.stringify({ devices: [] })],
    ["device not an object", JSON.stringify({ devices: { S: 5 } })],
    ["scenes not an object", JSON.stringify({ devices: { S: { scenes: [] } } })],
    ["key without action", JSON.stringify({ devices: { S: { scenes: { a: { keys: { "0": { settings: {} } } } } } } })],
    ["action without id", JSON.stringify({ devices: { S: { scenes: { a: { keys: { "0": { action: {} } } } } } } })],
    ["non-integer key index", JSON.stringify({ devices: { S: { scenes: { a: { keys: { x: { action: { id: "none" } } } } } } } })],
    ["texts not an array", JSON.stringify({ devices: { S: { scenes: { a: { keys: { "0": { action: { id: "none" }, texts: {} } } } } } } })],
    ["strip items not an array", JSON.stringify({ devices: { S: { scenes: { a: { keys: {}, strip: { items: {} } } } } } })],
    ["strip item without numeric x", JSON.stringify({ devices: { S: { scenes: { a: { keys: {}, strip: { items: [{ id: "i", x: "a", y: 0, w: 1, h: 1 }] } } } } } })],
    ["triggers not an array", JSON.stringify({ devices: { S: { scenes: { a: { keys: {}, triggers: {} } } } } })],
  ];
  it.each(bad)("rejects %s", (_name, json) => {
    expect(() => parseProfileJson(json)).toThrow(ProfileFormatError);
  });

  it("error messages name the offending path", () => {
    expect(() => parseProfileJson(bad[5][1])).toThrow(/devices\.S\.scenes\.a\.keys\.0\.action/);
  });

  it("fills defaults and coerces values to the types the app relies on", () => {
    const p = parseProfileJson(JSON.stringify({
      devices: { S: { scenes: { a: {
        keys: { "0": { action: { id: "http-request" }, settings: { port: 8080, on: true, body: { a: 1 }, nil: null } } },
        encoders: { "0": { value: 50, min: 0, max: 255, step: "5", rotateAction: { id: "ha-service" } } },
        strip: { items: [{ id: "x", x: "1", y: 0, w: 10, h: 10 }, { id: "x", x: 2, y: 0, w: 10, h: 10 }, { x: 3, y: 0, w: 1, h: 1 }] },
      } }, activeSceneId: "missing" } },
    }));
    const dev = p.devices!.S;
    const scene = dev.scenes.a;
    expect(dev.activeSceneId).toBe("a");
    expect(scene.id).toBe("a");
    expect(scene.name).toBe("Scene");
    expect(scene.triggers).toEqual([{ type: "manual" }]);
    expect(scene.keys["0"].settings).toEqual({ port: "8080", on: "true", body: '{"a":1}', nil: "" });
    expect(scene.keys["0"].backgroundColor).toBe("#000000");
    expect(scene.keys["0"].action).toEqual({ id: "http-request", label: "http-request", icon: "", color: "#333" });
    const enc = scene.encoders!["0"];
    expect([enc.value, enc.min, enc.max, enc.step]).toEqual(["50", "0", "255", 5]);
    expect(enc.pressAction.id).toBe("none");
    expect(enc.pressSettings).toEqual({});
    const ids = scene.strip!.items.map(i => i.id);
    expect(new Set(ids).size).toBe(3);
    expect(ids[0]).toBe("x");
    expect(scene.strip!.items[0].x).toBe(1);
    expect(scene.strip!.backgroundColor).toBe("#0a0a1a");
    expect(p.favorites).toEqual([]);
    expect(p.name).toBe("default");
  });

  it("empty object is a valid empty profile", () => {
    const p = normalizeProfile({}, "gen");
    expect(p).toEqual({ name: "gen", devices: {}, favorites: [], recent: [] });
  });
});

describe("legacy single-device format", () => {
  const legacy = {
    name: "old",
    scenes: { s1: { id: "s1", name: "Main", keys: { "0": { action: { id: "none", label: "None", icon: "", color: "#333" }, settings: {}, backgroundColor: "#ff0000" } }, triggers: [{ type: "manual" }] } },
    activeSceneId: "s1",
    favorites: ["back"], recent: [],
  };

  it("is detected and converted to one device config", () => {
    const p = parseProfileJson(JSON.stringify(legacy));
    expect(isLegacyProfile(p)).toBe(true);
    const dev = legacyDeviceConfig(p)!;
    expect(dev.activeSceneId).toBe("s1");
    expect(dev.scenes.s1.keys["0"].backgroundColor).toBe("#ff0000");
    expect(p.devices).toEqual({});
  });

  it("an unbound legacy layout survives a save (it is not dropped)", () => {
    const p = parseProfileJson(JSON.stringify(legacy));
    const saved = parseProfileJson(serializeProfile(p.name, p.devices!, p.favorites, p.recent, legacyDeviceConfig(p)));
    expect(isLegacyProfile(saved)).toBe(true);
    expect(legacyDeviceConfig(saved)).toEqual(legacyDeviceConfig(p));
  });

  it("once bound to a device it is saved in the devices format", () => {
    const p = parseProfileJson(JSON.stringify(legacy));
    const devices = { SERIAL: cloneJson(legacyDeviceConfig(p)!) };
    const saved = parseProfileJson(serializeProfile(p.name, devices, p.favorites, p.recent, null));
    expect(isLegacyProfile(saved)).toBe(false);
    expect(saved.devices!.SERIAL.scenes.s1.name).toBe("Main");
    expect(saved.favorites).toEqual(["back"]);
  });

  it("falls back to the first scene when activeSceneId is dangling", () => {
    const p = parseProfileJson(JSON.stringify({ ...legacy, activeSceneId: "gone" }));
    expect(legacyDeviceConfig(p)!.activeSceneId).toBe("s1");
  });
});
