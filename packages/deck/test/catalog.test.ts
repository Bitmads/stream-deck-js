// Drift tests: catalog.ts copies facts from UI modules that cannot be imported in Node.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { ACTIONS, BUILTIN_PLUGINS, HA_CONTROLS, UI_FONTS } from "../src/catalog.ts";

const UI = fileURLToPath(new URL("../../ui/src/", import.meta.url));
const read = (rel: string) => readFileSync(join(UI, rel), "utf8");

describe("ACTIONS mirror the built-in plugin definitions", () => {
  it("has every plugin action with the same ActionDef and plugin id", () => {
    const found: Array<{ id: string; label: string; icon: string; color: string; plugin: string }> = [];
    const plugins: string[] = [];
    for (const dir of readdirSync(join(UI, "lib/plugins"))) {
      let src: string;
      try { src = read(`lib/plugins/${dir}/index.ts`); } catch { continue; }
      const plugin = /export const \w+PluginDef: PluginDef = \{\s*id: "([^"]+)"/.exec(src)?.[1];
      if (!plugin) continue;
      plugins.push(plugin);
      for (const m of src.matchAll(/const \w+ = \{ id: "([^"]+)", label: "([^"]+)", icon: "([^"]*)", color: "([^"]+)" \};/g)) {
        found.push({ id: m[1], label: m[2], icon: m[3], color: m[4], plugin });
      }
    }
    const ours = ACTIONS.map(a => ({ ...a.def, plugin: a.plugin }));
    const byId = (x: { id: string }, y: { id: string }) => x.id.localeCompare(y.id);
    expect([...ours].sort(byId)).toEqual([...found].sort(byId));
    expect([...BUILTIN_PLUGINS].sort()).toEqual([...plugins].sort());
  });

  it("marks exactly the actions the store dispatcher handles itself", () => {
    const store = read("lib/stores/store.svelte.ts");
    const start = store.indexOf("async executeAction(");
    const body = store.slice(start, store.indexOf("const executor = pluginExecutors", start));
    const cases = [...body.matchAll(/case "([^"]+)":/g)].map(m => m[1]).sort();
    expect(ACTIONS.filter(a => a.dispatcherHandled).map(a => a.def.id).sort()).toEqual(cases);
  });
});

describe("UI_FONTS mirror the text editor font list", () => {
  it("matches the <option> values of the font select", () => {
    const src = read("components/icon/TextConfig.svelte");
    const start = src.indexOf("value={config.fontFamily}");
    const select = src.slice(start, src.indexOf("</select>", start));
    expect([...select.matchAll(/<option value="([^"]+)">/g)].map(m => m[1])).toEqual([...UI_FONTS]);
  });
});

describe("HA_CONTROLS mirror HAClient.getEntityControls", () => {
  it("has the same ids, services, attributes and default ranges", () => {
    const src = read("lib/plugins/homeassistant/client.ts");
    const start = src.indexOf("getEntityControls(entityId: string)");
    const body = src.slice(start, src.indexOf("searchEntities(", start));
    const num = (v: string) => {
      const fallback = /num\([^,]+,\s*([\d.]+)\)/.exec(v);
      return Number(fallback ? fallback[1] : v.trim());
    };
    const parsed = [...body.matchAll(/controls\.push\(\{\s*id: "(\w+)", label: "[^"]*", domain, service: "(\w+)", attr: "(\w+)",(?:\s*readAttr: "(\w+)",)?\s*min: (.+?), max: (.+?), step: (.+?) \}\);/gs)]
      .map(m => ({ id: m[1], service: m[2], attr: m[3], readAttr: m[4], min: num(m[5]), max: num(m[6]), step: num(m[7]) }));
    expect(parsed.length).toBeGreaterThanOrEqual(7);
    const ours = HA_CONTROLS.filter(c => c.ratioMapping).map(c => ({ id: c.id, service: c.service, attr: c.attr, readAttr: c.readAttr, min: c.min, max: c.max, step: c.step }));
    expect(ours).toEqual(parsed);
    // humidity is a deck-side addition: when the client gains it, mark it ratioMapping and mirror it.
    expect(parsed.some(c => c.attr === "humidity")).toBe(false);
  });
});
