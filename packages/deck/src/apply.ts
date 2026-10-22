// Merge a built deck into a stored profile and apply it to the app's config files.
//
// Merge semantics (mergeProfile):
// - Only the deck's devices are touched; every other device (and a legacy top-level layout) stays
//   exactly as it was.
// - On a deck device, the deck's scenes come first in deck order (the first scene is the
//   window-trigger fallback). A deck scene whose id already exists replaces that scene in place
//   (same id, so references to it keep working). Scenes the deck does not define are kept after the
//   deck's, in their previous order, unless `prune` removes them.
// - activeSceneId is kept when that scene still exists, otherwise the deck's first scene.
//
// Apply (applyDeck):
// - Hot: the app answers GET /api/health on loopback → GET /api/profile/{name}, merge, PUT it back
//   (the app writes it atomically, keeps a .bak and reloads the profile and the HA watch list).
//   plugins.json is owned by the running app, so missing plugins are only reported.
// - Cold: the app is not running → atomic write of profile_<name>.json; plugins.json gets the
//   required plugins enabled.
// - Both: ha_config.json `watched` gets every referenced entity (read-modify-write, all other keys
//   preserved, the token is never printed). Every file is backed up (timestamped) before it changes.

import { closeSync, copyFileSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeSync, chmodSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import type { DeviceConfig, SavedProfile, Scene } from "../../ui/src/lib/types/profile.ts";
import { cloneJson } from "../../ui/src/lib/utils/profile.ts";
import type { BuiltDeck } from "./build.ts";
import { hasErrors, validateDeck, type HaStateLite, type Issue } from "./validate.ts";

// ─── Merge ───────────────────────────────────────────────────

export interface DeviceMergeSummary {
  serial: string;
  added: string[];
  replaced: string[];
  kept: string[];
  removed: string[];
  newDevice: boolean;
}

export interface MergeOptions {
  /** Remove scenes of the deck's devices that the deck does not define. */
  prune?: boolean;
  /** Profile name for a new profile. */
  profileName?: string;
}

export function emptyProfile(name: string): SavedProfile {
  return { name, devices: {}, favorites: [], recent: [] };
}

export function mergeProfile(base: SavedProfile | null, built: BuiltDeck, opts: MergeOptions = {}): { profile: SavedProfile; summary: DeviceMergeSummary[] } {
  const profile: SavedProfile = base ? cloneJson(base) : emptyProfile(opts.profileName ?? "default");
  if (!profile.devices || typeof profile.devices !== "object") profile.devices = {};
  const summary: DeviceMergeSummary[] = [];

  for (const dev of built.devices) {
    const existing: DeviceConfig | undefined = profile.devices[dev.serial];
    const oldScenes: Record<string, Scene> = existing?.scenes ?? {};
    const s: DeviceMergeSummary = { serial: dev.serial, added: [], replaced: [], kept: [], removed: [], newDevice: !existing };
    const scenes: Record<string, Scene> = {};
    for (const sc of dev.scenes) {
      (oldScenes[sc.id] ? s.replaced : s.added).push(sc.id);
      scenes[sc.id] = cloneJson(sc);
    }
    for (const [id, sc] of Object.entries(oldScenes)) {
      if (scenes[id]) continue;
      if (opts.prune) s.removed.push(id);
      else { scenes[id] = sc; s.kept.push(id); }
    }
    const active = existing?.activeSceneId && scenes[existing.activeSceneId] ? existing.activeSceneId : (dev.scenes[0]?.id ?? Object.keys(scenes)[0] ?? null);
    const merged: DeviceConfig = { ...(existing ?? {}), scenes, activeSceneId: active };
    if (dev.brightness !== undefined) merged.brightness = dev.brightness;
    profile.devices[dev.serial] = merged;
    summary.push(s);
  }
  return { profile, summary };
}

/** Scene ids per deck device after the merge (for scene-reference validation). */
export function sceneIdsBySerial(profile: SavedProfile, built: BuiltDeck): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const dev of built.devices) out[dev.serial] = Object.keys(profile.devices?.[dev.serial]?.scenes ?? {});
  return out;
}

// ─── Config files ────────────────────────────────────────────

