use crate::state::AppState;

#[derive(serde::Serialize)]
pub struct ExternalPluginInfo {
    pub uuid: String,
    pub name: String,
    pub description: String,
    pub version: String,
    pub author: String,
    pub actions: Vec<ExternalActionInfo>,
    pub has_config: bool,
}

#[derive(serde::Serialize)]
pub struct ExternalActionInfo {
    pub uuid: String,
    pub name: String,
}

#[tauri::command]
pub fn discover_external_plugins(state: tauri::State<AppState>) -> Result<Vec<ExternalPluginInfo>, String> {
    let mut pm = state.plugin_manager.lock().map_err(|e| e.to_string())?;
    pm.discover().map_err(|e| e.to_string())?;
    let manifests = pm.list_discovered();
    let infos: Vec<ExternalPluginInfo> = manifests.iter().map(|m| {
        let has_config = pm.get_plugin_dir(&m.uuid)
            .map(|d| d.join("config.schema.json").exists())
            .unwrap_or(false);
        ExternalPluginInfo {
            uuid: m.uuid.clone(),
            name: m.name.clone(),
            description: m.description.clone().unwrap_or_default(),
            version: m.version.clone(),
            author: m.author.clone().unwrap_or_else(|| "Unknown".to_string()),
            actions: m.actions.iter().map(|a| ExternalActionInfo {
                uuid: a.uuid.clone(),
                name: a.name.clone(),
            }).collect(),
            has_config,
        }
    }).collect();
    Ok(infos)
}

#[tauri::command]
pub fn start_external_plugin(uuid: String, state: tauri::State<AppState>) -> Result<(), String> {
    let ws_port = state.ws_port.load(std::sync::atomic::Ordering::Relaxed);
    let mut pm = state.plugin_manager.lock().map_err(|e| e.to_string())?;
    pm.start_plugin(&uuid, ws_port).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn stop_external_plugin(uuid: String, state: tauri::State<AppState>) -> Result<(), String> {
    let mut pm = state.plugin_manager.lock().map_err(|e| e.to_string())?;
    pm.stop_plugin(&uuid).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_plugin_config_schema(uuid: String, state: tauri::State<AppState>) -> Result<String, String> {
    let pm = state.plugin_manager.lock().map_err(|e| e.to_string())?;
    let dir = pm.get_plugin_dir(&uuid)
        .ok_or_else(|| format!("Plugin {} not found", uuid))?;
    std::fs::read_to_string(dir.join("config.schema.json"))
        .map_err(|e| format!("No config schema: {}", e))
}

#[tauri::command]
pub fn read_plugin_config(uuid: String, state: tauri::State<AppState>) -> Result<String, String> {
    let pm = state.plugin_manager.lock().map_err(|e| e.to_string())?;
    let dir = pm.get_plugin_dir(&uuid)
        .ok_or_else(|| format!("Plugin {} not found", uuid))?;
    std::fs::read_to_string(dir.join("config.json"))
        .map_err(|e| format!("No config file: {}", e))
}

#[tauri::command]
pub fn write_plugin_config(uuid: String, config: String, state: tauri::State<AppState>) -> Result<(), String> {
    let pm = state.plugin_manager.lock().map_err(|e| e.to_string())?;
    let dir = pm.get_plugin_dir(&uuid)
        .ok_or_else(|| format!("Plugin {} not found", uuid))?;
    std::fs::write(dir.join("config.json"), config)
        .map_err(|e| format!("Failed to write config: {}", e))
}
