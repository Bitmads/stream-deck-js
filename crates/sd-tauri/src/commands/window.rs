use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter};

#[derive(Clone, Serialize)]
struct ActiveWindowEvent {
    app_name: String,
    title: String,
}

/// Starts a background thread polling the active window every 500ms.
/// Emits "active-window-changed" event when it changes.
#[tauri::command]
pub fn start_window_watcher(
    app: AppHandle,
    _running: tauri::State<Arc<AtomicBool>>,
) -> Result<(), String> {
    // Reuse the same flag — if key listener is running, window watcher piggybacks.
    // For now, use a separate static flag.
    static WATCHER_RUNNING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

    if WATCHER_RUNNING.load(Ordering::Relaxed) {
        return Ok(());
    }
    WATCHER_RUNNING.store(true, Ordering::Relaxed);

    std::thread::spawn(move || {
        let mut prev_app = String::new();
        let mut prev_title = String::new();
        let mut detection_failing = false;

        while WATCHER_RUNNING.load(Ordering::Relaxed) {
            match sd_core::platform::get_active_window() {
                Ok(Some(win)) => {
                    if detection_failing {
                        tracing::info!("Active window detection is working again");
                        detection_failing = false;
                    }
                    if win.app_name != prev_app || win.title != prev_title {
                        prev_app = win.app_name.clone();
                        prev_title = win.title.clone();
                        let _ = app.emit("active-window-changed", ActiveWindowEvent {
                            app_name: win.app_name,
                            title: win.title,
                        });
                    }
                }
                Ok(None) => {}
                Err(e) => {
                    // Log once per failure streak, not every 500 ms.
                    if !detection_failing {
                        tracing::warn!("Window-focus scene triggers are inactive: {}", e);
                        detection_failing = true;
                    }
                }
            }
            std::thread::sleep(std::time::Duration::from_millis(500));
        }
    });

    Ok(())
}
