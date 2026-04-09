import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { renderKeyToDataUrl } from "../utils/render-key";

// ─── Types ───────────────────────────────────────────────────

export interface ActionDef { id: string; label: string; icon: string; color: string; }

export interface TextConfig {
  text: string; fontFamily: string; fontSize: number;
  fontWeight: "normal" | "bold"; fontStyle: "normal" | "italic"; color: string;
  hAlign: "left" | "center" | "right"; vAlign: "top" | "middle" | "bottom";
  anchor: "start" | "center" | "end"; hidden?: boolean;
  x?: number; y?: number; useAbsolutePos: boolean;
}

export interface IconConfig {
  setId: string; iconName: string; svgBody: string; color: string; size: number; viewBox: string;
}

export interface KeyAssignment {
  action: ActionDef; settings: Record<string, string>; backgroundColor: string;
  imagePath?: string; imageDataUrl?: string;
  text?: TextConfig; texts?: TextConfig[]; icon?: IconConfig; pinned?: boolean;
}

export interface SceneTrigger {
  type: "window" | "key_press" | "manual";
  app_name?: string; window_title?: string; priority?: number;
  key_index?: number; mode?: "push" | "switch";
}

export interface EncoderConfig {
  pressAction: ActionDef; pressSettings: Record<string, string>;
  rotateAction: ActionDef; rotateSettings: Record<string, string>;
  label: string;
  value: string;  // number or {{$var}}
  min: string;    // number or {{$var}}
  max: string;    // number or {{$var}}
  step: number;
}

export interface StripItem {
  id: string;
  x: number; y: number; w: number; h: number;
  // Visual (same concepts as KeyAssignment)
  backgroundColor?: string;  // {{$var|rgb}} supported
  imageDataUrl?: string;
  icon?: IconConfig;
  texts?: TextConfig[];
  // Bar indicator (progress fill)
  bar?: {
    value: string;     // {{$var}} or number — current value
    min: string;       // min range
    max: string;       // max range
    color: string;     // fill color, supports {{$var|rgb}}
    position: "bottom" | "full" | "left";  // where the bar renders
    height: number;    // bar height in px (for bottom/top position)
  };
  // Gesture actions
  tapAction?: ActionDef;
  tapSettings?: Record<string, string>;
  longPressAction?: ActionDef;
  longPressSettings?: Record<string, string>;
  swipeAction?: ActionDef;
  swipeSettings?: Record<string, string>;
}

export interface StripConfig {
  backgroundColor: string;
  items: StripItem[];
}

export interface Scene {
  id: string; name: string; keys: Record<string, KeyAssignment>;
  encoders?: Record<string, EncoderConfig>; strip?: StripConfig; triggers: SceneTrigger[];
}

export interface DeviceInfo {
  serial: string; model: string; model_id: string; columns: number; rows: number;
  key_size: number; has_lcd_strip: boolean; has_dials: boolean;
  encoder_count: number; lcd_width: number; lcd_height: number;
}

interface DeviceConfig { scenes: Record<string, Scene>; activeSceneId: string | null; }
interface SavedProfile {
  name: string; devices?: Record<string, DeviceConfig>;
  scenes?: Record<string, Scene>; activeSceneId?: string | null;
  favorites: string[]; recent: string[];
}
interface UndoEntry { sceneId: string; keys: Record<string, KeyAssignment>; }

const NONE_ACTION: ActionDef = { id: "none", label: "None", icon: "", color: "#333" };
const MAX_UNDO = 50;
const TEMPLATE_RE = /\{\{([^}]+)\}\}/g;

/** All action types are now registered by plugins via registerActionType(). */

const pluginActions: ActionDef[] = [];
const pluginExecutors: Record<string, (settings: Record<string, string>) => Promise<void>> = {};

/** Plugins call this to register new action types. */
export function registerActionType(action: ActionDef, executor?: (settings: Record<string, string>) => Promise<void>) {
  if (!pluginActions.find(a => a.id === action.id)) {
    pluginActions.push(action);
  }
  if (executor) pluginExecutors[action.id] = executor;
}

/** Remove a plugin-registered action type from the picker. */
export function unregisterActionType(actionId: string) {
  const idx = pluginActions.findIndex(a => a.id === actionId);
  if (idx >= 0) pluginActions.splice(idx, 1);
  delete pluginExecutors[actionId];
}

/** Execute a plugin-registered action. Returns true if handled. */
export async function executePluginAction(actionId: string, settings: Record<string, string>): Promise<boolean> {
  const executor = pluginExecutors[actionId];
  if (executor) { await executor(settings); return true; }
  return false;
}

/** All registered action types (from plugins). */
export const ACTION_TYPES = { get all() { return [...pluginActions]; } };

// ─── The Store ───────────────────────────────────────────────

class AppStore {
  // ── Devices ──
  devices = $state<DeviceInfo[]>([]);
  selectedDevice = $state<DeviceInfo | null>(null);
  deviceLoading = $state(false);
  deviceError = $state<string | null>(null);

  // ── Scenes ──
  scenes = $state<Record<string, Scene>>({});
  activeSceneId = $state<string | null>(null);
  sceneStack = $state<string[]>([]);

  // ── Selection (key XOR encoder) ──
  selectedKeyIndex = $state<number | null>(null);
  selectedEncoderIndex = $state<number | null>(null);

  // ── Profile ──
  activeProfileName = $state("default");
  profileDevices: Record<string, DeviceConfig> = {};

  // ── Favorites / Recent ──
  recentActions = $state<string[]>([]);
  favoriteActions = $state<string[]>([]);

  // ── Variables ──
  variables = $state<Record<string, string>>({});
  varRevision = $state(0);

