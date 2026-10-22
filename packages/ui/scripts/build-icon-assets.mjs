#!/usr/bin/env node
// Regenerate the bundled icon sets in src/assets/icons/ from @iconify/json.
//
//   pnpm --filter @open-stream-deck/ui icons        (or: node scripts/build-icon-assets.mjs)
//
// Output per set: { icons: { name: body }, w, h, vb? } where w/h are the set's default icon size
// (iconify default 16x16 when the set does not declare one) and vb maps icon names whose own
// viewBox differs from "0 0 w h" (per-icon left/top/width/height) to that viewBox. Aliases are not
// bundled. index.json lists { prefix: { name, count } } for the icon browser.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SETS = [
  "lucide", "tabler", "mdi", "ph", "ri", "bi",
  "fa6-solid", "fa6-regular", "carbon", "fluent", "icon-park-outline", "solar",
];

// Iconify defaults (see @iconify/utils lib/icon/defaults).
const DEFAULT_SIZE = 16;

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "..", "src", "assets", "icons");
const require = createRequire(import.meta.url);
const iconifyDir = dirname(require.resolve("@iconify/json/package.json"));

/** viewBox of one icon, using iconify's inheritance: icon value → set value → default. */
export function iconViewBox(icon, set) {
  const left = icon.left ?? set.left ?? 0;
  const top = icon.top ?? set.top ?? 0;
  const width = icon.width ?? set.width ?? DEFAULT_SIZE;
  const height = icon.height ?? set.height ?? DEFAULT_SIZE;
  return `${left} ${top} ${width} ${height}`;
}

export function buildSet(set) {
  const w = set.width ?? DEFAULT_SIZE;
  const h = set.height ?? DEFAULT_SIZE;
  const icons = {};
  const vb = {};
  for (const [name, icon] of Object.entries(set.icons)) {
    icons[name] = icon.body;
    const v = iconViewBox(icon, set);
    if (v !== `0 0 ${w} ${h}`) vb[name] = v;
  }
  const out = { icons, w, h };
  if (Object.keys(vb).length > 0) out.vb = vb;
  return out;
}

function main() {
  mkdirSync(outDir, { recursive: true });
  const index = {};
  for (const prefix of SETS) {
    const set = JSON.parse(readFileSync(join(iconifyDir, "json", `${prefix}.json`), "utf8"));
    const out = buildSet(set);
    writeFileSync(join(outDir, `${prefix}.json`), JSON.stringify(out));
    index[prefix] = { name: set.info?.name ?? prefix, count: Object.keys(out.icons).length };
    const custom = out.vb ? Object.keys(out.vb).length : 0;
    console.log(`${prefix}: ${index[prefix].count} icons, ${out.w}x${out.h}, ${custom} with their own viewBox`);
  }
  writeFileSync(join(outDir, "index.json"), JSON.stringify(index));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
