// deck CLI.
//
//   deck build <deck.ts> [--profile <name>] [--config-dir <dir>] [--base <profile.json>]
//                        [--ha-states <states.json>] [--prune]
//                        [--dry-run | --out <file> | --apply [--force-cold]]
//
// Relative paths are resolved against the directory the command was started from (INIT_CWD under
// pnpm). Never contacts Home Assistant; --ha-states takes a states JSON file (GET /api/states).

import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { buildDeck } from "./build.ts";
import type { DeckSpec } from "./builders.ts";
import { hasErrors, validateDeck, type HaStateLite } from "./validate.ts";
import {
  ApplyAbortedError, applyDeck, defaultConfigDir, mergeProfile, parseStoredProfile, pluginLabel, profileFile,
  sanitizeProfileName, sceneIdsBySerial,
} from "./apply.ts";
import { deckReport, issuesReport } from "./report.ts";

export const USAGE = `Usage:
  deck build <deck.ts> [options] [--dry-run | --out <file> | --apply]

Modes (default --dry-run):
  --dry-run              print the per-scene key/encoder/strip tables and the validation report
  --out <file>           write the merged profile JSON to <file> (never inside the app config dir)
  --apply                merge into the live profile: through the running app's REST API on
                         127.0.0.1:8484 (hot), else by writing the config files (cold)

Options:
  --profile <name>       profile to merge into (default "default")
  --config-dir <dir>     app config dir (default ~/.config/open-stream-deck)
  --base <file>          base profile JSON for --dry-run/--out (default: the stored profile, read only)
  --ha-states <file>     Home Assistant states JSON (array of {entity_id, state, attributes}) to check
                         referenced entities and attributes against
  --prune                drop scenes of the deck's devices that the deck does not define
  --force-cold           --apply: write files although an app process runs without a reachable API
  -h, --help             show this help`;

interface Args {
  command: string;
  deck: string;
  profile: string;
  configDir?: string;
  base?: string;
  haStates?: string;
  out?: string;
  mode: "dry-run" | "out" | "apply";
  prune: boolean;
  forceCold: boolean;
}

export function parseArgs(argv: string[]): Args {
  const rest = [...argv];
  const positional: string[] = [];
  const a: Partial<Args> & { modes: string[] } = { profile: "default", prune: false, forceCold: false, modes: [] };
  const value = (flag: string) => {
    const v = rest.shift();
    if (v === undefined || v.startsWith("--")) throw new Error(`${flag} needs a value`);
    return v;
  };
  while (rest.length) {
    const arg = rest.shift()!;
    switch (arg) {
      case "--profile": a.profile = value(arg); break;
      case "--config-dir": a.configDir = value(arg); break;
      case "--base": a.base = value(arg); break;
      case "--ha-states": a.haStates = value(arg); break;
      case "--out": a.out = value(arg); a.modes.push("out"); break;
      case "--dry-run": a.modes.push("dry-run"); break;
      case "--apply": a.modes.push("apply"); break;
      case "--prune": a.prune = true; break;
      case "--force-cold": a.forceCold = true; break;
      default:
        if (arg.startsWith("-")) throw new Error(`Unknown option ${arg}`);
        positional.push(arg);
    }
  }
  if (positional[0] !== "build" || positional.length !== 2) throw new Error("Expected: deck build <deck.ts>");
  if (a.modes.length > 1) throw new Error("Use only one of --dry-run, --out, --apply");
  if (a.base && a.modes[0] === "apply") throw new Error("--base cannot be used with --apply (apply always merges into the live profile)");
  return {
    command: positional[0], deck: positional[1], profile: a.profile!, configDir: a.configDir, base: a.base,
    haStates: a.haStates, out: a.out, mode: (a.modes[0] ?? "dry-run") as Args["mode"], prune: a.prune!, forceCold: a.forceCold!,
  };
}

function fromCwd(p: string): string {
  return isAbsolute(p) ? p : resolve(process.env.INIT_CWD || process.cwd(), p);
}

export async function loadDeck(path: string): Promise<DeckSpec> {
  const mod = await import(pathToFileURL(path).href) as { default?: unknown };
  let deck = mod.default;
  if (typeof deck === "function") deck = await (deck as () => unknown)();
  if (!deck || typeof deck !== "object" || !Array.isArray((deck as DeckSpec).devices)) {
    throw new Error(`${path} must export default a deck (defineDeck({ devices: [...] }))`);
  }
  return deck as DeckSpec;
}