  // ── Undo / Redo ──
  undoStack = $state<UndoEntry[]>([]);
  redoStack = $state<UndoEntry[]>([]);

  // ── Internal ──
  revision = $state(0);
  private saveTimer: number | null = null;
  private syncTimers: Record<string, number> = {};
  private syncVersion: Record<string, number> = {};
  private activeTimers: Record<string, number> = {};
  private lastStripVarRev = 0;

  constructor() {
    const id = crypto.randomUUID();
    this.scenes[id] = { id, name: "Default", keys: {}, triggers: [{ type: "manual" }] };
    this.activeSceneId = id;
    this.sceneStack = [id];
  }

  // ═══ Device Methods ════════════════════════════════════════

  get currentSerial(): string | null { return this.selectedDevice?.serial ?? null; }

  async refreshDevices() {
    this.deviceLoading = true;
    this.deviceError = null;
    try {
      const newDevices = await invoke<DeviceInfo[]>("list_devices");
      const changed = newDevices.length !== this.devices.length ||
        newDevices.some((d, i) => d.serial !== this.devices[i]?.serial);
      if (changed) this.devices = newDevices;
      if (this.devices.length > 0 && (!this.selectedDevice || !this.devices.find(d => d.serial === this.selectedDevice?.serial))) {
        await this.selectDevice(this.devices[0]);
      }
      if (this.devices.length === 0 && this.selectedDevice) this.selectedDevice = null;
    } catch (e) { this.deviceError = String(e); }
    finally { this.deviceLoading = false; }
  }

  async selectDevice(device: DeviceInfo) {
    const prevSerial = this.selectedDevice?.serial ?? null;
    this.selectedDevice = device;
    await invoke("open_device", { serial: device.serial }).catch(() => {});
    this.switchToDevice(device.serial, prevSerial);
  }

  // ═══ Variable Methods ══════════════════════════════════════

  getVariable(name: string): string {
    void this.varRevision;
    return this.variables[name] ?? "";
  }

  /** Track recently locally-set variables to suppress HA echo-back */
  private locallySetVars: Record<string, number> = {};
  private LOCAL_SUPPRESS_MS = 500;

  setVariable(name: string, value: string) {
    if (this.variables[name] === value) return;
    this.variables[name] = value;
    this.varRevision++;
    this.locallySetVars[name] = Date.now();
    invoke("set_variable", { name, value }).catch(() => {});
    // Trigger strip sync if this variable is used by the strip
    if (this.selectedDevice?.has_lcd_strip && this.stripUsesVariable(name)) {
      clearTimeout(this.stripSyncDebounce);
      this.stripSyncDebounce = window.setTimeout(() => this.syncStrip(), 50);
    }
  }

  private stripSyncDebounce: number | undefined;
  setVariableLocal(name: string, value: string) {
    if (this.variables[name] === value) return;
    // Suppress remote updates for variables that were just set locally (prevents echo-back flicker)
    const lastLocal = this.locallySetVars[name];
    if (lastLocal && Date.now() - lastLocal < this.LOCAL_SUPPRESS_MS) return;
    this.variables[name] = value;
    this.varRevision++;
    // Only sync strip if this variable is used by any strip item
    if (this.selectedDevice?.has_lcd_strip && this.stripUsesVariable(name)) {
      clearTimeout(this.stripSyncDebounce);
      this.stripSyncDebounce = window.setTimeout(() => this.syncStrip(), 50);
    }
  }

  private stripUsesVariable(varName: string): boolean {
    const cfg = this.activeScene?.strip;
    if (!cfg) return false;
    const needle = varName;
    for (const item of cfg.items) {
      if (item.backgroundColor?.includes(needle)) return true;
      if (item.bar?.value?.includes(needle) || item.bar?.color?.includes(needle)) return true;
      if (item.texts) {
        for (const t of item.texts) {
          if (t.text?.includes(needle) || t.color?.includes(needle)) return true;
        }
      }
    }
    return false;
  }

  deleteVariable(name: string) {
    delete this.variables[name];
    this.varRevision++;
    invoke("delete_variable", { name }).catch(() => {});
  }

  private static FILTERS: Record<string, (val: string) => string> = {
    kelvin: (v) => {
      const k = parseFloat(v) / 100;
      let r: number, g: number, b: number;
      if (k <= 66) { r = 255; g = Math.min(255, Math.max(0, 99.47 * Math.log(k) - 161.12)); }
      else { r = Math.min(255, Math.max(0, 329.7 * Math.pow(k - 60, -0.1332))); g = Math.min(255, Math.max(0, 288.12 * Math.pow(k - 60, -0.0755))); }
      if (k >= 66) b = 255;
      else if (k <= 19) b = 0;
      else b = Math.min(255, Math.max(0, 138.52 * Math.log(k - 10) - 305.04));
      return `#${Math.round(r).toString(16).padStart(2,'0')}${Math.round(g).toString(16).padStart(2,'0')}${Math.round(b).toString(16).padStart(2,'0')}`;
    },
    rgb: (v) => {
      const parts = v.split(",").map(s => parseInt(s.trim()));
      if (parts.length >= 3) return `#${parts.slice(0,3).map(n => (n||0).toString(16).padStart(2,'0')).join('')}`;
      return v;
    },
    round: (v) => String(Math.round(parseFloat(v) || 0)),
    floor: (v) => String(Math.floor(parseFloat(v) || 0)),
    ceil: (v) => String(Math.ceil(parseFloat(v) || 0)),
    percent: (v) => `${Math.round((parseFloat(v) || 0) * 100)}%`,
    upper: (v) => v.toUpperCase(),
    lower: (v) => v.toLowerCase(),
  };

