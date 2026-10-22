import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildDeck, defineDeck, device, key, nav, scene, sceneIdFromSlug } from "../src/index.ts";
import {
  ApplyAbortedError, applyDeck, computePluginUpdate, computeWatchUpdate, defaultConfigDir, mergeProfile,
  profileFile, sanitizeProfileName, type HttpFn,
} from "../src/apply.ts";
import { LIGHT, OTHER, PLUS, sampleDeck, storedProfile } from "./fixtures.ts";

describe("mergeProfile", () => {
  it("leaves other devices, favorites and recent untouched", () => {
    const base = storedProfile();
    const { profile } = mergeProfile(base, buildDeck(sampleDeck()));
    expect(profile.devices![OTHER]).toEqual(base.devices![OTHER]);
    expect(profile.favorites).toEqual(base.favorites);
    expect(profile.recent).toEqual(base.recent);
    expect(profile.name).toBe("default");
    expect(base.devices![PLUS].scenes["old-scene-1"].name).toBe("Old 1"); // input not mutated
  });

  it("puts deck scenes first in deck order, keeps the others after them, keeps the active scene and brightness", () => {
    const { profile, summary } = mergeProfile(storedProfile(), buildDeck(sampleDeck()));
    const dev = profile.devices![PLUS];
    expect(Object.keys(dev.scenes)).toEqual([sceneIdFromSlug("home"), sceneIdFromSlug("sub"), "old-scene-1", "old-scene-2"]);
    expect(dev.activeSceneId).toBe("old-scene-2");
    expect(dev.brightness).toBe(40);
    expect(summary[0]).toMatchObject({ added: [sceneIdFromSlug("home"), sceneIdFromSlug("sub")], kept: ["old-scene-1", "old-scene-2"], replaced: [], removed: [] });
  });

  it("replaces a scene with the same id in place and moves it into deck order", () => {
    const deck = defineDeck({ devices: [device(PLUS, "plus", [
      scene("first", { keys: { 0: key({ action: nav.push("replaced") }) } }),
      scene("replaced", { id: "old-scene-2", name: "New 2" }),
    ], { brightness: 80 })] });
    const { profile, summary } = mergeProfile(storedProfile(), buildDeck(deck));
    const dev = profile.devices![PLUS];
    expect(Object.keys(dev.scenes)).toEqual([sceneIdFromSlug("first"), "old-scene-2", "old-scene-1"]);
    expect(dev.scenes["old-scene-2"].name).toBe("New 2");
    expect(dev.scenes["old-scene-2"].keys).toEqual({});
    expect(dev.scenes[sceneIdFromSlug("first")].keys["0"].settings.sceneId).toBe("old-scene-2");
    expect(dev.activeSceneId).toBe("old-scene-2");
    expect(dev.brightness).toBe(80);
    expect(summary[0]).toMatchObject({ replaced: ["old-scene-2"], kept: ["old-scene-1"] });
  });

  it("prunes scenes the deck does not define only with prune", () => {
    const { profile, summary } = mergeProfile(storedProfile(), buildDeck(sampleDeck()), { prune: true });
    expect(Object.keys(profile.devices![PLUS].scenes)).toEqual([sceneIdFromSlug("home"), sceneIdFromSlug("sub")]);
    expect(profile.devices![PLUS].activeSceneId).toBe(sceneIdFromSlug("home"));
    expect(summary[0].removed).toEqual(["old-scene-1", "old-scene-2"]);
    expect(profile.devices![OTHER]).toEqual(storedProfile().devices![OTHER]);
  });

  it("creates a new profile and keeps a legacy top-level layout", () => {
    const { profile } = mergeProfile(null, buildDeck(sampleDeck()), { profileName: "work" });
    expect(profile.name).toBe("work");
    expect(profile.devices![PLUS].activeSceneId).toBe(sceneIdFromSlug("home"));
    const legacy = { name: "default", scenes: { x: { id: "x", name: "X", keys: {}, triggers: [] } }, activeSceneId: "x", favorites: [], recent: [] };
    const merged = mergeProfile(legacy, buildDeck(sampleDeck())).profile;
    expect(merged.scenes).toEqual(legacy.scenes);
    expect(merged.activeSceneId).toBe("x");
  });
});

