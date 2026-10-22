import { invoke } from "@tauri-apps/api/core";
import { attrToVariable, nullAttrValue, parseNumericSetting, quantize, ratioToValue } from "./mapping";

export interface HAEntity {
  entity_id: string;
  state: string;
  attributes: Record<string, any>;
  friendly_name: string;
  domain: string;
}

export interface HAService {
  domain: string;
  services: Record<string, { name: string; description: string; fields: Record<string, any> }>;
}

/** A numeric attribute of an entity that can be driven by an encoder or strip gesture. */
export interface HAControl {
  id: string;
  label: string;
  domain: string;
  service: string;
  /** Service-data key written when setting the value (e.g. "position" for set_cover_position). */
  attr: string;
  /** Entity attribute that reports the current value, when it differs from `attr` (covers: "current_position"). */
  readAttr?: string;
  min: number;
  max: number;
  step: number;
}

/** Persisted shape of ha_config.json. Unknown keys are preserved on write. */
interface HAConfigFile {
  url?: string;
  token?: string;
  watched?: string[];
  [key: string]: unknown;
}

export interface HAStatus {
  connected: boolean;
  /** Last connection/auth error, cleared on successful auth. */
  error: string | null;
}

interface PendingRequest {
  resolve: (msg: any) => void;
  reject: (err: Error) => void;
  timer: number;
}

const REQUEST_TIMEOUT_MS = 10_000;
const TIMEOUT_MESSAGE = "Home Assistant request timed out";
const RECONNECT_BASE_MS = 1_000;
/** Kept short so deck keys work again soon after a routine Home Assistant restart. */
const RECONNECT_MAX_MS = 10_000;
/** A `ping` is sent this often while connected; a missed `pong` drops the (half-open) socket. */
const HEARTBEAT_INTERVAL_MS = 30_000;
/** This many request timeouts in a row also drop the socket. */
const MAX_CONSECUTIVE_TIMEOUTS = 2;

/**
 * Home Assistant WebSocket client.
 * Persistent connection, auto-reconnect with exponential backoff, entity/service caching.
 * A heartbeat detects half-open sockets (suspend/resume, network change), which never fire `close`.
 */
export class HAClient {
  private ws: WebSocket | null = null;
  private msgId = 1;
  private pending = new Map<number, PendingRequest>();
  private _connected = false;
  private _error: string | null = null;
  private _url = "";
  private _token = "";
  private reconnectTimer: number | null = null;
  private reconnectAttempts = 0;
  private heartbeatTimer: number | null = null;
  private consecutiveTimeouts = 0;
  private onlineListener: (() => void) | null = null;
  /** Set by disconnect() and on auth failure: the socket's close must not schedule a reconnect. */
  private manualClose = false;
  private entities: HAEntity[] = [];
  private services: HAService[] = [];
  private onStateChange: ((entities: HAEntity[]) => void) | null = null;
  private statusListeners = new Set<(status: HAStatus) => void>();
  /** Serializes read-modify-write cycles on ha_config.json. */
  private configWrite: Promise<void> = Promise.resolve();

  get connected() { return this._connected; }
  get url() { return this._url; }
  get lastError() { return this._error; }

  /** Subscribe to connection status changes. Returns an unsubscribe function. */
  onStatus(listener: (status: HAStatus) => void): () => void {
    this.statusListeners.add(listener);
    return () => { this.statusListeners.delete(listener); };
  }

  private emitStatus() {
    const status: HAStatus = { connected: this._connected, error: this._error };
    for (const l of this.statusListeners) {
      try { l(status); } catch (e) { console.error("[HA] Status listener failed:", e); }
    }
  }

  // ─── Config file ───────────────────────────────────────────

  async loadConfig(): Promise<HAConfigFile | null> {
    try {
      const json = await invoke<string | null>("load_json_file", { filename: "ha_config" });
      if (!json) return null;
      const parsed = JSON.parse(json);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
    } catch (e) {
      console.error("[HA] Failed to read ha_config.json:", e);
      return null;
    }
  }

