//! REST API (default 0.0.0.0:8484, see `apiBind` in app_settings.json).
//!
//! Auth (see [`decide_auth`]):
//! - GET /api/health is always public.
//! - With no API key stored, only loopback clients are served.
//! - With keys stored, every other endpoint needs `Authorization: Bearer <key>`
//!   matching any stored key, except the /api/profile endpoints, which loopback
//!   clients may use without a key.
//! - Until the stored keys have been read from the OS keychain (startup, or
//!   after a keychain error) the API is locked: only /api/health and requests
//!   with a successfully loaded key are served. It never falls back to the
//!   keyless loopback mode because the keychain could not be read.
//! - Access granted only because the client is on loopback additionally
//!   requires a local Host header and no foreign web Origin (blocks DNS
//!   rebinding and drive-by requests from web pages).

use crate::state::{AppState, ProfileReloadEvent, VarChangeEvent};
use axum::{
    body::Bytes,
    extract::{ConnectInfo, DefaultBodyLimit, Path, State as AxState},
    http::{header, HeaderMap, Method, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::sync::{Arc, Mutex};
use tower_http::cors::CorsLayer;
use tracing::info;

type SharedState = Arc<AppState>;

/// Live API key state.
struct ApiAuth {
    /// Precomputed "Bearer <key>" values for every loaded API key.
    bearers: Vec<String>,
    /// The stored keys are not (fully) known yet: before the first keychain
    /// read, or after a read failed. Fails closed.
    locked: bool,
    /// Why the keys could not be read, if a read failed.
    error: Option<String>,
}

static API_AUTH: Mutex<ApiAuth> = Mutex::new(ApiAuth { bearers: Vec::new(), locked: true, error: None });

/// Largest accepted profile upload (profiles can embed image data URLs).
const MAX_PROFILE_BYTES: usize = 64 * 1024 * 1024;

/// Replace the set of valid API keys after every stored key was read
/// (called from api_keys). Unlocks the API.
pub fn set_api_keys(keys: Vec<String>) {
    let mut a = API_AUTH.lock().unwrap_or_else(|e| e.into_inner());
    a.bearers = keys.into_iter().map(|k| format!("Bearer {}", k)).collect();
    a.locked = false;
    a.error = None;
    info!("API authentication: {} key(s) active", a.bearers.len());
}

/// The keychain could not be (fully) read: accept only the keys that were
/// loaded and lock everything else until a later read succeeds.
pub fn set_api_keys_locked(keys: Vec<String>, error: String) {
    let mut a = API_AUTH.lock().unwrap_or_else(|e| e.into_inner());
    a.bearers = keys.into_iter().map(|k| format!("Bearer {}", k)).collect();
    a.locked = true;
    tracing::error!("API locked ({} key(s) loaded): {}", a.bearers.len(), error);
    a.error = Some(error);
}

/// `(locked, error)` of the live API key state.
pub fn api_auth_status() -> (bool, Option<String>) {
    let a = API_AUTH.lock().unwrap_or_else(|e| e.into_inner());
    (a.locked, a.error.clone())
}

pub fn start_api_server(state: AppState, port: u16, bind_address: &str) {
    let shared: SharedState = Arc::new(state);
    let addr = match bind_address.parse::<IpAddr>() {
        Ok(ip) => SocketAddr::new(ip, port),
        Err(e) => {
            tracing::error!("Invalid API bind address {:?}: {}; API server not started", bind_address, e);
            return;
        }
    };

    std::thread::spawn(move || {
        let rt = match tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .worker_threads(2)
            .build()
        {
            Ok(rt) => rt,
            Err(e) => { tracing::error!("Failed to create API runtime: {}", e); return; }
        };

        rt.block_on(async move {
            #[allow(unused_mut)] // extended in debug builds
            let mut origins: Vec<axum::http::HeaderValue> = vec![
                "tauri://localhost".parse().unwrap(),
                "http://tauri.localhost".parse().unwrap(),
                "https://tauri.localhost".parse().unwrap(),
            ];
            #[cfg(debug_assertions)]
            origins.push("http://localhost:5173".parse().unwrap());

            let cors = CorsLayer::new()
                .allow_origin(origins)
                .allow_methods([Method::GET, Method::POST, Method::PUT, Method::DELETE])
                .allow_headers([header::CONTENT_TYPE, header::AUTHORIZATION]);

            let app = Router::new()
                .route("/api/health", get(health))
                // Devices
                .route("/api/devices", get(list_devices))
                .route("/api/devices/{serial}/brightness", post(set_brightness))
                // Variables
                .route("/api/variables", get(list_variables))
                .route("/api/variables/{name}", get(get_variable).put(set_variable).delete(delete_variable))
                // Actions
                .route("/api/actions/execute", post(execute_action))
                // Profiles
                .route("/api/profile/reload", post(reload_profile))
                .route(
                    "/api/profile/{name}",
                    get(get_profile).put(put_profile).layer(DefaultBodyLimit::max(MAX_PROFILE_BYTES)),
                )
                .layer(axum::middleware::from_fn(auth_middleware))
                // CORS is the outermost layer so preflights are answered before auth.
                .layer(cors)
                .with_state(shared);

            match tokio::net::TcpListener::bind(addr).await {
                Ok(listener) => {
                    info!("HTTP API server listening on http://{}", addr);
                    if let Err(e) = axum::serve(listener, app.into_make_service_with_connect_info::<SocketAddr>()).await {
                        tracing::error!("API server stopped: {}", e);
                    }
                }
                Err(e) => {
                    tracing::warn!("API server failed to bind on {}: {} (another instance running?)", addr, e);
                }
            }
        });
    });
}

// ─── Auth ─────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuthDecision {
    Allow,
    /// A key is required and none/an invalid one was given.
    Unauthorized,
    /// The request may not be served without a key at all.
    Forbidden,
    /// The stored keys could not be read yet; only a loaded key is accepted.
    Locked,
}

fn is_loopback(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => v4.is_loopback(),
        IpAddr::V6(v6) => v6.is_loopback() || v6.to_ipv4_mapped().map(|v4| v4.is_loopback()).unwrap_or(false),
    }
}

