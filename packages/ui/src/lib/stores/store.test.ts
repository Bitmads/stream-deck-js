import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";

// ── Minimal browser + Tauri environment for the store ─────────────────────────
const h = vi.hoisted(() => {
  const g = globalThis as any;
  g.window = g;
  g.addEventListener = () => {};
  g.document = { addEventListener: () => {}, visibilityState: "visible" };
  const files: Record<string, string> = {};
  const calls: { cmd: string; args: any }[] = [];
  const devices: any[] = [];
  const listeners: Record<string, (e: { payload: any }) => void> = {};
  return { files, calls, devices, listeners };
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
      case "delete_json_file": delete h.files[args.filename]; return null;
      case "list_devices": return h.devices.map(d => ({ ...d })); // fresh objects, as over IPC
      default: return null;
    }
  }),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, cb: (e: { payload: any }) => void) => { h.listeners[name] = cb; return () => {}; }),
}));

import { store, registerActionType, unregisterActionType } from "./store.svelte";

const fixture = readFileSync(new URL("../utils/__fixtures__/profile_default.redacted.json", import.meta.url), "utf8");
const PLUS = "TESTSERIAL01";
const OTHER = "TESTSERIAL02";
const dev = (serial: string, extra: object = {}) => ({
  serial, model: "Deck", model_id: "x", columns: 5, rows: 3, key_size: 72, has_lcd_strip: false,
  has_dials: false, encoder_count: 0, lcd_width: 0, lcd_height: 0, ...extra,
});

function saves(name = "profile_default") {
  return h.calls.filter(c => c.cmd === "save_json_file" && c.args.filename === name);
}

async function boot(profileJson: string | null = fixture, extraFiles: Record<string, string> = {}) {
  for (const k of Object.keys(h.files)) delete h.files[k];
  if (profileJson !== null) h.files.profile_default = profileJson;
  Object.assign(h.files, extraFiles);
  h.calls.length = 0;
  h.devices.length = 0;
  h.devices.push(dev(PLUS, { columns: 4, rows: 2, key_size: 120, has_lcd_strip: true, has_dials: true, encoder_count: 4, lcd_width: 800, lcd_height: 100 }), dev(OTHER));
  (globalThis as any).__osd_initialized = false;
  // Reset device state between tests (the store is a singleton).
  store.devices = [];
  store.selectedDevice = null;
  store.boundSerial = null;
  await store.initStore();
  await store.refreshDevices();
}

beforeEach(() => {
  vi.useRealTimers();
});

describe("profile load", () => {
  it("loads the live-profile fixture and binds the first device", async () => {
    await boot();
    expect(store.loadError).toBeNull();
    expect(store.boundSerial).toBe(PLUS);
    expect(store.getKeyAssignment(2)?.text?.text).toContain("f2c|round1");
    expect(store.getEncoderConfigForDevice(PLUS, 0)?.step).toBe(5);
    expect(h.calls.filter(c => c.cmd === "open_device").map(c => c.args.serial)).toEqual([PLUS, OTHER]);
  });

  it("does not save just because it loaded", async () => {
    vi.useFakeTimers();
    await boot();
    await vi.advanceTimersByTimeAsync(2000);
    expect(saves()).toHaveLength(0);
  });

  it("a broken profile at startup is never overwritten", async () => {
    vi.useFakeTimers();
    await boot("{ not json");
    expect(store.loadError).toMatch(/Invalid JSON/);
    store.createScene("x");
    store.setKeyBackgroundColor(0, "#ff0000");
    await vi.advanceTimersByTimeAsync(2000);
    expect(saves()).toHaveLength(0);
    expect(h.files.profile_default).toBe("{ not json");
  });

  it("uses app_settings.activeProfile at startup", async () => {
    await boot(fixture, {
      app_settings: JSON.stringify({ activeProfile: "work", apiBind: "0.0.0.0" }),
      profile_work: JSON.stringify({ name: "work", devices: {}, favorites: ["back"], recent: [] }),
    });
    expect(store.activeProfileName).toBe("work");
    expect(store.favoriteActions).toEqual(["back"]);
  });

  it("falls back to default when the remembered profile is gone", async () => {
    await boot(fixture, { app_settings: JSON.stringify({ activeProfile: "gone" }) });
    expect(store.activeProfileName).toBe("default");
    expect(store.getKeyAssignment(4)?.backgroundColor).toBe("#e01b24");
  });

  it("switching profiles saves pending edits first and remembers the new profile", async () => {
    vi.useFakeTimers();
    await boot(fixture, {
      app_settings: JSON.stringify({ apiBind: "127.0.0.1" }),
      profile_work: JSON.stringify({ name: "work", devices: {}, favorites: [], recent: [] }),
    });
    store.setKeyBackgroundColor(0, "#0000ff");
    expect(await store.loadProfile("work")).toBe(true);
    expect(JSON.stringify(JSON.parse(h.files.profile_default))).toContain("#0000ff");
    expect(JSON.parse(h.files.app_settings)).toEqual({ apiBind: "127.0.0.1", activeProfile: "work" });
    expect(store.getKeyAssignment(0)).toBeUndefined();
  });
});

