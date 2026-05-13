import { invoke } from "@tauri-apps/api/core";

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

type MessageHandler = (msg: any) => void;

/**
 * Home Assistant WebSocket client.
 * Persistent connection, auto-reconnect, entity/service caching.
 */
export class HAClient {
  private ws: WebSocket | null = null;
  private msgId = 1;
  private pending = new Map<number, (result: any) => void>();
  private _connected = false;
  private _url = "";
  private _token = "";
  private reconnectTimer: number | null = null;
  private entities: HAEntity[] = [];
  private services: HAService[] = [];
  private onStateChange: ((entities: HAEntity[]) => void) | null = null;

  get connected() { return this._connected; }
  get url() { return this._url; }

  async loadConfig(): Promise<{ url: string; token: string } | null> {
    try {
      const json = await invoke<string | null>("load_json_file", { filename: "ha_config" });
      return json ? JSON.parse(json) : null;
    } catch { return null; }
  }

  async saveConfig(url: string, token: string) {
    this._url = url;
    this._token = token;
    await invoke("save_json_file", { filename: "ha_config", content: JSON.stringify({ url, token }) }).catch(() => {});
  }

  connect(url: string, token: string) {
    this._url = url;
    this._token = token;
    this.disconnect();

    try {
      this.ws = new WebSocket(url.replace(/^http/, "ws") + "/api/websocket");
    } catch (e) {
      console.error("[HA] Connection failed:", e);
      return;
    }

    this.ws.onopen = () => {};

    this.ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);

      if (msg.type === "auth_required") {
        this.ws?.send(JSON.stringify({ type: "auth", access_token: token }));
        return;
      }

      if (msg.type === "auth_ok") {
        this._connected = true;
        console.log("[HA] Connected");
        this.fetchEntities();
        this.fetchServices();
        this.subscribeStateChanges();
        return;
      }

      if (msg.type === "auth_invalid") {
        console.error("[HA] Auth failed:", msg.message);
        this._connected = false;
        return;
      }

      if (msg.type === "event" && msg.event?.event_type === "state_changed") {
        this.handleStateChange(msg.event.data);
        return;
      }

