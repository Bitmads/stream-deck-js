// Offline icon lookup from @iconify/json, producing the IconConfig the UI stores.
//
// The UI stores the raw iconify body and a "left top width height" viewBox (see
// packages/ui/scripts/build-icon-assets.mjs and lib/utils/icon-svg.ts). The same values come out of
// @iconify/utils here: getIconData() resolves aliases and merges per-icon / set-level dimensions,
// iconToSVG() applies the iconify defaults (16x16) and alias transformations (rotate/flip, wrapped
// in a <g transform>), and returns the body unchanged for plain icons.

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { getIconData, iconToSVG } from "@iconify/utils";
import type { IconConfig } from "../../ui/src/lib/types/profile.ts";

type IconifyJSON = Parameters<typeof getIconData>[0];

const require = createRequire(import.meta.url);
const sets = new Map<string, IconifyJSON>();

/** Default icon color and size, as the UI icon browser uses (IconBrowser.svelte). */
export const DEFAULT_ICON_COLOR = "#ffffff";
export const DEFAULT_ICON_SIZE = 48;

function iconifyJsonDir(): string {
  return join(dirname(require.resolve("@iconify/json/package.json")), "json");
}

/** Load (and cache) one iconify set by prefix, e.g. "tabler". */
export function loadIconSet(prefix: string): IconifyJSON {
  const cached = sets.get(prefix);
  if (cached) return cached;
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(prefix)) throw new Error(`Invalid icon set prefix "${prefix}"`);
  let raw: string;
  try {
    raw = readFileSync(join(iconifyJsonDir(), `${prefix}.json`), "utf8");
  } catch {
    throw new Error(`Unknown icon set "${prefix}" (not in @iconify/json)`);
  }
  const set = JSON.parse(raw) as IconifyJSON;
  sets.set(prefix, set);
  return set;
}

export interface IconOptions {
  color?: string;
  size?: number;
  /** Conditional icon: shown when the template `variable` (e.g. "{{$ha.switch.x.state}}") resolves to `value`. */
  when?: { variable: string; value: string };
}

/** Split "set:name" into its parts (the set prefix itself may contain dashes: "fa6-solid:house"). */
export function parseIconName(full: string): { prefix: string; name: string } {
  const i = full.indexOf(":");
  if (i <= 0 || i === full.length - 1) throw new Error(`Icon name must be "set:name", got "${full}"`);
  return { prefix: full.slice(0, i), name: full.slice(i + 1) };
}

/** Body + viewBox of an icon, exactly as the UI would store it. */
export function iconSvgData(full: string): { setId: string; iconName: string; svgBody: string; viewBox: string } {
  const { prefix, name } = parseIconName(full);
  const set = loadIconSet(prefix);
  const data = getIconData(set, name);
  if (!data) throw new Error(`Icon "${name}" not found in set "${prefix}"`);
  const built = iconToSVG(data);
  return { setId: prefix, iconName: name, svgBody: built.body, viewBox: built.attributes.viewBox };
}

/** icon("tabler:bulb", { color, size, when }) → a complete IconConfig. */
export function icon(full: string, opts: IconOptions = {}): IconConfig {
  const d = iconSvgData(full);
  const cfg: IconConfig = {
    setId: d.setId,
    iconName: d.iconName,
    svgBody: d.svgBody,
    color: opts.color ?? DEFAULT_ICON_COLOR,
    size: opts.size ?? DEFAULT_ICON_SIZE,
    viewBox: d.viewBox,
  };
  if (opts.when) {
    cfg.variable = opts.when.variable;
    cfg.value = opts.when.value;
  }
  return cfg;
}