/** Same as the app's config dir (Rust dirs::config_dir() + "open-stream-deck"). */
export function defaultConfigDir(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  const home = env.HOME || homedir();
  let base: string;
  if (platform === "darwin") base = join(home, "Library", "Application Support");
  else if (platform === "win32") base = env.APPDATA || join(home, "AppData", "Roaming");
  else base = env.XDG_CONFIG_HOME && env.XDG_CONFIG_HOME.startsWith("/") ? env.XDG_CONFIG_HOME : join(home, ".config");
  return join(base, "open-stream-deck");
}

/** sd-core sanitize_profile_name: 1-64 chars, everything outside [A-Za-z0-9_-] becomes "_". */
export function sanitizeProfileName(name: string): string {
  const t = name.trim();
  if (!t || [...t].length > 64) throw new Error(`Invalid profile name "${name}" (1-64 characters)`);
  return [...t].map(c => (/^[A-Za-z0-9_-]$/.test(c) ? c : "_")).join("");
}

export function profileFile(configDir: string, name: string): string {
  return join(configDir, `profile_${sanitizeProfileName(name)}.json`);
}

/** Write a file atomically (temp file in the same dir, fsync, rename), mode 0600. */
export function atomicWrite(path: string, content: string): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.${basename(path)}.${randomBytes(6).toString("hex")}.tmp`);
  let fd: number | null = null;
  try {
    fd = openSync(tmp, "wx", 0o600);
    writeSync(fd, content);
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameSync(tmp, path);
  } catch (e) {
    if (fd !== null) { try { closeSync(fd); } catch { /* already failing */ } }
    try { unlinkSync(tmp); } catch { /* not created */ }
    throw e;
  }
}

function timestamp(d: Date): string {
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${p(d.getMilliseconds(), 3)}`;
}

/** Timestamped backups of every file a run touches: <configDir>/deck-backups/<stamp>/<file>. */
export class Backups {
  readonly dir: string;
  readonly files: string[] = [];

  constructor(configDir: string, now: Date) {
    this.dir = join(configDir, "deck-backups", timestamp(now));
  }

  private target(name: string): string {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const t = join(this.dir, name);
    this.files.push(t);
    return t;
  }

  /** Copy an existing file (no-op when it does not exist). */
  copy(path: string): void {
    if (!existsSync(path)) return;
    const t = this.target(basename(path));
    copyFileSync(path, t);
    chmodSync(t, 0o600);
  }

  /** Save content that was read elsewhere (e.g. a profile fetched over the API). */
  save(name: string, content: string): void {
    atomicWrite(this.target(name), content);
  }
}

