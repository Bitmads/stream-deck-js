import { describe, expect, it } from "vitest";
import { DEPTH_KEY, MAX_DEPTH, depthOf, parseSteps, serializeSteps, stepSettings } from "./steps";

describe("parseSteps", () => {
  it("returns no steps for empty input", () => {
    expect(parseSteps(undefined)).toEqual([]);
    expect(parseSteps("")).toEqual([]);
    expect(parseSteps("   ")).toEqual([]);
  });

  it("parses the stored UI format", () => {
    const json = JSON.stringify([
      { actionId: "hotkey", actionLabel: "Hotkey", settings: { key: "F5", modifiers: "ctrl" }, delayMs: 200 },
      { actionId: "switch-scene", actionLabel: "Switch Scene", settings: { sceneId: "abc", mode: "push" }, delayMs: 0 },
    ]);
    expect(parseSteps(json)).toEqual([
      { actionId: "hotkey", actionLabel: "Hotkey", settings: { key: "F5", modifiers: "ctrl" }, delayMs: 200 },
      { actionId: "switch-scene", actionLabel: "Switch Scene", settings: { sceneId: "abc", mode: "push" }, delayMs: 0 },
    ]);
  });

  it("accepts legacy actionType, stringifies settings and normalizes delays", () => {
    const json = JSON.stringify([{ actionType: "counter", settings: { value: 3, obj: { a: 1 }, n: null }, delayMs: "-5" }]);
    expect(parseSteps(json)).toEqual([
      { actionId: "counter", actionLabel: "counter", settings: { value: "3", obj: '{"a":1}', n: "" }, delayMs: 0 },
    ]);
  });

  it("keeps template text untouched (resolution happens per value at execution)", () => {
    const json = JSON.stringify([{ actionId: "command", settings: { command: 'echo {{$window.title}}' }, delayMs: 0 }]);
    expect(parseSteps(json)[0].settings.command).toBe("echo {{$window.title}}");
  });

  it("throws descriptive errors for invalid input", () => {
    expect(() => parseSteps("{not json")).toThrow(/not valid JSON/);
    expect(() => parseSteps('{"a":1}')).toThrow(/must be a JSON array/);
    expect(() => parseSteps("[1]")).toThrow(/step 1 is not an object/);
    expect(() => parseSteps('[{"settings":{}}]')).toThrow(/step 1 has no actionId/);
  });

  it("round-trips through serializeSteps", () => {
    const steps = [{ actionId: "http-request", actionLabel: "HTTP", settings: { url: "http://x", body: '{"q":"\\""}' }, delayMs: 150 }];
    expect(parseSteps(serializeSteps(steps))).toEqual(steps);
  });
});

describe("nesting depth", () => {
  it("defaults to 0 and reads the depth key", () => {
    expect(depthOf({})).toBe(0);
    expect(depthOf({ [DEPTH_KEY]: "2" })).toBe(2);
    expect(depthOf({ [DEPTH_KEY]: "junk" })).toBe(0);
  });

  it("increments depth only for nested multi-actions, per execution", () => {
    const nested = { actionId: "multi-action", actionLabel: "MA", settings: { steps: "[]" }, delayMs: 0 };
    const plain = { actionId: "hotkey", actionLabel: "Hotkey", settings: { key: "a" }, delayMs: 0 };
    expect(stepSettings(nested, 1)).toEqual({ steps: "[]", [DEPTH_KEY]: "2" });
    expect(stepSettings(plain, 3)).toEqual({ key: "a" });
    expect(MAX_DEPTH).toBeGreaterThan(1);
  });
});
