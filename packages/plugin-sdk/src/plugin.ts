import type { EventMap, RegistrationInfo, Settings } from "./types";

type EventHandler<T> = (event: T) => void;

/** Minimal WebSocket surface used by the SDK (browser WebSocket, Node >= 22 global, or `ws`). */
export interface WebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(): void;
  onopen: ((ev: any) => void) | null;
  onmessage: ((ev: { data: any }) => void) | null;
  onclose: ((ev: any) => void) | null;
  onerror: ((ev: any) => void) | null;
}
export type WebSocketCtor = new (url: string) => WebSocketLike;

export interface PluginOptions {
  /**
   * WebSocket implementation. Defaults to the global `WebSocket` (browsers, Node >= 22).
   * On Node 18/20 pass the `ws` package: `new StreamDeckPlugin({ WebSocket: require("ws") })`.
   */
  WebSocket?: WebSocketCtor;
  /** Command-line arguments to parse; defaults to process.argv.slice(2). */
  argv?: string[];
  /**
   * What to do when the host connection closes after it was established. Default "exit":
   * end the Node process (the host starts the plugin again when needed), like Elgato plugins.
   * "reconnect" keeps retrying every 2 s.
   */
  onDisconnect?: "exit" | "reconnect";
}

const OPEN = 1;
const INITIAL_CONNECT_ATTEMPTS = 10;

declare const process: { argv: string[]; exit(code?: number): never } | undefined;

/**
 * Plugin SDK for Open Stream Deck.
 *
 * Speaks the subset of the Elgato Stream Deck plugin protocol that the host implements:
 *  - Host → plugin: willAppear, willDisappear, keyDown, keyUp, dialRotate, dialDown, dialUp,
 *    didReceiveSettings, didReceiveGlobalSettings, variableChanged (reply to getVariable).
 *  - Plugin → host: setTitle, setImage, setState, showOk, showAlert, setSettings, getSettings,
 *    setGlobalSettings, getGlobalSettings, openUrl (http/https only), logMessage,
 *    setVariable, getVariable.
 * The host has no property inspector and no encoder feedback layouts, so
 * sendToPropertyInspector / setFeedback / setFeedbackLayout are not offered.
 *
 * Launch arguments: -port <n> -pluginUUID <manifest UUID> -registerEvent registerPlugin -info <json>.
 *
 * Usage:
 *   const plugin = new StreamDeckPlugin();
 *   plugin.onKeyDown((ev) => plugin.setTitle(ev.context, "Pressed"));
 *   plugin.connect();
 */
export class StreamDeckPlugin {
  private ws: WebSocketLike | null = null;
  private port = 0;
  private uuid = "";
  private registerEvent = "registerPlugin";
  private _info: RegistrationInfo = {};
  private registered = false;
  private attempts = 0;
  private readonly WS: WebSocketCtor | undefined;
  private readonly onDisconnectMode: "exit" | "reconnect";

  private handlers: { [K in keyof EventMap]?: EventHandler<EventMap[K]>[] } = {};

  constructor(options: PluginOptions = {}) {
    this.WS = options.WebSocket ?? (globalThis as any).WebSocket;
    this.onDisconnectMode = options.onDisconnect ?? "exit";
    this.parseArgs(options.argv ?? (typeof process !== "undefined" ? process.argv.slice(2) : []));
  }

  /** The plugin's manifest UUID, as passed by the host with -pluginUUID. */
  get pluginUUID(): string { return this.uuid; }
  /** Registration info passed by the host with -info. */
  get info(): RegistrationInfo { return this._info; }

  private parseArgs(args: string[]) {
    for (let i = 0; i < args.length - 1; i += 2) {
      const key = args[i].replace(/^-+/, "");
      const val = args[i + 1];
      switch (key) {
        case "port": this.port = parseInt(val, 10); break;
        case "pluginUUID": this.uuid = val; break;
        case "registerEvent": this.registerEvent = val; break;
        case "info": try { this._info = JSON.parse(val); } catch { /* keep defaults */ } break;
      }
    }
  }

