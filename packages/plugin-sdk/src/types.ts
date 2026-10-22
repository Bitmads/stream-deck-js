export interface ActionEvent {
  action: string;
  context: string;
  device: string;
  payload: Record<string, any>;
}

export interface KeyDownEvent extends ActionEvent {
  event: "keyDown";
}

export interface KeyUpEvent extends ActionEvent {
  event: "keyUp";
}

export interface WillAppearEvent extends ActionEvent {
  event: "willAppear";
}

export interface WillDisappearEvent extends ActionEvent {
  event: "willDisappear";
}

export interface DidReceiveSettingsEvent extends ActionEvent {
  event: "didReceiveSettings";
}
