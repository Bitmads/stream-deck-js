import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type {
  ActionDef, TextConfig, IconConfig, KeyAssignment, SceneTrigger, EncoderConfig,
  StripItem, StripConfig, Scene, DeviceInfo, DeviceConfig, SavedProfile, RuntimeOverride, ControllerKind,
} from "../types/profile";
import * as tpl from "../utils/template";
import { makeContext, parseContext, type ParsedContext } from "../utils/context";
import {
  NONE_ACTION, parseProfileJson, cloneJson, createEmptyScene, createDeviceConfig,
  legacyDeviceConfig, serializeProfile,
} from "../utils/profile";
import { setDefaultVarLookup } from "../utils/render-key";
import { isIgnoredWindow, pickTriggerScene } from "../utils/window-trigger";

// Persisted model types live in ../types/profile (importable from Node); re-exported for existing imports.
export type {
  ActionDef, TextConfig, IconConfig, KeyAssignment, SceneTrigger, EncoderConfig,
  StripItem, StripConfig, Scene, DeviceInfo, DeviceConfig, SavedProfile, RuntimeOverride, ControllerKind,
} from "../types/profile";
export type { ParsedContext } from "../utils/context";

/** Where an action runs: the device (and scene/key) it was triggered from. */
export interface ActionContext { serial: string; sceneId?: string; keyIndex?: number; }

export type ActionExecutor = (settings: Record<string, string>, ctx?: ActionContext) => Promise<void>;

interface UndoEntry { serial: string; sceneId: string; keys: Record<string, KeyAssignment>; }

const MAX_UNDO = 50;
const SAVE_DEBOUNCE_MS = 500;
const LOCAL_SUPPRESS_MS = 500;
const DEFAULT_STRIP: StripConfig = { backgroundColor: "#0a0a1a", items: [] };
const EMPTY_SCENES: Record<string, Scene> = Object.freeze({}) as Record<string, Scene>;
/** Error prefix of save_json_file when the expected stamp no longer matches (storage.rs CHANGED_ON_DISK). */
const CHANGED_ON_DISK = "changed on disk";

/** Settings whose value is a JSON document consumed by its executor, never template-resolved here. */
// JSON blobs are passed raw: their executors parse them first and resolve templates per string
// value, so a variable containing a quote cannot break the JSON.
const RAW_SETTINGS: Record<string, string[]> = {
  "multi-action": ["steps"],
  "ha-service": ["ha_service_data"],
  "ha-custom": ["ha_custom_json"],
};
/** Settings whose substituted variable values are shell-quoted (they are run by `sh -c`). */
const SHELL_SETTINGS: Record<string, string[]> = { command: ["command"], launch: ["target"] };

// ─── Action registry (filled by plugins) ─────────────────────

let pluginActions = $state<ActionDef[]>([]);
const pluginExecutors: Record<string, ActionExecutor> = {};

/** Plugins call this to register new action types. */
export function registerActionType(action: ActionDef, executor?: ActionExecutor) {
  if (!pluginActions.find(a => a.id === action.id)) {
    pluginActions = [...pluginActions, action];
  }
  if (executor) pluginExecutors[action.id] = executor;
}

/** Remove a plugin-registered action type from the picker. */
export function unregisterActionType(actionId: string) {
  pluginActions = pluginActions.filter(a => a.id !== actionId);
  delete pluginExecutors[actionId];
}

/** Execute a plugin-registered action with already-resolved settings. Returns true if handled. */
export async function executePluginAction(actionId: string, settings: Record<string, string>, ctx?: ActionContext): Promise<boolean> {
  const executor = pluginExecutors[actionId];
  if (executor) { await executor(settings, ctx); return true; }
  return false;
}

/** All registered action types (from plugins). */
export const ACTION_TYPES = { get all() { return pluginActions; } };

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// ─── The Store ───────────────────────────────────────────────

class AppStore {
  // ── Devices ──
  devices = $state<DeviceInfo[]>([]);
  selectedDevice = $state<DeviceInfo | null>(null);
  deviceLoading = $state(false);
  deviceError = $state<string | null>(null);
  /** Bumped whenever a device (re)opens or the profile reloads: device sync then re-sends everything. */
  deviceEpochs = $state<Record<string, number>>({});

  // ── Profile: every device's scenes (single source of truth, persisted) ──
  activeProfileName = $state("default");
  profileDevices = $state<Record<string, DeviceConfig>>({});
  /** Device whose scenes the editor shows/edits: the selected device, or the last one selected. */
  boundSerial = $state<string | null>(null);
  /** Runtime back-navigation stacks per device (not persisted). */
  sceneStacks = $state<Record<string, string[]>>({});
  /** Per device: the scene the last window trigger switched to (the fallback only undoes that switch). */
  private triggerScenes: Record<string, string | null> = {};
  /** Last profile load/reload error (bad JSON or shape); null after a successful load. */
  loadError = $state<string | null>(null);
  /** Last action/save error, for display. */
  lastError = $state<string | null>(null);
  /** A failed initial load blocks saving, so a broken file is never overwritten by an empty profile. */
  private saveBlocked = false;
  /** Legacy single-device layout waiting for the first device to bind. */
  private pendingLegacy: DeviceConfig | null = null;
  /**
   * Stamp of each profile file as last loaded or saved by this window. Saves pass it as
   * `expectedStamp`, so a stale autosave never overwrites a file another writer (API PUT) replaced.
   */
  private fileStamps: Record<string, string> = {};

  // ── Selection (key XOR encoder XOR strip item) ──
  selectedKeyIndex = $state<number | null>(null);
  selectedEncoderIndex = $state<number | null>(null);
  selectedStripItemId = $state<string | null>(null);

  // ── Favorites / Recent ──
  recentActions = $state<string[]>([]);
  favoriteActions = $state<string[]>([]);

  // ── Variables ──
  variables = $state<Record<string, string>>({});
  /** Bumped on every variable change; only for consumers that need the whole map (getAllVariables). */
  varRevision = $state(0);

  // ── Runtime overrides (plugins, timers, counters): keyed by context id ──
  runtimeOverrides = $state<Record<string, RuntimeOverride>>({});

  // ── Undo / Redo ──
  undoStack = $state<UndoEntry[]>([]);
  redoStack = $state<UndoEntry[]>([]);

  // ── Internal ──
  revision = $state(0);
  private saveTimer: number | null = null;
  private timers: Record<string, number> = {};
  private encoderActionTimers: Record<string, number> = {};
  private encoderDeltaAcc: Record<string, number> = {};
  private locallySetVars: Record<string, number> = {};
  private pendingRemote: Record<string, string> = {};
  private pendingRemoteTimers: Record<string, number> = {};

  /** Variable lookup for template resolution. Reads only the named variable (fine-grained reactivity). */
  readonly lookupVar = (name: string): string | undefined => this.variables[name];

  constructor() {
    setDefaultVarLookup(this.lookupVar);
  }

  // ═══ Device Methods ════════════════════════════════════════

  get currentSerial(): string | null { return this.selectedDevice?.serial ?? null; }

  /** Serials of all connected devices. */
  getConnectedSerials(): string[] { return this.devices.map(d => d.serial); }

  getDevice(serial: string): DeviceInfo | undefined { return this.devices.find(d => d.serial === serial); }

  private bumpEpoch(serial: string) {
    this.deviceEpochs[serial] = (this.deviceEpochs[serial] ?? 0) + 1;
  }

  private async openDevice(serial: string): Promise<boolean> {
    try {
      await invoke("open_device", { serial });
      this.bumpEpoch(serial);
      await this.applyBrightness(serial);
      return true;
    } catch (e) {
      console.error(`Failed to open device ${serial}:`, e);
      return false;
    }
  }

  /** Saved brightness of a device (undefined when never set). */
  getDeviceBrightness(serial: string): number | undefined {
    return this.profileDevices[serial]?.brightness;
  }

  /** Set, apply and persist a device's brightness. */
  async setDeviceBrightness(serial: string, percent: number) {
    const value = Math.max(0, Math.min(100, Math.round(percent)));
    this.ensureDeviceConfig(serial).brightness = value;
    this.scheduleSave();
    await this.applyBrightness(serial);
  }

