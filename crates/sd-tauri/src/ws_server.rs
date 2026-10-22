use sd_core::plugin::protocol::{PluginCommand, RegistrationInfo, AppInfo, PluginInfo};
use crate::state::VarChangeEvent;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tokio::sync::{broadcast, mpsc};
use tracing::{info, warn, error};

/// Handle to communicate with the WebSocket server.
pub struct WsServerHandle {
    pub port: u16,
    /// Send events to connected plugins by UUID.
    pub event_tx: mpsc::UnboundedSender<(String, String)>, // (plugin_uuid, json_message)
}

/// Connected plugin session.
struct PluginSession {
    uuid: String,
    tx: mpsc::UnboundedSender<String>,
}

/// Start the plugin WebSocket server on a random port.
/// Spawns its own Tokio runtime in a background thread.
pub fn start_ws_server(
    variables: Arc<Mutex<HashMap<String, String>>>,
    var_tx: broadcast::Sender<VarChangeEvent>,
) -> WsServerHandle {
    let std_listener = std::net::TcpListener::bind("127.0.0.1:0").expect("Failed to bind WS server");
    let port = std_listener.local_addr().unwrap().port();
    std_listener.set_nonblocking(true).ok();

    let (event_tx, mut event_rx) = mpsc::unbounded_channel::<(String, String)>();
    let sessions: Arc<Mutex<HashMap<String, PluginSession>>> = Arc::new(Mutex::new(HashMap::new()));

    let sessions_clone = sessions.clone();
    let sessions_for_server = sessions.clone();

    // Run the entire WS server on a dedicated Tokio runtime in a background thread
    std::thread::spawn(move || {
        let rt = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .worker_threads(2)
            .build()
            .expect("Failed to create Tokio runtime for WS server");

        rt.block_on(async move {
            // Forward events to the right plugin
            tokio::spawn(async move {
                while let Some((uuid, msg)) = event_rx.recv().await {
                    let sessions = sessions_clone.lock().unwrap();
                    if let Some(session) = sessions.get(&uuid) {
                        let _ = session.tx.send(msg);
                    }
                }
            });

            // Reuse the pre-bound listener (no TOCTOU race)
        let listener = match tokio::net::TcpListener::from_std(std_listener) {
            Ok(l) => l,
            Err(e) => { error!("Failed to convert WS listener: {}", e); return; }
        };
        info!("Plugin WebSocket server listening on ws://127.0.0.1:{}", port);

        loop {
            let (stream, peer) = match listener.accept().await {
                Ok(s) => s,
                Err(e) => { warn!("WS accept error: {}", e); continue; }
            };
            info!("Plugin connection from {}", peer);

            let sessions = sessions_for_server.clone();
            let vars_for_conn = variables.clone();
            let var_tx_for_conn = var_tx.clone();

            tokio::spawn(async move {
                let ws = match tokio_tungstenite::accept_async(stream).await {
                    Ok(ws) => ws,
                    Err(e) => { warn!("WS handshake failed: {}", e); return; }
                };

                use futures_util::{StreamExt, SinkExt};
                let (mut write, mut read) = ws.split();
                let (tx, mut rx) = mpsc::unbounded_channel::<String>();

                // Forward outgoing messages
                let write_task = tokio::spawn(async move {
                    while let Some(msg) = rx.recv().await {
                        if write.send(tokio_tungstenite::tungstenite::Message::Text(msg.into())).await.is_err() {
                            break;
                        }
                    }
                });

                let mut registered_uuid: Option<String> = None;

                // Read incoming messages
                while let Some(Ok(msg)) = read.next().await {
                    if let tokio_tungstenite::tungstenite::Message::Text(text) = msg {
                        let text_str: &str = &text;
                        match serde_json::from_str::<PluginCommand>(text_str) {
                            Ok(PluginCommand::RegisterPlugin { uuid }) => {
                                info!("Plugin registered: {}", uuid);
                                sessions.lock().unwrap().insert(uuid.clone(), PluginSession {
                                    uuid: uuid.clone(),
                                    tx: tx.clone(),
                                });
                                registered_uuid = Some(uuid);
                            }
                            Ok(PluginCommand::RegisterPropertyInspector { uuid }) => {
                                info!("Property Inspector registered: {}", uuid);
                                registered_uuid = Some(uuid);
                            }
                            Ok(cmd) => {
                                handle_plugin_command(cmd, &vars_for_conn, &var_tx_for_conn, &tx);
                            }
                            Err(e) => {
                                warn!("Invalid plugin message: {}", e);
                            }
                        }
                    }
                }

                // Cleanup on disconnect
                if let Some(uuid) = registered_uuid {
                    info!("Plugin disconnected: {}", uuid);
                    sessions.lock().unwrap().remove(&uuid);
                }
                write_task.abort();
            });
        }
        }); // end rt.block_on
    }); // end std::thread::spawn

    info!("Plugin WebSocket server allocated on port {}", port);
    WsServerHandle { port, event_tx }
}

fn handle_plugin_command(
    cmd: PluginCommand,
    variables: &Arc<Mutex<HashMap<String, String>>>,
    var_tx: &broadcast::Sender<VarChangeEvent>,
    reply_tx: &mpsc::UnboundedSender<String>,
) {
    match cmd {
        PluginCommand::LogMessage { payload } => {
            info!("[Plugin] {}", payload.message);
        }
        PluginCommand::OpenUrl { payload } => {
            if crate::commands::action::is_safe_url(&payload.url) {
                let _ = std::process::Command::new("xdg-open").arg(&payload.url).spawn();
            } else {
                warn!("Blocked non-HTTP URL from plugin: {}", payload.url);
            }
        }
        PluginCommand::SetTitle { context, payload } => {
            info!("Plugin setTitle: context={} title={:?}", context, payload.title);
        }
        PluginCommand::SetImage { context, payload } => {
            info!("Plugin setImage: context={} has_image={}", context, payload.image.is_some());
        }
        PluginCommand::SetVariable { payload } => {
            info!("[Plugin] setVariable: {} = {}", payload.name, payload.value);
            let mut vars = variables.lock().unwrap_or_else(|e| e.into_inner());
            vars.insert(payload.name.clone(), payload.value.clone());
            let _ = var_tx.send(VarChangeEvent { name: payload.name, value: payload.value });
        }
        PluginCommand::GetVariable { payload } => {
            let vars = variables.lock().unwrap_or_else(|e| e.into_inner());
            let value = vars.get(&payload.name).cloned().unwrap_or_default();
            let response = serde_json::json!({
                "event": "variableChanged",
                "payload": { "name": payload.name, "value": value }
            });
            let _ = reply_tx.send(response.to_string());
        }
        _ => {}
    }
}

/// Build the registration info JSON blob that gets passed to plugins on startup.
pub fn build_registration_info(plugin_uuid: &str) -> RegistrationInfo {
    RegistrationInfo {
        application: AppInfo {
            language: "en".to_string(),
            platform: std::env::consts::OS.to_string(),
            platform_version: String::new(),
            version: "0.1.0".to_string(),
        },
        plugin: PluginInfo {
            uuid: plugin_uuid.to_string(),
            version: "1.0.0".to_string(),
        },
        devices: vec![],
        device_pixel_ratio: 1,
    }
}