  /** Read-modify-write ha_config.json; writes are serialized so concurrent updates cannot drop keys. */
  private updateConfigFile(mutate: (cfg: HAConfigFile) => void): Promise<void> {
    const run = async () => {
      const cfg: HAConfigFile = (await this.loadConfig()) ?? {
        url: this._url,
        token: this._token,
        watched: [...this.watchedEntities],
      };
      mutate(cfg);
      await invoke("save_json_file", { filename: "ha_config", content: JSON.stringify(cfg) });
    };
    const next = this.configWrite.then(run, run);
    this.configWrite = next.catch(() => {});
    return next;
  }

  /** Persist URL + token, preserving the watched list and any other keys in the file. */
  async saveConfig(url: string, token: string) {
    this._url = url;
    this._token = token;
    await this.updateConfigFile(cfg => {
      cfg.url = url;
      cfg.token = token;
      if (!Array.isArray(cfg.watched)) cfg.watched = [...this.watchedEntities];
    });
  }

  // ─── Connection ────────────────────────────────────────────

  connect(url: string, token: string) {
    this._url = url;
    this._token = token;
    this.manualClose = false;
    this.clearReconnectTimer();
    this.teardownSocket("Reconnecting");
    this.listenForNetwork();

    let sock: WebSocket;
    try {
      sock = new WebSocket(url.replace(/\/+$/, "").replace(/^http/, "ws") + "/api/websocket");
    } catch (e) {
      console.error("[HA] Connection failed:", e);
      this._error = `Connection failed: ${e instanceof Error ? e.message : String(e)}`;
      this.emitStatus();
      this.scheduleReconnect();
      return;
    }
    this.ws = sock;

    sock.onmessage = (event) => {
      if (this.ws !== sock) return;
      this.consecutiveTimeouts = 0;
      let msg: any;
      try { msg = JSON.parse(event.data); } catch { return; }

      if (msg.type === "auth_required") {
        sock.send(JSON.stringify({ type: "auth", access_token: token }));
        return;
      }

      if (msg.type === "auth_ok") {
        this._connected = true;
        this._error = null;
        this.reconnectAttempts = 0;
        console.log("[HA] Connected");
        this.emitStatus();
        this.startHeartbeat(sock);
        this.onAuthenticated();
        return;
      }

      if (msg.type === "auth_invalid") {
        console.error("[HA] Auth failed:", msg.message);
        this._connected = false;
        this._error = `Authentication failed: ${msg.message || "invalid token"}`;
        // A bad token will not fix itself — stop retrying until the user reconnects.
        this.manualClose = true;
        this.emitStatus();
        return;
      }

      if (msg.type === "event" && msg.event?.event_type === "state_changed") {
        this.handleStateChange(msg.event.data);
        return;
      }

      // Response to a command
      if (typeof msg.id === "number" && this.pending.has(msg.id)) {
        const req = this.pending.get(msg.id)!;
        this.pending.delete(msg.id);
        clearTimeout(req.timer);
        if (msg.type === "result" && msg.success === false) {
          const err = msg.error || {};
          req.reject(new Error(`HA error${err.code ? ` (${err.code})` : ""}: ${err.message || "request failed"}`));
        } else {
          req.resolve(msg);
        }
      }
    };

    sock.onclose = () => {
      if (this.ws !== sock) return;
      this.ws = null;
      this.stopHeartbeat();
      const wasConnected = this._connected;
      this._connected = false;
      this.rejectAllPending("Connection closed");
      if (wasConnected) console.warn("[HA] Connection closed");
      this.emitStatus();
      if (!this.manualClose) this.scheduleReconnect();
    };

    sock.onerror = () => {
      if (this.ws !== sock) return;
      if (!this._connected) {
        this._error = "Cannot reach Home Assistant";
        this.emitStatus();
      }
    };
  }

  /** Stop the connection and any pending/future reconnect. */
  disconnect() {
    this.manualClose = true;
    this.clearReconnectTimer();
    this.teardownSocket("Disconnected");
    this.emitStatus();
  }