describe("reloadProfileFromDisk", () => {
  it("keeps state, sets loadError and does not save on a bad file", async () => {
    vi.useFakeTimers();
    await boot();
    store.setKeyBackgroundColor(0, "#123456"); // pending debounced save
    h.files.profile_default = JSON.stringify({ devices: { X: { scenes: { a: { keys: { "0": {} } } } } } });
    const ok = await store.reloadProfileFromDisk("default");
    expect(ok).toBe(false);
    expect(store.loadError).toMatch(/missing action/);
    expect(store.getKeyAssignment(0)?.backgroundColor).toBe("#123456");
    await vi.advanceTimersByTimeAsync(2000);
    expect(saves()).toHaveLength(0);
  });

  it("replaces state, cancels the pending save and resyncs devices", async () => {
    vi.useFakeTimers();
    await boot();
    store.setKeyBackgroundColor(0, "#123456");
    const epochBefore = store.deviceEpochs[PLUS];
    const next = JSON.parse(fixture);
    const plusScene = Object.values<any>(next.devices[PLUS].scenes)[0];
    plusScene.keys["0"].backgroundColor = "#abcdef";
    h.files.profile_default = JSON.stringify(next);
    expect(await store.reloadProfileFromDisk("default")).toBe(true);
    expect(store.loadError).toBeNull();
    expect(store.getKeyAssignment(0)?.backgroundColor).toBe("#abcdef");
    expect(store.deviceEpochs[PLUS]).toBeGreaterThan(epochBefore);
    await vi.advanceTimersByTimeAsync(2000);
    expect(saves()).toHaveLength(0);
    expect(JSON.parse(h.files.profile_default)).toEqual(next);
  });
});

describe("autosave vs. external writes", () => {
  it("a pending autosave never overwrites a profile replaced on disk (API PUT); the file wins", async () => {
    vi.useFakeTimers();
    await boot();
    store.lastError = null;
    store.setKeyBackgroundColor(0, "#123456"); // pending debounced save
    const next = JSON.parse(fixture);
    Object.values<any>(next.devices[PLUS].scenes)[0].keys["0"].backgroundColor = "#00ff00";
    h.files.profile_default = JSON.stringify(next); // PUT wrote the file; profile-reload not yet seen
    await vi.advanceTimersByTimeAsync(2000); // the debounced save fires in that gap
    expect(JSON.parse(h.files.profile_default)).toEqual(next);
    expect(store.getKeyAssignment(0)?.backgroundColor).toBe("#00ff00");
    expect(store.lastError).toBeNull();
  });

  it("saves normally when nobody else changed the file", async () => {
    vi.useFakeTimers();
    await boot();
    store.setKeyBackgroundColor(0, "#123456");
    await vi.advanceTimersByTimeAsync(1000);
    store.setKeyBackgroundColor(0, "#654321");
    await vi.advanceTimersByTimeAsync(1000);
    expect(saves()).toHaveLength(2);
    expect(h.files.profile_default).toContain("#654321");
  });
});

