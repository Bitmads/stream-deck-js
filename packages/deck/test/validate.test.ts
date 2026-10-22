import { describe, it, expect } from "vitest";
import {
  buildDeck, defineDeck, device, encoder, ha, haAttrControl, haDial, haSlider, haToggle, icon, key, nav, panel,
  scene, strip, stripItem, text, validateDeck, type Issue, type SceneOptions, type BuiltDeck,
} from "../src/index.ts";
import { LIGHT, PLUS, sampleDeck } from "./fixtures.ts";

function deckWith(opts: SceneOptions, model = "plus"): BuiltDeck {
  return buildDeck(defineDeck({ devices: [device(PLUS, model, [scene("s", opts)])] }));
}

const errors = (issues: Issue[]) => issues.filter(i => i.level === "error").map(i => i.message);
const warnings = (issues: Issue[]) => issues.filter(i => i.level === "warning").map(i => i.message);

function expectError(issues: Issue[], re: RegExp) {
  expect(errors(issues).some(m => re.test(m)), `errors: ${JSON.stringify(errors(issues))}`).toBe(true);
}

function expectWarning(issues: Issue[], re: RegExp) {
  expect(warnings(issues).some(m => re.test(m)), `warnings: ${JSON.stringify(warnings(issues))}`).toBe(true);
}