function loadStates(path: string): HaStateLite[] {
  const v = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (!Array.isArray(v) || !v.every(s => s && typeof s === "object" && typeof (s as HaStateLite).entity_id === "string")) {
    throw new Error(`${path} must be a JSON array of Home Assistant states ({entity_id, state, attributes})`);
  }
  return v as HaStateLite[];
}

function isInside(child: string, parent: string): boolean {
  const real = (p: string) => { try { return realpathSync(p); } catch { return resolve(p); } };
  const rel = relative(real(parent), join(real(dirname(child)), basename(child)));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function readActiveProfile(configDir: string): string | null {
  try {
    const s = JSON.parse(readFileSync(join(configDir, "app_settings.json"), "utf8")) as { activeProfile?: unknown };
    return typeof s.activeProfile === "string" ? s.activeProfile : null;
  } catch {
    return null;
  }
}

export async function main(argv: string[], out: (s: string) => void = s => console.log(s)): Promise<number> {
  if (argv.includes("-h") || argv.includes("--help") || argv.length === 0) { out(USAGE); return 0; }
  let args: Args;
  try { args = parseArgs(argv); } catch (e) {
    out(`${e instanceof Error ? e.message : String(e)}\n\n${USAGE}`);
    return 2;
  }
  const configDir = fromCwd(args.configDir ?? defaultConfigDir());
  const profileName = sanitizeProfileName(args.profile);
  const deck = await loadDeck(fromCwd(args.deck));
  const built = buildDeck(deck);
  const haStates = args.haStates ? loadStates(fromCwd(args.haStates)) : undefined;

  if (args.mode === "apply") {
    const active = readActiveProfile(configDir);
    if (active && active !== profileName) {
      out(`Note: the app's active profile is "${active}"; a hot apply of "${profileName}" makes the app switch to it.`);
    }
    try {
      const r = await applyDeck(built, { profileName, configDir, prune: args.prune, haStates, forceCold: args.forceCold, log: out });
      out(deckReport(built, r.summary));
      out(issuesReport(r.issues));
      out(`\nApplied (${r.mode}) to ${r.mode === "hot" ? `the running app (profile "${profileName}", reloaded)` : r.profilePath}`);
      out(r.watchAdded.length ? `ha_config.json: now also watching ${r.watchAdded.join(", ")}` : "ha_config.json: every referenced entity was already watched");
      if (r.pluginsDisabled.length) {
        out(r.mode === "cold"
          ? `plugins.json: enabled ${r.pluginsDisabled.join(", ")}`
          : `ACTION NEEDED: enable these plugins in the app (Plugins page), the running app owns plugins.json: ${r.pluginsDisabled.map(pluginLabel).join(", ")}`);
      }
      out(r.backups.length ? `Backups:\n  ${r.backups.join("\n  ")}` : "Backups: none needed (no existing files changed)");
      return 0;
    } catch (e) {
      if (e instanceof ApplyAbortedError) {
        out(deckReport(built));
        out(issuesReport(e.issues));
        out(`\n${e.message}`);
        return 1;
      }
      out(`Apply failed: ${e instanceof Error ? e.message : String(e)}`);
      return 1;
    }
  }

  // --dry-run / --out: merge against a base profile read from disk (never written).
  const basePath = args.base ? fromCwd(args.base) : profileFile(configDir, profileName);
  const base = existsSync(basePath) ? parseStoredProfile(readFileSync(basePath, "utf8"), profileName) : null;
  const { profile, summary } = mergeProfile(base, built, { prune: args.prune, profileName });
  let pluginStates: Record<string, { enabled?: boolean }> | undefined;
  try { pluginStates = JSON.parse(readFileSync(join(configDir, "plugins.json"), "utf8")); } catch { pluginStates = undefined; }
  const issues = validateDeck(built, { sceneIdsBySerial: sceneIdsBySerial(profile, built), haStates, pluginStates });
  out(`Base profile: ${base ? basePath : "(none, new profile)"}`);
  out(deckReport(built, summary));
  out(issuesReport(issues));
  if (args.mode === "out") {
    const target = fromCwd(args.out!);
    if (isInside(target, configDir)) {
      out(`Refusing to write ${target}: it is inside the app config dir (use --apply for live changes)`);
      return 2;
    }
    if (hasErrors(issues)) { out("\nValidation failed; nothing was written"); return 1; }
    writeFileSync(target, JSON.stringify(profile, null, 2) + "\n", { mode: 0o600 });
    out(`\nWrote merged profile to ${target}`);
  }
  return hasErrors(issues) ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; }, e => {
    console.error(e instanceof Error ? e.stack ?? e.message : String(e));
    process.exitCode = 1;
  });
}