  resolveTemplate(text: string): string {
    void this.varRevision;
    return text.replace(TEMPLATE_RE, (_, expr) => {
      const parts = expr.trim().split("|");
      const name = parts[0].replace(/^\$/, "").trim();
      const rawVal = this.variables[name];
      if (rawVal === undefined) {
        const fallback = parts.length > 1 ? parts.slice(1).join("|") : `{{${expr.trim()}}}`;
        return fallback;
      }
      // Apply filters if any
      let result = rawVal;
      for (let i = 1; i < parts.length; i++) {
        const filterName = parts[i].trim();
        const filter = AppStore.FILTERS[filterName];
        if (filter) result = filter(result);
        else return result; // unknown filter = treat rest as fallback (no-op since value exists)
      }
      return result;
    });
  }

  hasTemplates(text: string): boolean { return text.includes("{{"); }

  extractVariableNames(text: string): string[] {
    const names: string[] = [];
    const re = new RegExp(TEMPLATE_RE.source, TEMPLATE_RE.flags);
    let match;
    while ((match = re.exec(text)) !== null) {
      names.push(match[1].trim().replace(/^\$/, "").split("|")[0].trim());
    }
    return names;
  }

  initVariables() {
    const updateTime = () => {
      const now = new Date();
      this.setVariableLocal("time.now", now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));
      this.setVariableLocal("time.date", now.toLocaleDateString());
      this.setVariableLocal("time.hours", String(now.getHours()).padStart(2, "0"));
      this.setVariableLocal("time.minutes", String(now.getMinutes()).padStart(2, "0"));
      this.setVariableLocal("time.seconds", String(now.getSeconds()).padStart(2, "0"));
    };
    updateTime();
    setInterval(updateTime, 1000);