  /** Send the saved brightness to the device, if one is saved. Errors are logged, not thrown. */
  private async applyBrightness(serial: string) {
    const percent = this.profileDevices[serial]?.brightness;
    if (percent === undefined) return;
    try {
      await invoke("set_brightness", { serial, percent });
    } catch (e) {
      console.warn(`Failed to set brightness of ${serial}:`, e);
    }
  }

  async refreshDevices() {
    this.deviceLoading = true;
    this.deviceError = null;
    try {
      const newDevices = await invoke<DeviceInfo[]>("list_devices");
      const changed = newDevices.length !== this.devices.length ||
        newDevices.some((d, i) => d.serial !== this.devices[i]?.serial);
      // Same serials, but the backend reopened a handle (replug, USB reset or failed I/O within one
      // poll): that deck lost its images and brightness and must be repainted.
      const reopened = changed ? [] : newDevices.filter((d, i) =>
        (d.open_generation ?? 0) !== (this.devices[i]?.open_generation ?? 0));
      if (changed) {
        this.devices = newDevices;
        // (Re)open every deck: new ones need a handle, existing ones may be stale after suspend/replug.
        for (const d of newDevices) {
          this.ensureDeviceConfig(d.serial);
          await this.openDevice(d.serial);
        }
      } else if (reopened.length > 0) {
        this.devices = newDevices;
        for (const d of reopened) {
          this.bumpEpoch(d.serial);
          await this.applyBrightness(d.serial);
        }
      }

      if (this.devices.length > 0 && (!this.selectedDevice || !this.devices.find(d => d.serial === this.selectedDevice?.serial))) {
        await this.selectDevice(this.devices[0], !changed);
      }

      if (this.devices.length === 0 && this.selectedDevice) this.selectedDevice = null;
    } catch (e) { this.deviceError = String(e); }
    finally { this.deviceLoading = false; }
  }

  /** Select a device for editing. `open` re-opens its HID handle (skip when refreshDevices just did). */
  async selectDevice(device: DeviceInfo, open = true) {
    this.selectedDevice = device;
    if (open) await this.openDevice(device.serial);
    this.bindDevice(device.serial);
  }

  /** Make `serial` the device the editor works on. */
  bindDevice(serial: string) {
    this.ensureDeviceConfig(serial);
    if (this.boundSerial !== serial) {
      this.boundSerial = serial;
      this.selectedKeyIndex = null;
      this.selectedEncoderIndex = null;
      this.selectedStripItemId = null;
      this.revision++;
    }
  }

  /** Kept for existing callers: switching the edited device no longer copies scenes around. */
  switchToDevice(serial: string, _prevSerial?: string | null) {
    this.bindDevice(serial);
  }

  /** Make sure a device has a config (legacy layout or a fresh Default scene). Not saved until an edit. */
  private ensureDeviceConfig(serial: string): DeviceConfig {
    let config = this.profileDevices[serial];
    if (!config) {
      if (this.pendingLegacy) {
        this.profileDevices[serial] = this.pendingLegacy;
        this.pendingLegacy = null;
        this.scheduleSave(); // persist the migration
      } else {
        this.profileDevices[serial] = createDeviceConfig();
      }
      config = this.profileDevices[serial];
    }
    if (!config.activeSceneId || !config.scenes[config.activeSceneId]) {
      config.activeSceneId = Object.keys(config.scenes)[0] ?? null;
    }
    if (!this.sceneStacks[serial] && config.activeSceneId) this.sceneStacks[serial] = [config.activeSceneId];
    return config;
  }

  // ═══ Variable Methods ══════════════════════════════════════

  getVariable(name: string): string {
    return this.variables[name] ?? "";
  }

  setVariable(name: string, value: string) {
    this.locallySetVars[name] = Date.now();
    if (this.variables[name] === value) return;
    this.applyVariable(name, value);
    invoke("set_variable", { name, value }).catch((e) => console.error(`set_variable ${name} failed:`, e));
  }

  /**
   * Apply a value coming from outside (backend, HA, time). Remote updates arriving within
   * LOCAL_SUPPRESS_MS of a local setVariable are held (echo suppression) and the latest one is
   * applied when the window ends, so an authoritative remote value is never lost.
   */
  setVariableLocal(name: string, value: string) {
    const lastLocal = this.locallySetVars[name];
    if (lastLocal !== undefined) {
      const remaining = lastLocal + LOCAL_SUPPRESS_MS - Date.now();
      if (remaining > 0) {
        this.pendingRemote[name] = value;
        if (this.pendingRemoteTimers[name] === undefined) {
          this.pendingRemoteTimers[name] = window.setTimeout(() => this.flushPendingRemote(name), remaining + 10);
        }
        return;
      }
      delete this.locallySetVars[name];
    }
    if (this.variables[name] === value) return;
    this.applyVariable(name, value);
  }

  private flushPendingRemote(name: string) {
    delete this.pendingRemoteTimers[name];
    if (!(name in this.pendingRemote)) return;
    const value = this.pendingRemote[name];
    delete this.pendingRemote[name];
    this.setVariableLocal(name, value);
  }

  private applyVariable(name: string, value: string) {
    this.variables[name] = value;
    this.varRevision++;
  }

  deleteVariable(name: string) {
    delete this.variables[name];
    this.varRevision++;
    invoke("delete_variable", { name }).catch((e) => console.error(`delete_variable ${name} failed:`, e));
  }

  /** Remove a variable locally only (e.g. the backend reported it deleted). */
  deleteVariableLocal(name: string) {
    if (!(name in this.variables)) return;
    delete this.variables[name];
    this.varRevision++;
  }

  resolveTemplate(text: string): string {
    return tpl.resolveTemplate(text, this.lookupVar);
  }

  hasTemplates(text: string): boolean { return tpl.hasTemplates(text); }

  extractVariableNames(text: string): string[] { return tpl.extractVariableNames(text); }

  /** Resolve a number or {{$var}} template; `fallback` when missing or not numeric. */
  resolveNumber(input: string | number | undefined, fallback: number): number {
    return tpl.resolveNumber(input, this.lookupVar, fallback);
  }

  private timeInterval: number | undefined;

  initVariables() {
    if (this.timeInterval !== undefined) return;
    const updateTime = () => {
      const now = new Date();
      this.setVariableLocal("time.now", now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));
      this.setVariableLocal("time.date", now.toLocaleDateString());
      this.setVariableLocal("time.hours", String(now.getHours()).padStart(2, "0"));
      this.setVariableLocal("time.minutes", String(now.getMinutes()).padStart(2, "0"));
      this.setVariableLocal("time.seconds", String(now.getSeconds()).padStart(2, "0"));
    };
    updateTime();
    this.timeInterval = window.setInterval(updateTime, 1000);

