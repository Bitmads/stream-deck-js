use super::ActiveWindowInfo;
use crate::Result;

/// Get information about the currently focused window.
///
/// Returns `Err(Error::Platform)` when the platform backend cannot report the
/// focused window (for example a Wayland session without X11 focus info), so
/// callers can tell "no window" apart from "window detection unavailable".
pub fn get_active_window() -> Result<Option<ActiveWindowInfo>> {
    match active_win_pos_rs::get_active_window() {
        Ok(window) => Ok(Some(ActiveWindowInfo {
            title: window.title,
            app_name: window.app_name,
            pid: window.process_id as u32,
        })),
        // active-win-pos-rs reports failures as `Err(())`, so there is no detail to forward.
        Err(()) => Err(crate::Error::Platform(
            "the focused window could not be read (unsupported session, e.g. Wayland without X11 focus info)".into(),
        )),
    }
}
