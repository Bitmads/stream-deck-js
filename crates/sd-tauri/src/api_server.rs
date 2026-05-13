use crate::state::AppState;
use axum::{
    extract::{Path, State as AxState},
    http::{header, Method, StatusCode},
    routing::{delete, get, post, put},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tower_http::cors::CorsLayer;
use tracing::info;

type SharedState = Arc<AppState>;

/// Precomputed "Bearer <key>" header value for constant-time comparison.
static API_BEARER: Mutex<Option<String>> = Mutex::new(None);

/// Set the active API key at runtime (called from api_keys commands).
pub fn set_active_api_key(key: Option<String>) {
    let mut k = API_BEARER.lock().unwrap_or_else(|e| e.into_inner());
    match key {
        Some(k_val) => {
            info!("API authentication enabled");
            *k = Some(format!("Bearer {}", k_val));
        }
        None => {
            info!("API authentication disabled");
            *k = None;
        }
    }
}

pub fn start_api_server(state: AppState, port: u16, bind_address: &str) {
    let shared: SharedState = Arc::new(state);
    let addr = format!("{}:{}", bind_address, port);

    std::thread::spawn(move || {
        let rt = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .worker_threads(2)
            .build()
            .expect("Failed to create API runtime");

        rt.block_on(async move {
            let mut origins: Vec<axum::http::HeaderValue> = vec![
                "tauri://localhost".parse().unwrap(),
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
                // Variables (read-only endpoints don't need auth)
                .route("/api/variables", get(list_variables))
                .route("/api/variables/{name}", get(get_variable))
                .route("/api/variables/{name}", put(set_variable))
                .route("/api/variables/{name}", delete(delete_variable))
                // Actions
                .route("/api/actions/execute", post(execute_action))
                .layer(cors)
                .layer(axum::middleware::from_fn(auth_middleware))
                .with_state(shared);

            match tokio::net::TcpListener::bind(&addr).await {
                Ok(listener) => {
                    info!("HTTP API server listening on http://{}", addr);
                    axum::serve(listener, app).await.ok();
                }
                Err(e) => {
                    tracing::warn!("API server failed to bind on {}: {} (another instance running?)", addr, e);
                }
            }
        });
    });
}

// ─── Auth Middleware ──────────────────────────────────────────

async fn auth_middleware(
    req: axum::extract::Request,
    next: axum::middleware::Next,
) -> Result<axum::response::Response, StatusCode> {
    let expected = API_BEARER.lock().unwrap_or_else(|e| e.into_inner()).clone();

    // If no API key is configured, allow all requests
    if expected.is_none() {
        return Ok(next.run(req).await);
    }
    let expected = expected.unwrap();

    // Health endpoint is always public
    if req.uri().path() == "/api/health" {
        return Ok(next.run(req).await);
    }

    // Check Authorization header with constant-time comparison
    let auth = req.headers().get("authorization")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");

    let auth_bytes = auth.as_bytes();
    let expected_bytes = expected.as_bytes();
    // Constant-time: always compare full length, XOR all bytes
    let len_match = auth_bytes.len() == expected_bytes.len();
    let mut diff = 0u8;
    for i in 0..expected_bytes.len() {
        diff |= auth_bytes.get(i).copied().unwrap_or(0xFF) ^ expected_bytes[i];
    }
    if len_match && diff == 0 {
        Ok(next.run(req).await)
    } else {
        Err(StatusCode::UNAUTHORIZED)
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

async fn list_devices(AxState(state): AxState<SharedState>) -> Json<Vec<DeviceDto>> {
    let mut mgr = state.device_manager.lock().unwrap_or_else(|e| e.into_inner());
    let devs_raw = mgr.enumerate().unwrap_or_default();
    let devs: Vec<DeviceDto> = devs_raw.iter().map(|d| {
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
    }).collect();
    Json(devs)
}

#[derive(Deserialize)]
struct BrightnessBody {
    percent: u8,
}

async fn set_brightness(
    AxState(state): AxState<SharedState>,
    Path(_serial): Path<String>,
    Json(body): Json<BrightnessBody>,
) -> StatusCode {
    let mgr = state.device_manager.lock().unwrap_or_else(|e| e.into_inner());
    match mgr.set_brightness(body.percent) {
        Ok(()) => StatusCode::OK,
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR,
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

async fn set_variable(
    AxState(state): AxState<SharedState>,
    Path(name): Path<String>,
    Json(body): Json<SetVarBody>,
) -> StatusCode {
    // Validate variable name (alphanumeric, dots, underscores, hyphens only)
    if !name.chars().all(|c| c.is_alphanumeric() || c == '.' || c == '_' || c == '-') {
        return StatusCode::BAD_REQUEST;
    }
    let mut vars = state.variables.lock().unwrap_or_else(|e| e.into_inner());
    vars.insert(name.clone(), body.value.clone());
    let _ = state.var_tx.send(crate::state::VarChangeEvent { name, value: body.value });
    StatusCode::OK
}

async fn delete_variable(
    AxState(state): AxState<SharedState>,
    Path(name): Path<String>,
) -> StatusCode {
    let mut vars = state.variables.lock().unwrap_or_else(|e| e.into_inner());
    vars.remove(&name);
    StatusCode::OK
}

#[derive(Deserialize)]
struct ExecuteBody {
    action_type: String,
    settings: serde_json::Value,
}

async fn execute_action(Json(body): Json<ExecuteBody>) -> StatusCode {
    let settings_str = body.settings.to_string();
    match crate::commands::action::execute_action(body.action_type, settings_str) {
        Ok(()) => StatusCode::OK,
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR,
    }
}