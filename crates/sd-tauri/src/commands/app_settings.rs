use crate::state::AppState;
use tauri::State;

/// Called from frontend when the user toggles "minimize to tray on close".
/// Updates the in-memory flag so it takes effect immediately.
#[tauri::command]
pub fn set_minimize_to_tray(enabled: bool, state: State<'_, AppState>) {
    state.set_minimize_to_tray(enabled);
    tracing::info!("minimize_to_tray set to {}", enabled);
}
