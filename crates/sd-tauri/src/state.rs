use sd_core::device::DeviceManager;
use sd_core::profile::ProfileStore;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use tokio::sync::broadcast;

#[derive(Clone, Debug, serde::Serialize)]
pub struct VarChangeEvent {
    pub name: String,
    pub value: String,
}

pub struct AppState {
    pub profile_store: Arc<RwLock<ProfileStore>>,
    pub device_manager: Arc<Mutex<DeviceManager>>,
    pub variables: Arc<Mutex<HashMap<String, String>>>,
    pub var_tx: broadcast::Sender<VarChangeEvent>,
    pub minimize_to_tray: Arc<AtomicBool>,
}

impl AppState {
    pub fn new() -> Self {
        let (var_tx, _) = broadcast::channel(64);
        Self {
            profile_store: Arc::new(RwLock::new(ProfileStore::new())),
            device_manager: Arc::new(Mutex::new(DeviceManager::new())),
            variables: Arc::new(Mutex::new(HashMap::new())),
            var_tx,
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
