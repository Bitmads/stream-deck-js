/// Simple raw JSON file storage for frontend state.
/// Files are stored at ~/.config/open-stream-deck/<filename>.json
///
/// Writes are atomic (temp file + fsync + rename) with mode 0600 on unix.
/// Profiles (`profile_*`) additionally keep one previous copy as
/// `profile_<name>.json.bak`.
///
/// Optimistic concurrency: `load_json_file_stamped` returns a stamp of the
/// content it read and `save_json_file` returns the stamp of what it wrote.
/// A save that passes `expected_stamp` is refused with an error starting with
/// [`CHANGED_ON_DISK`] when the file no longer has that stamp (another writer,
/// e.g. `PUT /api/profile/{name}`, replaced it), so a stale autosave cannot
/// overwrite it.
use crate::state::config_dir;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// Prefix of the error returned when `expected_stamp` does not match.
pub const CHANGED_ON_DISK: &str = "changed on disk";

/// Serialises every write (and its stamp check) through `save_json_in`.
static WRITE_LOCK: Mutex<()> = Mutex::new(());

/// Stamp of a file's content (length + 64-bit hash). Only compared within one
/// app run, never persisted.
pub fn content_stamp(content: &[u8]) -> String {
    let mut h = std::collections::hash_map::DefaultHasher::new();
    content.hash(&mut h);
    format!("{}-{:016x}", content.len(), h.finish())
}

/// Write `<filename>.json`; returns the stamp of the written content.
#[tauri::command(async)]
pub fn save_json_file(filename: String, content: String, expected_stamp: Option<String>) -> Result<String, String> {
    let path = save_json_in(&config_dir()?, &filename, &content, expected_stamp.as_deref())?;
    tracing::info!("Saved {} ({} bytes)", path.display(), content.len());
    Ok(content_stamp(content.as_bytes()))
}

#[derive(Debug, serde::Serialize)]
pub struct StampedJson {
    pub content: String,
    pub stamp: String,
}

/// Read `<filename>.json` with the stamp of exactly the content returned.
#[tauri::command(async)]
pub fn load_json_file_stamped(filename: String) -> Result<Option<StampedJson>, String> {
    let path = json_path(&config_dir()?, &filename);
    match std::fs::read_to_string(&path) {
        Ok(content) => Ok(Some(StampedJson { stamp: content_stamp(content.as_bytes()), content })),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command(async)]
pub fn load_json_file(filename: String) -> Result<Option<String>, String> {
    let path = json_path(&config_dir()?, &filename);
    if !path.exists() {
        return Ok(None);
    }
    let content = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    Ok(Some(content))
}

#[tauri::command]
pub fn list_json_files() -> Result<Vec<String>, String> {
    let dir = config_dir()?;
    if !dir.exists() { return Ok(vec![]); }
    let mut files = vec![];
    for entry in std::fs::read_dir(&dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if path.extension().map(|e| e == "json").unwrap_or(false) {
            if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) {
                files.push(stem.to_string());
            }
        }
    }
    Ok(files)
}

#[tauri::command]
pub fn delete_json_file(filename: String) -> Result<(), String> {
    let path = json_path(&config_dir()?, &filename);
    if path.exists() {
        std::fs::remove_file(&path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub fn sanitize_filename(name: &str) -> String {
    name.chars().map(|c| if c.is_alphanumeric() || c == '-' || c == '_' { c } else { '_' }).collect()
}

pub fn json_path(dir: &Path, filename: &str) -> PathBuf {
    dir.join(format!("{}.json", sanitize_filename(filename)))
}

/// Path of a stored profile: `<dir>/profile_<name>.json`.
pub fn profile_path(dir: &Path, name: &str) -> PathBuf {
    json_path(dir, &format!("profile_{}", name))
}

/// Write `<dir>/<filename>.json` atomically; profiles keep one `.bak` copy.
/// With `expected_stamp`, the write only happens while the file still has
/// that stamp (a missing file never matches).
pub fn save_json_in(dir: &Path, filename: &str, content: &str, expected_stamp: Option<&str>) -> Result<PathBuf, String> {
    let _guard = WRITE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let path = json_path(dir, filename);
    if let Some(expected) = expected_stamp {
        let current = match std::fs::read(&path) {
            Ok(bytes) => Some(content_stamp(&bytes)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
            Err(e) => return Err(format!("Failed to read {}: {}", path.display(), e)),
        };
        if current.as_deref() != Some(expected) {
            return Err(format!("{}: {} was replaced by another writer", CHANGED_ON_DISK, path.display()));
        }
    }
    let is_profile = sanitize_filename(filename).starts_with("profile_");
    let result = if is_profile {
        sd_core::profile::write_profile_file(&path, content.as_bytes())
    } else {
        sd_core::profile::atomic_write(&path, content.as_bytes())
    };
    result.map_err(|e| format!("Failed to write {}: {}", path.display(), e))?;
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn profiles_get_backup_other_files_do_not() {
        let dir = std::env::temp_dir().join(format!("sd-tauri-storage-test-{}", uuid::Uuid::new_v4().simple()));
        save_json_in(&dir, "profile_default", "{\"v\":1}", None).unwrap();
        save_json_in(&dir, "profile_default", "{\"v\":2}", None).unwrap();
        save_json_in(&dir, "app_settings", "{\"a\":1}", None).unwrap();
        save_json_in(&dir, "app_settings", "{\"a\":2}", None).unwrap();
        assert_eq!(std::fs::read_to_string(dir.join("profile_default.json")).unwrap(), "{\"v\":2}");
        assert_eq!(std::fs::read_to_string(dir.join("profile_default.json.bak")).unwrap(), "{\"v\":1}");
        assert!(!dir.join("app_settings.json.bak").exists());
        assert_eq!(profile_path(&dir, "default"), dir.join("profile_default.json"));
        // Path traversal is neutralised.
        assert_eq!(json_path(&dir, "../x"), dir.join("___x.json"));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn expected_stamp_refuses_stale_writes() {
        let dir = std::env::temp_dir().join(format!("sd-tauri-stamp-test-{}", uuid::Uuid::new_v4().simple()));
        save_json_in(&dir, "profile_p", "{\"v\":1}", None).unwrap();
        let loaded = content_stamp(b"{\"v\":1}");
        // Another writer (API PUT) replaces the file.
        save_json_in(&dir, "profile_p", "{\"v\":\"api\"}", None).unwrap();
        let err = save_json_in(&dir, "profile_p", "{\"v\":\"stale\"}", Some(&loaded)).unwrap_err();
        assert!(err.starts_with(CHANGED_ON_DISK), "{}", err);
        assert_eq!(std::fs::read_to_string(dir.join("profile_p.json")).unwrap(), "{\"v\":\"api\"}");
        // A matching stamp writes.
        let current = content_stamp(b"{\"v\":\"api\"}");
        save_json_in(&dir, "profile_p", "{\"v\":3}", Some(&current)).unwrap();
        assert_eq!(std::fs::read_to_string(dir.join("profile_p.json")).unwrap(), "{\"v\":3}");
        // A missing file never matches an expected stamp.
        assert!(save_json_in(&dir, "profile_q", "{}", Some(&current)).is_err());
        assert_ne!(content_stamp(b"ab"), content_stamp(b"ba"));
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
