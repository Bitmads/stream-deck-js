// Loads a real (redacted) profile file through the store's startup and reload paths.
// Skipped unless OSD_LIVE_PROFILE points at a profile_<name>.json copy, so no user data is committed:
//   OSD_LIVE_PROFILE=/path/to/profile_default.json pnpm --filter @open-stream-deck/ui test live-profile
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";

const h = vi.hoisted(() => {
  const g = globalThis as any;
  g.window = g;
  g.addEventListener = () => {};
  g.document = { addEventListener: () => {}, visibilityState: "visible" };
  const files: Record<string, string> = {};
  const calls: { cmd: string; args: any }[] = [];
  const devices: any[] = [];
  return { files, calls, devices };
});

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args: any) => {
    h.calls.push({ cmd, args });
    switch (cmd) {
      case "load_json_file": return h.files[args.filename] ?? null;
      case "load_json_file_stamped": {
        const content = h.files[args.filename];
        return content === undefined ? null : { content, stamp: `s:${content}` };
      }
      case "save_json_file": {
        // Mirrors storage.rs: a save with a stale expectedStamp is refused.
        const current = h.files[args.filename];
        if (args.expectedStamp != null && (current === undefined || `s:${current}` !== args.expectedStamp)) {
          throw `changed on disk: ${args.filename}.json was replaced by another writer`;
        }
        h.files[args.filename] = args.content;
        return `s:${args.content}`;
      }
      case "list_json_files": return Object.keys(h.files);
      case "list_devices": return h.devices;
      default: return null;
    }
  }),
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

import { store } from "./store.svelte";
import { parseProfileJson, serializeProfile } from "../utils/profile";
import { resolveKeyInputs, keyFingerprint } from "../utils/render-key";
import { resolveStripInputs, stripFingerprint } from "../utils/render-strip";

const path = process.env.OSD_LIVE_PROFILE;

describe.skipIf(!path)("live profile file", () => {
  const text = path ? readFileSync(path, "utf8") : "{}";
  const raw = JSON.parse(text);
  const serials = Object.keys(raw.devices ?? {});

  it("parses and re-serializes losslessly", () => {
    const p = parseProfileJson(text);
    expect(Object.keys(p.devices!)).toEqual(serials);
    expect(JSON.parse(serializeProfile(p.name, p.devices!, p.favorites, p.recent))).toEqual(raw);
  });

  it("loads at startup, resolves every key and strip of every scene, and does not save", async () => {
    vi.useFakeTimers();
    h.files.profile_default = text;
    h.devices.push(...serials.map((serial, i) => ({
      serial, model: "Deck", model_id: "x", columns: i === 0 ? 4 : 5, rows: i === 0 ? 2 : 3,
      key_size: i === 0 ? 120 : 72, key_pixel_size: i === 0 ? 120 : 72,
      has_lcd_strip: i === 0, has_dials: i === 0, encoder_count: i === 0 ? 4 : 0,
      lcd_width: i === 0 ? 800 : 0, lcd_height: i === 0 ? 100 : 0,
    })));
    await store.initStore();
    await store.refreshDevices();
    expect(store.loadError).toBeNull();
    expect(store.getConnectedSerials().sort()).toEqual([...serials].sort());

    let keys = 0;
    for (const serial of serials) {
      const dev = raw.devices[serial];
      expect(store.getActiveSceneId(serial)).toBe(dev.activeSceneId);
      for (const [sceneId, scene] of Object.entries<any>(dev.scenes)) {
        for (const idx of Object.keys(scene.keys ?? {})) {
          const a = store.getEffectiveKey(serial, sceneId, Number(idx));
          expect(a, `${serial}/${sceneId}/${idx}`).toBeDefined();
          const inputs = resolveKeyInputs(a!, store.lookupVar);
          expect(typeof keyFingerprint(inputs, 120)).toBe("string");
          keys++;
        }
        if (scene.strip) expect(typeof stripFingerprint(resolveStripInputs(scene.strip, store.lookupVar), 800, 100)).toBe("string");
      }
    }
    expect(keys).toBeGreaterThan(0);

    await vi.advanceTimersByTimeAsync(2000);
    expect(h.calls.filter(c => c.cmd === "save_json_file" && c.args.filename === "profile_default")).toHaveLength(0);
  });

  it("reloads from disk through the profile-reload path", async () => {
    expect(await store.reloadProfileFromDisk("default")).toBe(true);
    expect(store.loadError).toBeNull();
    expect(store.activeProfileName).toBe("default");
    vi.useRealTimers();
  });
});
