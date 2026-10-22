import { describe, it, expect } from "vitest";
import {
  ACTIONS, buildDeck, command, counter, encoder, ha, haAttrControl, haDial, haScript, haService, haSlider, haToggle,
  hotkey, httpRequest, icon, key, multi, nav, none, openUrl, panel, scene, sceneIdFromSlug, strip, stripItem, text,
  timer, windowTrigger, defineDeck, device,
} from "../src/index.ts";
import { uuidv5 } from "../src/uuid.ts";
import { parseSteps } from "../../ui/src/lib/plugins/multi-action/steps.ts";
import { cloneJson, normalizeProfile } from "../../ui/src/lib/utils/profile.ts";
import { LIGHT, PLUS, sampleDeck } from "./fixtures.ts";

const allStrings = (o: Record<string, unknown>) => Object.values(o).every(v => typeof v === "string");
const catalogDef = (id: string) => ACTIONS.find(a => a.def.id === id)!.def;

describe("action builders", () => {
  it("copy the plugin ActionDef and use string settings", () => {
    const specs = [
      haToggle(LIGHT), haScript("script.x"), haService("light", "turn_on", LIGHT, { brightness: 10 }),
      haAttrControl(LIGHT, "brightness", 128), nav.push("a"), nav.back(), hotkey("ctrl+shift+t"), command("echo"),
      openUrl("https://x"), httpRequest("https://x"), timer(5), counter(), multi([haToggle(LIGHT)]),
    ];
    for (const s of specs) {
      expect(s.action).toEqual(catalogDef(s.action.id));
      expect(allStrings(s.settings)).toBe(true);
    }
    expect(none()).toEqual({ action: { id: "none", label: "None", icon: "", color: "#333" }, settings: {} });
  });

  it("build HA settings like the UI entity picker", () => {
    expect(haToggle(LIGHT).settings).toEqual({ ha_entity: LIGHT, ha_domain: "light", ha_service: "toggle", ha_control: "toggle", ha_attr: "" });
    expect(haScript("script.night").settings).toMatchObject({ ha_domain: "script", ha_service: "turn_on", ha_entity: "script.night" });
    expect(JSON.parse(haService("light", "turn_on", LIGHT, { brightness: 10 }).settings.ha_service_data)).toEqual({ brightness: 10 });
    expect(haAttrControl(LIGHT, "brightness", 128).settings).toEqual({
      ha_entity: LIGHT, ha_domain: "light", ha_service: "turn_on", ha_control: "brightness", ha_attr: "brightness", value: "128",
    });
    expect(() => haToggle("nodot")).toThrow(/entity id/);
    expect(() => haScript("light.x")).toThrow(/script/);
  });

  it("splits hotkeys and serializes multi-action steps", () => {
    expect(hotkey("ctrl+shift+t").settings).toEqual({ key: "t", modifiers: "ctrl, shift" });
    expect(hotkey("F5").settings).toEqual({ key: "F5", modifiers: "" });
    const steps = parseSteps(multi([haToggle(LIGHT), { action: nav.back(), delayMs: 250 }]).settings.steps);
    expect(steps).toEqual([
      { actionId: "ha-service", actionLabel: "HA Service Call", settings: haToggle(LIGHT).settings, delayMs: 0 },
      { actionId: "back", actionLabel: "Back (Previous Scene)", settings: {}, delayMs: 250 },
    ]);
  });
});

