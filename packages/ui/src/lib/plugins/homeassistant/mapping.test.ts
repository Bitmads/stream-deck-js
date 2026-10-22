import { describe, expect, it } from "vitest";
import { attrToVariable, decimalsOf, nullAttrValue, parseNumericSetting, quantize, ratioToValue } from "./mapping";

describe("decimalsOf", () => {
  it("counts step decimals", () => {
    expect(decimalsOf(1)).toBe(0);
    expect(decimalsOf(5)).toBe(0);
    expect(decimalsOf(0.5)).toBe(1);
    expect(decimalsOf(0.05)).toBe(2);
    expect(decimalsOf(1e-7)).toBe(7);
    expect(decimalsOf(0)).toBe(0);
  });
});

describe("ratioToValue", () => {
  it("keeps fractional ranges (media_player volume 0..1)", () => {
    const vol = { min: 0, max: 1, step: 0.05 };
    expect(ratioToValue(0, vol)).toBe(0);
    expect(ratioToValue(0.5, vol)).toBe(0.5);
    expect(ratioToValue(0.33, vol)).toBe(0.35);
    expect(ratioToValue(0.62, vol)).toBe(0.6);
    expect(ratioToValue(1, vol)).toBe(1);
  });

  it("snaps climate temperature to 0.5 steps", () => {
    const t = { min: 7, max: 35, step: 0.5 };
    expect(ratioToValue(0.5, t)).toBe(21);
    expect(ratioToValue(0.51, t)).toBe(21.5);
  });

  it("maps brightness onto 0..255 with step 5", () => {
    const b = { min: 0, max: 255, step: 5 };
    expect(ratioToValue(0.5, b)).toBe(130);
    expect(ratioToValue(1, b)).toBe(255);
  });

  it("reaches max even when max is off the step grid", () => {
    const ct = { min: 2000, max: 6535, step: 100 };
    expect(ratioToValue(1, ct)).toBe(6535);
    expect(ratioToValue(0.999, ct)).toBe(6500);
  });

  it("clamps out-of-range and invalid ratios", () => {
    const r = { min: 10, max: 20, step: 1 };
    expect(ratioToValue(-1, r)).toBe(10);
    expect(ratioToValue(2, r)).toBe(20);
    expect(ratioToValue(Number.NaN, r)).toBe(10);
  });

  it("anchors the step grid at min (input_number min 0.3 step 0.2)", () => {
    const r = { min: 0.3, max: 1.3, step: 0.2 };
    expect(ratioToValue(0.45, r)).toBe(0.7);
    expect(ratioToValue(0.6, r)).toBe(0.9);
  });
});

describe("quantize", () => {
  it("removes float noise from encoder arithmetic", () => {
    expect(quantize(0.1 + 0.2, { min: 0, max: 1, step: 0.05 })).toBe(0.3);
  });
  it("treats a non-positive step as 1", () => {
    expect(quantize(4.4, { min: 0, max: 10, step: 0 })).toBe(4);
  });
});

describe("null attributes", () => {
  it("publishes 0 for level attributes and empty string otherwise", () => {
    expect(nullAttrValue("brightness")).toBe("0");
    expect(nullAttrValue("volume_level")).toBe("0");
    expect(nullAttrValue("current_position")).toBe("0");
    expect(nullAttrValue("rgb_color")).toBe("");
    expect(attrToVariable("brightness", null)).toBe("0");
    expect(attrToVariable("color_mode", null)).toBe("");
  });
  it("formats arrays, skips objects", () => {
    expect(attrToVariable("rgb_color", [255, 128, 0])).toBe("255, 128, 0");
    expect(attrToVariable("x", { a: 1 })).toBeNull();
    expect(attrToVariable("brightness", 128)).toBe("128");
  });
});

describe("parseNumericSetting", () => {
  it("parses numbers including zero and keeps non-numeric strings", () => {
    expect(parseNumericSetting("0")).toBe(0);
    expect(parseNumericSetting("0.25")).toBe(0.25);
    expect(parseNumericSetting("heat")).toBe("heat");
    expect(parseNumericSetting("")).toBe("");
  });
});