describe("device reopen", () => {
  it("repaints a deck whose handle was reopened even when the serial list is unchanged", async () => {
    await boot();
    const before = store.deviceEpochs[PLUS];
    const otherBefore = store.deviceEpochs[OTHER];
    await store.refreshDevices();
    expect(store.deviceEpochs[PLUS]).toBe(before);
    h.devices[0] = { ...h.devices[0], open_generation: (h.devices[0].open_generation ?? 0) + 1 };
    await store.refreshDevices();
    expect(store.deviceEpochs[PLUS]).toBe(before + 1);
    expect(store.deviceEpochs[OTHER]).toBe(otherBefore);
  });
});

describe("pinned keys", () => {
  it("are shown in other scenes without being copied or persisted", async () => {
    vi.useFakeTimers();
    await boot();
    await store.selectDevice(store.devices[1]);
    expect(store.boundSerial).toBe(OTHER);
    const home = store.getActiveSceneId()!;
    const s2 = store.createScene("Second");
    store.pushScene(s2.id);
    expect(store.getActiveSceneId()).toBe(s2.id);
    expect(store.getKeyAssignment(14)?.texts?.[0].text).toBe("PIN");
    expect(store.isPinnedOverlay(14)).toBe(true);
    expect(store.getActiveScene()!.keys["14"]).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1000);
    const saved = JSON.parse(h.files.profile_default);
    expect(Object.keys(saved.devices[OTHER].scenes[s2.id].keys)).toEqual([]);
    // Unpinning removes it everywhere at once.
    store.togglePinned(14);
    expect(store.getKeyAssignment(14)).toBeUndefined();
    store.popScene();
    expect(store.getActiveSceneId()).toBe(home);
    expect(store.getKeyAssignment(14)?.pinned).toBe(false);
  });
});

describe("scenes", () => {
  it("duplicateScene deep-copies keys, encoders, strip and triggers, and saves", async () => {
    vi.useFakeTimers();
    await boot();
    const src = store.getActiveScene()!;
    const copy = store.duplicateScene(src.id)!;
    expect(copy.id).not.toBe(src.id);
    expect(copy.encoders?.["0"].step).toBe(5);
    expect(copy.strip?.items.length).toBe(src.strip?.items.length);
    expect(copy.triggers).toEqual(src.triggers);
    copy.keys["0"].backgroundColor = "#000001";
    expect(src.keys["0"].backgroundColor).not.toBe("#000001");
    await vi.advanceTimersByTimeAsync(1000);
    expect(saves().length).toBe(1);
  });

  it("deleting a scene removes it from the back stack", async () => {
    await boot();
    const a = store.getActiveSceneId()!;
    const b = store.createScene("B");
    const c = store.createScene("C");
    store.pushScene(b.id);
    store.pushScene(c.id);
    store.deleteScene(b.id);
    store.popScene();
    expect(store.getActiveSceneId()).toBe(a);
  });

  it("undo restores into the scene it came from, across scene switches", async () => {
    await boot();
    const a = store.getActiveSceneId()!;
    store.clearKey(4);
    expect(store.getKeyAssignment(4)).toBeUndefined();
    const b = store.createScene("B");
    store.switchScene(b.id);
    store.undo();
    expect(store.getActiveSceneId()).toBe(a);
    expect(store.getKeyAssignment(4)?.backgroundColor).toBe("#e01b24");
    store.redo();
    expect(store.getKeyAssignment(4)).toBeUndefined();
  });

  it("assignAction keeps imageUrl, imageFit and pinned", async () => {
    await boot();
    const before = store.getKeyAssignment(3)!;
    store.assignAction(3, { id: "counter", label: "Counter", icon: "#", color: "#e91e63" });
    const after = store.getKeyAssignment(3)!;
    expect(after.action.id).toBe("counter");
    expect(after.imageUrl).toBe(before.imageUrl);
    expect(after.imageFit).toBe("cover");
    expect(after.settings).toEqual({ value: "0" });
  });

  it("createProfile starts clean (no other devices, no recents) and becomes the active profile", async () => {
    await boot();
    await store.createProfile("fresh");
    const saved = JSON.parse(h.files.profile_fresh);
    expect(saved.recent).toEqual([]);
    for (const d of Object.values<any>(saved.devices)) {
      const scenes = Object.values<any>(d.scenes);
      expect(scenes).toHaveLength(1);
      expect(scenes[0].keys).toEqual({});
    }
    expect(JSON.parse(h.files.app_settings).activeProfile).toBe("fresh");
  });
});

