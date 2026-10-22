use crate::state::AppState;
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

#[derive(Clone, Serialize)]
struct VariableChangedEvent {
    name: String,
    value: String,
}

#[derive(Clone, Serialize)]
struct VariableDeletedEvent {
    name: String,
}

#[tauri::command]
pub fn set_variable(state: State<AppState>, app: AppHandle, name: String, value: String) -> Result<(), String> {
    let mut vars = state.variables.lock().map_err(|e| e.to_string())?;
    vars.insert(name.clone(), value.clone());
    let _ = app.emit("variable-changed", VariableChangedEvent { name, value });
    Ok(())
}

#[tauri::command]
pub fn get_variable(state: State<AppState>, name: String) -> Result<Option<String>, String> {
    let vars = state.variables.lock().map_err(|e| e.to_string())?;
    Ok(vars.get(&name).cloned())
}

#[tauri::command]
pub fn list_variables(state: State<AppState>) -> Result<Vec<(String, String)>, String> {
    let vars = state.variables.lock().map_err(|e| e.to_string())?;
    Ok(vars.iter().map(|(k, v)| (k.clone(), v.clone())).collect())
}

/// Delete a variable and emit "variable-deleted" {name} if it existed.
#[tauri::command]
pub fn delete_variable(state: State<AppState>, app: AppHandle, name: String) -> Result<(), String> {
    let mut vars = state.variables.lock().map_err(|e| e.to_string())?;
    if vars.remove(&name).is_some() {
        let _ = app.emit("variable-deleted", VariableDeletedEvent { name });
    }
    Ok(())
}
