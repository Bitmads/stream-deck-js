#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod api_server;
mod commands;
mod state;
mod ws_server;

use state::AppState;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use tauri::{Emitter, Manager};

const API_PORT: u16 = 8484;
const API_BIND: &str = "0.0.0.0";

fn main() {
    tracing_subscriber::fmt().init();

    let app_state = AppState::new();
    let var_rx = app_state.var_tx.subscribe();

    // Load API key from OS keychain (if any)
    commands::api_keys::load_api_key_on_startup();

    // Start HTTP API server (shares state via Arc, binds to 0.0.0.0 for LAN access)
    api_server::start_api_server(
        AppState {
            profile_store: app_state.profile_store.clone(),
            device_manager: app_state.device_manager.clone(),
            variables: app_state.variables.clone(),
            var_tx: app_state.var_tx.clone(),
            minimize_to_tray: app_state.minimize_to_tray.clone(),
        },
        API_PORT,
        API_BIND,
    );

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(app_state)
        .manage(Arc::new(AtomicBool::new(false)))
        .setup(|app| {
            // Open devtools in debug mode
            #[cfg(debug_assertions)]
            if let Some(window) = app.get_webview_window("main") {
                window.open_devtools();
            }

            // Start plugin WebSocket server
            let _ws_handle = ws_server::start_ws_server();
            tracing::info!("Plugin server on port {}", _ws_handle.port);

            // Forward API variable changes to frontend
            let app_for_vars = app.handle().clone();
            std::thread::spawn(move || {
                let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
                rt.block_on(async move {
                    let mut rx = var_rx;
                    loop {
                        match rx.recv().await {
                            Ok(evt) => { let _ = app_for_vars.emit("variable-changed", &evt); }
                            Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                                tracing::warn!("Variable forwarder lagged, skipped {} events", n);
                            }
                            Err(_) => break, // Channel closed
                        }
                    }
                });
            });

            // Load profiles from disk on startup
            let app_handle = app.handle().clone();
            std::thread::spawn(move || {
                let state = app_handle.state::<AppState>();
                if let Err(e) = commands::profile::load_profiles_from_disk_inner(&state) {
                    tracing::warn!("Failed to load profiles: {}", e);
                }
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::device::list_devices,
            commands::device::open_device,
            commands::device::get_device_info,
            commands::device::send_rendered_image,
            commands::device::clear_key,
            commands::device::set_brightness,
            commands::device::send_lcd_image,
            commands::device::start_key_listener,
            commands::device::stop_key_listener,
            commands::action::execute_action,
            commands::window::start_window_watcher,
            commands::profile::get_active_profile,
            commands::profile::list_profiles,
            commands::profile::save_profile,
            commands::profile::export_profile,
            commands::profile::import_profile,
            commands::profile::save_profiles_to_disk,
            commands::profile::load_profiles_from_disk,
            commands::storage::save_json_file,
            commands::storage::load_json_file,
            commands::storage::list_json_files,
            commands::storage::delete_json_file,
            commands::variables::set_variable,
            commands::variables::get_variable,
            commands::variables::list_variables,
            commands::variables::delete_variable,
            commands::api_keys::generate_api_key,
            commands::api_keys::list_api_keys,
            commands::api_keys::revoke_api_key,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Open Stream Deck");
}
