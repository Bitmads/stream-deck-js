//! Plugin WebSocket server (Elgato Stream Deck SDK wire protocol).
//!
//! Plugins are spawned with `-pluginUUID <manifest UUID>` and must register
//! with that UUID; only plugins currently started by the PluginManager are
//! accepted, and nothing else is processed before registration.
//!
//! The host handles registerPlugin, setVariable/getVariable, openUrl,
//! logMessage and setGlobalSettings/getGlobalSettings itself. Every other
//! message that carries a `context` is emitted to the UI as
//! "plugin-command" {plugin_uuid, message}. Registration and disconnect are
//! emitted as "plugin-connected" / "plugin-disconnected" {plugin_uuid}.

use crate::state::VarChangeEvent;
use sd_core::plugin::{PluginCommand, PluginManager};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter};
use tokio::sync::{broadcast, mpsc};
use tokio_tungstenite::tungstenite::handshake::server::{ErrorResponse, Request, Response};
use tracing::{error, info, warn};

/// Registered plugin sessions, keyed by manifest UUID.
#[derive(Default)]
pub struct PluginHub {
    sessions: Mutex<HashMap<String, mpsc::UnboundedSender<String>>>,
}

impl PluginHub {
    /// Send a raw JSON text message to a connected plugin.
    pub fn send(&self, plugin_uuid: &str, message: String) -> Result<(), String> {
        let sessions = self.sessions.lock().unwrap_or_else(|e| e.into_inner());
        let tx = sessions.get(plugin_uuid)
            .ok_or_else(|| format!("Plugin {} is not connected", plugin_uuid))?;
        tx.send(message).map_err(|_| format!("Plugin {} is not connected", plugin_uuid))
    }

    pub fn is_connected(&self, plugin_uuid: &str) -> bool {
        self.sessions.lock().unwrap_or_else(|e| e.into_inner())
            .get(plugin_uuid)
            .map(|tx| !tx.is_closed())
            .unwrap_or(false)
    }

    /// Register a session. Refused (returns false) while another connection
    /// still holds a live session for the same plugin, so a second client
    /// cannot take over a running plugin's channel.
    fn register(&self, plugin_uuid: &str, tx: mpsc::UnboundedSender<String>) -> bool {
        let mut sessions = self.sessions.lock().unwrap_or_else(|e| e.into_inner());
        if sessions.get(plugin_uuid).map(|cur| !cur.is_closed()).unwrap_or(false) {
            return false;
        }
        sessions.insert(plugin_uuid.to_string(), tx);
        true
    }

    /// Remove the session only if it still belongs to this connection (a
    /// newer connection for the same plugin may have replaced it).
    fn unregister(&self, plugin_uuid: &str, tx: &mpsc::UnboundedSender<String>) -> bool {
        let mut sessions = self.sessions.lock().unwrap_or_else(|e| e.into_inner());
        if sessions.get(plugin_uuid).map(|cur| cur.same_channel(tx)).unwrap_or(false) {
            sessions.remove(plugin_uuid);
            true
        } else {
            false
        }
    }
}

/// Everything a connection handler needs.
#[derive(Clone)]
pub struct WsContext {
    pub app: AppHandle,
    pub hub: Arc<PluginHub>,
    pub plugin_manager: Arc<Mutex<PluginManager>>,
    pub variables: Arc<Mutex<HashMap<String, String>>>,
    pub var_tx: broadcast::Sender<VarChangeEvent>,
}

/// Only clients without an Origin header may connect. Plugins are local
/// processes (node/native), which send none; every browser context sends one
/// (sandboxed iframes and file:/data: documents send "null"). The app's own
/// webview talks to plugins through `plugin_send_event`, never this socket.
fn origin_allowed(origin: Option<&str>) -> bool {
    origin.is_none()
}

