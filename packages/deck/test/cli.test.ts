// CLI tests. Only --dry-run and --out are exercised: --apply would talk to a running app.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { main, parseArgs } from "../src/cli.ts";
import { sceneIdFromSlug } from "../src/uuid.ts";

const EXAMPLE = fileURLToPath(new URL("../examples/example.deck.ts", import.meta.url));

describe("parseArgs", () => {
  it("parses modes and options", () => {
    expect(parseArgs(["build", "d.ts"])).toMatchObject({ deck: "d.ts", mode: "dry-run", profile: "default", prune: false });
    expect(parseArgs(["build", "d.ts", "--out", "o.json", "--profile", "work", "--prune"])).toMatchObject({ mode: "out", out: "o.json", profile: "work", prune: true });
    expect(parseArgs(["build", "d.ts", "--apply", "--ha-states", "s.json"])).toMatchObject({ mode: "apply", haStates: "s.json" });
    expect(() => parseArgs(["build", "d.ts", "--apply", "--dry-run"])).toThrow(/only one/);
    expect(() => parseArgs(["build", "d.ts", "--apply", "--base", "b.json"])).toThrow(/--base/);
    expect(() => parseArgs(["build"])).toThrow(/deck build/);
    expect(() => parseArgs(["build", "d.ts", "--bogus"])).toThrow(/Unknown option/);
  });
});

describe("main", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "deck-cli-")); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("--dry-run prints the tables and the validation report", async () => {
    const out: string[] = [];
    const code = await main(["build", EXAMPLE, "--config-dir", join(dir, "cfg"), "--dry-run"], s => out.push(s));
    const text = out.join("\n");
    expect(code).toBe(0);
    expect(text).toContain("Device EXAMPLE-PLUS-0001 (Stream Deck +, 4x2 keys, 4 encoders, 800x100 strip)");
    expect(text).toContain(`Scene "Home" ${sceneIdFromSlug("home")}`);
    expect(text).toMatch(/E0 Light\s+HA light\.turn_on light\.living_room brightness/);
    expect(text).toMatch(/panel-0\s+0,0 200x100/);
    expect(text).toContain("Validation: 0 error(s), 0 warning(s)");
    expect(existsSync(join(dir, "cfg"))).toBe(false);
  });

  it("--out writes the merged profile, but never into the config dir", async () => {
    const target = join(dir, "merged.json");
    expect(await main(["build", EXAMPLE, "--config-dir", join(dir, "cfg"), "--out", target], () => {})).toBe(0);
    const p = JSON.parse(readFileSync(target, "utf8"));
    expect(Object.keys(p.devices["EXAMPLE-PLUS-0001"].scenes)).toEqual([sceneIdFromSlug("home"), sceneIdFromSlug("media")]);
    const out: string[] = [];
    expect(await main(["build", EXAMPLE, "--config-dir", dir, "--out", join(dir, "profile_default.json")], s => out.push(s))).toBe(2);
    expect(out.join("\n")).toContain("inside the app config dir");
    expect(existsSync(join(dir, "profile_default.json"))).toBe(false);
  });
});