  private teardownSocket(reason: string) {
    const old = this.ws;
    this.ws = null;
    this._connected = false;
    this.stopHeartbeat();
    this.consecutiveTimeouts = 0;
    this.rejectAllPending(reason);
    if (old) {
      old.onmessage = null;
      old.onclose = null;
      old.onerror = null;
      try { old.close(); } catch {}
    }
  }

  private clearReconnectTimer() {
    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private startHeartbeat(sock: WebSocket) {
    this.stopHeartbeat();
    this.heartbeatTimer = window.setInterval(() => {
      if (this.ws !== sock || !this._connected) return;
      this.send({ type: "ping" }).catch((e) => {
        // Only a missing pong means the socket is dead; "not connected"/"closed" are handled elsewhere.
        if (this.ws === sock && e instanceof Error && e.message === TIMEOUT_MESSAGE) {
          this.dropStaleConnection("Home Assistant stopped responding (no pong)");
        }
      });
    }, HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat() {
    if (this.heartbeatTimer !== null) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  /** The socket looks open but nothing comes back: drop it and reconnect. */
  private dropStaleConnection(reason: string) {
    if (!this.ws) return;
    console.warn(`[HA] ${reason}; reconnecting`);
    this.teardownSocket(reason);
    this._error = reason;
    this.emitStatus();
    this.scheduleReconnect();
  }

  /**
   * Retry right away instead of waiting for the backoff timer (a key was pressed while
   * disconnected, or the network came back). No-op while a connection attempt is in flight.
   */
  private reconnectNow() {
    if (this.manualClose || !this._url || !this._token || this.ws) return;
    if (this.reconnectTimer === null) return; // not waiting to reconnect
    this.reconnectAttempts = 0;
    this.connect(this._url, this._token);
  }

  private listenForNetwork() {
    if (this.onlineListener || typeof window === "undefined" || typeof window.addEventListener !== "function") return;
    this.onlineListener = () => this.reconnectNow();
    window.addEventListener("online", this.onlineListener);
  }

  private scheduleReconnect() {
    if (this.manualClose || !this._url || !this._token) return;
    this.clearReconnectTimer();
    const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** this.reconnectAttempts);
    this.reconnectAttempts++;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.manualClose) this.connect(this._url, this._token);
    }, delay);
  }

  private rejectAllPending(reason: string) {
    for (const [, req] of this.pending) {
      clearTimeout(req.timer);
      req.reject(new Error(reason));
    }
    this.pending.clear();
  }

  /** After every (re)authentication: refresh caches and re-seed watched variables. */
  private async onAuthenticated() {
    this.subscribeStateChanges();
    await Promise.all([this.fetchEntities(), this.fetchServices()]);
    this.syncAllWatchedToVariables();
    this.onStateChange?.(this.entities);
    this.emitStatus(); // entity count is known now
  }

