// Wire types for the Open Stream Deck plugin protocol (a subset of the Elgato Stream Deck SDK
// protocol plus variable extensions). Everything listed here is actually sent or handled by the host.

export type Controller = "Keypad" | "Encoder";

export interface Coordinates {
  column: number;
  row: number;
}

export type Settings = Record<string, unknown>;

interface ContextEvent<E extends string, P> {
  event: E;
  /** Action UUID from your manifest (Actions[].UUID). */
  action: string;
  /** Instance id: `${deviceSerial}:${sceneId}:${controller}:${index}`. Treat as opaque. */
  context: string;
  /** Device serial. */
  device: string;
  payload: P;
}

export interface KeyPayload {
  settings: Settings;
  coordinates: Coordinates;
  state?: number;
  /** True when the key press comes from a Multi-Action step. */
  isInMultiAction: boolean;
}

export interface AppearPayload {
  settings: Settings;
  coordinates: Coordinates;
  controller: Controller;
  /** Present for Keypad instances. */
  state?: number;
  isInMultiAction: boolean;
}

export interface DialRotatePayload {
  settings: Settings;
  coordinates: Coordinates;
  controller: "Encoder";
  /** Signed number of detents turned (positive = clockwise). */
  ticks: number;
  pressed: boolean;
}

export interface DialPressPayload {
  settings: Settings;
  coordinates: Coordinates;
  controller: "Encoder";
}

export interface SettingsPayload {
  settings: Settings;
  coordinates: Coordinates;
  state?: number;
  isInMultiAction: boolean;
}

export type KeyDownEvent = ContextEvent<"keyDown", KeyPayload>;
export type KeyUpEvent = ContextEvent<"keyUp", KeyPayload>;
export type WillAppearEvent = ContextEvent<"willAppear", AppearPayload>;
export type WillDisappearEvent = ContextEvent<"willDisappear", AppearPayload>;
export type DialRotateEvent = ContextEvent<"dialRotate", DialRotatePayload>;
export type DialDownEvent = ContextEvent<"dialDown", DialPressPayload>;
export type DialUpEvent = ContextEvent<"dialUp", DialPressPayload>;
/** Reply to getSettings. */
export type DidReceiveSettingsEvent = ContextEvent<"didReceiveSettings", SettingsPayload>;

/** Reply to getGlobalSettings (and confirmation after setGlobalSettings). */
export interface DidReceiveGlobalSettingsEvent {
  event: "didReceiveGlobalSettings";
  payload: { settings: Settings };
}

/** Reply to getVariable (Open Stream Deck extension). */
export interface VariableChangedEvent {
  event: "variableChanged";
  payload: { name: string; value: string };
}

/** Any action-instance event. */
export type ActionEvent =
  | KeyDownEvent | KeyUpEvent | WillAppearEvent | WillDisappearEvent
  | DialRotateEvent | DialDownEvent | DialUpEvent | DidReceiveSettingsEvent;

/** Every event the host sends to a plugin. */
export type HostEvent = ActionEvent | DidReceiveGlobalSettingsEvent | VariableChangedEvent;

export interface EventMap {
  keyDown: KeyDownEvent;
  keyUp: KeyUpEvent;
  willAppear: WillAppearEvent;
  willDisappear: WillDisappearEvent;
  dialRotate: DialRotateEvent;
  dialDown: DialDownEvent;
  dialUp: DialUpEvent;
  didReceiveSettings: DidReceiveSettingsEvent;
  didReceiveGlobalSettings: DidReceiveGlobalSettingsEvent;
  variableChanged: VariableChangedEvent;
}

/** Registration info passed with -info on the command line. */
export interface RegistrationInfo {
  application?: { language?: string; platform?: string; platformVersion?: string; version?: string };
  plugin?: { uuid?: string; version?: string };
  devices?: unknown[];
  devicePixelRatio?: number;
}
