import { describe, it, expect } from "vitest";
import { wrapEncoderValue } from "./encoder";

describe("wrapEncoderValue", () => {
  it("moves within range", () => {
    expect(wrapEncoderValue(1, 1, 0, 3, 1)).toBe(2);
    expect(wrapEncoderValue(2, -1, 0, 3, 1)).toBe(1);
  });
  it("wraps past max to min and below min to max", () => {
    expect(wrapEncoderValue(3, 1, 0, 3, 1)).toBe(0);
    expect(wrapEncoderValue(0, -1, 0, 3, 1)).toBe(3);
    expect(wrapEncoderValue(2, 5, 0, 3, 1)).toBe(3);
  });
  it("respects step and a non-zero min", () => {
    expect(wrapEncoderValue(20, 10, 10, 30, 10)).toBe(30);
    expect(wrapEncoderValue(30, 10, 10, 30, 10)).toBe(10);
  });
  it("snaps an off-grid current value", () => {
    expect(wrapEncoderValue(1.4, 1, 0, 3, 1)).toBe(2);
  });
  it("handles a degenerate range", () => {
    expect(wrapEncoderValue(0, 1, 0, 0, 1)).toBe(0);
    expect(wrapEncoderValue(5, 1, 3, 1, 1)).toBe(3);
  });
});