  /** Connect to the host and register. Throws if the launch arguments or WebSocket are missing. */
  connect() {
    if (!this.WS) throw new Error("No WebSocket implementation: pass { WebSocket } (e.g. the `ws` package) on Node < 22");
    if (!this.port || !this.uuid) throw new Error("Missing -port / -pluginUUID launch arguments");
    this.attempts++;
    const ws = new this.WS(`ws://127.0.0.1:${this.port}`);
    this.ws = ws;
    ws.onopen = () => {
      this.attempts = 0;
      this.registered = true;
      this.send({ event: this.registerEvent, uuid: this.uuid });
    };
    ws.onmessage = (msg) => {
      let data: any;
      try { data = JSON.parse(typeof msg.data === "string" ? msg.data : String(msg.data)); } catch { return; }
      if (data && typeof data.event === "string") this.dispatch(data.event, data);
    };
    ws.onerror = () => { /* followed by onclose */ };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      const wasRegistered = this.registered;
      this.registered = false;
      if (wasRegistered && this.onDisconnectMode === "exit" && typeof process !== "undefined") {
        process.exit(0);
      }
      if (!wasRegistered && this.attempts >= INITIAL_CONNECT_ATTEMPTS) {
        throw new Error(`Could not connect to the host on port ${this.port}`);
      }
      setTimeout(() => this.connect(), wasRegistered ? 2000 : 1000);
    };
  }

  // ─── Event Handlers ─────────────────────

  onWillAppear(handler: EventHandler<EventMap["willAppear"]>) { this.on("willAppear", handler); }
  onWillDisappear(handler: EventHandler<EventMap["willDisappear"]>) { this.on("willDisappear", handler); }
  onKeyDown(handler: EventHandler<EventMap["keyDown"]>) { this.on("keyDown", handler); }
  onKeyUp(handler: EventHandler<EventMap["keyUp"]>) { this.on("keyUp", handler); }
  onDialRotate(handler: EventHandler<EventMap["dialRotate"]>) { this.on("dialRotate", handler); }
  onDialDown(handler: EventHandler<EventMap["dialDown"]>) { this.on("dialDown", handler); }
  onDialUp(handler: EventHandler<EventMap["dialUp"]>) { this.on("dialUp", handler); }
  onDidReceiveSettings(handler: EventHandler<EventMap["didReceiveSettings"]>) { this.on("didReceiveSettings", handler); }
  onDidReceiveGlobalSettings(handler: EventHandler<EventMap["didReceiveGlobalSettings"]>) { this.on("didReceiveGlobalSettings", handler); }

  /** Called with replies to getVariable. */
  onVariableChanged(handler: (name: string, value: string) => void) {
    this.on("variableChanged", (data) => handler(data.payload?.name, data.payload?.value));
  }

  on<K extends keyof EventMap>(event: K, handler: EventHandler<EventMap[K]>) {
    ((this.handlers[event] ??= []) as EventHandler<EventMap[K]>[]).push(handler);
  }

  private dispatch(event: string, data: any) {
    const list = this.handlers[event as keyof EventMap] as EventHandler<any>[] | undefined;
    for (const h of list ?? []) {
      try { h(data); } catch (e) { this.logMessage(`Handler for ${event} threw: ${e instanceof Error ? e.message : String(e)}`); }
    }
  }

  // ─── Commands ───────────────────────────

  /** Replace the key's first label; an empty title restores the user's configured label. */
  setTitle(context: string, title: string) {
    this.send({ event: "setTitle", context, payload: { title } });
  }

  /** Replace the key's background image (data URL or raw SVG); empty restores the configured image. */
  setImage(context: string, image: string) {
    this.send({ event: "setImage", context, payload: { image } });
  }

  setState(context: string, state: number) {
    this.send({ event: "setState", context, payload: { state } });
  }

  /** Persist settings for this action instance (stored in the profile). */
  setSettings(context: string, settings: Settings) {
    this.send({ event: "setSettings", context, payload: settings });
  }

  /** Request settings; answered with didReceiveSettings. */
  getSettings(context: string) {
    this.send({ event: "getSettings", context });
  }

  /** Persist plugin-wide settings. */
  setGlobalSettings(settings: Settings) {
    this.send({ event: "setGlobalSettings", context: this.uuid, payload: settings });
  }

  /** Request plugin-wide settings; answered with didReceiveGlobalSettings. */
  getGlobalSettings() {
    this.send({ event: "getGlobalSettings", context: this.uuid });
  }

  showAlert(context: string) {
    this.send({ event: "showAlert", context });
  }

  showOk(context: string) {
    this.send({ event: "showOk", context });
  }

  /** Open an http(s) URL in the default browser. Other schemes are refused by the host. */
  openUrl(url: string) {
    this.send({ event: "openUrl", payload: { url } });
  }

  /** Write a line to the host's log. */
  logMessage(message: string) {
    this.send({ event: "logMessage", payload: { message } });
  }

  // ─── Variables (Open Stream Deck extension) ─────

  /** Publish a variable usable in templates as {{$name}}. */
  setVariable(name: string, value: string) {
    this.send({ event: "setVariable", payload: { name, value } });
  }

  /** Request a variable's value; answered with variableChanged. */
  getVariable(name: string) {
    this.send({ event: "getVariable", payload: { name } });
  }

  private send(data: object) {
    if (this.ws && this.ws.readyState === OPEN) {
      this.ws.send(JSON.stringify(data));
    }
  }
}
