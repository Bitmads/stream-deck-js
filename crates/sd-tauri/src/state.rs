use crate::ws_server::PluginHub;
use sd_core::device::DeviceManager;
use sd_core::plugin::PluginManager;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU16, Ordering};
use std::sync::{Arc, Mutex};
use tokio::sync::broadcast;

/// A variable change from the API or a plugin, forwarded to the UI as
/// "variable-changed" ({name, value}) or, when `deleted`, "variable-deleted" ({name}).
#[derive(Clone, Debug)]
pub struct VarChangeEvent {
    pub name: String,
    pub value: String,
    pub deleted: bool,
}

/// Ask the UI to reload `profile_<name>.json` from disk ("profile-reload" event).
#[derive(Clone, Debug, serde::Serialize)]
pub struct ProfileReloadEvent {
    pub name: String,
}

#[derive(Clone)]
pub struct AppState {
    pub device_manager: Arc<Mutex<DeviceManager>>,
    pub plugin_manager: Arc<Mutex<PluginManager>>,
    pub plugin_hub: Arc<PluginHub>,
    pub variables: Arc<Mutex<HashMap<String, String>>>,
    pub var_tx: broadcast::Sender<VarChangeEvent>,
    pub profile_tx: broadcast::Sender<ProfileReloadEvent>,
    pub ws_port: Arc<AtomicU16>,
    pub minimize_to_tray: Arc<AtomicBool>,
}

/// `~/.config/open-stream-deck`
pub fn config_dir() -> Result<PathBuf, String> {
    let base = dirs::config_dir().ok_or("Could not determine config directory")?;
    Ok(base.join("open-stream-deck"))
}

impl AppState {
    pub fn new() -> Self {
        let (var_tx, _) = broadcast::channel(64);
        let (profile_tx, _) = broadcast::channel(16);

        // User-installed plugins. Bundled plugins (release builds) are added
        // from the resource dir in setup; the repo's plugins/ only in debug builds.
        let mut plugin_dirs = Vec::new();
        if let Ok(dir) = config_dir() {
            let user_plugins = dir.join("plugins");
            if let Err(e) = std::fs::create_dir_all(&user_plugins) {
                tracing::warn!("Failed to create {}: {}", user_plugins.display(), e);
            }
            plugin_dirs.push(user_plugins);
        }
        #[cfg(debug_assertions)]
        {
            // CARGO_MANIFEST_DIR = crates/sd-tauri → up 2 levels to the repo root.
            if let Some(repo_root) = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).ancestors().nth(2) {
                plugin_dirs.push(repo_root.join("plugins"));
            }
        }

        Self {
            device_manager: Arc::new(Mutex::new(DeviceManager::new())),
            plugin_manager: Arc::new(Mutex::new(PluginManager::new(plugin_dirs))),
            plugin_hub: Arc::new(PluginHub::default()),
            variables: Arc::new(Mutex::new(HashMap::new())),
            var_tx,
            profile_tx,
            ws_port: Arc::new(AtomicU16::new(0)),
            minimize_to_tray: Arc::new(AtomicBool::new(true)), // default: on
        }
    }

    pub fn should_minimize_to_tray(&self) -> bool {
        self.minimize_to_tray.load(Ordering::Relaxed)
    }

    pub fn set_minimize_to_tray(&self, enabled: bool) {
        self.minimize_to_tray.store(enabled, Ordering::Relaxed);
    }
}