/// Host header names this machine (localhost, 127.x, ::1), with or without a port.
fn is_local_host_header(host: &str) -> bool {
    let host = host.trim();
    let name = if let Some(rest) = host.strip_prefix('[') {
        rest.split(']').next().unwrap_or("")
    } else {
        host.rsplit_once(':').map(|(h, _)| h).unwrap_or(host)
    };
    if name.eq_ignore_ascii_case("localhost") {
        return true;
    }
    name.parse::<IpAddr>().map(is_loopback).unwrap_or(false)
}

/// Origins that may use loopback-trusted access: none (curl, scripts), the
/// app's own webview, and browser extensions (they hold explicit host permissions).
fn is_trusted_origin(origin: &str) -> bool {
    let o = origin.trim().to_ascii_lowercase();
    o == "tauri://localhost"
        || o == "http://tauri.localhost"
        || o == "https://tauri.localhost"
        || o.starts_with("chrome-extension://")
        || o.starts_with("moz-extension://")
        || (cfg!(debug_assertions) && o == "http://localhost:5173")
}

/// Constant-time comparison of the Authorization header against every bearer.
fn matches_any_key(auth: &str, bearers: &[String]) -> bool {
    let auth = auth.as_bytes();
    let mut ok = false;
    for expected in bearers {
        let expected = expected.as_bytes();
        let mut diff = (auth.len() != expected.len()) as u8;
        for (i, &e) in expected.iter().enumerate() {
            diff |= auth.get(i).copied().unwrap_or(0xFF) ^ e;
        }
        ok |= diff == 0;
    }
    ok
}

/// Decide whether a request may proceed.
pub fn decide_auth(
    path: &str,
    peer: IpAddr,
    host: Option<&str>,
    origin: Option<&str>,
    authorization: Option<&str>,
    bearers: &[String],
    locked: bool,
) -> AuthDecision {
    if path == "/api/health" {
        return AuthDecision::Allow;
    }
    if !bearers.is_empty() && authorization.map(|a| matches_any_key(a, bearers)).unwrap_or(false) {
        return AuthDecision::Allow;
    }
    if locked {
        return AuthDecision::Locked;
    }

    let loopback_trusted = is_loopback(peer)
        && host.map(is_local_host_header).unwrap_or(true)
        && origin.map(is_trusted_origin).unwrap_or(true);
    let loopback_exempt = path == "/api/profile" || path.starts_with("/api/profile/");

    if bearers.is_empty() {
        if loopback_trusted { AuthDecision::Allow } else { AuthDecision::Forbidden }
    } else if loopback_exempt && loopback_trusted {
        AuthDecision::Allow
    } else {
        AuthDecision::Unauthorized
    }
}

