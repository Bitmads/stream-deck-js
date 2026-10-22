use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Plugin-to-host messages that the host handles itself.
///
/// Every other inbound message that carries a `context` (setTitle, setImage,
/// setState, setSettings, getSettings, showOk, showAlert,
/// sendToPropertyInspector, setFeedback, setFeedbackLayout, ...) is
/// forwarded verbatim to the UI, which owns keys, settings and rendering.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "event")]
pub enum PluginCommand {
    #[serde(rename = "openUrl")]
    OpenUrl { payload: OpenUrlPayload },
    #[serde(rename = "logMessage")]
    LogMessage { payload: LogPayload },
    #[serde(rename = "setGlobalSettings")]
    SetGlobalSettings { payload: Value },
    #[serde(rename = "getGlobalSettings")]
    GetGlobalSettings {},
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

impl PluginCommand {
    /// Events parsed into [`PluginCommand`]; anything else is not host-handled.
    pub const HOST_EVENTS: &'static [&'static str] = &[
        "openUrl",
        "logMessage",
        "setGlobalSettings",
        "getGlobalSettings",
        "setVariable",
        "getVariable",
        "registerPlugin",
        "registerPropertyInspector",
    ];

    pub fn is_host_event(event: &str) -> bool {
        Self::HOST_EVENTS.contains(&event)
    }
}

// ─── Payload types ───

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OpenUrlPayload {
    pub url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LogPayload {
    pub message: String,
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

/// Registration info passed to plugins on startup (`-info`).
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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeviceSize {
    pub columns: u8,
    pub rows: u8,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_host_commands() {
        let c: PluginCommand = serde_json::from_str(r#"{"event":"registerPlugin","uuid":"com.x"}"#).unwrap();
        assert!(matches!(c, PluginCommand::RegisterPlugin { uuid } if uuid == "com.x"));
        let c: PluginCommand = serde_json::from_str(r#"{"event":"getGlobalSettings","context":"com.x"}"#).unwrap();
        assert!(matches!(c, PluginCommand::GetGlobalSettings {}));
        let c: PluginCommand = serde_json::from_str(r#"{"event":"setGlobalSettings","context":"com.x","payload":{"a":1}}"#).unwrap();
        assert!(matches!(c, PluginCommand::SetGlobalSettings { payload } if payload["a"] == 1));
        assert!(PluginCommand::is_host_event("setVariable"));
        assert!(!PluginCommand::is_host_event("setTitle"));
    }
}