    listen<{ name: string; value: string | null; deleted?: boolean }>("variable-changed", (e) => {
      const { name, value, deleted } = e.payload;
      if (deleted || value === null || value === undefined) this.deleteVariableLocal(name);
      else this.setVariableLocal(name, value);
    });
    listen<{ name: string }>("variable-deleted", (e) => {
      this.deleteVariableLocal(e.payload.name);
    });
    listen<{ app_name: string; title: string }>("active-window-changed", (e) => {
      this.setVariableLocal("window.title", e.payload.title);
      this.setVariableLocal("window.app", e.payload.app_name);
    });
  }

  // ═══ Persistence ═══════════════════════════════════════════

  private scheduleSave() {
    if (this.saveBlocked) return;
    if (this.saveTimer !== null) clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => { void this.flushSave(); }, SAVE_DEBOUNCE_MS);
  }

  private cancelPendingSave() {
    if (this.saveTimer !== null) clearTimeout(this.saveTimer);
    this.saveTimer = null;
  }

  /** Write the profile now if a save is pending (or `force`). Errors are surfaced in lastError. */
  async flushSave(force = false): Promise<void> {
    const pending = this.saveTimer !== null;
    this.cancelPendingSave();
    if (this.saveBlocked || (!pending && !force)) return;
    const name = this.activeProfileName;
    const content = serializeProfile(name, this.profileDevices, this.favoriteActions, this.recentActions, this.pendingLegacy);
    const filename = `profile_${name}`;
    try {
      const stamp = await invoke<string | null>("save_json_file", { filename, content, expectedStamp: this.fileStamps[filename] ?? null });
      if (typeof stamp === "string") this.fileStamps[filename] = stamp;
    } catch (e) {
      if (errorMessage(e).startsWith(CHANGED_ON_DISK)) {
        // Someone else (REST API) replaced the file since this window loaded it: theirs wins.
        console.warn(`Profile "${name}" changed on disk; reloading instead of overwriting it`);
        delete this.fileStamps[filename];
        if (name === this.activeProfileName) await this.reloadProfileFromDisk(name);
        return;
      }
      console.error("Failed to save profile:", e);
      this.lastError = `Failed to save profile "${name}": ${errorMessage(e)}`;
    }
  }

  /** Read + validate a stored profile. null if the file does not exist; throws on bad JSON/shape. */
  private async readProfile(name: string): Promise<SavedProfile | null> {
    const filename = `profile_${name}`;
    const file = await invoke<{ content: string; stamp: string } | null>("load_json_file_stamped", { filename });
    if (file === null || file === undefined) { delete this.fileStamps[filename]; return null; }
    const profile = parseProfileJson(file.content, name);
    this.fileStamps[filename] = file.stamp;
    return profile;
  }

  /**
   * Replace all profile state with `p` (already validated). Plugin overrides are kept on a reload of
   * the same profile (their contexts stay valid when scene ids are unchanged); timers always stop.
   */
  private applyProfile(p: SavedProfile, name: string, keepOverrides = false) {
    this.stopAllTimers();
    if (!keepOverrides) this.runtimeOverrides = {};
    this.profileDevices = p.devices ?? {};
    this.pendingLegacy = legacyDeviceConfig(p);
    this.favoriteActions = p.favorites || [];
    this.recentActions = p.recent || [];
    this.activeProfileName = name;
    this.undoStack = [];
    this.redoStack = [];
    this.sceneStacks = {};
    this.loadError = null;
    this.saveBlocked = false;

    for (const d of this.devices) this.ensureDeviceConfig(d.serial);
    const bind = this.selectedDevice?.serial ?? this.boundSerial;
    if (bind) this.ensureDeviceConfig(bind);
    this.selectedKeyIndex = null;
    this.selectedEncoderIndex = null;
    this.selectedStripItemId = null;
    for (const d of this.devices) {
      this.bumpEpoch(d.serial);
      void this.applyBrightness(d.serial);
    }
    this.revision++;
  }

  /** Switch to another stored profile (pending edits of the current one are saved first). */
  async loadProfile(name: string): Promise<boolean> {
    await this.flushSave();
    try {
      const p = await this.readProfile(name);
      if (!p) throw new Error(`profile_${name}.json does not exist`);
      this.applyProfile(p, name);
      await this.persistActiveProfile(name);
      return true;
    } catch (e) {
      this.loadError = `Failed to load profile "${name}": ${errorMessage(e)}`;
      console.error(this.loadError);
      return false;
    }
  }

  /**
   * Re-read a profile that was changed on disk (API PUT / external tool) and apply it.
   * A pending debounced save is cancelled so it cannot overwrite the new file. On any read,
   * parse or shape error the current in-memory state is kept, loadError is set and nothing is saved.
   */
  async reloadProfileFromDisk(name: string = this.activeProfileName): Promise<boolean> {
    this.cancelPendingSave();
    try {
      const p = await this.readProfile(name);
      if (!p) throw new Error(`profile_${name}.json does not exist`);
      const changedName = name !== this.activeProfileName;
      this.applyProfile(p, name, !changedName);
      if (changedName) await this.persistActiveProfile(name);
      return true;
    } catch (e) {
      this.loadError = `Failed to reload profile "${name}": ${errorMessage(e)}`;
      console.error(this.loadError);
      return false;
    }
  }

  async listProfiles(): Promise<string[]> {
    try {
      const files = await invoke<string[]>("list_json_files");
      return files.filter(f => f.startsWith("profile_")).map(f => f.substring("profile_".length));
    } catch (e) {
      console.error("Failed to list profiles:", e);
      return [];
    }
  }

  /** Create a new empty profile and make it active (pending edits of the current one are saved first). */
  async createProfile(name: string) {
    await this.flushSave();
    this.stopAllTimers();
    this.runtimeOverrides = {};
    this.activeProfileName = name;
    this.profileDevices = {};
    this.pendingLegacy = null;
    this.favoriteActions = [];
    this.recentActions = [];
    this.undoStack = [];
    this.redoStack = [];
    this.sceneStacks = {};
    this.loadError = null;
    this.saveBlocked = false;
    for (const d of this.devices) this.ensureDeviceConfig(d.serial);
    if (this.boundSerial) this.ensureDeviceConfig(this.boundSerial);
    this.selectedKeyIndex = null;
    this.selectedEncoderIndex = null;
    this.selectedStripItemId = null;
    for (const d of this.devices) this.bumpEpoch(d.serial);
    this.revision++;
    await this.flushSave(true);
    await this.persistActiveProfile(name);
  }

  async deleteProfile(name: string) {
    if (name === this.activeProfileName) {
      this.lastError = "The active profile cannot be deleted";
      return;
    }
    try {
      await invoke("delete_json_file", { filename: `profile_${name}` });
    } catch (e) {
      this.lastError = `Failed to delete profile "${name}": ${errorMessage(e)}`;
    }
  }

  private async readAppSettings(): Promise<Record<string, unknown> | null> {
    const raw = await invoke<string | null>("load_json_file", { filename: "app_settings" });
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  }

  /** Remember the active profile in app_settings.json ("activeProfile"), preserving other keys. */
  private async persistActiveProfile(name: string) {
    try {
      const settings = await this.readAppSettings();
      if (!settings) { console.error("app_settings.json is not a JSON object; active profile not saved"); return; }
      if (settings.activeProfile === name) return;
      settings.activeProfile = name;
      await invoke("save_json_file", { filename: "app_settings", content: JSON.stringify(settings, null, 2) });
    } catch (e) {
      console.error("Failed to persist active profile:", e);
    }
  }

  private async readActiveProfileSetting(): Promise<string> {
    try {
      const settings = await this.readAppSettings();
      const name = settings?.activeProfile;
      if (typeof name === "string" && /^[A-Za-z0-9_-]+$/.test(name)) return name;
    } catch (e) {
      console.error("Failed to read app_settings.json:", e);
    }
    return "default";
  }

  async initStore() {
    if ((window as any).__osd_initialized) return;
    (window as any).__osd_initialized = true;

    let name = await this.readActiveProfileSetting();
    try {
      let p = await this.readProfile(name);
      if (!p && name !== "default") {
        console.warn(`Active profile "${name}" not found, falling back to "default"`);
        name = "default";
        p = await this.readProfile(name);
      }
      if (p) this.applyProfile(p, name);
      else this.activeProfileName = name; // first run: start empty, first edit creates the file
    } catch (e) {
      // Keep the broken file intact: start empty and refuse to save until a profile loads.
      this.activeProfileName = name;
      this.saveBlocked = true;
      this.loadError = `Failed to load profile "${name}": ${errorMessage(e)}. Changes will not be saved until the file is fixed and reloaded.`;
      console.error(this.loadError);
    }

    // Do not lose a pending debounced save when the window is hidden to tray or the page unloads.
    window.addEventListener("beforeunload", () => { void this.flushSave(); });
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") void this.flushSave();
    });
  }

  // ═══ Scene access ══════════════════════════════════════════

  getDeviceConfig(serial: string | null | undefined): DeviceConfig | undefined {
    return serial ? this.profileDevices[serial] : undefined;
  }

  private get editConfig(): DeviceConfig | undefined { return this.getDeviceConfig(this.boundSerial); }

  /** Scenes of the edited device. */
  get scenes(): Record<string, Scene> { return this.editConfig?.scenes ?? EMPTY_SCENES; }
  get activeSceneId(): string | null { return this.editConfig?.activeSceneId ?? null; }
  get sceneStack(): string[] { return (this.boundSerial && this.sceneStacks[this.boundSerial]) || []; }

  private get activeScene(): Scene | undefined {
    const c = this.editConfig;
    return c?.activeSceneId ? c.scenes[c.activeSceneId] : undefined;
  }

  /** Active scene of `serial`, or of the edited device when omitted. */
  getActiveScene(serial?: string): Scene | undefined {
    if (serial === undefined) { void this.revision; return this.activeScene; }
    const c = this.profileDevices[serial];
    return c?.activeSceneId ? c.scenes[c.activeSceneId] : undefined;
  }

  getScenes(serial?: string): Scene[] {
    void this.revision;
    const c = serial === undefined ? this.editConfig : this.profileDevices[serial];
    return c ? Object.values(c.scenes) : [];
  }
  getActiveSceneId(serial?: string): string | null {
    return serial === undefined ? this.activeSceneId : (this.profileDevices[serial]?.activeSceneId ?? null);
  }
  getSceneStack(serial?: string): string[] {
    return serial === undefined ? this.sceneStack : (this.sceneStacks[serial] ?? []);
  }

  /**
   * Key shown at `index` of a scene: the scene's own key, else a pinned key of the same index from
   * another scene of that device (back stack first, then scene order). Pinned keys are never copied.
   */
  getEffectiveKey(serial: string, sceneId: string, index: number): KeyAssignment | undefined {
    return this.findKeyOwner(serial, sceneId, index)?.key;
  }

  private findKeyOwner(serial: string, sceneId: string, index: number): { scene: Scene; key: KeyAssignment; pinnedFrom: string | null } | undefined {
    const config = this.profileDevices[serial];
    const scene = config?.scenes[sceneId];
    if (!config || !scene) return undefined;
    const k = String(index);
    const own = scene.keys[k];
    if (own) return { scene, key: own, pinnedFrom: null };
    const order = [...(this.sceneStacks[serial] ?? [])].reverse();
    for (const id of Object.keys(config.scenes)) if (!order.includes(id)) order.push(id);
    for (const id of order) {
      if (id === sceneId) continue;
      const s = config.scenes[id];
      const key = s?.keys[k];
      if (key?.pinned) return { scene: s, key, pinnedFrom: id };
    }
    return undefined;
  }

  // ═══ Scene Methods (edited device) ═════════════════════════

  /** Create a scene on the edited device (with no device bound yet, the scene is returned unsaved). */
  createScene(name: string): Scene {
    const config = this.editConfig;
    const scene = createEmptyScene(name);
    if (!config) return scene;
    config.scenes[scene.id] = scene;
    this.revision++;
    this.scheduleSave();
    return config.scenes[scene.id];
  }

  deleteScene(id: string) {
    const config = this.editConfig;
    const serial = this.boundSerial;
    if (!config || !serial || !config.scenes[id] || Object.keys(config.scenes).length <= 1) return;
    delete config.scenes[id];
    this.stopTimers(serial, t => t.sceneId === id);
    const stack = (this.sceneStacks[serial] ?? []).filter(s => s !== id);
    if (config.activeSceneId === id) {
      const next = stack[stack.length - 1] ?? Object.keys(config.scenes)[0];
      config.activeSceneId = next;
      this.sceneStacks[serial] = stack.length ? stack : [next];
      this.selectedKeyIndex = null;
      this.selectedEncoderIndex = null;
      this.selectedStripItemId = null;
    } else {
      this.sceneStacks[serial] = stack.length ? stack : (config.activeSceneId ? [config.activeSceneId] : []);
    }
    this.undoStack = this.undoStack.filter(e => !(e.serial === serial && e.sceneId === id));
    this.redoStack = this.redoStack.filter(e => !(e.serial === serial && e.sceneId === id));
    this.revision++;
    this.scheduleSave();
  }

  renameScene(id: string, name: string) {
    const scene = this.editConfig?.scenes[id];
    if (scene) { scene.name = name; this.revision++; this.scheduleSave(); }
  }

  updateSceneTriggers(id: string, triggers: SceneTrigger[]) {
    const scene = this.editConfig?.scenes[id];
    if (scene) { scene.triggers = cloneJson(triggers); this.revision++; this.scheduleSave(); }
  }

  /** Full deep copy (keys, encoders, strip, triggers) under a new id. */
  duplicateScene(id: string): Scene | undefined {
    const config = this.editConfig;
    const src = config?.scenes[id];
    if (!config || !src) return undefined;
    const copy: Scene = cloneJson(src);
    copy.id = crypto.randomUUID();
    copy.name = src.name + " (copy)";
    config.scenes[copy.id] = copy;
    this.revision++;
    this.scheduleSave();
    return config.scenes[copy.id];
  }

  // ── Scene Navigation (any device; defaults to the edited device) ──

  private navTarget(serial?: string | null): { serial: string; config: DeviceConfig } | null {
    const s = serial ?? this.boundSerial;
    if (!s) return null;
    const config = this.profileDevices[s];
    return config ? { serial: s, config } : null;
  }

  private afterSceneChange(serial: string, newSceneId: string | null, preserveSelection = false) {
    this.stopTimers(serial, t => t.sceneId !== newSceneId);
    if (serial === this.boundSerial && !preserveSelection) {
      this.selectedKeyIndex = null;
      this.selectedEncoderIndex = null;
      this.selectedStripItemId = null;
    }
    this.revision++;
    this.scheduleSave(); // activeSceneId is persisted
  }

  switchScene(id: string, preserveSelection = false, serial?: string) {
    const t = this.navTarget(serial);
    if (!t || !t.config.scenes[id] || t.config.activeSceneId === id) return;
    t.config.activeSceneId = id;
    this.sceneStacks[t.serial] = [id];
    this.afterSceneChange(t.serial, id, preserveSelection);
  }

  pushScene(id: string, serial?: string) {
    const t = this.navTarget(serial);
    if (!t || !t.config.scenes[id] || t.config.activeSceneId === id) return;
    const stack = this.sceneStacks[t.serial] ?? (t.config.activeSceneId ? [t.config.activeSceneId] : []);
    this.sceneStacks[t.serial] = [...stack, id];
    t.config.activeSceneId = id;
    this.afterSceneChange(t.serial, id);
  }

  popScene(serial?: string) {
    const t = this.navTarget(serial);
    if (!t) return;
    // Drop entries of scenes deleted since they were pushed.
    const stack = (this.sceneStacks[t.serial] ?? []).filter(id => !!t.config.scenes[id]);
    if (stack.length <= 1) { this.sceneStacks[t.serial] = stack; return; }
    stack.pop();
    const prevId = stack[stack.length - 1];
    this.sceneStacks[t.serial] = stack;
    if (t.config.activeSceneId === prevId) return;
    t.config.activeSceneId = prevId;
    this.afterSceneChange(t.serial, prevId);
  }

  /**
   * Focused window changed: on every device of the profile, switch to the scene whose window trigger
   * matches with the highest priority. When nothing matches and the scene on screen is still the one
   * a trigger chose, go back to the device's first scene; a manual switch since then (Header, key
   * press, API) wins.
   */
  applyWindowTriggers(appName: string, windowTitle: string) {
    if (isIgnoredWindow(appName, windowTitle)) return;
    for (const serial of Object.keys(this.profileDevices)) {
      const scenes = this.getScenes(serial);
      const currentId = this.getActiveSceneId(serial);
      const best = pickTriggerScene(scenes, appName, windowTitle);
      if (best) {
        if (best !== currentId) {
          this.triggerScenes[serial] = best;
          this.switchScene(best, false, serial);
        }
      } else if (this.triggerScenes[serial] && currentId === this.triggerScenes[serial]) {
        this.triggerScenes[serial] = null;
        if (scenes[0] && scenes[0].id !== currentId) this.switchScene(scenes[0].id, false, serial);
      } else {
        this.triggerScenes[serial] = null;
      }
    }
  }

  // ═══ Selection ═════════════════════════════════════════════

  selectKey(index: number | null) {
    this.selectedKeyIndex = this.selectedKeyIndex === index ? null : index;
    if (this.selectedKeyIndex !== null) { this.selectedEncoderIndex = null; this.selectedStripItemId = null; }
  }

  selectEncoder(index: number | null) {
    this.selectedEncoderIndex = this.selectedEncoderIndex === index ? null : index;
    if (this.selectedEncoderIndex !== null) { this.selectedKeyIndex = null; this.selectedStripItemId = null; }
  }

  // ═══ Key Methods (edited device's active scene) ════════════

  /** Key shown at `index` on the edited device (including a pinned key from another scene). */
  getKeyAssignment(index: number): KeyAssignment | undefined {
    void this.revision;
    const serial = this.boundSerial;
    const sceneId = this.activeSceneId;
    return serial && sceneId ? this.getEffectiveKey(serial, sceneId, index) : undefined;
  }

  /** Key shown at `index` on any device's active scene. */
  getKeyAssignmentForDevice(serial: string, index: number): KeyAssignment | undefined {
    const sceneId = this.profileDevices[serial]?.activeSceneId;
    return sceneId ? this.getEffectiveKey(serial, sceneId, index) : undefined;
  }

  /** True when the key at `index` is shown from another scene (pinned there), not owned by this scene. */
  isPinnedOverlay(index: number): boolean {
    const serial = this.boundSerial, sceneId = this.activeSceneId;
    if (!serial || !sceneId) return false;
    return !!this.findKeyOwner(serial, sceneId, index)?.pinnedFrom;
  }

  /** The key edits at `index` apply to: this scene's own key, else the pinned key it shows. */
  private keyRef(index: number): { scene: Scene; key: KeyAssignment } | undefined {
    const serial = this.boundSerial, sceneId = this.activeSceneId;
    if (!serial || !sceneId) return undefined;
    const r = this.findKeyOwner(serial, sceneId, index);
    return r ? { scene: r.scene, key: r.key } : undefined;
  }

  /** Like keyRef, creating an empty own key when the slot is empty. */
  private ensureKey(index: number): { scene: Scene; key: KeyAssignment } | undefined {
    const existing = this.keyRef(index);
    if (existing) return existing;
    const scene = this.activeScene;
    if (!scene) return undefined;
    scene.keys[String(index)] = { action: { ...NONE_ACTION }, settings: {}, backgroundColor: "#000000" };
    return { scene, key: scene.keys[String(index)] };
  }

  assignAction(keyIndex: number, action: ActionDef) {
    const scene = this.activeScene;
    const serial = this.boundSerial;
    if (!scene || !serial) return;
    this.saveUndoState(scene);
    const k = String(keyIndex);
    const own = scene.keys[k];
    // Keep every visual/config field of the existing key (image URL, fit, pinned, texts, icons...).
    const base: Partial<KeyAssignment> = own ? cloneJson(own) : {};
    scene.keys[k] = {
      ...base,
      action: { ...action },
      settings: this.getDefaultSettings(action.id),
      backgroundColor: base.backgroundColor || "#000000",
    };
    const ctx = makeContext(serial, scene.id, "Keypad", keyIndex);
    this.stopTimer(ctx);
    this.clearRuntimeOverride(ctx);
    this.trackRecent(action.id);
    this.revision++;
    this.scheduleSave();
  }

  swapKeys(from: number, to: number) {
    const scene = this.activeScene;
    if (!scene || from === to) return;
    this.saveUndoState(scene);
    const a = scene.keys[String(from)], b = scene.keys[String(to)];
    const ac = a ? cloneJson(a) : undefined, bc = b ? cloneJson(b) : undefined;
    if (ac) scene.keys[String(to)] = ac; else delete scene.keys[String(to)];
    if (bc) scene.keys[String(from)] = bc; else delete scene.keys[String(from)];
    this.revision++;
    this.scheduleSave();
  }

  updateKeySetting(keyIndex: number, key: string, value: string) {
    const r = this.keyRef(keyIndex);
    if (r) { r.key.settings = { ...r.key.settings, [key]: value }; this.revision++; this.scheduleSave(); }
  }

  /** Replace all settings of a key (e.g. from an action settings editor). */
  setKeySettings(keyIndex: number, settings: Record<string, string>) {
    const r = this.keyRef(keyIndex);
    if (r) { r.key.settings = { ...settings }; this.revision++; this.scheduleSave(); }
  }

  setKeyBackgroundColor(keyIndex: number, color: string) {
    const r = this.ensureKey(keyIndex);
    if (r) { r.key.backgroundColor = color; this.revision++; this.scheduleSave(); }
  }

  setKeyImage(keyIndex: number, dataUrl: string, filePath?: string) {
    const r = this.ensureKey(keyIndex);
    if (!r) return;
    this.saveUndoState(r.scene);
    r.key.imageDataUrl = dataUrl;
    r.key.imagePath = filePath;
    this.revision++;
    this.scheduleSave();
  }

  removeKeyImage(keyIndex: number) {
    const r = this.keyRef(keyIndex);
    if (!r) return;
    this.saveUndoState(r.scene);
    r.key.imageDataUrl = undefined;
    r.key.imagePath = undefined;
    this.revision++;
    this.scheduleSave();
  }

  /** Remote image URL (templates allowed) and fit mode. */
  setKeyImageUrl(keyIndex: number, url: string, fit?: KeyAssignment["imageFit"]) {
    const r = this.ensureKey(keyIndex);
    if (!r) return;
    r.key.imageUrl = url || undefined;
    if (fit !== undefined) r.key.imageFit = fit;
    this.revision++;
    this.scheduleSave();
  }

  setKeyImageFit(keyIndex: number, fit: KeyAssignment["imageFit"]) {
    const r = this.keyRef(keyIndex);
    if (r) { r.key.imageFit = fit; this.revision++; this.scheduleSave(); }
  }

  setKeyText(keyIndex: number, textConfig: TextConfig, textIndex: number = 0) {
    const r = this.ensureKey(keyIndex);
    if (!r) return;
    const a = r.key;
    if (!a.texts) a.texts = a.text ? [cloneJson(a.text)] : [];
    while (a.texts.length <= textIndex) a.texts.push(this.defaultTextConfig());
    a.texts[textIndex] = cloneJson(textConfig);
    a.text = cloneJson(a.texts[0]);
    this.revision++;
    this.scheduleSave();
  }

  addKeyText(keyIndex: number) {
    const r = this.ensureKey(keyIndex);
    if (!r) return;
    this.saveUndoState(r.scene);
    const a = r.key;
    if (!a.texts) a.texts = a.text ? [cloneJson(a.text)] : [];
    a.texts.push(this.defaultTextConfig());
    a.text = cloneJson(a.texts[0]);
    this.revision++;
    this.scheduleSave();
  }

  removeKeyText(keyIndex: number, textIndex: number) {
    const r = this.keyRef(keyIndex);
    const a = r?.key;
    if (!r || !a?.texts || a.texts.length <= 1) return;
    this.saveUndoState(r.scene);
    a.texts.splice(textIndex, 1);
    a.text = cloneJson(a.texts[0]);
    this.revision++;
    this.scheduleSave();
  }

  getKeyTexts(keyIndex: number): TextConfig[] {
    const a = this.getKeyAssignment(keyIndex);
    if (!a) return [];
    return a.texts?.length ? a.texts : (a.text ? [a.text] : []);
  }

  private emptyIcon(): IconConfig {
    return { setId: "", iconName: "", svgBody: "", color: "#ffffff", size: 48, viewBox: "0 0 24 24" };
  }

  setKeyIcon(keyIndex: number, iconConfig: IconConfig, iconIndex: number = 0) {
    const r = this.ensureKey(keyIndex);
    if (!r) return;
    this.saveUndoState(r.scene);
    const a = r.key;
    if (!a.icons) a.icons = a.icon ? [cloneJson(a.icon)] : [];
    while (a.icons.length <= iconIndex) a.icons.push(this.emptyIcon());
    a.icons[iconIndex] = cloneJson(iconConfig);
    a.icon = cloneJson(a.icons[0]);
    this.revision++;
    this.scheduleSave();
  }

  removeKeyIcon(keyIndex: number) {
    const r = this.keyRef(keyIndex);
    if (!r) return;
    this.saveUndoState(r.scene);
    r.key.icon = undefined;
    r.key.icons = undefined;
    this.revision++;
    this.scheduleSave();
  }

  getKeyIcons(keyIndex: number): IconConfig[] {
    const a = this.getKeyAssignment(keyIndex);
    if (!a) return [];
    return a.icons?.length ? a.icons : (a.icon ? [a.icon] : []);
  }

  addKeyIcon(keyIndex: number) {
    const r = this.ensureKey(keyIndex);
    if (!r) return;
    this.saveUndoState(r.scene);
    const a = r.key;
    if (!a.icons) a.icons = a.icon ? [cloneJson(a.icon)] : [];
    const base = a.icons[0] ? cloneJson(a.icons[0]) : this.emptyIcon();
    a.icons.push({ ...base, variable: "", value: "" });
    a.icon = cloneJson(a.icons[0]);
    this.revision++;
    this.scheduleSave();
  }

  removeKeyIconAt(keyIndex: number, iconIndex: number) {
    const r = this.keyRef(keyIndex);
    if (!r) return;
    const a = r.key;
    if (!a.icons || a.icons.length <= 1) {
      this.removeKeyIcon(keyIndex);
      return;
    }
    this.saveUndoState(r.scene);
    a.icons.splice(iconIndex, 1);
    a.icon = cloneJson(a.icons[0]);
    this.revision++;
    this.scheduleSave();
  }

  togglePinned(keyIndex: number) {
    const r = this.keyRef(keyIndex);
    if (!r) return;
    this.saveUndoState(r.scene);
    r.key.pinned = !r.key.pinned;
    this.revision++;
    this.scheduleSave();
  }

  isPinned(keyIndex: number): boolean { return this.getKeyAssignment(keyIndex)?.pinned ?? false; }

  /** Clear the key at `index` (for a pinned key shown from another scene, that pinned key is removed). */
  clearKey(keyIndex: number) {
    const r = this.keyRef(keyIndex);
    const serial = this.boundSerial;
    if (!r || !serial) return;
    this.saveUndoState(r.scene);
    delete r.scene.keys[String(keyIndex)];
    const ctx = makeContext(serial, r.scene.id, "Keypad", keyIndex);
    this.stopTimer(ctx);
    this.clearRuntimeOverride(ctx);
    this.revision++;
    this.scheduleSave();
  }

  // ═══ Encoder Methods ═══════════════════════════════════════

  defaultEncoderConfig(): EncoderConfig {
    return { pressAction: { ...NONE_ACTION }, pressSettings: {}, rotateAction: { ...NONE_ACTION }, rotateSettings: {},
      label: "", value: "50", min: "0", max: "100", step: 1 };
  }

  getEncoderConfig(index: number): EncoderConfig | undefined {
    void this.revision;
    return this.activeScene?.encoders?.[String(index)];
  }

  getEncoderConfigForDevice(serial: string, index: number): EncoderConfig | undefined {
    return this.getActiveScene(serial)?.encoders?.[String(index)];
  }

  setEncoderConfig(index: number, config: EncoderConfig) {
    const scene = this.activeScene;
    if (!scene) return;
    if (!scene.encoders) scene.encoders = {};
    scene.encoders[String(index)] = cloneJson(config);
    this.revision++;
    this.scheduleSave();
  }

  /** Resolved value/min/max of an encoder of the edited device. */
  getEncoderResolved(index: number): { value: number; min: number; max: number } {
    return this.encoderResolved(this.getEncoderConfig(index));
  }

  private encoderResolved(cfg: EncoderConfig | undefined): { value: number; min: number; max: number } {
    if (!cfg) return { value: 0, min: 0, max: 100 };
    return {
      value: this.resolveNumber(cfg.value, 0),
      min: this.resolveNumber(cfg.min, 0),
      max: this.resolveNumber(cfg.max, 100),
    };
  }

  /**
   * Rotate an encoder on any device. The value updates immediately (bound variable or the literal
   * value, which is persisted); the rotate action runs debounced with the accumulated delta.
   */
  handleEncoderRotateForDevice(serial: string, index: number, delta: number) {
    const scene = this.getActiveScene(serial);
    const cfg = scene?.encoders?.[String(index)];
    if (!scene || !cfg) return;
    const { value: cur, min, max } = this.encoderResolved(cfg);
    const step = Number(cfg.step) || 1;
    const newVal = Math.max(min, Math.min(max, cur + delta * step));

    const varName = tpl.extractVarName(cfg.value);
    if (varName) {
      this.setVariable(varName, String(newVal));
    } else if (cfg.value !== String(newVal)) {
      cfg.value = String(newVal);
      this.revision++;
      this.scheduleSave();
    }

    if (cfg.rotateAction.id === "none") return;
    const k = `${serial}:${scene.id}:${index}`;
    this.encoderDeltaAcc[k] = (this.encoderDeltaAcc[k] ?? 0) + delta;
    clearTimeout(this.encoderActionTimers[k]);
    this.encoderActionTimers[k] = window.setTimeout(() => {
      delete this.encoderActionTimers[k];
      const acc = this.encoderDeltaAcc[k] ?? delta;
      delete this.encoderDeltaAcc[k];
      const latest = this.encoderResolved(cfg);
      this.runAction(cfg.rotateAction.id, {
        ...cfg.rotateSettings,
        value: String(latest.value), delta: String(acc), min: String(latest.min), max: String(latest.max),
      }, { serial, sceneId: scene.id });
    }, 30);
  }

  handleEncoderPressForDevice(serial: string, index: number) {
    const scene = this.getActiveScene(serial);
    const cfg = scene?.encoders?.[String(index)];
    if (!scene || !cfg || cfg.pressAction.id === "none") return;
    const { value, min, max } = this.encoderResolved(cfg);
    this.runAction(cfg.pressAction.id, {
      ...cfg.pressSettings, value: String(value), min: String(min), max: String(max),
    }, { serial, sceneId: scene.id });
  }

  /** Edited/selected device variants (kept for existing callers). */
  handleEncoderRotate(index: number, delta: number) {
    const serial = this.currentSerial ?? this.boundSerial;
    if (serial) this.handleEncoderRotateForDevice(serial, index, delta);
  }

  handleEncoderPress(index: number) {
    const serial = this.currentSerial ?? this.boundSerial;
    if (serial) this.handleEncoderPressForDevice(serial, index);
  }

  // ═══ Action dispatch ═══════════════════════════════════════

  /**
   * Resolve templates per setting value (never inside JSON documents such as multi-action steps).
   * For shell actions, substituted variable values are POSIX single-quoted.
   */
  resolveActionSettings(actionId: string, settings: Record<string, string>): Record<string, string> {
    const raw = RAW_SETTINGS[actionId] ?? [];
    const shell = SHELL_SETTINGS[actionId] ?? [];
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(settings ?? {})) {
      if (typeof v !== "string") { out[k] = v == null ? "" : String(v); continue; }
      if (raw.includes(k)) out[k] = v;
      else if (shell.includes(k)) out[k] = tpl.resolveTemplate(v, this.lookupVar, { transform: tpl.shellQuote });
      else out[k] = tpl.resolveTemplate(v, this.lookupVar);
    }
    return out;
  }

  /**
   * The single action dispatcher for keys, encoders, strip gestures and multi-action steps.
   * Navigation, timer and counter act on ctx.serial's device; everything else goes to the
   * registered plugin executor. Failures (including unknown actions) are logged, stored in
   * lastError and rethrown.
   */
  async executeAction(actionId: string, settings: Record<string, string>, ctx?: ActionContext): Promise<void> {
    if (!actionId || actionId === "none") return;
    try {
      const resolved = this.resolveActionSettings(actionId, settings);
      const serial = ctx?.serial ?? this.currentSerial ?? this.boundSerial ?? undefined;
      switch (actionId) {
        case "switch-scene": {
          const t = this.navTarget(serial);
          if (!t) throw new Error("No device to switch scenes on");
          if (!resolved.sceneId) throw new Error("No target scene configured");
          if (!t.config.scenes[resolved.sceneId]) throw new Error(`Scene ${resolved.sceneId} does not exist on ${t.serial}`);
          if (resolved.mode === "switch") this.switchScene(resolved.sceneId, false, t.serial);
          else this.pushScene(resolved.sceneId, t.serial);
          return;
        }
        case "back":
          this.popScene(serial);
          return;
        case "timer":
        case "counter": {
          const t = this.navTarget(serial);
          if (!t || ctx?.keyIndex === undefined) throw new Error(`${actionId} needs a key to display on`);
          const sceneId = ctx.sceneId ?? t.config.activeSceneId;
          if (!sceneId) throw new Error("No active scene");
          if (actionId === "timer") this.handleTimerPress(t.serial, sceneId, ctx.keyIndex, resolved);
          else this.handleCounterPress(t.serial, sceneId, ctx.keyIndex);
          return;
        }
      }
      const executor = pluginExecutors[actionId];
      if (!executor) {
        const known = pluginActions.some(a => a.id === actionId);
        throw new Error(known ? `Action "${actionId}" has no executor` : `Unknown action "${actionId}" (is its plugin enabled?)`);
      }
      await executor(resolved, ctx);
    } catch (e) {
      const msg = errorMessage(e);
      console.error(`[Action] ${actionId} failed:`, e);
      this.lastError = `${actionId}: ${msg}`;
      throw e;
    }
  }

  /** Fire-and-forget dispatch for internal callers (errors are already surfaced by executeAction). */
  private runAction(actionId: string, settings: Record<string, string>, ctx?: ActionContext) {
    this.executeAction(actionId, settings, ctx).catch(() => {});
  }

  /** Run the action of the key at `keyIndex` on any device's active scene (physical press). */
  async executeKeyAction(serial: string, keyIndex: number): Promise<void> {
    const sceneId = this.profileDevices[serial]?.activeSceneId;
    if (!sceneId) return;
    const key = this.getEffectiveKey(serial, sceneId, keyIndex);
    if (!key) return;
    await this.executeAction(key.action.id, key.settings, { serial, sceneId, keyIndex });
  }

  // ═══ Touch Strip ════════════════════════════════════════════

  /** Strip of the edited device's active scene. */
  getStripConfig(): StripConfig {
    void this.revision;
    return this.activeScene?.strip || DEFAULT_STRIP;
  }

  getStripConfigForDevice(serial: string): StripConfig {
    return this.getActiveScene(serial)?.strip || DEFAULT_STRIP;
  }

  updateStrip(config: StripConfig) {
    const scene = this.activeScene;
    if (!scene) return;
    scene.strip = cloneJson(config);
    this.revision++;
    this.scheduleSave();
  }

  addStripItem(item: StripItem) {
    const cfg = this.getStripConfig();
    this.updateStrip({ ...cfg, items: [...cfg.items, item] });
    this.selectedStripItemId = item.id;
  }

  updateStripItem(id: string, partial: Partial<StripItem>) {
    const cfg = this.getStripConfig();
    const items = cfg.items.map(it => it.id === id ? { ...it, ...partial } : it);
    this.updateStrip({ ...cfg, items });
  }

  removeStripItem(id: string) {
    const cfg = this.getStripConfig();
    this.updateStrip({ ...cfg, items: cfg.items.filter(it => it.id !== id) });
    if (this.selectedStripItemId === id) this.selectedStripItemId = null;
  }

  selectStripItem(id: string | null) {
    this.selectedStripItemId = this.selectedStripItemId === id ? null : id;
    if (this.selectedStripItemId) { this.selectedKeyIndex = null; this.selectedEncoderIndex = null; }
  }

  private hitTestStrip(serial: string, x: number, y: number): StripItem | null {
    const items = this.getStripConfigForDevice(serial).items;
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i];
      if (x >= it.x && x <= it.x + it.w && y >= it.y && y <= it.y + it.h) return it;
    }
    return null;
  }

  /**
   * A swipe belongs to the item it starts on (topmost first), so overshooting into a neighbour never
   * acts there. Only a swipe that starts outside every item falls back to the topmost item whose x
   * range the swipe overlaps.
   */
  private hitTestSwipe(serial: string, fromX: number, toX: number): StripItem | null {
    const items = this.getStripConfigForDevice(serial).items;
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i];
      if (fromX >= it.x && fromX <= it.x + it.w) return it;
    }
    const minX = Math.min(fromX, toX), maxX = Math.max(fromX, toX);
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i];
      if (maxX >= it.x && minX <= it.x + it.w) return it;
    }
    return null;
  }

  private stripCtx(serial: string): ActionContext {
    return { serial, sceneId: this.profileDevices[serial]?.activeSceneId ?? undefined };
  }

  handleStripTapForDevice(serial: string, x: number, y: number) {
    const item = this.hitTestStrip(serial, x, y);
    if (!item?.tapAction || item.tapAction.id === "none") return;
    this.runAction(item.tapAction.id, {
      ...(item.tapSettings ?? {}),
      tap_x: String(x), tap_y: String(y),
      // Swipe-bar: x position within the item as a 0-1 ratio
      ratio: String(Math.max(0, Math.min(1, (x - item.x) / (item.w || 1)))),
    }, this.stripCtx(serial));
  }

  handleStripLongPressForDevice(serial: string, x: number, y: number) {
    const item = this.hitTestStrip(serial, x, y);
    if (!item?.longPressAction || item.longPressAction.id === "none") return;
    this.runAction(item.longPressAction.id, { ...(item.longPressSettings ?? {}) }, this.stripCtx(serial));
  }

  handleStripSwipeForDevice(serial: string, fromX: number, _fromY: number, toX: number, _toY: number) {
    const item = this.hitTestSwipe(serial, fromX, toX);
    if (!item?.swipeAction || item.swipeAction.id === "none") return;
    const w = item.w || 1;
    this.runAction(item.swipeAction.id, {
      ...(item.swipeSettings ?? {}),
      from_x: String(fromX), to_x: String(toX),
      from_ratio: String(Math.max(0, Math.min(1, (fromX - item.x) / w))),
      to_ratio: String(Math.max(0, Math.min(1, (toX - item.x) / w))),
      direction: toX > fromX ? "right" : "left",
      distance: String(Math.abs(toX - fromX)),
    }, this.stripCtx(serial));
  }

  /** Selected-device variants (kept for existing callers). */
  handleStripTap(x: number, y: number) {
    const s = this.currentSerial; if (s) this.handleStripTapForDevice(s, x, y);
  }
  handleStripLongPress(x: number, y: number) {
    const s = this.currentSerial; if (s) this.handleStripLongPressForDevice(s, x, y);
  }
  handleStripSwipe(fromX: number, fromY: number, toX: number, toY: number) {
    const s = this.currentSerial; if (s) this.handleStripSwipeForDevice(s, fromX, fromY, toX, toY);
  }

  // ═══ Contexts, runtime overrides, plugin settings ══════════

  makeContext(serial: string, sceneId: string, controller: ControllerKind, index: number): string {
    return makeContext(serial, sceneId, controller, index);
  }

  parseContext(ctx: string): ParsedContext | null {
    return parseContext(ctx);
  }

  /** Merge `patch` into a context's override; a field set to undefined is removed. */
  setRuntimeOverride(ctx: string, patch: Partial<RuntimeOverride>) {
    const next: RuntimeOverride = { ...(this.runtimeOverrides[ctx] ?? {}) };
    for (const [k, v] of Object.entries(patch) as [keyof RuntimeOverride, unknown][]) {
      if (v === undefined) delete next[k];
      else (next as Record<string, unknown>)[k] = v;
    }
    if (Object.keys(next).length === 0) delete this.runtimeOverrides[ctx];
    else this.runtimeOverrides[ctx] = next;
  }

  clearRuntimeOverride(ctx: string) {
    if (ctx in this.runtimeOverrides) delete this.runtimeOverrides[ctx];
  }

  /**
   * Override to render a key with: the context's runtime override, plus the counter value as the
   * title for counter keys (so the count survives restarts without touching the label).
   */
  getKeyOverride(serial: string, sceneId: string, index: number, key?: KeyAssignment): RuntimeOverride | undefined {
    const o = this.runtimeOverrides[makeContext(serial, sceneId, "Keypad", index)];
    if (key?.action?.id === "counter" && o?.title === undefined) {
      return { ...(o ?? {}), title: key.settings?.value || "0" };
    }
    return o;
  }

  /** getKeyOverride for the edited device's active scene (editor preview). */
  getEditorKeyOverride(index: number): RuntimeOverride | undefined {
    const serial = this.boundSerial, sceneId = this.activeSceneId;
    if (!serial || !sceneId) return undefined;
    return this.getKeyOverride(serial, sceneId, index, this.getEffectiveKey(serial, sceneId, index));
  }

  private contextTarget(ctx: string): { kind: "key"; key: KeyAssignment } | { kind: "encoder"; enc: EncoderConfig } | null {
    const p = parseContext(ctx);
    if (!p) return null;
    if (p.controller === "Keypad") {
      const r = this.findKeyOwner(p.serial, p.sceneId, p.index);
      return r ? { kind: "key", key: r.key } : null;
    }
    const enc = this.profileDevices[p.serial]?.scenes[p.sceneId]?.encoders?.[String(p.index)];
    return enc ? { kind: "encoder", enc } : null;
  }

  /** Persist a plugin's settings object for a context (as JSON in settings.pluginSettings). */
  setPluginSettings(ctx: string, obj: Record<string, unknown>) {
    const t = this.contextTarget(ctx);
    if (!t) { console.warn(`setPluginSettings: no key/encoder at ${ctx}`); return; }
    const json = JSON.stringify(obj ?? {});
    if (t.kind === "key") {
      if (t.key.settings.pluginSettings === json) return;
      t.key.settings = { ...t.key.settings, pluginSettings: json };
    } else {
      // An Elgato encoder action handles both press and rotate: keep both slots in sync.
      if (t.enc.rotateAction.id !== "none") t.enc.rotateSettings = { ...t.enc.rotateSettings, pluginSettings: json };
      if (t.enc.pressAction.id !== "none") t.enc.pressSettings = { ...t.enc.pressSettings, pluginSettings: json };
    }
    this.revision++;
    this.scheduleSave();
  }

  /** Parsed plugin settings of a context ({} when unset or invalid). */
  getPluginSettings(ctx: string): Record<string, unknown> {
    const t = this.contextTarget(ctx);
    if (!t) return {};
    const raw = t.kind === "key"
      ? t.key.settings.pluginSettings
      : (t.enc.rotateSettings.pluginSettings ?? t.enc.pressSettings.pluginSettings);
    if (!raw) return {};
    try {
      const v = JSON.parse(raw);
      return v && typeof v === "object" && !Array.isArray(v) ? v : {};
    } catch { return {}; }
  }

  // ═══ Favorites / Recent ════════════════════════════════════

  getRecentActions(): ActionDef[] { return this.recentActions.map(id => ACTION_TYPES.all.find(a => a.id === id)).filter((a): a is ActionDef => !!a); }
  getFavoriteActions(): ActionDef[] { return this.favoriteActions.map(id => ACTION_TYPES.all.find(a => a.id === id)).filter((a): a is ActionDef => !!a); }
  toggleFavorite(id: string) {
    this.favoriteActions = this.favoriteActions.includes(id) ? this.favoriteActions.filter(x => x !== id) : [...this.favoriteActions, id];
    this.scheduleSave();
  }
  isFavorite(id: string): boolean { return this.favoriteActions.includes(id); }
  private trackRecent(id: string) { this.recentActions = [id, ...this.recentActions.filter(x => x !== id)].slice(0, 10); }

  // ═══ Undo / Redo (per scene, across devices) ═══════════════

  private saveUndoState(scene: Scene | undefined) {
    const serial = this.boundSerial;
    if (!scene || !serial) return;
    this.undoStack = [...this.undoStack.slice(-(MAX_UNDO - 1)), { serial, sceneId: scene.id, keys: cloneJson(scene.keys) }];
    this.redoStack = [];
  }

  /** Restore `entry` into its own scene; returns the snapshot it replaced (for the opposite stack). */
  private restoreEntry(entry: UndoEntry): UndoEntry | null {
    const config = this.profileDevices[entry.serial];
    const scene = config?.scenes[entry.sceneId];
    if (!config || !scene) return null;
    const replaced: UndoEntry = { serial: entry.serial, sceneId: entry.sceneId, keys: cloneJson(scene.keys) };
    scene.keys = cloneJson(entry.keys);
    if (entry.serial === this.boundSerial && config.activeSceneId !== entry.sceneId) {
      this.switchScene(entry.sceneId, false, entry.serial); // show what changed
    }
    this.revision++;
    this.scheduleSave();
    return replaced;
  }

  undo() {
    while (this.undoStack.length > 0) {
      const entry = this.undoStack[this.undoStack.length - 1];
      this.undoStack = this.undoStack.slice(0, -1);
      const replaced = this.restoreEntry(entry);
      if (replaced) { this.redoStack = [...this.redoStack, replaced]; return; }
      // Entry for a deleted scene/device: skip it.
    }
  }

  redo() {
    while (this.redoStack.length > 0) {
      const entry = this.redoStack[this.redoStack.length - 1];
      this.redoStack = this.redoStack.slice(0, -1);
      const replaced = this.restoreEntry(entry);
      if (replaced) { this.undoStack = [...this.undoStack, replaced]; return; }
    }
  }

  canUndo(): boolean { return this.undoStack.length > 0; }
  canRedo(): boolean { return this.redoStack.length > 0; }

  // ═══ Timer / Counter (display via runtime overrides; label never mutated) ═══

  /** Start, or stop and reset, the countdown timer of a key. */
  handleTimerPress(serial: string, sceneId: string, keyIndex: number, settings: Record<string, string>) {
    const ctx = makeContext(serial, sceneId, "Keypad", keyIndex);
    const parsed = parseInt(settings.duration || "60", 10);
    const duration = Number.isFinite(parsed) && parsed > 0 ? parsed : 60;
    if (this.timers[ctx] !== undefined) {
      this.stopTimer(ctx);
      this.setRuntimeOverride(ctx, { title: this.formatTime(duration) });
      return;
    }
    let remaining = duration;
    this.setRuntimeOverride(ctx, { title: this.formatTime(remaining) });
    this.timers[ctx] = window.setInterval(() => {
      remaining--;
      if (remaining <= 0) {
        this.stopTimer(ctx);
        this.setRuntimeOverride(ctx, { title: "DONE" });
        return;
      }
      this.setRuntimeOverride(ctx, { title: this.formatTime(remaining) });
    }, 1000);
  }

  /** Increment a counter key; the count is the key's `value` setting (persisted) and shown as its title. */
  handleCounterPress(serial: string, sceneId: string, keyIndex: number) {
    const r = this.findKeyOwner(serial, sceneId, keyIndex);
    if (!r) return;
    const cur = parseInt(r.key.settings.value || "0", 10);
    const val = (Number.isFinite(cur) ? cur : 0) + 1;
    r.key.settings = { ...r.key.settings, value: String(val) }; // shown as the title by getKeyOverride
    this.revision++;
    this.scheduleSave();
  }

  private stopTimer(ctx: string) {
    const id = this.timers[ctx];
    if (id === undefined) return;
    clearInterval(id);
    delete this.timers[ctx];
  }

  /** Stop timers of a device matching `pred` and clear their displays. */
  private stopTimers(serial: string, pred: (p: ParsedContext) => boolean) {
    for (const ctx of Object.keys(this.timers)) {
      const p = parseContext(ctx);
      if (!p || p.serial !== serial || !pred(p)) continue;
      this.stopTimer(ctx);
      this.setRuntimeOverride(ctx, { title: undefined });
    }
  }

  private stopAllTimers() {
    for (const ctx of Object.keys(this.timers)) {
      this.stopTimer(ctx);
      this.setRuntimeOverride(ctx, { title: undefined });
    }
  }

  // ═══ Helpers ═══════════════════════════════════════════════

  findAction(id: string): ActionDef | undefined { return ACTION_TYPES.all.find(a => a.id === id); }
  searchActions(query: string): ActionDef[] {
    const q = query.toLowerCase().trim();
    return q ? ACTION_TYPES.all.filter(a => a.label.toLowerCase().includes(q) || a.id.includes(q)) : ACTION_TYPES.all;
  }

  defaultTextConfig(): TextConfig {
    return { text: "", fontFamily: "sans-serif", fontSize: 14, fontWeight: "normal", fontStyle: "normal",
      color: "#ffffff", hAlign: "center", vAlign: "middle", anchor: "center", useAbsolutePos: false };
  }

  /** Resolve every setting value's templates (no shell quoting; see resolveActionSettings). */
  resolveSettings(settings: Record<string, string>): Record<string, string> {
    const r: Record<string, string> = {};
    for (const [k, v] of Object.entries(settings)) r[k] = this.resolveTemplate(v);
    return r;
  }

  getDefaultSettings(actionId: string): Record<string, string> {
    switch (actionId) {
      case "hotkey": return { key: "", modifiers: "" };
      case "launch": return { target: "" };
      case "command": return { command: "" };
      case "open-url": return { url: "https://" };
      case "http-request": return { url: "", method: "POST", headers: "", body: "" };
      case "switch-scene": return { sceneId: "", mode: "push" };
      case "back": return {};
      case "timer": return { duration: "60" };
      case "counter": return { value: "0" };
      case "multi-action": return { steps: "[]" };
      default: return {};
    }
  }

  private formatTime(s: number): string { const m = Math.floor(s / 60); return m > 0 ? `${m}:${String(s % 60).padStart(2, "0")}` : `${s}`; }
}

// ─── Singleton ───────────────────────────────────────────────

export const store = new AppStore();