async fn auth_middleware(
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    req: axum::extract::Request,
    next: axum::middleware::Next,
) -> Response {
    let (bearers, locked) = {
        let a = API_AUTH.lock().unwrap_or_else(|e| e.into_inner());
        (a.bearers.clone(), a.locked)
    };
    let headers = req.headers();
    let hv = |name: header::HeaderName| headers.get(name).and_then(|v| v.to_str().ok());
    let decision = decide_auth(
        req.uri().path(),
        peer.ip(),
        hv(header::HOST),
        hv(header::ORIGIN),
        hv(header::AUTHORIZATION),
        &bearers,
        locked,
    );
    match decision {
        AuthDecision::Allow => next.run(req).await,
        AuthDecision::Unauthorized => (StatusCode::UNAUTHORIZED, "Missing or invalid API key").into_response(),
        AuthDecision::Forbidden => (
            StatusCode::FORBIDDEN,
            "No API key is configured: only local (loopback) clients are allowed. Generate an API key in Settings for LAN access.",
        ).into_response(),
        AuthDecision::Locked => (
            StatusCode::SERVICE_UNAVAILABLE,
            "API keys could not be read from the OS keychain yet (locked or unavailable); retrying. Requests need a valid API key until then.",
        ).into_response(),
    }
}

// ─── Handlers ────────────────────────────────────────────────

async fn health() -> &'static str {
    "ok"
}

#[derive(Serialize)]
struct DeviceDto {
    serial: String,
    model: String,
    columns: u8,
    rows: u8,
    key_size: u16,
    has_lcd: bool,
    encoder_count: u8,
}

async fn list_devices(AxState(state): AxState<SharedState>) -> Response {
    let mut mgr = state.device_manager.lock().unwrap_or_else(|e| e.into_inner());
    match mgr.enumerate() {
        Ok(devs) => Json(devs.iter().map(|d| {
            let p = d.profile;
            DeviceDto {
                serial: d.serial.clone(),
                model: p.display_name.to_string(),
                columns: p.columns,
                rows: p.rows,
                key_size: p.key_pixel_size,
                has_lcd: p.has_lcd_strip,
                encoder_count: p.encoder_count,
            }
        }).collect::<Vec<_>>()).into_response(),
        Err(e) => (StatusCode::SERVICE_UNAVAILABLE, e.to_string()).into_response(),
    }
}

#[derive(Deserialize)]
struct BrightnessBody {
    percent: u8,
}

async fn set_brightness(
    AxState(state): AxState<SharedState>,
    Path(serial): Path<String>,
    Json(body): Json<BrightnessBody>,
) -> Response {
    let mgr = state.device_manager.lock().unwrap_or_else(|e| e.into_inner());
    if mgr.get_device(&serial).is_none() {
        return (StatusCode::NOT_FOUND, format!("Device {} not found", serial)).into_response();
    }
    match mgr.set_brightness(&serial, body.percent.min(100)) {
        Ok(()) => StatusCode::OK.into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    }
}

async fn list_variables(AxState(state): AxState<SharedState>) -> Json<HashMap<String, String>> {
    let vars = state.variables.lock().unwrap_or_else(|e| e.into_inner());
    Json(vars.clone())
}

async fn get_variable(
    AxState(state): AxState<SharedState>,
    Path(name): Path<String>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    let vars = state.variables.lock().unwrap_or_else(|e| e.into_inner());
    match vars.get(&name) {
        Some(v) => Ok(Json(serde_json::json!({"name": name, "value": v}))),
        None => Err(StatusCode::NOT_FOUND),
    }
}

#[derive(Deserialize)]
struct SetVarBody {
    value: String,
}