    listen<{ name: string; value: string }>("variable-changed", (e) => {
      this.setVariableLocal(e.payload.name, e.payload.value);
    });
    listen<{ app_name: string; title: string }>("active-window-changed", (e) => {
      this.setVariableLocal("window.title", e.payload.title);
      this.setVariableLocal("window.app", e.payload.app_name);
    });
  }

  // ═══ Persistence ═══════════════════════════════════════════

  private scheduleSave() {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      const serial = this.currentSerial;
      if (!serial) return;
      this.profileDevices[serial] = JSON.parse(JSON.stringify({ scenes: this.scenes, activeSceneId: this.activeSceneId }));
      const data: SavedProfile = {
        name: this.activeProfileName,
        devices: { ...this.profileDevices },
        favorites: this.favoriteActions,
        recent: this.recentActions,
      };
      invoke("save_json_file", { filename: `profile_${this.activeProfileName}`, content: JSON.stringify(data) }).catch(() => {});
    }, 500);
  }

  async loadProfile(name: string) {
    try {
      const json = await invoke<string | null>("load_json_file", { filename: `profile_${name}` });
      if (!json) return;
      const data: SavedProfile = JSON.parse(json);
      if (data.devices) {
        this.profileDevices = data.devices;
      } else if (data.scenes) {
        const serial = this.currentSerial;
        if (serial) this.profileDevices = { [serial]: { scenes: data.scenes, activeSceneId: data.activeSceneId ?? null } };
      }
      this.favoriteActions = data.favorites || [];
      this.recentActions = data.recent || [];
      this.activeProfileName = name;
      if (this.currentSerial) this.loadDeviceScenes(this.currentSerial);
    } catch (e) { console.error("Failed to load profile:", e); }
  }

  private loadDeviceScenes(serial: string) {
    const config = this.profileDevices[serial];
    Object.keys(this.scenes).forEach(k => delete this.scenes[k]);
    if (config) {
      const cloned = JSON.parse(JSON.stringify(config.scenes));
      Object.assign(this.scenes, cloned);
      this.activeSceneId = config.activeSceneId || Object.keys(this.scenes)[0] || null;
    } else {
      const id = crypto.randomUUID();
      this.scenes[id] = { id, name: "Default", keys: {}, triggers: [{ type: "manual" }] };
      this.activeSceneId = id;
    }
    this.sceneStack = this.activeSceneId ? [this.activeSceneId] : [];
    this.selectedKeyIndex = null;
    this.selectedEncoderIndex = null;
    this.revision++;
    this.syncAllKeysToDevice();
  }

  switchToDevice(serial: string, prevSerial?: string | null) {
    const prev = prevSerial ?? this.currentSerial;
    if (prev && prev !== serial) this.profileDevices[prev] = JSON.parse(JSON.stringify({ scenes: this.scenes, activeSceneId: this.activeSceneId }));
    this.loadDeviceScenes(serial);
    // Don't scheduleSave here — only user mutations should trigger saves
  }

  async listProfiles(): Promise<string[]> {
    try {
      const files = await invoke<string[]>("list_json_files");
      return files.filter(f => f.startsWith("profile_")).map(f => f.replace("profile_", ""));
    } catch { return []; }
  }

  async createProfile(name: string) {
    this.activeProfileName = name;
    Object.keys(this.scenes).forEach(k => delete this.scenes[k]);
    const id = crypto.randomUUID();
    this.scenes[id] = { id, name: "Default", keys: {}, triggers: [{ type: "manual" }] };
    this.activeSceneId = id;
    this.sceneStack = [id];
    this.favoriteActions = [];
    this.revision++;
    this.scheduleSave();
    this.syncAllKeysToDevice();
  }

  async deleteProfile(name: string) {
    await invoke("delete_json_file", { filename: `profile_${name}` }).catch(() => {});
  }

  async initStore() {
    if ((window as any).__osd_initialized) return;
    (window as any).__osd_initialized = true;
    await this.loadProfile("default").catch(() => {});
  }

  // ═══ Scene Methods ═════════════════════════════════════════

  private get activeScene(): Scene | undefined {
    return this.activeSceneId ? this.scenes[this.activeSceneId] : undefined;
  }

  getScenes(): Scene[] { void this.revision; return Object.values(this.scenes); }
  getActiveScene(): Scene | undefined { void this.revision; return this.activeScene; }
  getActiveSceneId(): string | null { return this.activeSceneId; }
  getSceneStack(): string[] { return this.sceneStack; }

  createScene(name: string): Scene {
    const id = crypto.randomUUID();
    const scene: Scene = { id, name, keys: {}, triggers: [{ type: "manual" }] };
    this.scenes[id] = scene;
    this.revision++;
    return scene;
  }

  deleteScene(id: string) {
    if (Object.keys(this.scenes).length <= 1) return;
    delete this.scenes[id];
    if (this.activeSceneId === id) this.switchScene(Object.keys(this.scenes)[0]);
    this.revision++;
    this.scheduleSave();
  }

  renameScene(id: string, name: string) {
    if (this.scenes[id]) { this.scenes[id] = { ...this.scenes[id], name }; this.revision++; this.scheduleSave(); }
  }

  updateSceneTriggers(id: string, triggers: SceneTrigger[]) {
    if (this.scenes[id]) { this.scenes[id] = { ...this.scenes[id], triggers }; this.revision++; this.scheduleSave(); }
  }

  duplicateScene(id: string): Scene | undefined {
    const src = this.scenes[id];
    if (!src) return;
    const s = this.createScene(src.name + " (copy)");
    s.keys = JSON.parse(JSON.stringify(src.keys));
    this.scenes[s.id] = s;
    this.revision++;
    return s;
  }

  // ── Scene Navigation ──

  switchScene(id: string, preserveSelection = false) {
    if (!this.scenes[id] || this.activeSceneId === id) return;
    this.carryPinnedKeys(this.activeSceneId, id);
    this.activeSceneId = id;
    this.sceneStack = [id];
    if (!preserveSelection) { this.selectedKeyIndex = null; this.selectedEncoderIndex = null; }
    this.revision++;
    this.syncAllKeysToDevice();
  }

  pushScene(id: string) {
    if (!this.scenes[id]) return;
    this.carryPinnedKeys(this.activeSceneId, id);
    this.sceneStack = [...this.sceneStack, id];
    this.activeSceneId = id;
    this.selectedKeyIndex = null;
    this.revision++;
    this.syncAllKeysToDevice();
  }

  popScene() {
    if (this.sceneStack.length <= 1) return;
    const prevId = this.activeSceneId;
    this.sceneStack = this.sceneStack.slice(0, -1);
    this.activeSceneId = this.sceneStack[this.sceneStack.length - 1];
    this.carryPinnedKeys(prevId, this.activeSceneId);
    this.selectedKeyIndex = null;
    this.revision++;
    this.syncAllKeysToDevice();
  }

  private carryPinnedKeys(fromId: string | null, toId: string) {
    if (!fromId) return;
    const from = this.scenes[fromId], to = this.scenes[toId];
    if (!from || !to) return;
    for (const [idx, key] of Object.entries(from.keys)) {
      if (key.pinned && !to.keys[idx]) to.keys[idx] = { ...key };
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

  // ═══ Key Methods ═══════════════════════════════════════════

  getKeyAssignment(index: number): KeyAssignment | undefined {
    void this.revision;
    return this.activeScene?.keys[String(index)];
  }

  assignAction(keyIndex: number, action: ActionDef) {
    const scene = this.activeScene;
    if (!scene) return;
    this.saveUndoState();
    const existing = scene.keys[String(keyIndex)];
    scene.keys[String(keyIndex)] = {
      action, settings: this.getDefaultSettings(action.id),
      backgroundColor: existing?.backgroundColor || "#000000",
      imagePath: existing?.imagePath, imageDataUrl: existing?.imageDataUrl,
      text: existing?.text, icon: existing?.icon,
    };
    this.trackRecent(action.id);
    this.revision++;
    this.saveAndSync(keyIndex);
  }

  swapKeys(from: number, to: number) {
    const scene = this.activeScene;
    if (!scene || from === to) return;
    this.saveUndoState();
    const a = scene.keys[String(from)], b = scene.keys[String(to)];
    if (a) scene.keys[String(to)] = a; else delete scene.keys[String(to)];
    if (b) scene.keys[String(from)] = b; else delete scene.keys[String(from)];
    this.revision++;
    this.saveAndSync(from);
    this.syncKeyToDevice(to);
  }

  updateKeySetting(keyIndex: number, key: string, value: string) {
    const a = this.activeScene?.keys[String(keyIndex)];
    if (a) { a.settings = { ...a.settings, [key]: value }; this.revision++; this.saveAndSync(keyIndex); }
  }

  setKeyBackgroundColor(keyIndex: number, color: string) {
    this.ensureKey(keyIndex);
    const a = this.activeScene?.keys[String(keyIndex)];
    if (a) { a.backgroundColor = color; this.revision++; this.saveAndSync(keyIndex); }
  }

  setKeyImage(keyIndex: number, dataUrl: string, filePath?: string) {
    this.ensureKey(keyIndex);
    const a = this.activeScene?.keys[String(keyIndex)];
    if (a) { a.imageDataUrl = dataUrl; a.imagePath = filePath; this.revision++; this.saveAndSync(keyIndex); }
  }

  removeKeyImage(keyIndex: number) {
    const a = this.activeScene?.keys[String(keyIndex)];
    if (a) { a.imageDataUrl = undefined; a.imagePath = undefined; this.revision++; this.saveAndSync(keyIndex); }
  }

  setKeyText(keyIndex: number, textConfig: TextConfig, textIndex: number = 0) {
    this.ensureKey(keyIndex);
    const scene = this.activeScene;
    if (!scene) return;
    const a = scene.keys[String(keyIndex)];
    if (!a) return;
    const texts = a.texts ? [...a.texts] : [];
    while (texts.length <= textIndex) texts.push(this.defaultTextConfig());
    texts[textIndex] = textConfig;
    scene.keys[String(keyIndex)] = { ...a, texts, text: texts[0] };
    this.revision++;
    this.saveAndSync(keyIndex);
  }

  addKeyText(keyIndex: number) {
    this.ensureKey(keyIndex);
    const scene = this.activeScene;
    if (!scene) return;
    const a = scene.keys[String(keyIndex)];
    if (!a) return;
    const texts = a.texts ? [...a.texts] : (a.text ? [a.text] : []);
    texts.push(this.defaultTextConfig());
    scene.keys[String(keyIndex)] = { ...a, texts, text: texts[0] };
    this.revision++;
    this.saveAndSync(keyIndex);
  }

  removeKeyText(keyIndex: number, textIndex: number) {
    const scene = this.activeScene;
    if (!scene) return;
    const a = scene.keys[String(keyIndex)];
    if (!a?.texts || a.texts.length <= 1) return;
    const texts = a.texts.filter((_, i) => i !== textIndex);
    scene.keys[String(keyIndex)] = { ...a, texts, text: texts[0] };
    this.revision++;
    this.saveAndSync(keyIndex);
  }

  getKeyTexts(keyIndex: number): TextConfig[] {
    const a = this.getKeyAssignment(keyIndex);
    if (!a) return [];
    return a.texts?.length ? a.texts : (a.text ? [a.text] : []);
  }

  setKeyIcon(keyIndex: number, iconConfig: IconConfig) {
    this.ensureKey(keyIndex);
    const a = this.activeScene?.keys[String(keyIndex)];
    if (a) { a.icon = iconConfig; this.revision++; this.saveAndSync(keyIndex); }
  }

  removeKeyIcon(keyIndex: number) {
    const a = this.activeScene?.keys[String(keyIndex)];
    if (a) { a.icon = undefined; this.revision++; this.saveAndSync(keyIndex); }
  }

  togglePinned(keyIndex: number) {
    const scene = this.activeScene;
    if (!scene) return;
    const a = scene.keys[String(keyIndex)];
    if (a) { scene.keys[String(keyIndex)] = { ...a, pinned: !a.pinned }; this.revision++; this.scheduleSave(); }
  }

  isPinned(keyIndex: number): boolean { return this.getKeyAssignment(keyIndex)?.pinned ?? false; }

  clearKey(keyIndex: number) {
    const scene = this.activeScene;
    if (scene) { this.saveUndoState(); delete scene.keys[String(keyIndex)]; this.revision++; this.saveAndSync(keyIndex); }
  }

  // ═══ Encoder Methods ═══════════════════════════════════════

  defaultEncoderConfig(): EncoderConfig {
    return { pressAction: NONE_ACTION, pressSettings: {}, rotateAction: NONE_ACTION, rotateSettings: {},
      label: "", value: "50", min: "0", max: "100", step: 1 };
  }

  getEncoderConfig(index: number): EncoderConfig | undefined {
    void this.revision;
    return this.activeScene?.encoders?.[String(index)];
  }

  setEncoderConfig(index: number, config: EncoderConfig) {
    const scene = this.activeScene;
    if (!scene) return;
    if (!scene.encoders) scene.encoders = {};
    scene.encoders[String(index)] = config;
    this.revision++;
    this.scheduleSave();
  }

  /** Resolve any field — returns number if parseable, uses resolveTemplate for {{$var}} */
  resolveNumber(input: string | number | undefined, fallback: number): number {
    if (input === undefined || input === null || input === "") return fallback;
    if (typeof input === "number") return input;
    const resolved = this.resolveTemplate(input);
    if (resolved === input && input.includes("{{")) return fallback; // variable not set yet
    const parsed = parseFloat(resolved);
    return isNaN(parsed) ? fallback : parsed;
  }

  /** Extract variable name from template: {{$name}} → name */
  private extractVarName(template: string): string | null {
    const m = template.match(/^\{\{\$?([^}|]+)/);
    return m ? m[1].trim() : null;
  }

  /** Read all resolved encoder values at once */
  getEncoderResolved(index: number): { value: number; min: number; max: number } {
    const cfg = this.getEncoderConfig(index);
    if (!cfg) return { value: 0, min: 0, max: 100 };
    return {
      value: this.resolveNumber(cfg.value, 0),
      min: this.resolveNumber(cfg.min, 0),
      max: this.resolveNumber(cfg.max, 100),
    };
  }

  private encoderActionTimers: Record<string, number> = {};

  handleEncoderRotate(index: number, delta: number) {
    const scene = this.activeScene;
    if (!scene) return;
    if (!scene.encoders) scene.encoders = {};
    const cfg = scene.encoders[String(index)] || this.defaultEncoderConfig();
    const { value: cur, min, max } = this.getEncoderResolved(index);
    const newVal = Math.max(min, Math.min(max, cur + delta * cfg.step));

    // Update value immediately (UI stays responsive)
    const varName = this.extractVarName(cfg.value);
    if (varName) {
      this.setVariable(varName, String(newVal));
    } else {
      cfg.value = String(newVal);
    }
    scene.encoders[String(index)] = { ...cfg };
    this.revision++;

    // Debounce the action execution — accumulates rapid rotations into one request
    if (cfg.rotateAction.id !== "none") {
      const k = String(index);
      clearTimeout(this.encoderActionTimers[k]);
      this.encoderActionTimers[k] = window.setTimeout(() => {
        const latest = this.getEncoderResolved(index);
        const resolved = this.resolveSettings(cfg.rotateSettings);
        resolved.value = String(latest.value);
        resolved.delta = String(delta);
        resolved.min = String(latest.min);
        resolved.max = String(latest.max);
        this.executeAction(cfg.rotateAction.id, resolved);
      }, 30);
    }
  }

  handleEncoderPress(index: number) {
    const cfg = this.getEncoderConfig(index);
    if (!cfg || cfg.pressAction.id === "none") return;
    const { value, min, max } = this.getEncoderResolved(index);
    const resolved = this.resolveSettings(cfg.pressSettings);
    resolved.value = String(value);
    resolved.min = String(min);
    resolved.max = String(max);
    this.executeAction(cfg.pressAction.id, resolved);
  }

  /** Unified action execution: tries plugin executor first, falls back to Rust backend. */
  private async executeAction(actionId: string, settings: Record<string, string>) {
    try {
      const handled = await executePluginAction(actionId, settings);
      if (!handled) {
        invoke("execute_action", { actionType: actionId, settings: JSON.stringify(settings) }).catch(() => {});
      }
    } catch (e) {
      // Silently ignore connection errors — don't spam console
    }
  }

  // ═══ Touch Strip ════════════════════════════════════════════

  selectedStripItemId = $state<string | null>(null);

  getStripConfig(): StripConfig {
    void this.revision;
    return this.activeScene?.strip || { backgroundColor: "#0a0a1a", items: [] };
  }

  updateStrip(config: StripConfig) {
    const scene = this.activeScene;
    if (!scene) return;
    scene.strip = config;
    this.revision++;
    this.scheduleSave();
    this.syncStrip();
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

  private hitTestStrip(x: number, y: number): StripItem | null {
    const cfg = this.getStripConfig();
    for (let i = cfg.items.length - 1; i >= 0; i--) {
      const it = cfg.items[i];
      if (x >= it.x && x <= it.x + it.w && y >= it.y && y <= it.y + it.h) return it;
    }
    return null;
  }

  handleStripTap(x: number, y: number) {
    const item = this.hitTestStrip(x, y);
    if (item?.tapAction && item.tapAction.id !== "none" && item.tapSettings) {
      const resolved = this.resolveSettings(item.tapSettings);
      resolved.tap_x = String(x);
      resolved.tap_y = String(y);
      // Swipe-bar: map x position within item to 0-1 ratio
      resolved.ratio = String(Math.max(0, Math.min(1, (x - item.x) / item.w)));
      this.executeAction(item.tapAction.id, resolved);
    }
  }

  handleStripLongPress(x: number, y: number) {
    const item = this.hitTestStrip(x, y);
    if (item?.longPressAction && item.longPressAction.id !== "none" && item.longPressSettings) {
      const resolved = this.resolveSettings(item.longPressSettings);
      this.executeAction(item.longPressAction.id, resolved);
    }
  }

  /** Hit-test for swipe — checks if either start or end of swipe intersects any item */
  private hitTestSwipe(fromX: number, fromY: number, toX: number, toY: number): StripItem | null {
    const cfg = this.getStripConfig();
    const minX = Math.min(fromX, toX);
    const maxX = Math.max(fromX, toX);
    for (let i = cfg.items.length - 1; i >= 0; i--) {
      const it = cfg.items[i];
      // Swipe intersects item if the swipe range overlaps the item's x range
      if (maxX >= it.x && minX <= it.x + it.w) return it;
    }
    return null;
  }

  handleStripSwipe(fromX: number, fromY: number, toX: number, toY: number) {
    const item = this.hitTestSwipe(fromX, fromY, toX, toY);
    if (item?.swipeAction && item.swipeAction.id !== "none" && item.swipeSettings) {
      // Calculate ratio based on the END position relative to the item
      const toRatio = Math.max(0, Math.min(1, (toX - item.x) / item.w));
      const resolved = this.resolveSettings(item.swipeSettings);
      resolved.from_x = String(fromX);
      resolved.to_x = String(toX);
      resolved.from_ratio = String(Math.max(0, Math.min(1, (fromX - item.x) / item.w)));
      resolved.to_ratio = String(Math.max(0, Math.min(1, (toX - item.x) / item.w)));
      resolved.direction = toX > fromX ? "right" : "left";
      resolved.distance = String(Math.abs(toX - fromX));
      this.executeAction(item.swipeAction.id, resolved);
    }
  }

  /** Render the full 800x100 strip and push to device */
  private stripSyncTimer: number | undefined;
  syncStrip() {
    if (!this.selectedDevice?.has_lcd_strip) return;
    clearTimeout(this.stripSyncTimer);
    this.stripSyncTimer = window.setTimeout(async () => {
      const cfg = this.getStripConfig();
      const canvas = document.createElement("canvas");
      canvas.width = 800; canvas.height = 100;
      const ctx = canvas.getContext("2d")!;

      // Background
      const bg = this.resolveTemplate(cfg.backgroundColor || "#0a0a1a");
      ctx.fillStyle = (bg.startsWith("#") || bg.startsWith("rgb")) ? bg : "#0a0a1a";
      ctx.fillRect(0, 0, 800, 100);

      // Render items in order
      for (const item of cfg.items) {
        await this.renderStripItemAsync(ctx, item);
      }

      const dataUrl = canvas.toDataURL("image/jpeg", 0.90);
      invoke("send_lcd_image", { x: 0, y: 0, w: 800, h: 100, imageData: dataUrl }).catch(() => {});
    }, 100);
  }

  private async renderStripItemAsync(ctx: CanvasRenderingContext2D, item: StripItem) {
    const { x, y, w, h } = item;

    // Clip to item bounds
    ctx.save();
    ctx.beginPath(); ctx.roundRect(x, y, w, h, 4); ctx.clip();

    // Background
    if (item.backgroundColor) {
      const bg = this.resolveTemplate(item.backgroundColor);
      ctx.fillStyle = (bg.startsWith("#") || bg.startsWith("rgb")) ? bg : "#333";
      ctx.fillRect(x, y, w, h);
    }

    // Bar indicator
    if (item.bar) {
      const val = this.resolveNumber(item.bar.value, 0);
      const min = this.resolveNumber(item.bar.min, 0);
      const max = this.resolveNumber(item.bar.max, 100);
      const ratio = max > min ? Math.max(0, Math.min(1, (val - min) / (max - min))) : 0;
      const barColor = this.resolveTemplate(item.bar.color || "#03a9f4");
      ctx.fillStyle = (barColor.startsWith("#") || barColor.startsWith("rgb")) ? barColor : "#03a9f4";
      if (item.bar.position === "full") {
        ctx.fillRect(x, y, w * ratio, h);
      } else if (item.bar.position === "left") {
        const bw = item.bar.height || 8;
        ctx.fillStyle = "rgba(255,255,255,0.1)";
        ctx.fillRect(x, y, bw, h);
        ctx.fillStyle = (barColor.startsWith("#") || barColor.startsWith("rgb")) ? barColor : "#03a9f4";
        ctx.fillRect(x, y + h * (1 - ratio), bw, h * ratio);
      } else {
        // bottom (default)
        const bh = item.bar.height || 8;
        const barFill = (barColor.startsWith("#") || barColor.startsWith("rgb")) ? barColor : "#03a9f4";
        // track background
        ctx.fillStyle = "rgba(255,255,255,0.1)";
        ctx.beginPath(); ctx.roundRect(x + 4, y + h - bh - 4, w - 8, bh, 3); ctx.fill();
        // fill proportional
        ctx.fillStyle = barFill;
        ctx.beginPath(); ctx.roundRect(x + 4, y + h - bh - 4, (w - 8) * ratio, bh, 3); ctx.fill();
      }
    }

    // Image
    if (item.imageDataUrl) {
      try {
        const img = await this.loadImg(item.imageDataUrl);
        ctx.drawImage(img, x, y, w, h);
      } catch {}
    }

    // Icon
    if (item.icon) {
      const iconSize = Math.min(item.icon.size || 48, h - 4);
      const color = item.icon.color || "#fff";
      const svgStr = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${item.icon.viewBox}" width="${iconSize}" height="${iconSize}"><style>*{fill:none;stroke:${color};stroke-width:2;stroke-linecap:round;stroke-linejoin:round;}</style>${item.icon.svgBody}</svg>`;
      try {
        const svgB64 = btoa(unescape(encodeURIComponent(svgStr)));
        const img = await this.loadImg(`data:image/svg+xml;base64,${svgB64}`);
        ctx.drawImage(img, x + (w - iconSize) / 2, y + (h - iconSize) / 2, iconSize, iconSize);
      } catch {}
    }

    // Text layers
    if (item.texts) {
      for (const t of item.texts) {
        if (!t?.text || t.hidden) continue;
        const text = this.resolveTemplate(t.text);
        const color = this.resolveTemplate(t.color || "#fff");
        ctx.fillStyle = (color.startsWith("#") || color.startsWith("rgb")) ? color : "#fff";
        const weight = t.fontWeight === "bold" ? "bold " : "";
        const style = t.fontStyle === "italic" ? "italic " : "";
        ctx.font = `${style}${weight}${t.fontSize || 14}px ${t.fontFamily || "sans-serif"}`;

        // Position text relative to item bounds
        let tx: number, ty: number;
        if (t.useAbsolutePos) { tx = x + (t.x || 0); ty = y + (t.y || 0); }
        else {
          tx = t.hAlign === "left" ? x + 4 : t.hAlign === "right" ? x + w - 4 : x + w / 2;
          ty = t.vAlign === "top" ? y + t.fontSize : t.vAlign === "bottom" ? y + h - 4 : y + h / 2;
        }
        ctx.textAlign = t.hAlign === "left" ? "left" : t.hAlign === "right" ? "right" : "center";
        ctx.textBaseline = t.vAlign === "top" ? "top" : t.vAlign === "bottom" ? "bottom" : "middle";
        ctx.fillText(text, tx, ty, w - 8);
      }
    }
    ctx.restore(); // end clip
  }

  private loadImg(src: string): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = src;
    });
  }

  // ═══ Favorites / Recent ════════════════════════════════════

  getRecentActions(): ActionDef[] { return this.recentActions.map(id => ACTION_TYPES.all.find(a => a.id === id)).filter((a): a is ActionDef => !!a); }
  getFavoriteActions(): ActionDef[] { return this.favoriteActions.map(id => ACTION_TYPES.all.find(a => a.id === id)).filter((a): a is ActionDef => !!a); }
  toggleFavorite(id: string) { this.favoriteActions = this.favoriteActions.includes(id) ? this.favoriteActions.filter(x => x !== id) : [...this.favoriteActions, id]; }
  isFavorite(id: string): boolean { return this.favoriteActions.includes(id); }
  private trackRecent(id: string) { this.recentActions = [id, ...this.recentActions.filter(x => x !== id)].slice(0, 10); }

  // ═══ Undo / Redo ═══════════════════════════════════════════

  private saveUndoState() {
    const scene = this.activeScene;
    if (!scene) return;
    this.undoStack = [...this.undoStack.slice(-(MAX_UNDO - 1)), { sceneId: scene.id, keys: JSON.parse(JSON.stringify(scene.keys)) }];
    this.redoStack = [];
  }

  undo() {
    if (this.undoStack.length === 0) return;
    const scene = this.activeScene;
    if (!scene) return;
    this.redoStack = [...this.redoStack, { sceneId: scene.id, keys: JSON.parse(JSON.stringify(scene.keys)) }];
    const prev = this.undoStack[this.undoStack.length - 1];
    this.undoStack = this.undoStack.slice(0, -1);
    if (prev.sceneId === scene.id) { scene.keys = prev.keys; this.revision++; this.syncAllKeysToDevice(); }
  }

  redo() {
    if (this.redoStack.length === 0) return;
    const scene = this.activeScene;
    if (!scene) return;
    this.undoStack = [...this.undoStack, { sceneId: scene.id, keys: JSON.parse(JSON.stringify(scene.keys)) }];
    const next = this.redoStack[this.redoStack.length - 1];
    this.redoStack = this.redoStack.slice(0, -1);
    if (next.sceneId === scene.id) { scene.keys = next.keys; this.revision++; this.syncAllKeysToDevice(); }
  }

  canUndo(): boolean { return this.undoStack.length > 0; }
  canRedo(): boolean { return this.redoStack.length > 0; }

  // ═══ Timer / Counter ═══════════════════════════════════════

  handleTimerPress(keyIndex: number) {
    const a = this.activeScene?.keys[String(keyIndex)];
    if (!a) return;
    const duration = parseInt(a.settings.duration || "60");
    if (this.activeTimers[String(keyIndex)]) {
      clearInterval(this.activeTimers[String(keyIndex)]);
      delete this.activeTimers[String(keyIndex)];
      a.text = { ...this.defaultTextConfig(), text: this.formatTime(duration), fontSize: 20, color: "#ffffff" };
      this.revision++; this.syncKeyToDevice(keyIndex); return;
    }
    let remaining = duration;
    a.text = { ...this.defaultTextConfig(), text: this.formatTime(remaining), fontSize: 20, color: "#00ff00" };
    this.revision++; this.syncKeyToDevice(keyIndex);
    this.activeTimers[String(keyIndex)] = window.setInterval(() => {
      remaining--;
      const ka = this.activeScene?.keys[String(keyIndex)];
      if (!ka || remaining <= 0) {
        clearInterval(this.activeTimers[String(keyIndex)]); delete this.activeTimers[String(keyIndex)];
        if (ka) { ka.text = { ...this.defaultTextConfig(), text: "DONE", fontSize: 16, color: "#ff0000" }; this.revision++; this.syncKeyToDevice(keyIndex); }
        return;
      }
      ka.text = { ...this.defaultTextConfig(), text: this.formatTime(remaining), fontSize: 20, color: remaining <= 10 ? "#ff4444" : "#00ff00" };
      this.revision++; this.syncKeyToDevice(keyIndex);
    }, 1000);
  }

  handleCounterPress(keyIndex: number) {
    const a = this.activeScene?.keys[String(keyIndex)];
    if (!a) return;
    const val = parseInt(a.settings.value || "0") + 1;
    a.settings.value = String(val);
    a.text = { ...this.defaultTextConfig(), text: String(val), fontSize: 24, color: "#ffffff" };
    this.revision++; this.syncKeyToDevice(keyIndex);
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

  resolveSettings(settings: Record<string, string>): Record<string, string> {
    const r: Record<string, string> = {};
    for (const [k, v] of Object.entries(settings)) r[k] = this.resolveTemplate(v);
    return r;
  }

  private ensureKey(keyIndex: number) {
    const scene = this.activeScene;
    if (!scene || scene.keys[String(keyIndex)]) return;
    scene.keys[String(keyIndex)] = { action: NONE_ACTION, settings: {}, backgroundColor: "#000000" };
  }

  private getDefaultSettings(actionId: string): Record<string, string> {
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
      default: return {};
    }
  }

  private formatTime(s: number): string { const m = Math.floor(s / 60); return m > 0 ? `${m}:${String(s % 60).padStart(2, "0")}` : `${s}`; }

  // ═══ Device Sync ═══════════════════════════════════════════

  /** Sync key to device AND save profile. Called from user-initiated mutations. */
  private saveAndSync(keyIndex: number) {
    this.scheduleSave();
    this.syncKeyToDevice(keyIndex);
  }

  syncKeyToDevice(keyIndex: number) {
    const k = String(keyIndex);
    if (this.syncTimers[k]) clearTimeout(this.syncTimers[k]);
    const ver = (this.syncVersion[k] || 0) + 1;
    this.syncVersion[k] = ver;
    this.syncTimers[k] = window.setTimeout(async () => {
      if (this.syncVersion[k] !== ver) return;
      const a = this.getKeyAssignment(keyIndex);
      try {
        if (a) {
          const url = await renderKeyToDataUrl(a, this.selectedDevice?.key_size || 72);
          if (this.syncVersion[k] !== ver) return;
          await invoke("send_rendered_image", { keyIndex, imageData: url });
        } else {
          await invoke("clear_key", { keyIndex });
        }
      } catch {}
    }, 100);
  }

  syncAllKeysToDevice() {
    this.syncStrip();
    const scene = this.activeScene;
    if (!scene) return;
    const maxKey = Object.keys(scene.keys).reduce((max, k) => Math.max(max, Number(k)), -1);
    for (let i = 0; i <= maxKey; i++) this.syncKeyToDevice(i);
  }
}

// ─── Singleton ───────────────────────────────────────────────

export const store = new AppStore();
