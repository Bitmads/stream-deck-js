use rand::Rng;
use serde::Serialize;

const SERVICE_NAME: &str = "open-stream-deck";
const KEY_PREFIX: &str = "api-key-";

#[derive(Debug, Clone, Serialize)]
pub struct ApiKeyInfo {
    pub id: String,
    pub name: String,
    pub key_preview: String, // first 8 chars + "..."
    pub created_at: String,
}

fn hex_encode(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

fn keyring_entry(id: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE_NAME, &format!("{}{}", KEY_PREFIX, id))
        .map_err(|e| format!("Keyring error: {}", e))
}

fn meta_entry(id: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE_NAME, &format!("{}meta-{}", KEY_PREFIX, id))
        .map_err(|e| format!("Keyring error: {}", e))
}

fn index_entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE_NAME, "api-key-index")
        .map_err(|e| format!("Keyring error: {}", e))
}

/// Get the list of key IDs from the index.
fn get_key_ids() -> Vec<String> {
    match index_entry() {
        Ok(entry) => match entry.get_password() {
            Ok(s) if !s.is_empty() => s.split(',').map(|s| s.to_string()).collect(),
            _ => vec![],
        },
        Err(_) => vec![],
    }
}

fn save_key_ids(ids: &[String]) {
    if let Ok(entry) = index_entry() {
        let _ = entry.set_password(&ids.join(","));
    }
}

/// Generate a new API key, store in OS keychain, return the full key (shown once).
#[tauri::command]
pub fn generate_api_key(name: String) -> Result<String, String> {
    let id = uuid::Uuid::new_v4().to_string();
    let key = generate_key();

    // Store the key in the OS keychain
    let entry = keyring_entry(&id)?;
    entry.set_password(&key).map_err(|e| format!("Failed to store key: {}", e))?;

    // Store metadata (name + created timestamp)
    let meta = format!("{}|{}", name, chrono_now());
    let m = meta_entry(&id)?;
    m.set_password(&meta).map_err(|e| format!("Failed to store meta: {}", e))?;

    // Add to index
    let mut ids = get_key_ids();
    ids.push(id.clone());
    save_key_ids(&ids);

    // Update the live API server key
    crate::api_server::set_active_api_key(Some(key.clone()));

    tracing::info!("Generated API key '{}' (id: {})", name, id);
    Ok(key) // Full key shown to user once
}

/// List all API keys (without the actual secrets).
#[tauri::command]
pub fn list_api_keys() -> Result<Vec<ApiKeyInfo>, String> {
    let ids = get_key_ids();
    let mut keys = Vec::new();

    for id in &ids {
        let preview = match keyring_entry(id) {
            Ok(e) => match e.get_password() {
                Ok(k) if k.len() >= 8 => format!("{}...", &k[..8]),
                _ => "???".to_string(),
            },
            Err(_) => continue,
        };

        let (name, created) = match meta_entry(id) {
            Ok(e) => match e.get_password() {
                Ok(meta) => {
                    let parts: Vec<&str> = meta.splitn(2, '|').collect();
                    (parts.first().unwrap_or(&"Unnamed").to_string(),
                     parts.get(1).unwrap_or(&"").to_string())
                },
                _ => ("Unnamed".to_string(), String::new()),
            },
            Err(_) => ("Unnamed".to_string(), String::new()),
        };

        keys.push(ApiKeyInfo { id: id.clone(), name, key_preview: preview, created_at: created });
    }

    Ok(keys)
}

/// Revoke (delete) an API key.
#[tauri::command]
pub fn revoke_api_key(id: String) -> Result<(), String> {
    // Delete from keychain
    if let Ok(entry) = keyring_entry(&id) { let _ = entry.delete_credential(); }
    if let Ok(entry) = meta_entry(&id) { let _ = entry.delete_credential(); }

    // Remove from index
    let ids: Vec<String> = get_key_ids().into_iter().filter(|i| i != &id).collect();
    save_key_ids(&ids);

    // Rotate to next available key, or disable auth if none left
    if let Some(next_id) = ids.first() {
        if let Ok(entry) = keyring_entry(next_id) {
            if let Ok(key) = entry.get_password() {
                crate::api_server::set_active_api_key(Some(key));
                tracing::info!("Rotated to API key (id: {})", next_id);
            }
        }
    } else {
        crate::api_server::set_active_api_key(None);
    }

    tracing::info!("Revoked API key (id: {})", id);
    Ok(())
}

/// Load the first API key from keychain on startup (if any exist).
pub fn load_api_key_on_startup() {
    let ids = get_key_ids();
    if let Some(id) = ids.first() {
        if let Ok(entry) = keyring_entry(id) {
            if let Ok(key) = entry.get_password() {
                crate::api_server::set_active_api_key(Some(key));
                tracing::info!("Loaded API key from keychain (id: {})", id);
                return;
            }
        }
    }
    tracing::info!("No API keys configured — API running without authentication");
}

fn generate_key() -> String {
    let mut rng = rand::rng();
    let bytes: [u8; 32] = rng.random();
    hex_encode(&bytes)
}

fn chrono_now() -> String {
    // Simple ISO-ish timestamp without chrono dependency
    let dur = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    format!("{}", dur.as_secs())
}