describe("executeAction", () => {
  it("resolves templates per value and shell-quotes variables in commands", async () => {
    await boot();
    const seen: Record<string, string>[] = [];
    registerActionType({ id: "command", label: "Cmd", icon: "", color: "" }, async (s) => { seen.push(s); });
    store.setVariableLocal("t", "a'; rm -rf ~ #");
    await store.executeAction("command", { command: "notify-send {{$t}}", other: "{{$t}}" });
    expect(seen[0].command).toBe("notify-send 'a'\\''; rm -rf ~ #'");
    expect(seen[0].other).toBe("a'; rm -rf ~ #");
    unregisterActionType("command");
  });

  it("never resolves templates inside multi-action steps JSON", async () => {
    await boot();
    let got = "";
    registerActionType({ id: "multi-action", label: "M", icon: "", color: "" }, async (s) => { got = s.steps; });
    store.setVariableLocal("q", "\"quoted\"");
    const steps = JSON.stringify([{ actionId: "x", actionLabel: "x", settings: { v: "{{$q}}" }, delayMs: 0 }]);
    await store.executeAction("multi-action", { steps });
    expect(got).toBe(steps);
    unregisterActionType("multi-action");
  });

  it("unknown actions throw and are surfaced in lastError", async () => {
    await boot();
    await expect(store.executeAction("nope", {})).rejects.toThrow(/Unknown action/);
    expect(store.lastError).toMatch(/nope/);
  });

  it("navigation acts on the device that triggered it", async () => {
    await boot();
    expect(store.boundSerial).toBe(PLUS);
    const otherHome = store.getActiveSceneId(OTHER);
    await store.selectDevice(store.devices[1]);
    const s2 = store.createScene("Two");
    await store.selectDevice(store.devices[0]);
    await store.executeAction("switch-scene", { sceneId: s2.id, mode: "push" }, { serial: OTHER });
    expect(store.getActiveSceneId(OTHER)).toBe(s2.id);
    await store.executeAction("back", {}, { serial: OTHER });
    expect(store.getActiveSceneId(OTHER)).toBe(otherHome);
    expect(store.boundSerial).toBe(PLUS);
  });

  it("timer shows via a runtime override, never touches the label, and stops on scene switch", async () => {
    vi.useFakeTimers();
    await boot();
    const sceneId = store.getActiveSceneId(PLUS)!;
    const label = JSON.stringify(store.getKeyAssignment(4));
    await store.executeAction("timer", { duration: "3" }, { serial: PLUS, sceneId, keyIndex: 4 });
    const ctx = store.makeContext(PLUS, sceneId, "Keypad", 4);
    expect(store.runtimeOverrides[ctx]?.title).toBe("3");
    await vi.advanceTimersByTimeAsync(1000);
    expect(store.runtimeOverrides[ctx]?.title).toBe("2");
    expect(JSON.stringify(store.getKeyAssignment(4))).toBe(label);
    const other = store.createScene("Other");
    store.switchScene(other.id);
    expect(store.runtimeOverrides[ctx]).toBeUndefined();
    await vi.advanceTimersByTimeAsync(5000);
    expect(store.runtimeOverrides[ctx]).toBeUndefined();
  });

  it("counter persists its value in settings and shows it as the title", async () => {
    await boot();
    const sceneId = store.getActiveSceneId(PLUS)!;
    store.assignAction(6, { id: "counter", label: "Counter", icon: "#", color: "" });
    await store.executeAction("counter", store.getKeyAssignment(6)!.settings, { serial: PLUS, sceneId, keyIndex: 6 });
    await store.executeAction("counter", store.getKeyAssignment(6)!.settings, { serial: PLUS, sceneId, keyIndex: 6 });
    expect(store.getKeyAssignment(6)!.settings.value).toBe("2");
    expect(store.getKeyOverride(PLUS, sceneId, 6, store.getKeyAssignment(6))?.title).toBe("2");
    expect(store.getKeyAssignment(6)!.texts?.[0].text).toBe("Kitchen");
  });
});