      // Response to a command
      if (msg.id && this.pending.has(msg.id)) {
        this.pending.get(msg.id)!(msg);
        this.pending.delete(msg.id);
      }
    };

    this.ws.onclose = () => {
      this._connected = false;
      // Auto-reconnect after 5s
      if (this._url && this._token) {
        this.reconnectTimer = window.setTimeout(() => this.connect(this._url, this._token), 5000);
      }
    };

    this.ws.onerror = () => {};
  }

  disconnect() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this._connected = false;
    this.ws?.close();
    this.ws = null;
  }

  private send(msg: any): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        console.warn("[HA] WebSocket not connected, can't send");
        reject(new Error("Not connected"));
        return;
      }
      const id = this.msgId++;
      msg.id = id;
      this.pending.set(id, resolve);
      this.ws.send(JSON.stringify(msg));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          console.warn("[HA] Message timed out:", msg.type, msg.domain, msg.service);
          reject(new Error("Timeout"));
        }
      }, 10000);
    });
  }

  // ─── Entity Methods ────────────────────────────────────────

  private async fetchEntities() {
    try {
      const res = await this.send({ type: "get_states" });
      if (res.result) {
        this.entities = res.result.map((e: any) => ({
          entity_id: e.entity_id,
          state: e.state,
          attributes: e.attributes,
          friendly_name: e.attributes?.friendly_name || e.entity_id,
          domain: e.entity_id.split(".")[0],
        }));
      }
    } catch (e) { console.error("[HA] Failed to fetch entities:", e); }
  }

  private watchedEntities: Set<string> = new Set();
  private variableSetter: ((name: string, value: string) => void) | null = null;

  /** Set the function used to push variables into the app store. */
  setVariableSetter(setter: (name: string, value: string) => void) {
    this.variableSetter = setter;
  }

  /** Add an entity to the watch list — its state + attributes auto-become variables. */
  addWatch(entityId: string) {
    this.watchedEntities.add(entityId);
    // Sync initial state
    const ent = this.getEntity(entityId);
    if (ent) this.syncEntityToVariables(ent);
    this.saveWatchList();
  }

  removeWatch(entityId: string) {
    this.watchedEntities.delete(entityId);
    this.saveWatchList();
  }

  isWatched(entityId: string): boolean { return this.watchedEntities.has(entityId); }
  getWatchedIds(): string[] { return [...this.watchedEntities]; }

  private async saveWatchList() {
    const config = await this.loadConfig() || { url: this._url, token: this._token };
    (config as any).watched = [...this.watchedEntities];
    await invoke("save_json_file", { filename: "ha_config", content: JSON.stringify(config) }).catch(() => {});
  }

  async loadWatchList() {
    const config = await this.loadConfig();
    if (config && (config as any).watched) {
      this.watchedEntities = new Set((config as any).watched);
    }
  }

  /** Sync one entity's state + attributes to app variables. */
  private syncEntityToVariables(ent: HAEntity) {
    if (!this.variableSetter || !this.watchedEntities.has(ent.entity_id)) return;
    const prefix = `ha.${ent.entity_id}`;
    this.variableSetter(`${prefix}.state`, ent.state);
    this.variableSetter(`${prefix}.friendly_name`, ent.friendly_name);
    for (const [key, val] of Object.entries(ent.attributes)) {
      if (val === null || val === undefined) continue;
      if (Array.isArray(val)) {
        this.variableSetter(`${prefix}.${key}`, val.join(", "));
      } else if (typeof val !== "object") {
        this.variableSetter(`${prefix}.${key}`, String(val));
      }
    }
  }

  /** Sync all watched entities to variables (on connect). */
  syncAllWatchedToVariables() {
    for (const id of this.watchedEntities) {
      const ent = this.getEntity(id);
      if (ent) this.syncEntityToVariables(ent);
    }
  }

  private subscribeStateChanges() {
    this.send({ type: "subscribe_events", event_type: "state_changed" }).catch(() => {});
  }

  private handleStateChange(data: any) {
    const newState = data.new_state;
    if (!newState) return;
    const idx = this.entities.findIndex(e => e.entity_id === newState.entity_id);
    const entity: HAEntity = {
      entity_id: newState.entity_id,
      state: newState.state,
      attributes: newState.attributes,
      friendly_name: newState.attributes?.friendly_name || newState.entity_id,
      domain: newState.entity_id.split(".")[0],
    };
    if (idx >= 0) this.entities[idx] = entity;
    else this.entities.push(entity);
    // Auto-sync watched entities to variables
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

  /** Get controllable numeric attributes for an entity — for encoder dials. Built from entity state + attributes. */
  getEntityControls(entityId: string): Array<{ id: string; label: string; domain: string; service: string; attr: string; min: number; max: number; step: number }> {
    const domain = entityId.split(".")[0];
    const ent = this.getEntity(entityId);
    const controls: Array<{ id: string; label: string; domain: string; service: string; attr: string; min: number; max: number; step: number }> = [];

    if (!ent) return controls;

    // Build controls from entity attributes dynamically
    const attrs = ent.attributes;

    if (attrs.brightness !== undefined) {
      controls.push({ id: "brightness", label: "Brightness", domain, service: "turn_on", attr: "brightness", min: 0, max: 255, step: 5 });
    }
    if (attrs.color_temp_kelvin !== undefined) {
      controls.push({ id: "color_temp", label: "Color Temperature", domain, service: "turn_on", attr: "color_temp_kelvin",
        min: attrs.min_color_temp_kelvin ?? 2000, max: attrs.max_color_temp_kelvin ?? 6500, step: 100 });
    }
    if (attrs.volume_level !== undefined) {
      controls.push({ id: "volume", label: "Volume", domain, service: "volume_set", attr: "volume_level", min: 0, max: 1, step: 0.05 });
    }
    if (attrs.temperature !== undefined) {
      controls.push({ id: "temperature", label: "Temperature", domain, service: "set_temperature", attr: "temperature",
        min: attrs.min_temp ?? 16, max: attrs.max_temp ?? 30, step: attrs.target_temp_step ?? 0.5 });
    }
    if (attrs.position !== undefined || domain === "cover") {
      controls.push({ id: "position", label: "Position", domain, service: "set_cover_position", attr: "position", min: 0, max: 100, step: 5 });
    }
    if (attrs.percentage !== undefined) {
      controls.push({ id: "percentage", label: "Speed", domain, service: "set_percentage", attr: "percentage", min: 0, max: 100, step: 10 });
    }
    if (domain === "number" || domain === "input_number") {
      controls.push({ id: "value", label: "Value", domain, service: "set_value", attr: "value",
        min: attrs.min ?? 0, max: attrs.max ?? 100, step: attrs.step ?? 1 });
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
      if (res.result) {
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

  async callService(domain: string, service: string, data?: Record<string, any>, target?: { entity_id: string }) {
    const msg: any = { type: "call_service", domain, service };
    if (data) msg.service_data = data;
    if (target) msg.target = target;
    return this.send(msg);
  }

  /** Call service from a flat settings object (used by action execution) */
  async callFromSettings(settings: Record<string, string>) {
    const domain = settings.ha_domain;
    const service = settings.ha_service;
    const entityId = settings.ha_entity;
    let data: Record<string, any> | undefined;

    if (settings.ha_custom_json) {
      try { data = JSON.parse(settings.ha_custom_json); } catch {}
    } else if (settings.ha_service_data) {
      try { data = JSON.parse(settings.ha_service_data); } catch {}
    } else if (settings.ha_attr) {
      // Auto-build service data from control attribute
      let attrValue: number | string;
      if (settings.value) {
        attrValue = parseFloat(settings.value) || settings.value;
      } else if (settings.to_ratio !== undefined || settings.ratio !== undefined) {
        // Swipe (to_ratio) or tap (ratio): map 0-1 to the attribute's actual range
        const ratio = parseFloat(settings.to_ratio ?? settings.ratio) || 0;
        const ctrl = this.getEntityControls(settings.ha_entity || "").find(c => c.attr === settings.ha_attr);
        if (ctrl) {
          attrValue = Math.round(ctrl.min + ratio * (ctrl.max - ctrl.min));
        } else {
          attrValue = ratio;
        }
      } else {
        attrValue = 0;
      }
      data = { [settings.ha_attr]: attrValue };
    }

    if (domain && service) {
      console.log("[HA] Calling", domain, service, entityId || "(no entity)", data || "(no data)");
      return this.callService(domain, service, data, entityId ? { entity_id: entityId } : undefined);
    } else {
      console.warn("[HA] Missing domain/service:", { domain, service, entityId, settings });
    }
  }

  setStateChangeHandler(handler: (entities: HAEntity[]) => void) {
    this.onStateChange = handler;
  }
}

// Singleton
export const ha = new HAClient();