/// Start the plugin WebSocket server on a random loopback port and return the port.
/// Spawns its own Tokio runtime in a background thread.
pub fn start_ws_server(ctx: WsContext) -> std::io::Result<u16> {
    let std_listener = std::net::TcpListener::bind("127.0.0.1:0")?;
    let port = std_listener.local_addr()?.port();
    std_listener.set_nonblocking(true)?;

    std::thread::spawn(move || {
        let rt = match tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .worker_threads(2)
            .build()
        {
            Ok(rt) => rt,
            Err(e) => { error!("Failed to create Tokio runtime for WS server: {}", e); return; }
        };

        rt.block_on(async move {
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
                tokio::spawn(handle_connection(stream, ctx.clone()));
            }
        });
    });

    Ok(port)
}

async fn handle_connection(stream: tokio::net::TcpStream, ctx: WsContext) {
    // Signature is fixed by tungstenite's handshake Callback trait.
    #[allow(clippy::result_large_err)]
    let check_origin = |req: &Request, resp: Response| -> Result<Response, ErrorResponse> {
        let origin = req.headers().get("origin").and_then(|v| v.to_str().ok());
        if origin_allowed(origin) {
            Ok(resp)
        } else {
            warn!("Rejected plugin WebSocket connection from origin {:?}", origin);
            let mut err = ErrorResponse::new(Some("Forbidden origin".into()));
            *err.status_mut() = tokio_tungstenite::tungstenite::http::StatusCode::FORBIDDEN;
            Err(err)
        }
    };
    let ws = match tokio_tungstenite::accept_hdr_async(stream, check_origin).await {
        Ok(ws) => ws,
        Err(e) => { warn!("WS handshake failed: {}", e); return; }
    };

    use futures_util::{SinkExt, StreamExt};
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

    let mut registered: Option<String> = None;

    while let Some(Ok(msg)) = read.next().await {
        let text = match msg {
            tokio_tungstenite::tungstenite::Message::Text(t) => t,
            tokio_tungstenite::tungstenite::Message::Close(_) => break,
            _ => continue,
        };
        let text_str: &str = &text;
        let value: Value = match serde_json::from_str(text_str) {
            Ok(v) => v,
            Err(e) => { warn!("Invalid plugin message: {}", e); continue; }
        };
        let event = value.get("event").and_then(|v| v.as_str()).unwrap_or("").to_string();

        if registered.is_none() {
            if event != "registerPlugin" {
                warn!("Ignoring {:?} from an unregistered plugin connection", event);
                continue;
            }
            let uuid = value.get("uuid").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let known = ctx.plugin_manager.lock().ok()
                .filter(|pm| pm.is_managed(&uuid))
                .map(|pm| pm.list_discovered().iter().map(|m| m.uuid.clone()).collect::<Vec<_>>());
            let Some(known) = known else {
                warn!("Rejected registration for unknown or stopped plugin {:?}", uuid);
                break;
            };
            if !ctx.hub.register(&uuid, tx.clone()) {
                warn!("Rejected registration for {:?}: the plugin already has a live session", uuid);
                break;
            }
            info!("Plugin registered: {}", uuid);
            if let Ok(dir) = crate::state::config_dir() {
                crate::commands::plugin::migrate_legacy_global_settings(&dir, &uuid, &known);
            }
            let _ = ctx.app.emit("plugin-connected", json!({ "plugin_uuid": uuid }));
            registered = Some(uuid);
            continue;
        }
        let plugin_uuid = registered.as_deref().unwrap_or_default();

        if PluginCommand::is_host_event(&event) {
            match serde_json::from_value::<PluginCommand>(value) {
                Ok(cmd) => handle_host_command(cmd, plugin_uuid, &ctx, &tx),
                Err(e) => warn!("Invalid {} message from {}: {}", event, plugin_uuid, e),
            }
        } else if value.get("context").is_some() {
            let _ = ctx.app.emit("plugin-command", json!({
                "plugin_uuid": plugin_uuid,
                "message": text_str,
            }));
        } else {
            warn!("Unsupported plugin message {:?} from {}", event, plugin_uuid);
        }
    }

    // Cleanup on disconnect
    if let Some(uuid) = registered {
        if ctx.hub.unregister(&uuid, &tx) {
            info!("Plugin disconnected: {}", uuid);
            let _ = ctx.app.emit("plugin-disconnected", json!({ "plugin_uuid": uuid }));
        }
    }
    write_task.abort();
}