describe("HA JSON settings", () => {
  it("passes ha_service_data / ha_custom_json raw so executors resolve per value", async () => {
    await boot();
    const got: Record<string, string>[] = [];
    registerActionType({ id: "ha-service", label: "S", icon: "", color: "" }, async (s) => { got.push(s); });
    registerActionType({ id: "ha-custom", label: "C", icon: "", color: "" }, async (s) => { got.push(s); });
    store.setVariableLocal("q", "\"quoted\"");
    const data = '{"message": "{{$q}}"}';
    await store.executeAction("ha-service", { ha_entity: "{{$q}}", ha_service_data: data });
    await store.executeAction("ha-custom", { ha_custom_json: data });
    expect(got[0].ha_service_data).toBe(data);
    expect(got[0].ha_entity).toBe("\"quoted\"");
    expect(got[1].ha_custom_json).toBe(data);
    unregisterActionType("ha-service");
    unregisterActionType("ha-custom");
  });
});

describe("brightness", () => {
  it("is saved per device and applied when the device opens or the profile reloads", async () => {
    vi.useFakeTimers();
    await boot();
    expect(store.getDeviceBrightness(OTHER)).toBeUndefined();
    expect(h.calls.filter(c => c.cmd === "set_brightness")).toHaveLength(0);
    await store.setDeviceBrightness(OTHER, 140);
    expect(store.getDeviceBrightness(OTHER)).toBe(100);
    expect(h.calls.filter(c => c.cmd === "set_brightness").map(c => c.args)).toEqual([{ serial: OTHER, percent: 100 }]);
    await vi.advanceTimersByTimeAsync(2000);
    expect(JSON.parse(h.files.profile_default).devices[OTHER].brightness).toBe(100);
    expect(JSON.parse(h.files.profile_default).devices[PLUS].brightness).toBeUndefined();

    h.calls.length = 0;
    expect(await store.reloadProfileFromDisk("default")).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.calls.filter(c => c.cmd === "set_brightness").map(c => c.args)).toEqual([{ serial: OTHER, percent: 100 }]);
  });

  it("rejects an out-of-range brightness in a profile file", async () => {
    await boot();
    const bad = JSON.parse(fixture);
    bad.devices[PLUS].brightness = "bright";
    h.files.profile_default = JSON.stringify(bad);
    expect(await store.reloadProfileFromDisk("default")).toBe(false);
    expect(store.loadError).toMatch(/brightness/);
  });
});

describe("plugin contexts", () => {
  it("setPluginSettings/getPluginSettings round-trip via settings.pluginSettings", async () => {
    await boot();
    const ctx = store.makeContext(PLUS, store.getActiveSceneId(PLUS)!, "Keypad", 4);
    expect(store.getPluginSettings(ctx)).toEqual({});
    store.setPluginSettings(ctx, { symbol: "BTC" });
    expect(store.getKeyAssignment(4)!.settings.pluginSettings).toBe('{"symbol":"BTC"}');
    expect(store.getPluginSettings(ctx)).toEqual({ symbol: "BTC" });
    expect(store.parseContext(ctx)?.index).toBe(4);
  });

  it("setRuntimeOverride merges and removes fields set to undefined", async () => {
    await boot();
    store.setRuntimeOverride("c", { title: "a", flash: "ok" });
    store.setRuntimeOverride("c", { flash: undefined });
    expect(store.runtimeOverrides.c).toEqual({ title: "a" });
    store.clearRuntimeOverride("c");
    expect(store.runtimeOverrides.c).toBeUndefined();
  });
});

describe("encoders", () => {
  it("accumulates deltas for the debounced rotate action and moves literal values on any device", async () => {
    vi.useFakeTimers();
    await boot();
    const seen: Record<string, string>[] = [];
    registerActionType({ id: "rot", label: "rot", icon: "", color: "" }, async (s) => { seen.push(s); });
    const scene = store.getActiveScene(PLUS)!;
    scene.encoders!["1"] = { ...scene.encoders!["1"], rotateAction: { id: "rot", label: "rot", icon: "", color: "" }, value: "10", step: 2 };
    await store.selectDevice(store.devices[1]); // PLUS is no longer the selected device
    for (let i = 0; i < 5; i++) store.handleEncoderRotateForDevice(PLUS, 1, 1);
    await vi.advanceTimersByTimeAsync(100);
    expect(seen).toHaveLength(1);
    expect(seen[0].delta).toBe("5");
    expect(seen[0].value).toBe("20");
    expect(store.getEncoderConfigForDevice(PLUS, 1)!.value).toBe("20");
    unregisterActionType("rot");
  });
});

