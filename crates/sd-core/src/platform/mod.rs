mod active_window;

pub use active_window::get_active_window;

/// Info about the currently focused window.
#[derive(Debug, Clone)]
pub struct ActiveWindowInfo {
    pub title: String,
    pub app_name: String,
    pub pid: u32,
}