fn handle_host_command(
    cmd: PluginCommand,
    plugin_uuid: &str,
    ctx: &WsContext,
    reply_tx: &mpsc::UnboundedSender<String>,
) {
    match cmd {
        PluginCommand::LogMessage { payload } => {
            info!("[Plugin {}] {}", plugin_uuid, payload.message);
        }
        PluginCommand::OpenUrl { payload } => {
            if crate::commands::action::is_safe_url(&payload.url) {
                if let Err(e) = crate::commands::action::open_url(&payload.url) {
                    warn!("openUrl from {} failed: {}", plugin_uuid, e);
                }
            } else {
                warn!("Blocked non-HTTP URL from plugin {}: {}", plugin_uuid, payload.url);
            }
        }
        PluginCommand::SetVariable { payload } => {
            info!("[Plugin {}] setVariable: {} = {}", plugin_uuid, payload.name, payload.value);
            let mut vars = ctx.variables.lock().unwrap_or_else(|e| e.into_inner());
            vars.insert(payload.name.clone(), payload.value.clone());
            let _ = ctx.var_tx.send(VarChangeEvent { name: payload.name, value: payload.value, deleted: false });
        }
        PluginCommand::GetVariable { payload } => {
            let vars = ctx.variables.lock().unwrap_or_else(|e| e.into_inner());
            let value = vars.get(&payload.name).cloned().unwrap_or_default();
            let response = json!({
                "event": "variableChanged",
                "payload": { "name": payload.name, "value": value }
            });
            let _ = reply_tx.send(response.to_string());
        }
        PluginCommand::SetGlobalSettings { payload } => {
            let result = crate::state::config_dir()
                .and_then(|dir| crate::commands::plugin::write_global_settings(&dir, plugin_uuid, &payload));
            if let Err(e) = result {
                error!("Failed to save global settings for {}: {}", plugin_uuid, e);
            }
        }
        PluginCommand::GetGlobalSettings {} => {
            let settings = crate::state::config_dir()
                .map(|dir| crate::commands::plugin::read_global_settings(&dir, plugin_uuid))
                .unwrap_or_else(|_| json!({}));
            let response = json!({
                "event": "didReceiveGlobalSettings",
                "payload": { "settings": settings }
            });
            let _ = reply_tx.send(response.to_string());
        }
        PluginCommand::RegisterPlugin { .. } | PluginCommand::RegisterPropertyInspector { .. } => {
            warn!("Ignoring repeated registration from {}", plugin_uuid);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn origin_policy() {
        assert!(origin_allowed(None));
        assert!(!origin_allowed(Some("null")));
        assert!(!origin_allowed(Some("tauri://localhost")));
        assert!(!origin_allowed(Some("http://tauri.localhost")));
        assert!(!origin_allowed(Some("file://")));
        assert!(!origin_allowed(Some("https://evil.example")));
        assert!(!origin_allowed(Some("http://127.0.0.1:8000")));
        assert!(!origin_allowed(Some("chrome-extension://abc")));
    }

    #[test]
    fn hub_send_and_unregister_only_own_session() {
        let hub = PluginHub::default();
        assert!(hub.send("p", "{}".into()).is_err());
        let (tx1, mut rx1) = mpsc::unbounded_channel();
        let (tx2, mut rx2) = mpsc::unbounded_channel();
        assert!(hub.register("p", tx1.clone()));
        // A second client cannot take over a live session.
        assert!(!hub.register("p", tx2.clone()));
        hub.send("p", "first".into()).unwrap();
        assert_eq!(rx1.try_recv().unwrap(), "first");
        assert!(rx2.try_recv().is_err());
        // Once the first connection's channel is closed, a reconnect replaces it.
        drop(rx1);
        assert!(hub.register("p", tx2.clone()));
        hub.send("p", "hello".into()).unwrap();
        assert_eq!(rx2.try_recv().unwrap(), "hello");
        assert!(!hub.unregister("p", &tx1), "stale connection must not remove the new session");
        assert!(hub.is_connected("p"));
        assert!(hub.unregister("p", &tx2));
        assert!(!hub.is_connected("p"));
    }
}