describe("validateDeck", () => {
  it("accepts the sample deck", () => {
    expect(validateDeck(buildDeck(sampleDeck()))).toEqual([]);
  });

  it("checks key, encoder and strip bounds per model", () => {
    expectError(validateDeck(deckWith({ keys: { 8: key() } })), /key 8 does not exist on plus/);
    expectError(validateDeck(deckWith({ encoders: { 4: encoder() } })), /encoder 4 does not exist/);
    expectError(validateDeck(deckWith({ encoders: { 0: encoder() } }, "mk2")), /encoder 0 does not exist on mk2/);
    expectError(validateDeck(deckWith({ strip: strip([panel(0)]) }, "xl")), /has no touch strip/);
    expectError(validateDeck(deckWith({ strip: strip([stripItem({ x: 700, y: 0, w: 150, h: 100 })]) })), /outside the 800x100 strip/);
    expectError(validateDeck(deckWith({ strip: strip([panel(0), panel(0)]) })), /duplicate strip item id "panel-0"/);
    expectWarning(validateDeck(deckWith({ keys: { 9: key() } }, "neo")), /touch button without display/);
    expectError(validateDeck(buildDeck(defineDeck({ devices: [device(PLUS, "nope", [])] }))), /unknown device model/);
  });

  it("requires string settings, complete actions and known action ids", () => {
    const k = key({ action: haToggle(LIGHT) });
    (k.settings as Record<string, unknown>).ha_entity = 5;
    expectError(validateDeck(deckWith({ keys: { 0: k } })), /setting values must be strings/);
    const unknown = key();
    unknown.action = { id: "teleport", label: "T", icon: "", color: "#000" };
    expectError(validateDeck(deckWith({ keys: { 0: unknown } })), /Unknown action id "teleport"/);
    const partial = key();
    (partial as unknown as Record<string, unknown>).action = { id: "back" };
    expectError(validateDeck(deckWith({ keys: { 0: partial } })), /must be a string/);
    const enc = encoder();
    (enc as unknown as Record<string, unknown>).value = 5;
    expectError(validateDeck(deckWith({ encoders: { 0: enc } })), /must be a string/);
    const item = panel(0, { tap: haToggle(LIGHT) });
    delete item.tapSettings;
    expectError(validateDeck(deckWith({ strip: strip([item]) })), /only fires when its settings object exists/);
  });

  it("resolves scene references only on the same device", () => {
    expectError(validateDeck(deckWith({ keys: { 0: key({ action: nav.push("missing") }) } })), /does not match any scene slug/);
    const two = buildDeck(defineDeck({ devices: [
      device("A", "plus", [scene("a1")]),
      device("B", "plus", [scene("b1", { keys: { 0: key({ action: nav.push(scene("a1")) }) } })]),
    ] }));
    expectError(validateDeck(two), /does not match any scene slug/);
    const explicit = deckWith({ keys: { 0: key({ action: { ...nav.push("x"), settings: { sceneId: "existing-id", mode: "push" } } }) } });
    expectError(validateDeck(explicit), /Scene existing-id does not exist/);
    expect(errors(validateDeck(explicit, { sceneIdsBySerial: { [PLUS]: ["existing-id"] } }))).toEqual([]);
  });

  it("checks template syntax and filters", () => {
    const t = (s: string) => validateDeck(deckWith({ keys: { 0: key({ text: s }) } }));
    expect(t("{{$ha.light.x.state|upper}} {{$time.now}}")).toEqual([]);
    expectWarning(t("{{$x|bogus}}"), /Unknown filter "bogus"/);
    expectError(t("{{$x|map:12:00=noon:*=other}}"), /has no "="/);
    expect(errors(t("{{$x|map:12\\:00=noon:*=other}}"))).toEqual([]);
    expectError(t("{{$x|map:a=b|c:*=d}}"), /"\|" inside the map argument/);
    expectError(t("{{$x|upper"), /not closed/);
    expectError(t("{{$x|map:a=}b}}"), /Stray "\{" or "\}"/);
    expect(t("{{$stock.{{$pos|default:0|map:0=BTC:1=NVDA}}.price|default:--}}")).toEqual([]);
    expectError(t("{{$stock.{{$pos|bogus:x}}.price"), /not closed/);
    expectError(t("{{$x|replace:/[/=y}}"), /Invalid regex/);
    expectError(t("{{|upper}}"), /no variable name/);
  });

  it("checks fonts, legibility, colors and numeric fields", () => {
    expectError(validateDeck(deckWith({ keys: { 0: key({ text: text("x", { fontFamily: "Comic Sans" }) }) } })), /not in the UI font list/);
    expectWarning(validateDeck(deckWith({ keys: { 0: key({ text: text("x", { fontSize: 10 }) }) } })), /hard to read/);
    expect(validateDeck(deckWith({ keys: { 0: key({ text: text("x", { fontSize: 10, hidden: true }) }) } }))).toEqual([]);
    expectError(validateDeck(deckWith({ keys: { 0: key({ bg: "blurple" }) } })), /not a usable color/);
    expectError(validateDeck(deckWith({ encoders: { 0: encoder({ max: "lots" }) } })), /neither a number nor a template/);
    expectWarning(validateDeck(deckWith({ keys: { 0: key({ icon: [icon("tabler:bulb", { when: { variable: ha(LIGHT), value: "on" } })] }) } })), /add an unconditional icon/);
  });

  it("checks HA attribute controls per gesture", () => {
    expectError(validateDeck(deckWith({ keys: { 0: key({ action: haAttrControl(LIGHT, "brightness") }) } })), /needs a value here/);
    expect(validateDeck(deckWith({ keys: { 0: key({ action: haAttrControl(LIGHT, "brightness", 128) }) } }))).toEqual([]);
    expectError(validateDeck(deckWith({ strip: strip([haSlider(0, "humidifier.h")]) })), /cannot map a touch position/);
    expect(validateDeck(deckWith({ encoders: { 0: haDial("humidifier.h") } }))).toEqual([]);
  });

  it("checks synthetic stats.* attributes against the sensor kind", () => {
    const P = "sensor.plug_power", E = "sensor.plug_energy";
    const states = [
      { entity_id: P, state: "5", attributes: { device_class: "power", state_class: "measurement" } },
      { entity_id: E, state: "1", attributes: { device_class: "energy", state_class: "total_increasing" } },
    ];
    const ok = deckWith({ keys: { 0: key({ text: `${ha(E, "stats.month")} ${ha(P, "stats.chart_24h")} ${ha(P, "stats.avg_24h")}` }) } });
    expect(validateDeck(ok, { haStates: states })).toEqual([]);
    const bad = deckWith({ keys: { 0: key({ text: `${ha(P, "stats.month")} ${ha(E, "stats.max_24h")} ${ha(E, "stats.week")}` }) } });
    const issues = validateDeck(bad, { haStates: states });
    expectError(issues, /plug_power\.stats\.month: only energy sensors/);
    expectError(issues, /plug_energy\.stats\.max_24h: only power sensors/);
    expectError(issues, /stats\.week: unknown statistics attribute/);
  });

  it("collects watched entities and checks them against a states file", () => {
    const built = deckWith({
      keys: { 0: key({ action: haToggle("switch.ghost"), text: `${ha(LIGHT, "brightness")} ${ha(LIGHT, "effect_list")} ${ha("sensor.nope")}` }) },
    });
    expect(built.watched).toEqual([LIGHT, "sensor.nope"]);
    const issues = validateDeck(built, { haStates: [{ entity_id: LIGHT, state: "off", attributes: { effect_list: ["a"], supported_color_modes: ["xy"] } }] });
    expectError(issues, /sensor\.nope does not exist/);
    expectError(issues, /switch\.ghost does not exist/);
    expectWarning(issues, /no attribute "brightness" \(reported as 0 while the entity is off\)/);
    expect(errors(issues).some(m => /effect_list/.test(m))).toBe(false);
  });

  it("reports disabled plugins and duplicate scene ids", () => {
    const built = buildDeck(sampleDeck());
    expectWarning(validateDeck(built, { pluginStates: { "multi-action": { enabled: false } } }), /"multi-action" is disabled: its actions do nothing/);
    expectWarning(validateDeck(built, { pluginStates: { navigation: { enabled: false } } }), /"navigation" is disabled \(its actions still run/);
    const dup = buildDeck(defineDeck({ devices: [device(PLUS, "plus", [scene("a", { id: "same" }), scene("b", { id: "same" })])] }));
    expectError(validateDeck(dup), /used twice/);
    const numeric = buildDeck(defineDeck({ devices: [device(PLUS, "plus", [scene("a", { id: "42" })])] }));
    expectError(validateDeck(numeric), /integer-like/);
  });
});
