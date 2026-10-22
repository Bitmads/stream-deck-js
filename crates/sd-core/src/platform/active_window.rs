use super::ActiveWindowInfo;
use crate::Result;

/// Get information about the currently focused window.
pub fn get_active_window() -> Result<Option<ActiveWindowInfo>> {
    match active_win_pos_rs::get_active_window() {
        Ok(window) => Ok(Some(ActiveWindowInfo {
            title: window.title,
            app_name: window.app_name,
            pid: window.process_id as u32,
        })),
        Err(_) => Ok(None),
    }
}
