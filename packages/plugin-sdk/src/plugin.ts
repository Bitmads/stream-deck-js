import type { ActionEvent, KeyDownEvent, KeyUpEvent, WillAppearEvent, WillDisappearEvent, DidReceiveSettingsEvent } from "./types";

type EventHandler<T> = (event: T) => void;

/**
 * Main SDK class for Stream Deck plugins.
 * Wire-compatible with the Elgato Stream Deck WebSocket protocol.
 *
 * Usage:
 *   const plugin = new StreamDeckPlugin();
 *   plugin.onKeyDown((ev) => { ... });
 *   plugin.connect();
 */
export class StreamDeckPlugin {
  private ws: WebSocket | null = null;
  private port: number = 0;
  private uuid: string = "";
  private registerEvent: string = "";
  private info: any = {};

  private handlers: Record<string, EventHandler<any>[]> = {};

  constructor() {
    this.parseArgs();
  }

  private parseArgs() {
    const args = typeof process !== "undefined" ? process.argv.slice(2) : [];
    for (let i = 0; i < args.length; i += 2) {
      const key = args[i]?.replace(/^-/, "");
      const val = args[i + 1];
      switch (key) {
        case "port": this.port = parseInt(val); break;
        case "pluginUUID": this.uuid = val; break;
        case "registerEvent": this.registerEvent = val; break;
        case "info": try { this.info = JSON.parse(val); } catch {} break;
      }
    }
  }

  connect() {
    this.ws = new WebSocket(`ws://127.0.0.1:${this.port}`);
    this.ws.onopen = () => {
      this.send({ event: this.registerEvent, uuid: this.uuid });
    };
    this.ws.onmessage = (msg) => {
      try {
        const data = JSON.parse(typeof msg.data === "string" ? msg.data : "");
        this.dispatch(data.event, data);
      } catch {}
    };
    this.ws.onclose = () => {
      setTimeout(() => this.connect(), 2000); // Auto-reconnect
    };
  }

  // ─── Event Handlers ─────────────────────

  onKeyDown(handler: EventHandler<KeyDownEvent>) { this.on("keyDown", handler); }
  onKeyUp(handler: EventHandler<KeyUpEvent>) { this.on("keyUp", handler); }
  onWillAppear(handler: EventHandler<WillAppearEvent>) { this.on("willAppear", handler); }
  onWillDisappear(handler: EventHandler<WillDisappearEvent>) { this.on("willDisappear", handler); }
  onDidReceiveSettings(handler: EventHandler<DidReceiveSettingsEvent>) { this.on("didReceiveSettings", handler); }

  private on(event: string, handler: EventHandler<any>) {
    (this.handlers[event] ??= []).push(handler);
  }

  private dispatch(event: string, data: any) {
    for (const h of this.handlers[event] ?? []) h(data);
  }

  // ─── Commands ───────────────────────────

  setTitle(context: string, title: string, target?: number) {
    this.send({ event: "setTitle", context, payload: { title, target } });
  }

  setImage(context: string, image: string, target?: number) {
    this.send({ event: "setImage", context, payload: { image, target } });
  }

  setState(context: string, state: number) {
    this.send({ event: "setState", context, payload: { state } });
  }

  setSettings(context: string, settings: Record<string, any>) {
    this.send({ event: "setSettings", context, payload: settings });
  }

  getSettings(context: string) {
    this.send({ event: "getSettings", context });
  }

  showAlert(context: string) {
    this.send({ event: "showAlert", context });
  }

  showOk(context: string) {
    this.send({ event: "showOk", context });
  }

  openUrl(url: string) {
    this.send({ event: "openUrl", payload: { url } });
  }

  logMessage(message: string) {
    this.send({ event: "logMessage", payload: { message } });
  }

  sendToPropertyInspector(action: string, context: string, payload: any) {
    this.send({ event: "sendToPropertyInspector", action, context, payload });
  }

  // ─── Variables (Open Stream Deck extension) ─────

  setVariable(name: string, value: string) {
    this.send({ event: "setVariable", payload: { name, value } });
  }

  getVariable(name: string) {
    this.send({ event: "getVariable", payload: { name } });
  }

  onVariableChanged(handler: (name: string, value: string) => void) {
    this.on("variableChanged", (data: any) => handler(data.payload?.name, data.payload?.value));
  }

  private send(data: any) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
    }
  }
}