describe("config file helpers", () => {
  it("adds watched entities while keeping url/token and order", () => {
    const u = computeWatchUpdate({ url: "https://ha.example", token: "SECRET", watched: ["sensor.a"], extra: 1 }, ["sensor.a", LIGHT]);
    expect(u.added).toEqual([LIGHT]);
    expect(JSON.parse(u.content!)).toEqual({ url: "https://ha.example", token: "SECRET", watched: ["sensor.a", LIGHT], extra: 1 });
    expect(computeWatchUpdate({ watched: [LIGHT] }, [LIGHT])).toEqual({ added: [], changed: false, content: null });
    expect(JSON.parse(computeWatchUpdate(null, [LIGHT]).content!)).toEqual({ watched: [LIGHT] });
  });

  it("enables only explicitly disabled required plugins", () => {
    const u = computePluginUpdate({ "multi-action": { enabled: false }, "system-actions": { enabled: false }, homeassistant: { enabled: true } }, ["homeassistant", "multi-action", "navigation"]);
    expect(u.disabled).toEqual(["multi-action"]);
    expect(JSON.parse(u.content!)).toEqual({ "multi-action": { enabled: true }, "system-actions": { enabled: false }, homeassistant: { enabled: true } });
    expect(computePluginUpdate({}, ["navigation"]).content).toBeNull();
  });

  it("resolves the app config dir and profile names like the app", () => {
    expect(defaultConfigDir({ HOME: "/home/u" }, "linux")).toBe("/home/u/.config/open-stream-deck");
    expect(defaultConfigDir({ HOME: "/home/u", XDG_CONFIG_HOME: "/xdg" }, "linux")).toBe("/xdg/open-stream-deck");
    expect(defaultConfigDir({ HOME: "/Users/u" }, "darwin")).toBe("/Users/u/Library/Application Support/open-stream-deck");
    expect(sanitizeProfileName("my profile/1")).toBe("my_profile_1");
    expect(() => sanitizeProfileName("  ")).toThrow();
    expect(profileFile("/c", "default")).toBe("/c/profile_default.json");
  });
});

