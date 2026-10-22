import { describe, it, expect } from "vitest";
import { makeContext, parseContext } from "./context";

describe("context ids", () => {
  it("make/parse round-trip", () => {
    const ctx = makeContext("TESTSERIAL01", "f8a1de57-e30c-4032-9467-8296b066a951", "Keypad", 3);
    expect(ctx).toBe("TESTSERIAL01:f8a1de57-e30c-4032-9467-8296b066a951:Keypad:3");
    expect(parseContext(ctx)).toEqual({
      serial: "TESTSERIAL01", sceneId: "f8a1de57-e30c-4032-9467-8296b066a951", controller: "Keypad", index: 3,
    });
  });
  it("encoders", () => {
    expect(parseContext(makeContext("S", "scene", "Encoder", 0))).toEqual({ serial: "S", sceneId: "scene", controller: "Encoder", index: 0 });
  });
  it("scene ids containing ':' round-trip", () => {
    expect(parseContext(makeContext("S", "a:b", "Keypad", 12))).toEqual({ serial: "S", sceneId: "a:b", controller: "Keypad", index: 12 });
  });
  it("rejects malformed contexts", () => {
    expect(parseContext("")).toBeNull();
    expect(parseContext("S:scene:Keypad")).toBeNull();
    expect(parseContext("S:scene:Dial:1")).toBeNull();
    expect(parseContext("S:scene:Keypad:x")).toBeNull();
    expect(parseContext("S:scene:Keypad:-1")).toBeNull();
    expect(parseContext(":scene:Keypad:1")).toBeNull();
    expect(parseContext("S::Keypad:1")).toBeNull();
    expect(parseContext("0123456789abcdef")).toBeNull();
  });
});
