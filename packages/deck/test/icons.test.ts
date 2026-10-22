import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DEFAULT_ICON_COLOR, DEFAULT_ICON_SIZE, icon, iconSvgData, loadIconSet, parseIconName } from "../src/icons.ts";
import { iconToSvg } from "../../ui/src/lib/utils/icon-svg.ts";

const ASSETS = fileURLToPath(new URL("../../ui/src/assets/icons/", import.meta.url));

/** The UI's bundled set (scripts/build-icon-assets.mjs output). */
function bundled(prefix: string): { icons: Record<string, string>; w: number; h: number; vb?: Record<string, string> } {
  return JSON.parse(readFileSync(`${ASSETS}${prefix}.json`, "utf8"));
}

describe("icon lookup", () => {
  it("builds a complete IconConfig with the UI defaults", () => {
    const ic = icon("tabler:bulb");
    expect(ic.setId).toBe("tabler");
    expect(ic.iconName).toBe("bulb");
    expect(ic.viewBox).toBe("0 0 24 24");
    expect(ic.svgBody).toBe(loadIconSet("tabler").icons.bulb.body);
    expect(ic.color).toBe(DEFAULT_ICON_COLOR);
    expect(ic.size).toBe(DEFAULT_ICON_SIZE);
    expect(ic.variable).toBeUndefined();
    const cond = icon("tabler:bulb-off", { color: "#ff0000", size: 30, when: { variable: "{{$ha.light.x.state}}", value: "off" } });
    expect(cond).toMatchObject({ color: "#ff0000", size: 30, variable: "{{$ha.light.x.state}}", value: "off" });
  });

  it("matches the UI's bundled body and viewBox for every icon of sets with per-icon sizes and the 16px default", () => {
    for (const prefix of ["tabler", "bi", "fa6-solid", "fluent"]) {
      const b = bundled(prefix);
      let checked = 0;
      for (const [name, body] of Object.entries(b.icons)) {
        const d = iconSvgData(`${prefix}:${name}`);
        expect(d.svgBody, `${prefix}:${name}`).toBe(body);
        expect(d.viewBox, `${prefix}:${name}`).toBe(b.vb?.[name] ?? `0 0 ${b.w} ${b.h}`);
        checked++;
      }
      expect(checked).toBeGreaterThan(100);
    }
    // bi has no set-level size: the iconify default 16 applies.
    expect(iconSvgData("bi:alarm").viewBox).toBe("0 0 16 16");
  });

  it("uses per-icon width/height (fa6-solid)", () => {
    const set = loadIconSet("fa6-solid");
    const [name, data] = Object.entries(set.icons).find(([, d]) => d.width !== undefined && d.width !== set.width)!;
    expect(iconSvgData(`fa6-solid:${name}`).viewBox).toBe(`0 0 ${data.width} ${data.height ?? set.height}`);
  });

  it("resolves aliases (plain and transformed)", () => {
    const set = loadIconSet("mdi");
    const aliases = Object.entries(set.aliases ?? {});
    const [plainName, plain] = aliases.find(([, a]) => set.icons[a.parent] && a.rotate === undefined && a.hFlip === undefined && a.vFlip === undefined && a.width === undefined)!;
    const d = iconSvgData(`mdi:${plainName}`);
    expect(d.svgBody).toBe(set.icons[plain.parent].body);
    expect(d.viewBox).toBe(iconSvgData(`mdi:${plain.parent}`).viewBox);
    // Transformed alias (fa: align-right = align-left flipped horizontally).
    const fa = loadIconSet("fa");
    expect(fa.aliases?.["align-right"]).toMatchObject({ parent: "align-left", hFlip: true });
    const f = iconSvgData("fa:align-right");
    expect(f.svgBody).toMatch(/^<g transform="translate\([\d.]+ 0\) scale\(-1 1\)">/);
    expect(f.svgBody).toContain(fa.icons["align-left"].body);
    expect(f.viewBox).toBe(iconSvgData("fa:align-left").viewBox);
  });

  it("renders through the UI's iconToSvg", () => {
    const svg = iconToSvg(icon("tabler:bulb"), "#00ff00", 48);
    expect(svg).toContain('viewBox="0 0 24 24"');
    expect(svg).toContain('stroke="#00ff00"');
  });

  it("rejects bad names, unknown sets and unknown icons", () => {
    expect(() => parseIconName("bulb")).toThrow(/set:name/);
    expect(parseIconName("fa6-solid:house")).toEqual({ prefix: "fa6-solid", name: "house" });
    expect(() => icon("no-such-set-xyz:bulb")).toThrow(/Unknown icon set/);
    expect(() => icon("../etc:passwd")).toThrow(/Invalid icon set prefix/);
    expect(() => icon("tabler:definitely-not-an-icon")).toThrow(/not found/);
  });
});
