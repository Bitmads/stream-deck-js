use crate::{Error, Result};
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

/// Longest profile name accepted from external callers.
pub const PROFILE_NAME_MAX_LEN: usize = 64;

/// Sanitize an externally supplied profile name.
///
/// Every character outside `[A-Za-z0-9_-]` is replaced by `_`. Returns `None`
/// for names that are empty (after trimming) or longer than
/// [`PROFILE_NAME_MAX_LEN`].
pub fn sanitize_profile_name(name: &str) -> Option<String> {
    let name = name.trim();
    if name.is_empty() || name.chars().count() > PROFILE_NAME_MAX_LEN {
        return None;
    }
    Some(
        name.chars()
            .map(|c| if c.is_ascii_alphanumeric() || c == '_' || c == '-' { c } else { '_' })
            .collect(),
    )
}

/// Check that `content` is a profile document: a JSON object whose `devices`
/// field is an object. Returns the parsed value.
pub fn validate_profile_json(content: &str) -> Result<serde_json::Value> {
    let value: serde_json::Value = serde_json::from_str(content)?;
    let obj = value
        .as_object()
        .ok_or_else(|| Error::Profile("profile must be a JSON object".into()))?;
    match obj.get("devices") {
        Some(serde_json::Value::Object(_)) => Ok(value),
        Some(_) => Err(Error::Profile("profile field \"devices\" must be an object".into())),
        None => Err(Error::Profile("profile is missing the \"devices\" object".into())),
    }
}

/// The single backup kept next to `path`: `<file name>.bak`.
pub fn backup_path(path: &Path) -> PathBuf {
    let mut name = path.file_name().unwrap_or_default().to_os_string();
    name.push(".bak");
    path.with_file_name(name)
}

/// Write `bytes` to `path` atomically.
///
/// The data goes to a temporary file in the same directory, is fsynced, and is
/// then renamed over `path`, so readers see either the old or the new content,
/// never a truncated file. On unix the file is created with mode 0600.
pub fn atomic_write(path: &Path, bytes: &[u8]) -> Result<()> {
    let dir = path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(dir)?;

    let file_name = path
        .file_name()
        .ok_or_else(|| Error::Io(std::io::Error::new(std::io::ErrorKind::InvalidInput, "path has no file name")))?
        .to_string_lossy()
        .into_owned();
    let tmp = dir.join(format!(".{}.{}.tmp", file_name, uuid::Uuid::new_v4().simple()));

    let result = (|| -> Result<()> {
        let mut opts = OpenOptions::new();
        opts.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o600);
        }
        let mut f = opts.open(&tmp)?;
        #[cfg(unix)]
        {
            // `mode` is filtered by the umask; enforce 0600 explicitly.
            use std::os::unix::fs::PermissionsExt;
            f.set_permissions(fs::Permissions::from_mode(0o600))?;
        }
        f.write_all(bytes)?;
        f.sync_all()?;
        drop(f);
        fs::rename(&tmp, path)?;
        Ok(())
    })();

    if result.is_err() {
        let _ = fs::remove_file(&tmp);
        return result;
    }

    // Persist the rename itself (directory entry). Not supported on Windows.
    #[cfg(unix)]
    if let Ok(d) = File::open(dir) {
        let _ = d.sync_all();
    }
    Ok(())
}

/// Atomically write a profile file, first keeping exactly one copy of the
/// previous content as `<file name>.bak` (also written atomically).
pub fn write_profile_file(path: &Path, bytes: &[u8]) -> Result<()> {
    match fs::read(path) {
        Ok(previous) => {
            if previous != bytes {
                atomic_write(&backup_path(path), &previous)?;
            }
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(e.into()),
    }
    atomic_write(path, bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir() -> PathBuf {
        let d = std::env::temp_dir().join(format!("sd-core-storage-test-{}", uuid::Uuid::new_v4().simple()));
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn sanitize_replaces_disallowed_characters() {
        assert_eq!(sanitize_profile_name("default").as_deref(), Some("default"));
        assert_eq!(sanitize_profile_name("Work-2_b").as_deref(), Some("Work-2_b"));
        assert_eq!(sanitize_profile_name("my profile").as_deref(), Some("my_profile"));
        assert_eq!(sanitize_profile_name("../../etc/passwd").as_deref(), Some("______etc_passwd"));
        assert_eq!(sanitize_profile_name("név").as_deref(), Some("n_v"));
    }

    #[test]
    fn sanitize_rejects_empty_and_long_names() {
        assert_eq!(sanitize_profile_name(""), None);
        assert_eq!(sanitize_profile_name("   "), None);
        assert_eq!(sanitize_profile_name(&"a".repeat(PROFILE_NAME_MAX_LEN)).map(|s| s.len()), Some(PROFILE_NAME_MAX_LEN));
        assert_eq!(sanitize_profile_name(&"a".repeat(PROFILE_NAME_MAX_LEN + 1)), None);
    }

    #[test]
    fn validate_requires_devices_object() {
        assert!(validate_profile_json(r#"{"name":"default","devices":{},"favorites":[],"recent":[]}"#).is_ok());
        assert!(validate_profile_json(r#"{"name":"default"}"#).is_err());
        assert!(validate_profile_json(r#"{"devices":[]}"#).is_err());
        assert!(validate_profile_json(r#"[1,2]"#).is_err());
        assert!(validate_profile_json(r#"{"devices":{}"#).is_err());
    }

    #[test]
    fn atomic_write_creates_and_replaces() {
        let dir = temp_dir();
        let path = dir.join("cfg.json");
        atomic_write(&path, b"{\"a\":1}").unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "{\"a\":1}");
        atomic_write(&path, b"{\"a\":2}").unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "{\"a\":2}");
        // No temporary files left behind.
        let leftovers: Vec<_> = fs::read_dir(&dir).unwrap().filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().ends_with(".tmp")).collect();
        assert!(leftovers.is_empty());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(&path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600);
        }
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn profile_write_keeps_one_backup() {
        let dir = temp_dir();
        let path = dir.join("profile_default.json");
        write_profile_file(&path, b"v1").unwrap();
        assert!(!backup_path(&path).exists());
        write_profile_file(&path, b"v2").unwrap();
        assert_eq!(fs::read_to_string(backup_path(&path)).unwrap(), "v1");
        write_profile_file(&path, b"v3").unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "v3");
        assert_eq!(fs::read_to_string(backup_path(&path)).unwrap(), "v2");
        // Rewriting identical content does not clobber the backup.
        write_profile_file(&path, b"v3").unwrap();
        assert_eq!(fs::read_to_string(backup_path(&path)).unwrap(), "v2");
        assert_eq!(backup_path(&path).file_name().unwrap(), "profile_default.json.bak");
        let baks = fs::read_dir(&dir).unwrap().filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().ends_with(".bak")).count();
        assert_eq!(baks, 1);
        fs::remove_dir_all(&dir).unwrap();
    }
}
