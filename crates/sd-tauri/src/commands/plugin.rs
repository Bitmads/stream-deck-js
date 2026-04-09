use crate::state::AppState;

#[derive(serde::Serialize)]
pub struct ExternalPluginInfo {
    pub uuid: String,
    pub name: String,
    pub description: String,
    pub version: String,
    pub author: String,
    pub actions: Vec<ExternalActionInfo>,
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
    Ok(manifests.iter().map(|m| ExternalPluginInfo {
        uuid: m.uuid.clone(),
        name: m.name.clone(),
        description: m.description.clone().unwrap_or_default(),
        version: m.version.clone(),
        author: m.author.clone().unwrap_or_else(|| "Unknown".to_string()),
        actions: m.actions.iter().map(|a| ExternalActionInfo {
            uuid: a.uuid.clone(),
            name: a.name.clone(),
        }).collect(),
    }).collect())
}

#[tauri::command]
pub fn start_external_plugin(uuid: String, state: tauri::State<AppState>) -> Result<(), String> {
    let ws_port = 0; // TODO: get actual WS port from WsServerHandle
    let mut pm = state.plugin_manager.lock().map_err(|e| e.to_string())?;
    pm.start_plugin(&uuid, ws_port).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn stop_external_plugin(uuid: String, state: tauri::State<AppState>) -> Result<(), String> {
    let mut pm = state.plugin_manager.lock().map_err(|e| e.to_string())?;
    pm.stop_plugin(&uuid).map_err(|e| e.to_string())
}