/// Variable names: alphanumeric, dots, underscores, hyphens.
fn valid_variable_name(name: &str) -> bool {
    !name.is_empty() && name.chars().all(|c| c.is_alphanumeric() || c == '.' || c == '_' || c == '-')
}

async fn set_variable(
    AxState(state): AxState<SharedState>,
    Path(name): Path<String>,
    Json(body): Json<SetVarBody>,
) -> StatusCode {
    if !valid_variable_name(&name) {
        return StatusCode::BAD_REQUEST;
    }
    let mut vars = state.variables.lock().unwrap_or_else(|e| e.into_inner());
    vars.insert(name.clone(), body.value.clone());
    let _ = state.var_tx.send(VarChangeEvent { name, value: body.value, deleted: false });
    StatusCode::OK
}

async fn delete_variable(
    AxState(state): AxState<SharedState>,
    Path(name): Path<String>,
) -> StatusCode {
    if !valid_variable_name(&name) {
        return StatusCode::BAD_REQUEST;
    }
    let mut vars = state.variables.lock().unwrap_or_else(|e| e.into_inner());
    if vars.remove(&name).is_some() {
        let _ = state.var_tx.send(VarChangeEvent { name, value: String::new(), deleted: true });
    }
    StatusCode::OK
}

#[derive(Deserialize)]
struct ExecuteBody {
    action_type: String,
    settings: serde_json::Value,
}

async fn execute_action(Json(body): Json<ExecuteBody>) -> Response {
    let settings_str = body.settings.to_string();
    let result = tokio::task::spawn_blocking(move || {
        crate::commands::action::execute_action(body.action_type, settings_str)
    }).await;
    match result {
        Ok(Ok(())) => StatusCode::OK.into_response(),
        Ok(Err(e)) => (StatusCode::BAD_REQUEST, e).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    }
}

// ─── Profiles ────────────────────────────────────────────────

// Err is an axum Response (handler early-return); boxing it would only add noise.
#[allow(clippy::result_large_err)]
fn profile_name_or_400(raw: &str) -> Result<String, Response> {
    sd_core::profile::sanitize_profile_name(raw).ok_or_else(|| {
        (StatusCode::BAD_REQUEST, format!(
            "Invalid profile name (1-{} characters)", sd_core::profile::PROFILE_NAME_MAX_LEN
        )).into_response()
    })
}

// Err is an axum Response (handler early-return); boxing it would only add noise.
#[allow(clippy::result_large_err)]
fn config_dir_or_500() -> Result<std::path::PathBuf, Response> {
    crate::state::config_dir().map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e).into_response())
}

fn json_response(status: StatusCode, body: String) -> Response {
    let mut headers = HeaderMap::new();
    headers.insert(header::CONTENT_TYPE, "application/json".parse().unwrap());
    (status, headers, body).into_response()
}

async fn get_profile(Path(name): Path<String>) -> Response {
    let name = match profile_name_or_400(&name) { Ok(n) => n, Err(r) => return r };
    let dir = match config_dir_or_500() { Ok(d) => d, Err(r) => return r };
    let path = crate::commands::storage::profile_path(&dir, &name);
    match tokio::fs::read_to_string(&path).await {
        Ok(content) => json_response(StatusCode::OK, content),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            (StatusCode::NOT_FOUND, format!("Profile {} not found", name)).into_response()
        }
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    }
}

/// Replace a stored profile (atomic write, previous version kept as .bak)
/// and tell the UI to reload it.
async fn put_profile(
    AxState(state): AxState<SharedState>,
    Path(name): Path<String>,
    body: String,
) -> Response {
    let name = match profile_name_or_400(&name) { Ok(n) => n, Err(r) => return r };
    if let Err(e) = sd_core::profile::validate_profile_json(&body) {
        return (StatusCode::BAD_REQUEST, e.to_string()).into_response();
    }
    let dir = match config_dir_or_500() { Ok(d) => d, Err(r) => return r };
    let filename = format!("profile_{}", name);
    let written = tokio::task::spawn_blocking(move || {
        crate::commands::storage::save_json_in(&dir, &filename, &body, None)
    }).await;
    match written {
        Ok(Ok(path)) => info!("Profile {} replaced via API ({})", name, path.display()),
        Ok(Err(e)) => return (StatusCode::INTERNAL_SERVER_ERROR, e).into_response(),
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    }
    let _ = state.profile_tx.send(ProfileReloadEvent { name: name.clone() });
    json_response(StatusCode::OK, serde_json::json!({ "ok": true, "name": name }).to_string())
}