function readJsonObject(path: string, what: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, "utf8");
  let v: unknown;
  try { v = JSON.parse(raw); } catch (e) {
    throw new Error(`${what} (${path}) is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error(`${what} (${path}) is not a JSON object`);
  return v as Record<string, unknown>;
}

/** Parse profile JSON without normalizing (other devices must stay byte-for-byte the same in content). */
export function parseStoredProfile(json: string, name: string): SavedProfile {
  let v: unknown;
  try { v = JSON.parse(json); } catch (e) {
    throw new Error(`profile "${name}" is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error(`profile "${name}" is not a JSON object`);
  const p = v as SavedProfile;
  if (p.devices !== undefined && (typeof p.devices !== "object" || p.devices === null || Array.isArray(p.devices))) {
    throw new Error(`profile "${name}": "devices" must be an object`);
  }
  return p;
}

export interface WatchUpdate {
  added: string[];
  /** The file changed (false when every entity was already watched). */
  changed: boolean;
  /** Resulting ha_config.json content, or null when unchanged. */
  content: string | null;
}

/** Add entities to ha_config.json `watched`, keeping every other key (url, token, ...) as is. */
export function computeWatchUpdate(current: Record<string, unknown> | null, entities: string[]): WatchUpdate {
  const cfg: Record<string, unknown> = current ? { ...current } : {};
  const watched = Array.isArray(cfg.watched) ? cfg.watched.filter((x): x is string => typeof x === "string") : [];
  const have = new Set(watched);
  const added = entities.filter(e => !have.has(e));
  if (added.length === 0 && Array.isArray(cfg.watched)) return { added, changed: false, content: null };
  cfg.watched = [...watched, ...added];
  return { added, changed: true, content: JSON.stringify(cfg) };
}

export interface PluginUpdate {
  /** Required plugins that plugins.json marks as disabled. */
  disabled: string[];
  content: string | null;
}

/** Enable required plugins in plugins.json ({ "<id>": { "enabled": bool } }); absent built-ins default to enabled. */
export function computePluginUpdate(current: Record<string, unknown> | null, required: string[]): PluginUpdate {
  const states: Record<string, unknown> = current ? { ...current } : {};
  const disabled = required.filter(id => {
    const s = states[id];
    return !!s && typeof s === "object" && (s as { enabled?: unknown }).enabled === false;
  });
  if (disabled.length === 0) return { disabled, content: null };
  for (const id of disabled) states[id] = { ...(states[id] as object), enabled: true };
  return { disabled, content: JSON.stringify(states) };
}

// ─── App detection and API ───────────────────────────────────

export interface HttpResponse { status: number; body: string; }

export type HttpFn = (method: "GET" | "PUT", path: string, body?: string) => Promise<HttpResponse>;

/**
 * Loopback HTTP client for the app's REST API. node:http is used instead of fetch so no Origin
 * header is sent (the API refuses loopback requests with a foreign Origin).
 */
export function loopbackHttp(port = 8484, host = "127.0.0.1", timeoutMs = 5000): HttpFn {
  return (method, path, body) => new Promise((resolve, reject) => {
    const req = httpRequest({
      host, port, path, method,
      headers: body !== undefined ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } : {},
      timeout: timeoutMs,
    }, res => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
      res.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new Error(`timeout after ${timeoutMs} ms`)));
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

export async function appReachable(http: HttpFn): Promise<boolean> {
  try {
    const r = await http("GET", "/api/health");
    return r.status === 200 && r.body.trim() === "ok";
  } catch {
    return false;
  }
}

/** Linux: is an app process running (comm is truncated to 15 characters)? */
export function appProcessRunning(): boolean {
  if (process.platform !== "linux") return false;
  const names = new Set(["sd-tauri", "open-stream-deck".slice(0, 15)]);
  let entries: string[];
  try { entries = readdirSync("/proc"); } catch { return false; }
  for (const e of entries) {
    if (!/^\d+$/.test(e)) continue;
    try {
      if (names.has(readFileSync(`/proc/${e}/comm`, "utf8").trim())) return true;
    } catch { /* process exited */ }
  }
  return false;
}

// ─── Apply ───────────────────────────────────────────────────

export interface ApplyOptions {
  profileName: string;
  configDir: string;
  prune?: boolean;
  haStates?: HaStateLite[];
  http?: HttpFn;
  /** Override process detection (tests). */
  isAppRunning?: () => boolean;
  /** Write files even though an app process seems to run without a reachable API. */
  forceCold?: boolean;
  now?: Date;
  log?: (line: string) => void;
}

export interface ApplyResult {
  mode: "hot" | "cold";
  profile: SavedProfile;
  summary: DeviceMergeSummary[];
  issues: Issue[];
  watchAdded: string[];
  /** Required plugins that are disabled (cold: now enabled; hot: the user must enable them). */
  pluginsDisabled: string[];
  backups: string[];
  profilePath: string;
}

export class ApplyAbortedError extends Error {
  issues: Issue[];
  constructor(message: string, issues: Issue[]) {
    super(message);
    this.name = "ApplyAbortedError";
    this.issues = issues;
  }
}

function prepare(base: SavedProfile | null, built: BuiltDeck, opts: ApplyOptions, pluginStates: Record<string, { enabled?: boolean }> | undefined) {
  const { profile, summary } = mergeProfile(base, built, { prune: opts.prune, profileName: opts.profileName });
  const issues = validateDeck(built, { sceneIdsBySerial: sceneIdsBySerial(profile, built), haStates: opts.haStates, pluginStates });
  if (hasErrors(issues)) throw new ApplyAbortedError("Validation failed; nothing was written", issues);
  return { profile, summary, issues };
}

export async function applyDeck(built: BuiltDeck, opts: ApplyOptions): Promise<ApplyResult> {
  const log = opts.log ?? (() => {});
  const http = opts.http ?? loopbackHttp();
  const configDir = opts.configDir;
  const name = sanitizeProfileName(opts.profileName);
  const profilePath = profileFile(configDir, name);
  const haConfigPath = join(configDir, "ha_config.json");
  const pluginsPath = join(configDir, "plugins.json");
  const backups = new Backups(configDir, opts.now ?? new Date());

  const pluginJson = readJsonObject(pluginsPath, "plugins.json");
  const pluginStates = (pluginJson ?? undefined) as Record<string, { enabled?: boolean }> | undefined;
  const haJson = readJsonObject(haConfigPath, "ha_config.json");
  const watch = computeWatchUpdate(haJson, built.watched);
  const plugins = computePluginUpdate(pluginJson, built.requiredPlugins);

  const hot = await appReachable(http);
  if (hot) {
    log(`App is running (API on loopback): hot apply of profile "${name}"`);
    const got = await http("GET", `/api/profile/${encodeURIComponent(name)}`);
    let base: SavedProfile | null = null;
    // Only the app's own "Profile <name> not found" means a new profile; any other 404 (e.g. an
    // older build without the route) must not be mistaken for an empty profile.
    const notFound = got.status === 404 && /^Profile .* not found/.test(got.body);
    if (got.status === 200) base = parseStoredProfile(got.body, name);
    else if (!notFound) {
      const hint = got.status === 401 || got.status === 403
        ? " (the running app refused a keyless loopback request to the profile API: it is probably an older build without"
          + " /api/profile; restart the app from the current build, then retry. Nothing was written.)"
        : "";
      throw new Error(`GET /api/profile/${name} failed: HTTP ${got.status} ${got.body.slice(0, 200)}${hint}`);
    }
    const { profile, summary, issues } = prepare(base, built, opts, pluginStates);

    if (base) backups.save(basename(profilePath), got.body);
    // ha_config.json is written before the PUT: the app re-reads the watch list right after the
    // profile reload the PUT triggers. A failed PUT restores the previous file.
    const haBefore = existsSync(haConfigPath) ? readFileSync(haConfigPath, "utf8") : null;
    if (watch.content !== null) {
      backups.copy(haConfigPath);
      atomicWrite(haConfigPath, watch.content);
    }
    const restoreHa = () => {
      if (watch.content === null) return;
      if (haBefore !== null) atomicWrite(haConfigPath, haBefore);
      else unlinkSync(haConfigPath);
    };
    let put: HttpResponse;
    try {
      put = await http("PUT", `/api/profile/${encodeURIComponent(name)}`, JSON.stringify(profile));
    } catch (e) {
      restoreHa();
      throw e;
    }
    if (put.status !== 200) {
      restoreHa();
      throw new Error(`PUT /api/profile/${name} failed: HTTP ${put.status} ${put.body.slice(0, 300)} (ha_config.json restored)`);
    }
    return { mode: "hot", profile, summary, issues, watchAdded: watch.added, pluginsDisabled: plugins.disabled, backups: backups.files, profilePath };
  }

  const running = (opts.isAppRunning ?? appProcessRunning)();
  if (running && !opts.forceCold) {
    throw new Error("An Open Stream Deck process is running but its API does not answer on 127.0.0.1:8484 "
      + "(apiBind set to a LAN address?). Quit the app from the tray (or fix apiBind) and retry; "
      + "--force-cold writes the files anyway (the running app will not reload them).");
  }
  log(`App is not running: cold apply to ${profilePath}`);
  const base = existsSync(profilePath) ? parseStoredProfile(readFileSync(profilePath, "utf8"), name) : null;
  const { profile, summary, issues } = prepare(base, built, opts, pluginStates);

  backups.copy(profilePath);
  atomicWrite(profilePath, JSON.stringify(profile));
  if (watch.content !== null) {
    backups.copy(haConfigPath);
    atomicWrite(haConfigPath, watch.content);
  }
  if (plugins.content !== null) {
    backups.copy(pluginsPath);
    atomicWrite(pluginsPath, plugins.content);
  }
  return { mode: "cold", profile, summary, issues, watchAdded: watch.added, pluginsDisabled: plugins.disabled, backups: backups.files, profilePath };
}

/** Human-readable plugin names for instructions. */
export function pluginLabel(id: string): string {
  const ids = new Map<string, string>([
    ["homeassistant", "Home Assistant"], ["http-actions", "HTTP Actions"], ["navigation", "Navigation"],
    ["system-actions", "System Actions"], ["utilities", "Utilities"], ["multi-action", "Multi-Action"],
  ]);
  return ids.get(id) ?? id;
}