  private send(msg: Record<string, any>): Promise<any> {
    return new Promise((resolve, reject) => {
      const sock = this.ws;
      if (!sock || sock.readyState !== WebSocket.OPEN || !this._connected) {
        reject(new Error("Home Assistant is not connected"));
        this.reconnectNow();
        return;
      }
      const id = this.msgId++;
      const timer = window.setTimeout(() => {
        if (this.pending.delete(id)) {
          console.warn("[HA] Message timed out:", msg.type, msg.domain ?? "", msg.service ?? "");
          reject(new Error(TIMEOUT_MESSAGE));
          if (this.ws === sock && ++this.consecutiveTimeouts >= MAX_CONSECUTIVE_TIMEOUTS) {
            this.dropStaleConnection(`${this.consecutiveTimeouts} Home Assistant requests timed out in a row`);
          }
        }
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      sock.send(JSON.stringify({ ...msg, id }));
    });
  }

  /** Send an arbitrary HA WebSocket command (any `id` in the message is replaced). */
  async sendCommand(msg: Record<string, any>) {
    if (!msg || typeof msg.type !== "string") throw new Error("HA command needs a string `type`");
    const { id: _ignored, ...rest } = msg;
    return this.send(rest);
  }

  // ─── Entity Methods ────────────────────────────────────────

  private async fetchEntities() {
    try {
      const res = await this.send({ type: "get_states" });
      if (Array.isArray(res.result)) {
        this.entities = res.result.map((e: any) => toEntity(e));
      }
    } catch (e) { console.error("[HA] Failed to fetch entities:", e); }
  }

  private watchedEntities: Set<string> = new Set();
  /** Attribute names last published per watched entity (to clear attributes that disappear). */
  private publishedAttrs = new Map<string, Set<string>>();
  private variableSetter: ((name: string, value: string) => void) | null = null;

  /** Set the function used to push variables into the app store. */
  setVariableSetter(setter: (name: string, value: string) => void) {
    this.variableSetter = setter;
  }

  /** Add an entity to the watch list — its state + attributes auto-become variables. */
  addWatch(entityId: string) {
    if (!entityId) return;
    this.watchedEntities.add(entityId);
    const ent = this.getEntity(entityId);
    if (ent) this.syncEntityToVariables(ent);
    this.saveWatchList();
  }

  removeWatch(entityId: string) {
    this.watchedEntities.delete(entityId);
    this.publishedAttrs.delete(entityId);
    this.saveWatchList();
  }

  isWatched(entityId: string): boolean { return this.watchedEntities.has(entityId); }
  getWatchedIds(): string[] { return [...this.watchedEntities]; }

  private saveWatchList() {
    this.updateConfigFile(cfg => { cfg.watched = [...this.watchedEntities]; })
      .catch(e => console.error("[HA] Failed to save watch list:", e));
  }

  /** (Re)load the watched list from ha_config.json. The file is the source of truth. */
  async loadWatchList() {
    const config = await this.loadConfig();
    const watched = Array.isArray(config?.watched)
      ? config!.watched.filter((id): id is string => typeof id === "string" && id.length > 0)
      : [];
    this.watchedEntities = new Set(watched);
    for (const id of [...this.publishedAttrs.keys()]) {
      if (!this.watchedEntities.has(id)) this.publishedAttrs.delete(id);
    }
  }

  /**
   * Sync one entity's state + attributes to app variables. Attributes that are null, or that
   * were published before and are now missing (HA drops e.g. brightness when a light turns
   * off), are published as nullAttrValue(): "0" for level-like attributes, "" otherwise.
   */
  private syncEntityToVariables(ent: HAEntity) {
    if (!this.variableSetter || !this.watchedEntities.has(ent.entity_id)) return;
    const prefix = `ha.${ent.entity_id}`;
    this.variableSetter(`${prefix}.state`, ent.state);
    this.variableSetter(`${prefix}.friendly_name`, ent.friendly_name);
    const published = new Set<string>();
    for (const [key, val] of Object.entries(ent.attributes || {})) {
      const value = attrToVariable(key, val);
      if (value === null) continue;
      this.variableSetter(`${prefix}.${key}`, value);
      published.add(key);
    }
    const previous = this.publishedAttrs.get(ent.entity_id);
    if (previous) {
      for (const key of previous) {
        if (!published.has(key)) {
          this.variableSetter(`${prefix}.${key}`, nullAttrValue(key));
          published.add(key);
        }
      }
    }
    this.publishedAttrs.set(ent.entity_id, published);
  }

  /** Sync all watched entities to variables (after every connect and on watch-list reload). */
  syncAllWatchedToVariables() {
    for (const id of this.watchedEntities) {
      const ent = this.getEntity(id);
      if (ent) this.syncEntityToVariables(ent);
    }
  }

  private subscribeStateChanges() {
    this.send({ type: "subscribe_events", event_type: "state_changed" })
      .catch(e => console.error("[HA] Failed to subscribe to state changes:", e));
  }

  private handleStateChange(data: any) {
    const newState = data?.new_state;
    if (!newState) return;
    const entity = toEntity(newState);
    const idx = this.entities.findIndex(e => e.entity_id === entity.entity_id);
    if (idx >= 0) this.entities[idx] = entity;
    else this.entities.push(entity);
    this.syncEntityToVariables(entity);
    this.onStateChange?.(this.entities);
  }

  getEntities(): HAEntity[] { return this.entities; }

  /** Get available services for an entity's domain — pulled from the live HA services list. */
  getEntityServices(entityId: string): Array<{ domain: string; service: string; name: string; fields: Record<string, any> }> {
    const domain = entityId.split(".")[0];
    const domainServices = this.services.find(s => s.domain === domain);
    if (!domainServices) return [];
    return Object.entries(domainServices.services).map(([svc, info]: [string, any]) => ({
      domain,
      service: svc,
      name: info.name || svc,
      fields: info.fields || {},
    }));
  }

  /** Get controllable numeric attributes for an entity — for encoder dials and strip bars. */
  getEntityControls(entityId: string): HAControl[] {
    const domain = entityId.split(".")[0];
    const ent = this.getEntity(entityId);
    const controls: HAControl[] = [];

    if (!ent) return controls;
    const attrs = ent.attributes || {};
    const num = (v: unknown, fallback: number) => (typeof v === "number" && Number.isFinite(v) ? v : fallback);
    const lightLike = domain === "light";

    // Lights report brightness as null while off, so detect support from the color modes too.
    if (attrs.brightness !== undefined || (lightLike && Array.isArray(attrs.supported_color_modes)
        && attrs.supported_color_modes.some((m: string) => m !== "onoff"))) {
      controls.push({ id: "brightness", label: "Brightness", domain, service: "turn_on", attr: "brightness", min: 0, max: 255, step: 5 });
    }
    if (attrs.color_temp_kelvin !== undefined || attrs.min_color_temp_kelvin !== undefined) {
      controls.push({ id: "color_temp", label: "Color Temperature", domain, service: "turn_on", attr: "color_temp_kelvin",
        min: num(attrs.min_color_temp_kelvin, 2000), max: num(attrs.max_color_temp_kelvin, 6500), step: 100 });
    }
    if (attrs.volume_level !== undefined) {
      controls.push({ id: "volume", label: "Volume", domain, service: "volume_set", attr: "volume_level", min: 0, max: 1, step: 0.05 });
    }
    if (attrs.temperature !== undefined) {
      controls.push({ id: "temperature", label: "Temperature", domain, service: "set_temperature", attr: "temperature",
        min: num(attrs.min_temp, 16), max: num(attrs.max_temp, 30), step: num(attrs.target_temp_step, 0.5) });
    }
    if (domain === "cover" && attrs.current_position !== undefined) {
      controls.push({ id: "position", label: "Position", domain, service: "set_cover_position", attr: "position",
        readAttr: "current_position", min: 0, max: 100, step: 5 });
    }
    if (attrs.percentage !== undefined) {
      controls.push({ id: "percentage", label: "Speed", domain, service: "set_percentage", attr: "percentage",
        min: 0, max: 100, step: num(attrs.percentage_step, 10) });
    }
    if (domain === "number" || domain === "input_number") {
      controls.push({ id: "value", label: "Value", domain, service: "set_value", attr: "value",
        readAttr: "state", min: num(attrs.min, 0), max: num(attrs.max, 100), step: num(attrs.step, 1) });
    }

    return controls;
  }

  searchEntities(query: string): HAEntity[] {
    const q = query.toLowerCase();
    if (!q) return this.entities.slice(0, 50);
    return this.entities.filter(e =>
      e.entity_id.includes(q) || e.friendly_name.toLowerCase().includes(q)
    ).slice(0, 50);
  }

  getEntity(entityId: string): HAEntity | undefined {
    return this.entities.find(e => e.entity_id === entityId);
  }

  // ─── Service Methods ───────────────────────────────────────

  private async fetchServices() {
    try {
      const res = await this.send({ type: "get_services" });
      if (res.result && typeof res.result === "object") {
        this.services = Object.entries(res.result).map(([domain, data]: [string, any]) => ({
          domain,
          services: data,
        }));
      }
    } catch (e) { console.error("[HA] Failed to fetch services:", e); }
  }

  getServices(): HAService[] { return this.services; }

  searchServices(query: string): Array<{ domain: string; service: string; name: string }> {
    const q = query.toLowerCase();
    const results: Array<{ domain: string; service: string; name: string }> = [];
    for (const s of this.services) {
      for (const [svc, info] of Object.entries(s.services)) {
        const full = `${s.domain}.${svc}`;
        const name = (info as any).name || svc;
        if (!q || full.includes(q) || name.toLowerCase().includes(q)) {
          results.push({ domain: s.domain, service: svc, name });
        }
      }
    }
    return results.slice(0, 50);
  }

  // ─── Call Service ──────────────────────────────────────────

  /** Call an HA service. Rejects when HA answers with success:false. */
  async callService(domain: string, service: string, data?: Record<string, any>, target?: Record<string, unknown>) {
    const msg: Record<string, any> = { type: "call_service", domain, service };
    if (data && Object.keys(data).length > 0) msg.service_data = data;
    if (target && Object.keys(target).length > 0) msg.target = target;
    return this.send(msg);
  }

  /**
   * Call a service from a flat settings object (keys, encoders, strip gestures).
   * `ha_service_data` must already be a parsed-safe JSON string; template resolution of its
   * string values is the caller's job (see the ha-service executor).
   */
  async callFromSettings(settings: Record<string, string>) {
    const domain = settings.ha_domain;
    const service = settings.ha_service;
    const entityId = settings.ha_entity;
    let data: Record<string, any> | undefined;

    if (!domain || !service) {
      throw new Error(`HA action is missing ${!domain ? "domain" : "service"}${entityId ? ` (entity ${entityId})` : ""}`);
    }

    if (settings.ha_service_data) {
      data = parseJsonObject(settings.ha_service_data, "ha_service_data");
    } else if (settings.ha_attr) {
      data = { [settings.ha_attr]: this.resolveAttrValue(settings) };
    }

    console.log("[HA] Calling", domain, service, entityId || "(no entity)", data || "(no data)");
    return this.callService(domain, service, data, entityId ? { entity_id: entityId } : undefined);
  }

  /** Compute the value for an attribute control from value / ratio / to_ratio settings. */
  private resolveAttrValue(settings: Record<string, string>): number | string {
    const attr = settings.ha_attr;
    const entityId = settings.ha_entity || "";
    const ctrl = this.getEntityControls(entityId).find(c => c.attr === attr);

    if (settings.value !== undefined && settings.value.trim() !== "") {
      const v = parseNumericSetting(settings.value);
      return typeof v === "number" && ctrl ? quantize(v, ctrl) : v;
    }

    const ratioStr = settings.to_ratio ?? settings.ratio;
    if (ratioStr !== undefined && ratioStr.trim() !== "") {
      const ratio = Number(ratioStr);
      if (!Number.isFinite(ratio)) throw new Error(`Invalid ratio "${ratioStr}" for HA control ${attr}`);
      if (!ctrl) throw new Error(`Cannot map strip position to ${entityId}.${attr}: entity range unknown (not loaded from HA)`);
      return ratioToValue(ratio, ctrl);
    }

    // A key press on an attribute control carries no value: never send a default (e.g. brightness 0).
    throw new Error(`HA control "${attr}" on ${entityId || "(no entity)"} has no value to send — set a value, or use it on an encoder/strip`);
  }

  setStateChangeHandler(handler: (entities: HAEntity[]) => void) {
    this.onStateChange = handler;
  }
}

function toEntity(e: any): HAEntity {
  return {
    entity_id: e.entity_id,
    state: e.state,
    attributes: e.attributes || {},
    friendly_name: e.attributes?.friendly_name || e.entity_id,
    domain: String(e.entity_id).split(".")[0],
  };
}

/** Parse a JSON object setting, with an error that names the setting. */
export function parseJsonObject(json: string, what: string): Record<string, any> {
  let parsed: unknown;
  try { parsed = JSON.parse(json); } catch (e) {
    throw new Error(`Invalid JSON in ${what}: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${what} must be a JSON object`);
  }
  return parsed as Record<string, any>;
}

// Singleton
export const ha = new HAClient();
