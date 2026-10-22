// Drift test: devices.ts must mirror DEVICE_PROFILES in crates/sd-core/src/device/profile.rs.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DEVICE_MODELS, buttonCount, deviceModel, keyDesignSize, keyIndex, type DeviceModel } from "../src/devices.ts";

const PROFILE_RS = fileURLToPath(new URL("../../../crates/sd-core/src/device/profile.rs", import.meta.url));

type RsValue = string | number | boolean;

function stripComments(src: string): string {
  return src.replace(/\/\/[^\n]*/g, "");
}

function parseValue(raw: string, params: Record<string, RsValue>): RsValue {
  const v = raw.trim();
  if (/^"(.*)"$/.test(v)) return v.slice(1, -1);
  if (/^0x[0-9a-f]+$/i.test(v)) return parseInt(v, 16);
  if (/^\d+$/.test(v)) return parseInt(v, 10);
  if (v === "true" || v === "false") return v === "true";
  if (v in params) return params[v];
  return v; // enum constant (ImageFormat::Jpeg, ...)
}

function splitTop(s: string): string[] {
  return s.split(",").map(x => x.trim()).filter(Boolean);
}

/** `name: value` / shorthand `name` fields of a DeviceProfile struct literal. */
function parseFields(body: string, params: Record<string, RsValue>): Record<string, RsValue> {
  const out: Record<string, RsValue> = {};
  for (const f of splitTop(body)) {
    const i = f.indexOf(":");
    if (i < 0 || f.slice(i).startsWith("::")) out[f] = parseValue(f, params);
    else out[f.slice(0, i).trim()] = parseValue(f.slice(i + 1), params);
  }
  return out;
}

function toModel(f: Record<string, RsValue>): DeviceModel {
  return {
    id: f.id as string,
    displayName: f.display_name as string,
    usbPid: f.usb_pid as number,
    columns: f.columns as number,
    rows: f.rows as number,
    keyPixelSize: f.key_pixel_size as number,
    touchButtonCount: f.touch_button_count as number,
    hasLcdStrip: f.has_lcd_strip as boolean,
    hasDials: f.has_dials as boolean,
    encoderCount: f.encoder_count as number,
    lcdStripWidth: f.lcd_strip_width as number,
    lcdStripHeight: f.lcd_strip_height as number,
    infoLcdWidth: f.info_lcd_width as number,
    infoLcdHeight: f.info_lcd_height as number,
  };
}

function parseProfileRs(src: string): DeviceModel[] {
  const code = stripComments(src);
  // const fn helpers returning a DeviceProfile literal.
  const helpers: Record<string, { params: string[]; body: string }> = {};
  const fnRe = /const fn (\w+)\(([^)]*)\)\s*->\s*DeviceProfile\s*\{\s*DeviceProfile\s*\{([^}]*)\}\s*\}/g;
  for (const m of code.matchAll(fnRe)) {
    helpers[m[1]] = { params: splitTop(m[2]).map(p => p.split(":")[0].trim()), body: m[3] };
  }
  const start = code.indexOf("pub static DEVICE_PROFILES");
  expect(start).toBeGreaterThan(0);
  const arrStart = code.indexOf("&[", code.indexOf("=", start)) + 2;
  const arrEnd = code.indexOf("];", arrStart);
  const arr = code.slice(arrStart, arrEnd);
  const models: DeviceModel[] = [];
  // Entries are `DeviceProfile { ... }` literals or helper calls `name(args)`; string arguments may
  // contain parentheses ("Stream Deck MK.2 (Scissor)"), so calls are scanned quote-aware.
  let i = 0;
  while (i < arr.length) {
    const rest = arr.slice(i);
    const lit = /^\s*DeviceProfile\s*\{([^}]*)\}\s*,?/.exec(rest);
    if (lit) {
      models.push(toModel(parseFields(lit[1], {})));
      i += lit[0].length;
      continue;
    }
    const call = /^\s*(\w+)\(/.exec(rest);
    if (!call) {
      if (rest.trim() === "") break;
      throw new Error(`profile.rs: cannot parse DEVICE_PROFILES near ${JSON.stringify(rest.slice(0, 40))}`);
    }
    let j = i + call[0].length;
    const args: string[] = [];
    let cur = "";
    let inStr = false;
    for (; j < arr.length; j++) {
      const c = arr[j];
      if (inStr) { cur += c; if (c === '"') inStr = false; continue; }
      if (c === '"') { inStr = true; cur += c; continue; }
      if (c === ",") { args.push(cur); cur = ""; continue; }
      if (c === ")") { if (cur.trim()) args.push(cur); break; }
      cur += c;
    }
    const h = helpers[call[1]];
    if (!h) throw new Error(`profile.rs: unknown helper ${call[1]}`);
    const params: Record<string, RsValue> = {};
    h.params.forEach((p, k) => { params[p] = parseValue(args[k] ?? "", {}); });
    models.push(toModel(parseFields(h.body, params)));
    i = j + 1;
    const comma = /^\s*,/.exec(arr.slice(i));
    if (comma) i += comma[0].length;
  }
  return models;
}

describe("devices.ts mirrors profile.rs", () => {
  it("has the same models, in the same order, with the same geometry", () => {
    const parsed = parseProfileRs(readFileSync(PROFILE_RS, "utf8"));
    expect(parsed.length).toBeGreaterThan(10);
    for (const m of parsed) {
      for (const [k, v] of Object.entries(m)) expect(v, `${m.id}.${k}`).not.toBeUndefined();
    }
    expect(DEVICE_MODELS).toEqual(parsed);
  });
});

describe("device helpers", () => {
  it("computes key counts, design size and grid indices", () => {
    const plus = deviceModel("plus");
    expect(buttonCount(plus)).toBe(8);
    expect(keyDesignSize(plus)).toBe(96);
    expect(keyDesignSize(deviceModel("mk2"))).toBe(72);
    expect(keyDesignSize(deviceModel("pedal"))).toBe(72);
    expect(buttonCount(deviceModel("neo"))).toBe(10);
    expect(keyIndex(deviceModel("xl"), 1, 2)).toBe(10);
    expect(() => keyIndex(plus, 2, 0)).toThrow(/outside/);
    expect(() => deviceModel("nope")).toThrow(/Unknown device model/);
  });
});