describe("key / text / encoder / strip builders", () => {
  it("key() writes canonical texts/icons and their legacy mirrors", () => {
    const k = key({ action: haToggle(LIGHT), bg: "#101010", text: ["A", text("B", { fontSize: 20 })], icon: ["tabler:bulb", icon("tabler:bulb-off")] });
    expect(k.texts!.map(t => t.text)).toEqual(["A", "B"]);
    expect(k.text).toEqual(k.texts![0]);
    expect(k.text).not.toBe(k.texts![0]);
    expect(k.icons!.map(i => i.iconName)).toEqual(["bulb", "bulb-off"]);
    expect(k.icon).toEqual(k.icons![0]);
    expect(k.backgroundColor).toBe("#101010");
    const empty = key();
    expect(empty).toEqual({ action: none().action, settings: {}, backgroundColor: "#000000" });
  });

  it("text() uses the UI defaults", () => {
    expect(text("x")).toEqual({ text: "x", fontFamily: "sans-serif", fontSize: 14, fontWeight: "normal", fontStyle: "normal",
      color: "#ffffff", hAlign: "center", vAlign: "middle", anchor: "center", useAbsolutePos: false });
  });

  it("haDial uses the client control ranges per domain", () => {
    const light = haDial(LIGHT);
    expect(light).toMatchObject({ value: `{{$ha.${LIGHT}.brightness}}`, min: "0", max: "255", step: 5 });
    expect(light.rotateSettings).toEqual({ ha_entity: LIGHT, ha_domain: "light", ha_service: "turn_on", ha_control: "brightness", ha_attr: "brightness" });
    expect(light.pressSettings.ha_service).toBe("toggle");
    const hum = haDial("humidifier.h");
    expect(hum).toMatchObject({ value: "{{$ha.humidifier.h.humidity}}", min: "0", max: "100", step: 1 });
    expect(hum.rotateSettings).toMatchObject({ ha_service: "set_humidity", ha_attr: "humidity" });
    const vol = haDial("media_player.tv");
    expect(vol).toMatchObject({ value: "{{$ha.media_player.tv.volume_level}}", min: "0", max: "1", step: 0.05 });
    expect(vol.rotateSettings).toMatchObject({ ha_service: "volume_set", ha_attr: "volume_level" });
    expect(haDial("cover.c").value).toBe("{{$ha.cover.c.current_position}}");
    expect(haDial("number.n").value).toBe("{{$ha.number.n.state}}");
    expect(() => haDial("switch.s")).toThrow(/no default control/);
    const plain = encoder();
    expect(plain).toMatchObject({ value: "0", min: "0", max: "100", step: 1, label: "" });
    expect(plain.rotateAction.id).toBe("none");
  });

  it("panel(i) spans 200 px per encoder and gestures always carry settings", () => {
    const p = panel(2, { tap: haToggle(LIGHT), longPress: nav.back(), swipe: none() });
    expect(p).toMatchObject({ id: "panel-2", x: 400, y: 0, w: 200, h: 100 });
    expect(p.tapSettings).toEqual(haToggle(LIGHT).settings);
    expect(p.longPressSettings).toEqual({});
    expect(p.swipeSettings).toEqual({});
    expect(() => panel(4)).toThrow();
    const s = haSlider(1, LIGHT);
    expect(s.bar).toMatchObject({ value: `{{$ha.${LIGHT}.brightness}}`, min: "0", max: "255", position: "full" });
    expect(s.tapSettings).toMatchObject({ ha_attr: "brightness" });
    expect(s.tapSettings!.value).toBeUndefined();
    expect(s.longPressSettings).toMatchObject({ ha_service: "toggle" });
    expect(stripItem({ x: 10, y: 5, w: 50, h: 20 }).id).toBe("item-10-5-50x20");
    expect(strip([p]).backgroundColor).toBe("#0a0a1a");
  });
});

describe("scenes and ids", () => {
  it("derives deterministic UUIDv5 ids from slugs unless an id is given", () => {
    expect(uuidv5("www.example.com", "6ba7b810-9dad-11d1-80b4-00c04fd430c8")).toBe("2ed6657d-e927-568b-95e1-2665a8aea6a2");
    expect(scene("home").scene.id).toBe(sceneIdFromSlug("home"));
    expect(scene("home").scene.id).toBe(scene("home").scene.id);
    expect(scene("home").scene.id).not.toBe(scene("other").scene.id);
    expect(scene("home", { id: "fixed-id" }).scene.id).toBe("fixed-id");
    expect(scene("home").scene.triggers).toEqual([{ type: "manual" }]);
    expect(() => scene("Bad Slug")).toThrow(/slug/);
  });

  it("windowTrigger needs app or title", () => {
    expect(windowTrigger({ app: "vlc", priority: 3 })).toEqual({ type: "window", app_name: "vlc", priority: 3 });
    expect(() => windowTrigger({})).toThrow(/never fires/);
  });

  it("buildDeck resolves scene references (also inside multi-action steps) and collects entities/plugins", () => {
    const built = buildDeck(sampleDeck());
    const dev = built.devices[0];
    const home = dev.scenes[0];
    const subId = sceneIdFromSlug("sub");
    expect(home.keys["1"].settings).toEqual({ sceneId: subId, mode: "push" });
    const steps = parseSteps(home.keys["2"].settings.steps);
    expect(steps[1].settings).toEqual({ sceneId: subId, mode: "switch" });
    expect(built.watched).toEqual([LIGHT]);
    expect(built.requiredPlugins).toEqual(["homeassistant", "multi-action", "navigation"]);
    expect(dev.model?.id).toBe("plus");
  });

  it("produces scenes the app's normalizer leaves unchanged", () => {
    const built = buildDeck(sampleDeck());
    const devices = { [PLUS]: { scenes: Object.fromEntries(built.devices[0].scenes.map(s => [s.id, s])), activeSceneId: built.devices[0].scenes[0].id } };
    const before = JSON.stringify(devices);
    const normalized = normalizeProfile(cloneJson({ name: "x", devices, favorites: [], recent: [] }));
    expect(JSON.stringify(normalized.devices)).toBe(before);
  });

  it("ha() builds variable templates", () => {
    expect(ha("sensor.t")).toBe("{{$ha.sensor.t.state}}");
    expect(ha("sensor.t", "state", "round1|default:--")).toBe("{{$ha.sensor.t.state|round1|default:--}}");
  });

  it("device() and defineDeck() keep the deck shape", () => {
    const d = defineDeck({ devices: [device("S", "mk2", [], { brightness: 50 })], watch: ["sensor.x"] });
    expect(d.devices[0]).toEqual({ serial: "S", model: "mk2", scenes: [], brightness: 50 });
  });
});
