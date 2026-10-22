use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Messages sent FROM the Stream Deck app TO plugins.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "event")]
pub enum PluginEvent {
    #[serde(rename = "keyDown")]
    KeyDown { action: String, context: String, device: String, payload: KeyPayload },
    #[serde(rename = "keyUp")]
    KeyUp { action: String, context: String, device: String, payload: KeyPayload },
    #[serde(rename = "willAppear")]
    WillAppear { action: String, context: String, device: String, payload: AppearPayload },
    #[serde(rename = "willDisappear")]
    WillDisappear { action: String, context: String, device: String, payload: AppearPayload },
    #[serde(rename = "didReceiveSettings")]
    DidReceiveSettings { action: String, context: String, device: String, payload: SettingsPayload },
    #[serde(rename = "didReceiveGlobalSettings")]
    DidReceiveGlobalSettings { payload: GlobalSettingsPayload },
    #[serde(rename = "deviceDidConnect")]
    DeviceDidConnect { device: String, #[serde(rename = "deviceInfo")] device_info: DeviceInfoPayload },
    #[serde(rename = "deviceDidDisconnect")]
    DeviceDidDisconnect { device: String },
    #[serde(rename = "propertyInspectorDidAppear")]
    PropertyInspectorDidAppear { action: String, context: String, device: String },
    #[serde(rename = "propertyInspectorDidDisappear")]
    PropertyInspectorDidDisappear { action: String, context: String, device: String },
}

/// Messages sent FROM plugins TO the Stream Deck app.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "event")]
pub enum PluginCommand {
    #[serde(rename = "setTitle")]
    SetTitle { context: String, payload: SetTitlePayload },
    #[serde(rename = "setImage")]
    SetImage { context: String, payload: SetImagePayload },
    #[serde(rename = "setState")]
    SetState { context: String, payload: SetStatePayload },
    #[serde(rename = "setSettings")]
    SetSettings { context: String, payload: Value },
    #[serde(rename = "getSettings")]
    GetSettings { context: String },
    #[serde(rename = "setGlobalSettings")]
    SetGlobalSettings { context: String, payload: Value },
    #[serde(rename = "getGlobalSettings")]
    GetGlobalSettings { context: String },
    #[serde(rename = "showAlert")]
    ShowAlert { context: String },
    #[serde(rename = "showOk")]
    ShowOk { context: String },
    #[serde(rename = "openUrl")]
    OpenUrl { payload: OpenUrlPayload },
    #[serde(rename = "logMessage")]
    LogMessage { payload: LogPayload },
    #[serde(rename = "sendToPropertyInspector")]
    SendToPropertyInspector { action: String, context: String, payload: Value },
    #[serde(rename = "switchToProfile")]
    SwitchToProfile { context: String, device: String, payload: SwitchProfilePayload },
    // Variables (Open Stream Deck extension)
    #[serde(rename = "setVariable")]
    SetVariable { payload: VariablePayload },
    #[serde(rename = "getVariable")]
    GetVariable { payload: GetVariablePayload },
    // Registration
    #[serde(rename = "registerPlugin")]
    RegisterPlugin { uuid: String },
    #[serde(rename = "registerPropertyInspector")]
    RegisterPropertyInspector { uuid: String },
}

// ─── Payload types ───

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KeyPayload {
    pub settings: Value,
    pub coordinates: Coordinates,
    #[serde(rename = "isInMultiAction")]
    pub is_in_multi_action: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppearPayload {
    pub settings: Value,
    pub coordinates: Coordinates,
    pub controller: String,
    pub state: u8,
    #[serde(rename = "isInMultiAction")]
    pub is_in_multi_action: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SettingsPayload {
    pub settings: Value,
    pub coordinates: Coordinates,
    #[serde(rename = "isInMultiAction")]
    pub is_in_multi_action: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GlobalSettingsPayload {
    pub settings: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Coordinates {
    pub column: u8,
    pub row: u8,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeviceInfoPayload {
    pub name: String,
    pub r#type: u8,
    pub size: DeviceSize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeviceSize {
    pub columns: u8,
    pub rows: u8,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SetTitlePayload {
    pub title: Option<String>,
    pub target: Option<u8>,
    pub state: Option<u8>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SetImagePayload {
    pub image: Option<String>,
    pub target: Option<u8>,
    pub state: Option<u8>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SetStatePayload {
    pub state: u8,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OpenUrlPayload {
    pub url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LogPayload {
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SwitchProfilePayload {
    pub profile: String,
    pub page: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VariablePayload {
    pub name: String,
    pub value: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GetVariablePayload {
    pub name: String,
}

/// Registration info sent to plugins on startup.
#[derive(Debug, Clone, Serialize)]
pub struct RegistrationInfo {
    pub application: AppInfo,
    pub plugin: PluginInfo,
    pub devices: Vec<RegistrationDevice>,
    #[serde(rename = "devicePixelRatio")]
    pub device_pixel_ratio: u8,
}

#[derive(Debug, Clone, Serialize)]
pub struct AppInfo {
    pub language: String,
    pub platform: String,
    #[serde(rename = "platformVersion")]
    pub platform_version: String,
    pub version: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct PluginInfo {
    pub uuid: String,
    pub version: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct RegistrationDevice {
    pub id: String,
    pub name: String,
    pub size: DeviceSize,
    pub r#type: u8,
}