describe("variables", () => {
  it("echo suppression applies the latest remote value after the window", async () => {
    vi.useFakeTimers();
    await boot();
    store.setVariable("ha.x", "37");
    store.setVariableLocal("ha.x", "36");
    expect(store.getVariable("ha.x")).toBe("37");
    await vi.advanceTimersByTimeAsync(600);
    expect(store.getVariable("ha.x")).toBe("36");
  });

  it("removes a variable on the backend's variable-deleted event", async () => {
    await boot();
    store.initVariables();
    store.setVariableLocal("api.gone", "1");
    expect(store.getVariable("api.gone")).toBe("1");
    h.listeners["variable-deleted"]({ payload: { name: "api.gone" } });
    expect(store.variables["api.gone"]).toBeUndefined();
  });
});

describe("strip swipes", () => {
  it("belong to the item they start on, even when they overshoot into a neighbour", async () => {
    await boot();
    const seen: { item: string; to_ratio: string }[] = [];
    registerActionType({ id: "sw", label: "sw", icon: "", color: "" }, async (s) => { seen.push({ item: s.item, to_ratio: s.to_ratio }); });
    const sw = { id: "sw", label: "sw", icon: "", color: "" };
    const scene = store.getActiveScene(PLUS)!;
    scene.strip = {
      backgroundColor: "#000000",
      items: [
        { id: "a", x: 0, y: 0, w: 200, h: 100, swipeAction: sw, swipeSettings: { item: "a" } },
        { id: "b", x: 200, y: 0, w: 200, h: 100 }, // no swipe action
        { id: "c", x: 400, y: 0, w: 200, h: 100, swipeAction: sw, swipeSettings: { item: "c" } },
      ],
    };
    store.handleStripSwipeForDevice(PLUS, 201, 50, 450, 50); // starts on b: nothing, never c
    store.handleStripSwipeForDevice(PLUS, 20, 50, 260, 50); // starts on a, overshoots into b
    store.handleStripSwipeForDevice(PLUS, 590, 50, 420, 50);
    await Promise.resolve();
    expect(seen).toEqual([{ item: "a", to_ratio: "1" }, { item: "c", to_ratio: "0.1" }]);
    unregisterActionType("sw");
  });
});

describe("window triggers", () => {
  it("switch scenes on every device, not only the edited one, and fall back per device", async () => {
    await boot();
    expect(store.boundSerial).toBe(PLUS);
    const plusHome = store.getActiveSceneId(PLUS)!;
    const otherHome = store.getActiveSceneId(OTHER)!;
    await store.selectDevice(store.devices[1]);
    const ide = store.createScene("IDE");
    ide.triggers = [{ type: "window", app_name: "regex:^jetbrains-phpstorm$", priority: 10 }];
    const loose = store.createScene("Loose");
    loose.triggers = [{ type: "window", app_name: "phpstorm", priority: 1 }];
    await store.selectDevice(store.devices[0]); // the PLUS deck is edited, OTHER owns the triggers

    store.applyWindowTriggers("jetbrains-phpstorm", "project – main.php");
    expect(store.getActiveSceneId(OTHER)).toBe(ide.id); // highest priority wins
    expect(store.getActiveSceneId(PLUS)).toBe(plusHome); // no triggers there: untouched

    store.applyWindowTriggers("Open Stream Deck", "Open Stream Deck"); // ignored window: no change
    expect(store.getActiveSceneId(OTHER)).toBe(ide.id);

    store.applyWindowTriggers("Google-chrome", "New Tab");
    expect(store.getActiveSceneId(OTHER)).toBe(otherHome); // nothing matches: back to the first scene

    // A manual switch after a trigger is kept when the next window matches nothing.
    store.applyWindowTriggers("jetbrains-phpstorm", "x");
    store.switchScene(loose.id, false, OTHER);
    store.applyWindowTriggers("Google-chrome", "y");
    expect(store.getActiveSceneId(OTHER)).toBe(loose.id);
  });
});
