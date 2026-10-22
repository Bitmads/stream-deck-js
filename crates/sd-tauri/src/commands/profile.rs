use crate::state::AppState;
use sd_core::profile::Profile;
use serde_json;
use tauri::State;

#[tauri::command]
pub fn get_active_profile(state: State<AppState>) -> Option<Profile> {
    let store = state.profile_store.read().ok()?;
    store.get_active().cloned()
}

#[tauri::command]
pub fn list_profiles(state: State<AppState>) -> Result<Vec<ProfileSummary>, String> {
    let store = state.profile_store.read().map_err(|e| e.to_string())?;
    Ok(store.list().iter().map(|p| ProfileSummary {
        id: p.id.to_string(),
        name: p.name.clone(),
        scene_count: p.scenes.len(),
    }).collect())
}

#[tauri::command]
pub fn save_profile(state: State<AppState>, profile: Profile) -> Result<(), String> {
    let mut store = state.profile_store.write().map_err(|e| e.to_string())?;
    store.save(profile).map_err(|e| e.to_string())
}

/// Export a profile as JSON string (frontend saves via file dialog).
#[tauri::command]
pub fn export_profile(state: State<AppState>, profile_id: String) -> Result<String, String> {
    let store = state.profile_store.read().map_err(|e| e.to_string())?;
    let id = profile_id.parse().map_err(|_| "Invalid profile ID".to_string())?;
    let profile = store.get(&id).ok_or("Profile not found")?;
    serde_json::to_string_pretty(profile).map_err(|e| e.to_string())
}

/// Import a profile from JSON string.
#[tauri::command]
pub fn import_profile(state: State<AppState>, json: String) -> Result<String, String> {
    let profile: Profile = serde_json::from_str(&json)
        .map_err(|e| format!("Invalid profile JSON: {}", e))?;
    let name = profile.name.clone();
    let mut store = state.profile_store.write().map_err(|e| e.to_string())?;
    store.save(profile).map_err(|e| e.to_string())?;
    Ok(name)
}

/// Save all profiles to disk at ~/.config/open-stream-deck/profiles/
#[tauri::command]
pub fn save_profiles_to_disk(state: State<AppState>) -> Result<(), String> {
    let store = state.profile_store.read().map_err(|e| e.to_string())?;
    let dir = profile_dir()?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    for profile in store.list() {
        let path = dir.join(format!("{}.json", profile.id));
        let json = serde_json::to_string_pretty(profile).map_err(|e| e.to_string())?;
        std::fs::write(&path, json).map_err(|e| e.to_string())?;
    }
    tracing::info!("Saved {} profiles to disk", store.list().len());
    Ok(())
}

/// Load all profiles from disk.
#[tauri::command]
pub fn load_profiles_from_disk(state: State<AppState>) -> Result<usize, String> {
    let dir = profile_dir()?;
    if !dir.exists() { return Ok(0); }

    let mut store = state.profile_store.write().map_err(|e| e.to_string())?;
    let mut count = 0;

    for entry in std::fs::read_dir(&dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if path.extension().map(|e| e == "json").unwrap_or(false) {
            match std::fs::read_to_string(&path) {
                Ok(json) => match serde_json::from_str::<Profile>(&json) {
                    Ok(profile) => {
                        let _ = store.save(profile);
                        count += 1;
                    }
                    Err(e) => tracing::warn!("Failed to parse {}: {}", path.display(), e),
                },
                Err(e) => tracing::warn!("Failed to read {}: {}", path.display(), e),
            }
        }
    }

    tracing::info!("Loaded {} profiles from disk", count);
    Ok(count)
}

#[derive(serde::Serialize)]
pub struct ProfileSummary {
    pub id: String,
    pub name: String,
    pub scene_count: usize,
}

/// Non-command helper for startup profile loading.
pub fn load_profiles_from_disk_inner(state: &AppState) -> Result<(), String> {
    let dir = profile_dir()?;
    if !dir.exists() { return Ok(()); }
    let mut store = state.profile_store.write().map_err(|e| e.to_string())?;
    for entry in std::fs::read_dir(&dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if path.extension().map(|e| e == "json").unwrap_or(false) {
            if let Ok(json) = std::fs::read_to_string(&path) {
                if let Ok(profile) = serde_json::from_str::<Profile>(&json) {
                    let _ = store.save(profile);
                }
            }
        }
    }
    Ok(())
}

fn profile_dir() -> Result<std::path::PathBuf, String> {
    let base = dirs::config_dir().ok_or("Could not determine config directory")?;
    Ok(base.join("open-stream-deck").join("profiles"))
}
