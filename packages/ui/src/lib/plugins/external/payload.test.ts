import { describe, expect, it } from "vitest";
import {
  buildAppearEvent, buildDialEvent, buildDidReceiveSettings, buildKeyEvent, commandToOverride,
  encoderCoordinates, keyCoordinates, normalizeImage, parsePluginMessage, asSettingsObject,
  type ActionRef,
} from "./payload";

const ref: ActionRef = {
  action: "com.example.counter.action",
  context: "AL12345:scene-1:Keypad:9",
  device: "AL12345",
  settings: { count: 2 },
  coordinates: keyCoordinates(9, 4),
};

describe("coordinates", () => {
  it("maps key indices row-major", () => {
    expect(keyCoordinates(0, 4)).toEqual({ column: 0, row: 0 });
    expect(keyCoordinates(9, 4)).toEqual({ column: 1, row: 2 });
    expect(keyCoordinates(14, 5)).toEqual({ column: 4, row: 2 });
    expect(keyCoordinates(3, 0)).toEqual({ column: 0, row: 3 });
  });
  it("puts encoders in one row", () => {
    expect(encoderCoordinates(2)).toEqual({ column: 2, row: 0 });
  });
});

describe("host → plugin events", () => {
  it("builds keyDown/keyUp in the Elgato shape", () => {
    expect(buildKeyEvent("keyDown", ref)).toEqual({
      event: "keyDown", action: ref.action, context: ref.context, device: "AL12345",
      payload: { settings: { count: 2 }, coordinates: { column: 1, row: 2 }, isInMultiAction: false },
    });
    expect(buildKeyEvent("keyUp", ref, { state: 1, isInMultiAction: true }).payload)
      .toEqual({ settings: { count: 2 }, coordinates: { column: 1, row: 2 }, isInMultiAction: true, state: 1 });
  });

  it("builds willAppear with controller and default state", () => {
    expect(buildAppearEvent("willAppear", ref, "Keypad")).toEqual({
      event: "willAppear", action: ref.action, context: ref.context, device: "AL12345",
      payload: { settings: { count: 2 }, coordinates: { column: 1, row: 2 }, controller: "Keypad", isInMultiAction: false, state: 0 },
    });
    const enc = { ...ref, context: "AL12345:scene-1:Encoder:1", coordinates: encoderCoordinates(1) };
    expect(buildAppearEvent("willDisappear", enc, "Encoder").payload).toEqual({
      settings: { count: 2 }, coordinates: { column: 1, row: 0 }, controller: "Encoder", isInMultiAction: false,
    });
  });

  it("builds dial events", () => {
    const enc = { ...ref, context: "AL12345:scene-1:Encoder:0", coordinates: encoderCoordinates(0) };
    expect(buildDialEvent("dialRotate", enc, -3).payload).toEqual({
      settings: { count: 2 }, coordinates: { column: 0, row: 0 }, controller: "Encoder", ticks: -3, pressed: false,
    });
    expect(buildDialEvent("dialDown", enc)).toMatchObject({ event: "dialDown", payload: { controller: "Encoder" } });
    expect(buildDialEvent("dialUp", enc).payload).not.toHaveProperty("ticks");
  });

  it("builds didReceiveSettings", () => {
    expect(buildDidReceiveSettings(ref)).toEqual({
      event: "didReceiveSettings", action: ref.action, context: ref.context, device: "AL12345",
      payload: { settings: { count: 2 }, coordinates: { column: 1, row: 2 }, isInMultiAction: false },
    });
  });
});

describe("plugin → host commands", () => {
  it("parses messages and rejects garbage", () => {
    expect(parsePluginMessage('{"event":"setTitle","context":"c","payload":{"title":"Hi"}}'))
      .toEqual({ event: "setTitle", context: "c", action: undefined, payload: { title: "Hi" } });
    expect(parsePluginMessage("nope")).toBeNull();
    expect(parsePluginMessage("[]")).toBeNull();
    expect(parsePluginMessage('{"context":"c"}')).toBeNull();
  });

  it("maps visual commands to runtime overrides", () => {
    expect(commandToOverride("setTitle", { title: "42" })).toEqual({ title: "42" });
    expect(commandToOverride("setTitle", { title: "" })).toEqual({ title: undefined });
    expect(commandToOverride("setImage", { image: "data:image/png;base64,AAA" })).toEqual({ image: "data:image/png;base64,AAA" });
    expect(commandToOverride("setImage", {})).toEqual({ image: undefined });
    expect(commandToOverride("setState", { state: 1 })).toEqual({ state: 1 });
    expect(commandToOverride("setState", { state: -1 })).toBeNull();
    expect(commandToOverride("showOk", undefined)).toEqual({ flash: "ok" });
    expect(commandToOverride("showAlert", undefined)).toEqual({ flash: "alert" });
    expect(commandToOverride("setSettings", {})).toBeNull();
  });

  it("turns raw SVG images into data URLs", () => {
    expect(normalizeImage('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))
      .toBe("data:image/svg+xml;charset=utf-8," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg"></svg>'));
    expect(normalizeImage("data:image/png;base64,AA")).toBe("data:image/png;base64,AA");
  });

  it("only accepts JSON objects as settings", () => {
    expect(asSettingsObject({ a: 1 })).toEqual({ a: 1 });
    expect(asSettingsObject([1])).toEqual({});
    expect(asSettingsObject("x")).toEqual({});
  });
});