/// POST /api/profile/reload with optional JSON body {"name": "..."} (default "default").
async fn reload_profile(AxState(state): AxState<SharedState>, body: Bytes) -> Response {
    let raw_name = if body.iter().all(|b| b.is_ascii_whitespace()) {
        "default".to_string()
    } else {
        match serde_json::from_slice::<serde_json::Value>(&body) {
            Ok(serde_json::Value::Object(obj)) => match obj.get("name") {
                None | Some(serde_json::Value::Null) => "default".to_string(),
                Some(serde_json::Value::String(s)) => s.clone(),
                Some(_) => return (StatusCode::BAD_REQUEST, "\"name\" must be a string").into_response(),
            },
            Ok(_) => return (StatusCode::BAD_REQUEST, "Body must be a JSON object").into_response(),
            Err(e) => return (StatusCode::BAD_REQUEST, format!("Invalid JSON: {}", e)).into_response(),
        }
    };
    let name = match profile_name_or_400(&raw_name) { Ok(n) => n, Err(r) => return r };
    let dir = match config_dir_or_500() { Ok(d) => d, Err(r) => return r };
    if !crate::commands::storage::profile_path(&dir, &name).exists() {
        return (StatusCode::NOT_FOUND, format!("Profile {} not found", name)).into_response();
    }
    let _ = state.profile_tx.send(ProfileReloadEvent { name: name.clone() });
    json_response(StatusCode::OK, serde_json::json!({ "ok": true, "name": name }).to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    const LOCAL: IpAddr = IpAddr::V4(std::net::Ipv4Addr::LOCALHOST);
    const LAN: IpAddr = IpAddr::V4(std::net::Ipv4Addr::new(192, 168, 1, 50));

    fn bearers(keys: &[&str]) -> Vec<String> {
        keys.iter().map(|k| format!("Bearer {}", k)).collect()
    }

    #[test]
    fn no_key_allows_only_loopback() {
        let none: Vec<String> = vec![];
        let h = Some("127.0.0.1:8484");
        assert_eq!(decide_auth("/api/actions/execute", LOCAL, h, None, None, &none, false), AuthDecision::Allow);
        assert_eq!(decide_auth("/api/actions/execute", LAN, Some("192.168.1.2:8484"), None, None, &none, false), AuthDecision::Forbidden);
        assert_eq!(decide_auth("/api/variables", LAN, None, None, Some("Bearer x"), &none, false), AuthDecision::Forbidden);
        let mapped: IpAddr = "::ffff:127.0.0.1".parse().unwrap();
        assert_eq!(decide_auth("/api/variables", mapped, Some("localhost"), None, None, &none, false), AuthDecision::Allow);
        assert_eq!(decide_auth("/api/variables", "::1".parse().unwrap(), Some("[::1]:8484"), None, None, &none, false), AuthDecision::Allow);
    }

    #[test]
    fn health_is_always_public() {
        assert_eq!(decide_auth("/api/health", LAN, None, None, None, &[], false), AuthDecision::Allow);
        assert_eq!(decide_auth("/api/health", LAN, None, None, None, &bearers(&["k"]), false), AuthDecision::Allow);
    }

    #[test]
    fn loopback_rejects_dns_rebinding_and_web_origins() {
        let none: Vec<String> = vec![];
        assert_eq!(decide_auth("/api/actions/execute", LOCAL, Some("evil.example:8484"), None, None, &none, false), AuthDecision::Forbidden);
        assert_eq!(decide_auth("/api/actions/execute", LOCAL, Some("127.0.0.1:8484"), Some("https://evil.example"), None, &none, false), AuthDecision::Forbidden);
        assert_eq!(decide_auth("/api/variables/x", LOCAL, Some("127.0.0.1:8484"), Some("chrome-extension://abcdef"), None, &none, false), AuthDecision::Allow);
        assert_eq!(decide_auth("/api/variables/x", LOCAL, Some("127.0.0.1:8484"), Some("tauri://localhost"), None, &none, false), AuthDecision::Allow);
    }

    #[test]
    fn every_stored_key_is_accepted() {
        let keys = bearers(&["aaaa", "bbbb", "cccc"]);
        for k in ["aaaa", "bbbb", "cccc"] {
            let auth = format!("Bearer {}", k);
            assert_eq!(decide_auth("/api/actions/execute", LAN, None, None, Some(&auth), &keys, false), AuthDecision::Allow);
        }
        assert_eq!(decide_auth("/api/actions/execute", LAN, None, None, Some("Bearer dddd"), &keys, false), AuthDecision::Unauthorized);
        assert_eq!(decide_auth("/api/actions/execute", LAN, None, None, Some("Bearer aaa"), &keys, false), AuthDecision::Unauthorized);
        assert_eq!(decide_auth("/api/actions/execute", LAN, None, None, Some("Bearer aaaaa"), &keys, false), AuthDecision::Unauthorized);
        assert_eq!(decide_auth("/api/actions/execute", LAN, None, None, None, &keys, false), AuthDecision::Unauthorized);
        // With keys stored, loopback needs a key too (except profile endpoints).
        assert_eq!(decide_auth("/api/actions/execute", LOCAL, Some("localhost:8484"), None, None, &keys, false), AuthDecision::Unauthorized);
    }

    #[test]
    fn profile_endpoints_allow_loopback_without_key() {
        let keys = bearers(&["k1"]);
        assert_eq!(decide_auth("/api/profile/reload", LOCAL, Some("127.0.0.1:8484"), None, None, &keys, false), AuthDecision::Allow);
        assert_eq!(decide_auth("/api/profile/default", LOCAL, Some("localhost:8484"), None, None, &keys, false), AuthDecision::Allow);
        assert_eq!(decide_auth("/api/profile/default", LAN, Some("10.0.0.2:8484"), None, None, &keys, false), AuthDecision::Unauthorized);
        assert_eq!(decide_auth("/api/profile/default", LAN, None, None, Some("Bearer k1"), &keys, false), AuthDecision::Allow);
        assert_eq!(decide_auth("/api/profile/default", LAN, None, None, None, &[], false), AuthDecision::Forbidden);
        assert_eq!(decide_auth("/api/profiles", LOCAL, Some("localhost"), None, None, &keys, false), AuthDecision::Unauthorized);
    }

    #[test]
    fn locked_keychain_fails_closed() {
        let none: Vec<String> = vec![];
        let keys = bearers(&["k1"]);
        let h = Some("127.0.0.1:8484");
        // Keychain unreadable: loopback does not fall back to keyless access.
        assert_eq!(decide_auth("/api/actions/execute", LOCAL, h, None, None, &none, true), AuthDecision::Locked);
        assert_eq!(decide_auth("/api/profile/default", LOCAL, h, None, None, &none, true), AuthDecision::Locked);
        assert_eq!(decide_auth("/api/variables", LAN, None, None, Some("Bearer x"), &none, true), AuthDecision::Locked);
        assert_eq!(decide_auth("/api/health", LAN, None, None, None, &none, true), AuthDecision::Allow);
        // Keys that were loaded before the failure keep working.
        assert_eq!(decide_auth("/api/actions/execute", LAN, None, None, Some("Bearer k1"), &keys, true), AuthDecision::Allow);
        assert_eq!(decide_auth("/api/actions/execute", LAN, None, None, Some("Bearer k2"), &keys, true), AuthDecision::Locked);
    }

    #[test]
    fn host_header_parsing() {
        assert!(is_local_host_header("localhost"));
        assert!(is_local_host_header("LOCALHOST:8484"));
        assert!(is_local_host_header("127.0.0.1:8484"));
        assert!(is_local_host_header("127.1.2.3"));
        assert!(is_local_host_header("[::1]:8484"));
        assert!(!is_local_host_header("192.168.1.2:8484"));
        assert!(!is_local_host_header("localhost.evil.example"));
    }
}
