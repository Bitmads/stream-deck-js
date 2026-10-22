use crate::state::AppState;
use std::path::PathBuf;
use tauri::State;

/// Host-side settings read from `~/.config/open-stream-deck/app_settings.json`
/// at startup. The UI owns the file; unknown keys are ignored here.
#[derive(Debug, Clone, PartialEq)]
pub struct AppSettings {
    /// "minimizeToTray" (default true)
    pub minimize_to_tray: bool,
    /// "startMinimized" (default false)
    pub start_minimized: bool,
    /// "apiBind": REST API bind address (default "0.0.0.0" so Home Assistant
    /// on the LAN can reach it; requests are still gated by API keys).
    pub api_bind: String,
    /// "nodePath": node executable for JavaScript plugins (default: auto-detect).
    pub node_path: Option<PathBuf>,
}

pub const DEFAULT_API_BIND: &str = "0.0.0.0";

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            minimize_to_tray: true,
            start_minimized: false,
            api_bind: DEFAULT_API_BIND.to_string(),
            node_path: None,
        }
    }
}

impl AppSettings {
    /// Parse the JSON text of app_settings.json; malformed input yields defaults.
    pub fn parse(content: &str) -> Self {
        let defaults = Self::default();
        let json: serde_json::Value = match serde_json::from_str(content) {
            Ok(v) => v,
            Err(e) => {
                tracing::warn!("app_settings.json is not valid JSON ({}); using defaults", e);
                return defaults;
            }
        };
        let non_empty_str = |key: &str| {
            json.get(key)
                .and_then(|v| v.as_str())
                .map(|s| s.trim())
                .filter(|s| !s.is_empty())
                .map(str::to_string)
        };
        let api_bind = match non_empty_str("apiBind") {
            Some(b) if b.parse::<std::net::IpAddr>().is_ok() => b,
            Some(b) => {
                tracing::warn!("Ignoring invalid apiBind {:?}; using {}", b, DEFAULT_API_BIND);
                defaults.api_bind.clone()
            }
            None => defaults.api_bind.clone(),
        };
        Self {
            minimize_to_tray: json.get("minimizeToTray").and_then(|v| v.as_bool()).unwrap_or(defaults.minimize_to_tray),
            start_minimized: json.get("startMinimized").and_then(|v| v.as_bool()).unwrap_or(defaults.start_minimized),
            api_bind,
            node_path: non_empty_str("nodePath").map(PathBuf::from),
        }
    }

    /// Load from disk, falling back to defaults if the file is missing or malformed.
    pub fn load() -> Self {
        let path = match crate::state::config_dir() {
            Ok(d) => d.join("app_settings.json"),
            Err(_) => return Self::default(),
        };
        match std::fs::read_to_string(&path) {
            Ok(content) => Self::parse(&content),
            Err(_) => Self::default(),
        }
    }
}

/// Called from frontend when the user toggles "minimize to tray on close".
/// Updates the in-memory flag so it takes effect immediately.
#[tauri::command]
pub fn set_minimize_to_tray(enabled: bool, state: State<'_, AppState>) {
    state.set_minimize_to_tray(enabled);
    tracing::info!("minimize_to_tray set to {}", enabled);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_when_missing_or_malformed() {
        assert_eq!(AppSettings::parse("{}"), AppSettings::default());
        assert_eq!(AppSettings::parse("not json"), AppSettings::default());
        assert_eq!(AppSettings::default().api_bind, "0.0.0.0");
    }

    #[test]
    fn reads_all_keys() {
        let s = AppSettings::parse(r#"{"minimizeToTray":false,"startMinimized":true,"apiBind":"127.0.0.1","nodePath":"/opt/node/bin/node","activeProfile":"work"}"#);
        assert!(!s.minimize_to_tray);
        assert!(s.start_minimized);
        assert_eq!(s.api_bind, "127.0.0.1");
        assert_eq!(s.node_path, Some(PathBuf::from("/opt/node/bin/node")));
    }

    #[test]
    fn rejects_invalid_bind_and_empty_node_path() {
        let s = AppSettings::parse(r#"{"apiBind":"not an ip","nodePath":"  "}"#);
        assert_eq!(s.api_bind, "0.0.0.0");
        assert_eq!(s.node_path, None);
        assert_eq!(AppSettings::parse(r#"{"apiBind":"::1"}"#).api_bind, "::1");
    }
}
