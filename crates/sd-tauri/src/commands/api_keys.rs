use rand::Rng;
use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};

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

/// Get the list of key IDs from the index. `Ok(vec![])` when no index is
/// stored; `Err` when the keychain could not be read (locked, unavailable).
fn get_key_ids() -> Result<Vec<String>, String> {
    match index_entry()?.get_password() {
        Ok(s) => Ok(s.split(',').filter(|s| !s.is_empty()).map(|s| s.to_string()).collect()),
        Err(keyring::Error::NoEntry) => Ok(vec![]),
        Err(e) => Err(format!("Could not read the API key index from the OS keychain: {}", e)),
    }
}

fn save_key_ids(ids: &[String]) -> Result<(), String> {
    index_entry()?
        .set_password(&ids.join(","))
        .map_err(|e| format!("Failed to update the API key index: {}", e))
}

/// Generate a new API key, store in OS keychain, return the full key (shown once).
/// Keyring commands run off the main thread: Secret Service calls can block
/// on an unlock prompt.
#[tauri::command(async)]
pub fn generate_api_key(name: String) -> Result<String, String> {
    // Read the index first: if it cannot be read, writing it back would drop
    // every existing key.
    let mut ids = get_key_ids()?;
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
    ids.push(id.clone());
    save_key_ids(&ids)?;

    // Every stored key stays valid; refresh the live key set.
    reload_api_keys();

    tracing::info!("Generated API key '{}' (id: {})", name, id);
    Ok(key) // Full key shown to user once
}

/// List all API keys (without the actual secrets).
#[tauri::command(async)]
pub fn list_api_keys() -> Result<Vec<ApiKeyInfo>, String> {
    let ids = get_key_ids()?;
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
#[tauri::command(async)]
pub fn revoke_api_key(id: String) -> Result<(), String> {
    let ids: Vec<String> = get_key_ids()?.into_iter().filter(|i| i != &id).collect();

    // Delete from keychain
    if let Ok(entry) = keyring_entry(&id) { let _ = entry.delete_credential(); }
    if let Ok(entry) = meta_entry(&id) { let _ = entry.delete_credential(); }

    // Remove from index
    save_key_ids(&ids)?;

    reload_api_keys();
    tracing::info!("Revoked API key (id: {})", id);
    Ok(())
}

/// State of the API key set for the Settings page.
#[derive(Debug, Clone, Serialize)]
pub struct ApiAuthStatus {
    /// The stored keys are not fully loaded; the API only accepts loaded keys.
    pub locked: bool,
    /// The keychain error that caused the lock, if any (None while loading).
    pub error: Option<String>,
}

#[tauri::command]
pub fn get_api_auth_status() -> ApiAuthStatus {
    let (locked, error) = crate::api_server::api_auth_status();
    ApiAuthStatus { locked, error }
}

/// Read every stored key. On a keychain error, returns the keys that could be
/// read together with the error. A listed key whose entry no longer exists is
/// skipped (it was deleted), which is not an error.
fn load_keys() -> Result<Vec<String>, (Vec<String>, String)> {
    let ids = get_key_ids().map_err(|e| (vec![], e))?;
    let mut keys = vec![];
    let mut error = None;
    for id in &ids {
        let read = keyring_entry(id).and_then(|entry| match entry.get_password() {
            Ok(k) => Ok(Some(k)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(format!("Could not read API key {} from the OS keychain: {}", id, e)),
        });
        match read {
            Ok(Some(k)) if !k.is_empty() => keys.push(k),
            Ok(Some(_)) => {}
            Ok(None) => tracing::warn!("API key {} is listed in the index but no longer stored; ignoring it", id),
            Err(e) => { error.get_or_insert(e); }
        }
    }
    match error {
        None => Ok(keys),
        Some(e) => Err((keys, e)),
    }
}

/// A retry loop is running (at most one).
static RETRY_ACTIVE: AtomicBool = AtomicBool::new(false);
/// Delays between keychain retries while the API is locked.
const RETRY_DELAYS_SECS: [u64; 4] = [5, 10, 30, 60];

/// Load every stored, non-revoked API key into the API server. All of them
/// are accepted. With no keys, the API only serves loopback clients. If the
/// keychain cannot be read, the API stays locked (fails closed) and the read
/// is retried in the background with backoff until it succeeds. Blocking:
/// call it off the main thread (it can wait on a keychain unlock prompt).
pub fn reload_api_keys() {
    match load_keys() {
        Ok(keys) => {
            if keys.is_empty() {
                tracing::info!("No API keys configured — API accepts loopback (127.0.0.1/::1) clients only");
            } else {
                tracing::info!("Loaded {} API key(s) from keychain", keys.len());
            }
            crate::api_server::set_api_keys(keys);
        }
        Err((keys, e)) => {
            crate::api_server::set_api_keys_locked(keys, e);
            spawn_retry();
        }
    }
}

fn spawn_retry() {
    if RETRY_ACTIVE.compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire).is_err() {
        return;
    }
    std::thread::spawn(|| {
        let mut attempt = 0usize;
        loop {
            let delay = RETRY_DELAYS_SECS[attempt.min(RETRY_DELAYS_SECS.len() - 1)];
            std::thread::sleep(std::time::Duration::from_secs(delay));
            attempt += 1;
            // Another reload (generate/revoke) may have succeeded meanwhile.
            if crate::api_server::api_auth_status().0 {
                match load_keys() {
                    Ok(keys) => {
                        tracing::info!("API keys loaded from keychain after {} retr{}", attempt, if attempt == 1 { "y" } else { "ies" });
                        crate::api_server::set_api_keys(keys);
                    }
                    Err((keys, e)) => {
                        crate::api_server::set_api_keys_locked(keys, e);
                        continue;
                    }
                }
            }
            RETRY_ACTIVE.store(false, Ordering::Release);
            // A failure that raced with this exit found the flag still set and
            // did not start a loop: keep going in that case.
            if !crate::api_server::api_auth_status().0
                || RETRY_ACTIVE.compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire).is_err()
            {
                break;
            }
        }
    });
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
