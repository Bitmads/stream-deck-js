#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod api_server;
mod commands;
mod state;
mod ws_server;

use state::AppState;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use tauri::{
    menu::{MenuBuilder, MenuItemBuilder},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Emitter, Manager, WindowEvent,
};

const API_PORT: u16 = 8484;
const API_BIND: &str = "0.0.0.0";

/// Load app_settings.json and return (minimize_to_tray, start_minimized).
/// Returns defaults (true, false) if file doesn't exist or is malformed.
fn load_app_settings() -> (bool, bool) {
    let base = match dirs::config_dir() {
        Some(d) => d.join("open-stream-deck"),
        None => return (true, false),
    };
    let path = base.join("app_settings.json");
    let content = match std::fs::read_to_string(&path) {
        Ok(c) => c,
        Err(_) => return (true, false),
    };
    let json: serde_json::Value = match serde_json::from_str(&content) {
        Ok(v) => v,
        Err(_) => return (true, false),
    };
    let minimize = json.get("minimizeToTray").and_then(|v| v.as_bool()).unwrap_or(true);
    let start_min = json.get("startMinimized").and_then(|v| v.as_bool()).unwrap_or(false);
    (minimize, start_min)
}

fn main() {
    tracing_subscriber::fmt().init();

    // Ensure WebKitGTK works regardless of GPU/driver state.
    // Without these, WebKitGTK can abort() on systems where GBM/EGL
    // initialisation fails (e.g. headless, Wayland edge-cases, driver bugs).
    #[cfg(target_os = "linux")]
    {
        if std::env::var("WEBKIT_DISABLE_DMABUF_RENDERER").is_err() {
            std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
        }
    }

    let app_state = AppState::new();
    let var_rx = app_state.var_tx.subscribe();

    // Load app settings (tray behavior, start-minimized)
    let (minimize_to_tray_default, start_minimized) = load_app_settings();
    app_state.set_minimize_to_tray(minimize_to_tray_default);

    // Load API key from OS keychain (if any)
    commands::api_keys::load_api_key_on_startup();

    // Start HTTP API server (shares state via Arc, binds to 0.0.0.0 for LAN access)
    api_server::start_api_server(
        AppState {
            profile_store: app_state.profile_store.clone(),
            device_manager: app_state.device_manager.clone(),
            plugin_manager: app_state.plugin_manager.clone(),
            variables: app_state.variables.clone(),
            var_tx: app_state.var_tx.clone(),
            minimize_to_tray: app_state.minimize_to_tray.clone(),
        },
        API_PORT,
        API_BIND,
    );

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .manage(app_state)
        .manage(Arc::new(AtomicBool::new(false)))
        .setup(move |app| {
            // Open devtools in debug mode
            #[cfg(debug_assertions)]
            if let Some(window) = app.get_webview_window("main") {
                window.open_devtools();
            }

            // Build system tray
            let show = MenuItemBuilder::with_id("show", "Show").build(app)?;
            let quit = MenuItemBuilder::with_id("quit", "Quit").build(app)?;
            let menu = MenuBuilder::new(app).items(&[&show, &quit]).build()?;

            let _tray = TrayIconBuilder::new()
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "show" => {
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.unminimize();
                            let _ = w.set_focus();
                        }
                    }
                    "quit" => {
                        app.exit(0);
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.unminimize();
                            let _ = w.set_focus();
                        }
                    }
                })
                .build(app)?;

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

            // Show window unless start-minimized is enabled
            if !start_minimized {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.show();
                    let _ = w.set_focus();
                }
            }

            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let state = window.state::<AppState>();
                if state.should_minimize_to_tray() {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
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
            commands::app_settings::set_minimize_to_tray,
            commands::plugin::discover_external_plugins,
            commands::plugin::start_external_plugin,
            commands::plugin::stop_external_plugin,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Open Stream Deck");
}