describe("applyDeck", () => {
  let home: string;
  let cfg: string;
  const now = new Date(2026, 0, 2, 3, 4, 5, 6);
  const offline: HttpFn = async () => { throw new Error("connect ECONNREFUSED 127.0.0.1:8484"); };

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "deck-apply-"));
    cfg = defaultConfigDir({ HOME: home }, "linux");
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  function seed() {
    const files: Record<string, string> = {
      "profile_default.json": JSON.stringify(storedProfile()),
      "ha_config.json": JSON.stringify({ url: "https://ha.example", token: "SECRET-TOKEN", watched: ["sensor.a"] }),
      "plugins.json": JSON.stringify({ "multi-action": { enabled: false }, homeassistant: { enabled: true } }),
    };
    mkdirSync(cfg, { recursive: true });
    for (const [f, c] of Object.entries(files)) writeFileSync(join(cfg, f), c);
    return files;
  }

  it("cold mode: merges, writes atomically with backups, updates ha_config and plugins.json", async () => {
    const original = seed();
    const lines: string[] = [];
    const r = await applyDeck(buildDeck(sampleDeck()), { profileName: "default", configDir: cfg, http: offline, isAppRunning: () => false, now, log: l => lines.push(l) });
    expect(r.mode).toBe("cold");

    const written = JSON.parse(readFileSync(join(cfg, "profile_default.json"), "utf8"));
    expect(written.devices[OTHER]).toEqual(storedProfile().devices![OTHER]);
    expect(Object.keys(written.devices[PLUS].scenes)).toEqual([sceneIdFromSlug("home"), sceneIdFromSlug("sub"), "old-scene-1", "old-scene-2"]);
    expect(statSync(join(cfg, "profile_default.json")).mode & 0o777).toBe(0o600);

    const haCfg = JSON.parse(readFileSync(join(cfg, "ha_config.json"), "utf8"));
    expect(haCfg).toEqual({ url: "https://ha.example", token: "SECRET-TOKEN", watched: ["sensor.a", LIGHT] });
    expect(r.watchAdded).toEqual([LIGHT]);
    expect(JSON.parse(readFileSync(join(cfg, "plugins.json"), "utf8"))["multi-action"]).toEqual({ enabled: true });
    expect(r.pluginsDisabled).toEqual(["multi-action"]);

    const backupDir = join(cfg, "deck-backups", "20260102-030405-006");
    expect(readdirSync(backupDir).sort()).toEqual(["ha_config.json", "plugins.json", "profile_default.json"]);
    for (const f of readdirSync(backupDir)) expect(readFileSync(join(backupDir, f), "utf8")).toBe(original[f]);
    expect(readdirSync(cfg).filter(f => f.endsWith(".tmp"))).toEqual([]);
    expect(lines.join("\n")).not.toContain("SECRET-TOKEN");
  });

  it("cold mode without existing files creates them and makes no backups", async () => {
    const r = await applyDeck(buildDeck(sampleDeck()), { profileName: "fresh", configDir: cfg, http: offline, isAppRunning: () => false, now });
    expect(existsSync(join(cfg, "profile_fresh.json"))).toBe(true);
    expect(JSON.parse(readFileSync(join(cfg, "ha_config.json"), "utf8"))).toEqual({ watched: [LIGHT] });
    expect(existsSync(join(cfg, "plugins.json"))).toBe(false);
    expect(r.backups).toEqual([]);
  });

  it("writes nothing when validation fails", async () => {
    const original = seed();
    const bad = buildDeck(defineDeck({ devices: [device(PLUS, "plus", [scene("s", { keys: { 20: key() } })])] }));
    await expect(applyDeck(bad, { profileName: "default", configDir: cfg, http: offline, isAppRunning: () => false, now })).rejects.toBeInstanceOf(ApplyAbortedError);
    for (const [f, c] of Object.entries(original)) expect(readFileSync(join(cfg, f), "utf8")).toBe(c);
    expect(existsSync(join(cfg, "deck-backups"))).toBe(false);
  });

  it("refuses a cold write while an app process runs without a reachable API", async () => {
    const original = seed();
    await expect(applyDeck(buildDeck(sampleDeck()), { profileName: "default", configDir: cfg, http: offline, isAppRunning: () => true, now })).rejects.toThrow(/process is running/);
    for (const [f, c] of Object.entries(original)) expect(readFileSync(join(cfg, f), "utf8")).toBe(c);
  });

  it("hot mode: GET, merge, PUT through the API; plugins.json is left to the app", async () => {
    const original = seed();
    const calls: Array<{ method: string; path: string; body?: string }> = [];
    const live = storedProfile();
    live.recent = ["live"];
    const http: HttpFn = async (method, path, body) => {
      calls.push({ method, path, body });
      if (path === "/api/health") return { status: 200, body: "ok" };
      if (method === "GET" && path === "/api/profile/default") return { status: 200, body: JSON.stringify(live) };
      if (method === "PUT" && path === "/api/profile/default") return { status: 200, body: '{"ok":true,"name":"default"}' };
      return { status: 404, body: "" };
    };
    const r = await applyDeck(buildDeck(sampleDeck()), { profileName: "default", configDir: cfg, http, isAppRunning: () => true, now });
    expect(r.mode).toBe("hot");
    expect(calls.map(c => `${c.method} ${c.path}`)).toEqual(["GET /api/health", "GET /api/profile/default", "PUT /api/profile/default"]);
    const put = JSON.parse(calls[2].body!);
    expect(put.recent).toEqual(["live"]);
    expect(put.devices[OTHER]).toEqual(live.devices![OTHER]);
    expect(Object.keys(put.devices[PLUS].scenes).slice(0, 2)).toEqual([sceneIdFromSlug("home"), sceneIdFromSlug("sub")]);
    // The profile file itself is written by the app (PUT), not by us.
    expect(readFileSync(join(cfg, "profile_default.json"), "utf8")).toBe(original["profile_default.json"]);
    expect(readFileSync(join(cfg, "plugins.json"), "utf8")).toBe(original["plugins.json"]);
    expect(r.pluginsDisabled).toEqual(["multi-action"]);
    expect(JSON.parse(readFileSync(join(cfg, "ha_config.json"), "utf8")).watched).toEqual(["sensor.a", LIGHT]);
    const backupDir = join(cfg, "deck-backups", "20260102-030405-006");
    expect(readFileSync(join(backupDir, "profile_default.json"), "utf8")).toBe(JSON.stringify(live));
    expect(readFileSync(join(backupDir, "ha_config.json"), "utf8")).toBe(original["ha_config.json"]);
  });

  it("hot mode surfaces a failed PUT and restores ha_config.json", async () => {
    const original = seed();
    const http: HttpFn = async (method, path) => {
      if (path === "/api/health") return { status: 200, body: "ok" };
      if (method === "GET") return { status: 404, body: "Profile default not found" };
      return { status: 401, body: "Missing or invalid API key" };
    };
    await expect(applyDeck(buildDeck(sampleDeck()), { profileName: "default", configDir: cfg, http, now })).rejects.toThrow(/HTTP 401/);
    expect(readFileSync(join(cfg, "ha_config.json"), "utf8")).toBe(original["ha_config.json"]);
  });

  it("hot mode stops before writing when the running app has no profile API", async () => {
    const original = seed();
    const calls: string[] = [];
    for (const status of [401, 404]) {
      const http: HttpFn = async (method, path) => {
        calls.push(`${method} ${path}`);
        return path === "/api/health" ? { status: 200, body: "ok" } : { status, body: "" };
      };
      await expect(applyDeck(buildDeck(sampleDeck()), { profileName: "default", configDir: cfg, http, now })).rejects.toThrow(new RegExp(`HTTP ${status}`));
    }
    expect(calls.filter(c => c.startsWith("PUT"))).toEqual([]);
    for (const [f, c] of Object.entries(original)) expect(readFileSync(join(cfg, f), "utf8")).toBe(c);
    expect(existsSync(join(cfg, "deck-backups"))).toBe(false);
  });
});
