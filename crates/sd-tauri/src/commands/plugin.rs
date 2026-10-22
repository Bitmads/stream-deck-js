use crate::state::AppState;
use std::path::{Path, PathBuf};

#[derive(serde::Serialize)]
pub struct ExternalPluginInfo {
    pub uuid: String,
    pub name: String,
    pub description: String,
    pub version: String,
    pub author: String,
    pub actions: Vec<ExternalActionInfo>,
    pub has_config: bool,
}

#[derive(serde::Serialize)]
pub struct ExternalActionInfo {
    pub uuid: String,
    pub name: String,
}

/// Runtime status of one external plugin (`get_plugin_status`).
#[derive(Debug, serde::Serialize)]
pub struct PluginStatusDto {
    pub uuid: String,
    /// The plugin process is alive.
    pub running: bool,
    /// The plugin has registered on the plugin WebSocket.
    pub connected: bool,
    /// Automatic restarts since it was last started by the user.
    pub restarts: u32,
    /// Last start/crash error, if any.
    pub error: Option<String>,
}

// Plugin-manager commands run off the main thread: the manager's lock can be
// held while a plugin process is spawned or node installations are probed.
#[tauri::command(async)]
pub fn discover_external_plugins(state: tauri::State<'_, AppState>) -> Result<Vec<ExternalPluginInfo>, String> {
    let mut pm = state.plugin_manager.lock().map_err(|e| e.to_string())?;
    pm.discover().map_err(|e| e.to_string())?;
    let manifests = pm.list_discovered();
    let infos: Vec<ExternalPluginInfo> = manifests.iter().map(|m| {
        let has_config = pm.get_plugin_dir(&m.uuid)
            .map(|d| d.join("config.schema.json").exists())
            .unwrap_or(false);
        ExternalPluginInfo {
            uuid: m.uuid.clone(),
            name: m.name.clone(),
            description: m.description.clone().unwrap_or_default(),
            version: m.version.clone(),
            author: m.author.clone().unwrap_or_else(|| "Unknown".to_string()),
            actions: m.actions.iter().map(|a| ExternalActionInfo {
                uuid: a.uuid.clone(),
                name: a.name.clone(),
            }).collect(),
            has_config,
        }
    }).collect();
    Ok(infos)
}

/// Start an external plugin. A no-op if it is already running. Node
/// installations (one `node --version` per candidate) are probed before the
/// plugin manager is locked, so other plugin commands are not held up.
#[tauri::command(async)]
pub fn start_external_plugin(uuid: String, state: tauri::State<'_, AppState>) -> Result<(), String> {
    let ws_port = state.ws_port.load(std::sync::atomic::Ordering::Relaxed);
    let needs_probe = state.plugin_manager.lock().map_err(|e| e.to_string())?.needs_node_probe();
    let probed = needs_probe.then(sd_core::plugin::node::discover_installations);
    let mut pm = state.plugin_manager.lock().map_err(|e| e.to_string())?;
    if let Some(installs) = probed {
        if pm.needs_node_probe() {
            pm.set_node_installations(installs);
        }
    }
    pm.start_plugin(&uuid, ws_port).map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub fn stop_external_plugin(uuid: String, state: tauri::State<'_, AppState>) -> Result<(), String> {
    let mut pm = state.plugin_manager.lock().map_err(|e| e.to_string())?;
    pm.stop_plugin(&uuid).map_err(|e| e.to_string())
}

/// Apply the `nodePath` app setting (the UI has already saved it to
/// app_settings.json). Empty or missing means auto-detect. Takes effect the
/// next time a plugin starts.
#[tauri::command(async)]
pub fn set_node_path(path: Option<String>, state: tauri::State<'_, AppState>) -> Result<(), String> {
    let path = path.map(|p| p.trim().to_string()).filter(|p| !p.is_empty()).map(PathBuf::from);
    match &path {
        Some(p) => tracing::info!("Using configured nodePath {}", p.display()),
        None => tracing::info!("nodePath cleared; auto-detecting Node.js"),
    }
    state.plugin_manager.lock().map_err(|e| e.to_string())?.set_node_path(path);
    Ok(())
}

#[tauri::command(async)]
pub fn get_plugin_status(state: tauri::State<'_, AppState>) -> Result<Vec<PluginStatusDto>, String> {
    let statuses = {
        let mut pm = state.plugin_manager.lock().map_err(|e| e.to_string())?;
        pm.status()
    };
    Ok(statuses.into_iter().map(|s| PluginStatusDto {
        connected: state.plugin_hub.is_connected(&s.uuid),
        uuid: s.uuid,
        running: s.running,
        restarts: s.restarts,
        error: s.error,
    }).collect())
}

/// Forward a raw JSON message (an Elgato SDK event such as keyDown or
/// willAppear) to a connected plugin.
#[tauri::command]
pub fn plugin_send_event(plugin_uuid: String, message: String, state: tauri::State<AppState>) -> Result<(), String> {
    serde_json::from_str::<serde_json::Value>(&message)
        .map_err(|e| format!("message is not valid JSON: {}", e))?;
    state.plugin_hub.send(&plugin_uuid, message)
}

#[tauri::command]
pub fn get_plugin_config_schema(uuid: String, state: tauri::State<AppState>) -> Result<String, String> {
    let dir = plugin_dir(&uuid, &state)?;
    std::fs::read_to_string(dir.join("config.schema.json"))
        .map_err(|e| format!("No config schema: {}", e))
}

#[tauri::command]
pub fn read_plugin_config(uuid: String, state: tauri::State<AppState>) -> Result<String, String> {
    let dir = plugin_dir(&uuid, &state)?;
    std::fs::read_to_string(dir.join("config.json"))
        .map_err(|e| format!("No config file: {}", e))
}

/// Write a plugin's config.json atomically with mode 0600 (it may hold API keys).
#[tauri::command]
pub fn write_plugin_config(uuid: String, config: String, state: tauri::State<AppState>) -> Result<(), String> {
    serde_json::from_str::<serde_json::Value>(&config)
        .map_err(|e| format!("Config is not valid JSON: {}", e))?;
    let dir = plugin_dir(&uuid, &state)?;
    sd_core::profile::atomic_write(&dir.join("config.json"), config.as_bytes())
        .map_err(|e| format!("Failed to write config: {}", e))
}

fn plugin_dir(uuid: &str, state: &AppState) -> Result<PathBuf, String> {
    let pm = state.plugin_manager.lock().map_err(|e| e.to_string())?;
    pm.get_plugin_dir(uuid)
        .map(Path::to_path_buf)
        .ok_or_else(|| format!("Plugin {} not found", uuid))
}

/// `plugin_global_<encoded uuid>.json`. The encoding is injective, so two
/// plugin UUIDs never share a file: `[A-Za-z0-9-]` is kept, `_` becomes
/// `__` and every other byte becomes `_XX` (uppercase hex).
pub fn global_settings_path(config_dir: &Path, plugin_uuid: &str) -> PathBuf {
    let mut safe = String::with_capacity(plugin_uuid.len());
    for b in plugin_uuid.bytes() {
        match b {
            b'_' => safe.push_str("__"),
            b if b.is_ascii_alphanumeric() || b == b'-' => safe.push(b as char),
            b => safe.push_str(&format!("_{:02X}", b)),
        }
    }
    config_dir.join(format!("plugin_global_{}.json", safe))
}

/// The previous file name: every char outside `[A-Za-z0-9_-]` replaced by `_`
/// (lossy; several UUIDs can map to one file).
fn legacy_global_settings_path(config_dir: &Path, plugin_uuid: &str) -> PathBuf {
    let safe: String = plugin_uuid.chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '_' || c == '-' { c } else { '_' })
        .collect();
    config_dir.join(format!("plugin_global_{}.json", safe))
}

/// Move a plugin's global settings from the legacy (lossy) file name to the
/// current one. Only done when the current file does not exist yet and no
/// other known plugin UUID maps to the same legacy file, so settings are never
/// handed to the wrong plugin.
pub fn migrate_legacy_global_settings(config_dir: &Path, plugin_uuid: &str, known_uuids: &[String]) {
    let path = global_settings_path(config_dir, plugin_uuid);
    let legacy = legacy_global_settings_path(config_dir, plugin_uuid);
    if legacy == path || path.exists() || !legacy.exists() {
        return;
    }
    // A legacy file that is itself the current name of another UUID belongs to it.
    let owners = known_uuids.iter()
        .filter(|u| u.as_str() != plugin_uuid)
        .filter(|u| legacy_global_settings_path(config_dir, u) == legacy || global_settings_path(config_dir, u) == legacy)
        .count();
    if owners > 0 {
        tracing::warn!(
            "Not migrating {} to {}: another plugin maps to the same legacy file",
            legacy.display(), path.display()
        );
        return;
    }
    match std::fs::rename(&legacy, &path) {
        Ok(()) => tracing::info!("Migrated global settings of {} to {}", plugin_uuid, path.display()),
        Err(e) => tracing::warn!("Failed to migrate {} to {}: {}", legacy.display(), path.display(), e),
    }
}

/// Read a plugin's global settings; `{}` when none are stored or the file is invalid.
pub fn read_global_settings(config_dir: &Path, plugin_uuid: &str) -> serde_json::Value {
    let path = global_settings_path(config_dir, plugin_uuid);
    match std::fs::read_to_string(&path) {
        Ok(s) => serde_json::from_str(&s).unwrap_or_else(|e| {
            tracing::warn!("Invalid global settings in {}: {}", path.display(), e);
            serde_json::json!({})
        }),
        Err(_) => serde_json::json!({}),
    }
}

pub fn write_global_settings(config_dir: &Path, plugin_uuid: &str, settings: &serde_json::Value) -> Result<(), String> {
    let path = global_settings_path(config_dir, plugin_uuid);
    let content = serde_json::to_string_pretty(settings).map_err(|e| e.to_string())?;
    sd_core::profile::atomic_write(&path, content.as_bytes()).map_err(|e| e.to_string())
}

// Used by release builds (bundled plugins) and tests.
#[cfg_attr(debug_assertions, allow(dead_code))]
fn manifest_version(plugin_dir: &Path) -> Option<String> {
    let json = std::fs::read_to_string(plugin_dir.join("manifest.json")).ok()?;
    serde_json::from_str::<sd_core::plugin::PluginManifest>(&json).ok().map(|m| m.version)
}

/// Copy `src` into `dst` recursively. An existing `config.json` in `dst` is
/// kept (it holds the user's plugin configuration).
// Used by release builds (bundled plugins) and tests.
#[cfg_attr(debug_assertions, allow(dead_code))]
fn copy_plugin_dir(src: &Path, dst: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let from = entry.path();
        let to = dst.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_plugin_dir(&from, &to)?;
        } else if !(entry.file_name() == "config.json" && to.exists()) {
            std::fs::copy(&from, &to)?;
        }
    }
    Ok(())
}

/// Copy `legacy/config.json` into `dst` (mode 0600) when `dst` has none.
/// Plugins used to run from the repository's plugins/ folder, whose
/// config.json (API keys, symbol lists) is not part of the bundle.
// Used by release builds (bundled plugins) and tests.
#[cfg_attr(debug_assertions, allow(dead_code))]
fn migrate_legacy_config(legacy: &Path, dst: &Path) {
    let target = dst.join("config.json");
    let source = legacy.join("config.json");
    if target.exists() || !source.is_file() || !dst.is_dir() {
        return;
    }
    let result = std::fs::read(&source)
        .map_err(|e| e.to_string())
        .and_then(|bytes| sd_core::profile::atomic_write(&target, &bytes).map_err(|e| e.to_string()));
    match result {
        Ok(()) => tracing::info!("Copied plugin config {} to {}", source.display(), target.display()),
        Err(e) => tracing::warn!("Failed to copy plugin config {} to {}: {}", source.display(), target.display(), e),
    }
}

/// Install the plugins bundled in the app resources (`<resources>/plugins`)
/// into the user's plugin directory, where they are writable. A plugin is
/// (re)installed when it is missing or its manifest Version differs from the
/// bundled one. When the installed copy has no config.json and
/// `legacy_dir/<name>/config.json` exists, that config is copied in (never
/// overwriting one). Returns the installed directory names.
// Used by release builds (bundled plugins) and tests.
#[cfg_attr(debug_assertions, allow(dead_code))]
pub fn install_bundled_plugins(bundled: &Path, user: &Path, legacy_dir: Option<&Path>) -> Vec<String> {
    let mut installed = vec![];
    let entries = match std::fs::read_dir(bundled) {
        Ok(e) => e,
        Err(_) => return installed,
    };
    for entry in entries.filter_map(|e| e.ok()) {
        let src = entry.path();
        let name = entry.file_name();
        if !src.is_dir() || !name.to_string_lossy().ends_with(".sdPlugin") {
            continue;
        }
        let dst = user.join(&name);
        let bundled_version = manifest_version(&src);
        if bundled_version.is_none() || manifest_version(&dst) != bundled_version {
            match copy_plugin_dir(&src, &dst) {
                Ok(()) => {
                    tracing::info!("Installed bundled plugin {} into {}", name.to_string_lossy(), dst.display());
                    installed.push(name.to_string_lossy().into_owned());
                }
                Err(e) => tracing::warn!("Failed to install bundled plugin {}: {}", name.to_string_lossy(), e),
            }
        }
        if let Some(legacy) = legacy_dir {
            migrate_legacy_config(&legacy.join(&name), &dst);
        }
    }
    installed
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn global_settings_round_trip() {
        let dir = std::env::temp_dir().join(format!("sd-tauri-global-test-{}", uuid::Uuid::new_v4().simple()));
        assert_eq!(global_settings_path(&dir, "com.x/../y"), dir.join("plugin_global_com_2Ex_2F_2E_2E_2Fy.json"));
        assert_eq!(read_global_settings(&dir, "com.x"), serde_json::json!({}));
        write_global_settings(&dir, "com.x", &serde_json::json!({"k": 1})).unwrap();
        assert_eq!(read_global_settings(&dir, "com.x"), serde_json::json!({"k": 1}));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn bundled_plugins_install_and_keep_user_config() {
        let root = std::env::temp_dir().join(format!("sd-tauri-bundled-test-{}", uuid::Uuid::new_v4().simple()));
        let bundled = root.join("res");
        let user = root.join("user");
        let p = bundled.join("x.sdPlugin");
        std::fs::create_dir_all(p.join("img")).unwrap();
        let manifest = |v: &str| format!(r#"{{"Name":"X","Version":"{}","UUID":"com.x","CodePath":"plugin.js","Actions":[]}}"#, v);
        std::fs::write(p.join("manifest.json"), manifest("1.0.0")).unwrap();
        std::fs::write(p.join("plugin.js"), "v1").unwrap();
        std::fs::write(p.join("img/a.png"), "png").unwrap();
        std::fs::write(p.join("config.json"), "{\"default\":true}").unwrap();

        assert_eq!(install_bundled_plugins(&bundled, &user, None), vec!["x.sdPlugin".to_string()]);
        assert_eq!(std::fs::read_to_string(user.join("x.sdPlugin/img/a.png")).unwrap(), "png");
        // Same version: nothing to do.
        assert!(install_bundled_plugins(&bundled, &user, None).is_empty());

        // New version updates code but keeps the user's config.json.
        std::fs::write(user.join("x.sdPlugin/config.json"), "{\"apiKey\":\"user\"}").unwrap();
        std::fs::write(p.join("manifest.json"), manifest("1.1.0")).unwrap();
        std::fs::write(p.join("plugin.js"), "v2").unwrap();
        assert_eq!(install_bundled_plugins(&bundled, &user, None).len(), 1);
        assert_eq!(std::fs::read_to_string(user.join("x.sdPlugin/plugin.js")).unwrap(), "v2");
        assert_eq!(std::fs::read_to_string(user.join("x.sdPlugin/config.json")).unwrap(), "{\"apiKey\":\"user\"}");
        assert!(install_bundled_plugins(&root.join("missing"), &user, None).is_empty());
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn global_settings_names_are_injective() {
        let dir = Path::new("/cfg");
        let a = global_settings_path(dir, "com.vendor.x");
        let b = global_settings_path(dir, "com_vendor_x");
        let c = global_settings_path(dir, "com.vendor-x");
        let d = global_settings_path(dir, "com-vendor.x");
        assert_ne!(a, b);
        assert_ne!(c, d);
        assert_eq!(b, dir.join("plugin_global_com__vendor__x.json"));
        // "_2E" vs "." must not collide either.
        assert_ne!(global_settings_path(dir, "a_2E"), global_settings_path(dir, "a."));
        // Plain alphanumeric/hyphen UUIDs keep their previous file name.
        assert_eq!(global_settings_path(dir, "abc-123"), legacy_global_settings_path(dir, "abc-123"));
    }

    #[test]
    fn legacy_global_settings_migrate_only_when_unambiguous() {
        let dir = std::env::temp_dir().join(format!("sd-tauri-global-mig-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dir).unwrap();
        let legacy = legacy_global_settings_path(&dir, "com.vendor.x");
        std::fs::write(&legacy, "{\"k\":1}").unwrap();

        // Another known UUID maps to the same legacy file: left alone.
        let known = vec!["com.vendor.x".to_string(), "com_vendor_x".to_string()];
        migrate_legacy_global_settings(&dir, "com.vendor.x", &known);
        assert!(legacy.exists());
        assert_eq!(read_global_settings(&dir, "com.vendor.x"), serde_json::json!({}));

        // Unambiguous: moved to the new name.
        migrate_legacy_global_settings(&dir, "com.vendor.x", &["com.vendor.x".to_string()]);
        assert!(!legacy.exists());
        assert_eq!(read_global_settings(&dir, "com.vendor.x"), serde_json::json!({"k": 1}));

        // An existing new file is never overwritten.
        std::fs::write(&legacy, "{\"k\":2}").unwrap();
        migrate_legacy_global_settings(&dir, "com.vendor.x", &["com.vendor.x".to_string()]);
        assert_eq!(read_global_settings(&dir, "com.vendor.x"), serde_json::json!({"k": 1}));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn bundled_install_copies_legacy_config_once() {
        let root = std::env::temp_dir().join(format!("sd-tauri-legacy-cfg-{}", uuid::Uuid::new_v4().simple()));
        let bundled = root.join("res");
        let user = root.join("user");
        let legacy = root.join("repo-plugins");
        let p = bundled.join("x.sdPlugin");
        std::fs::create_dir_all(&p).unwrap();
        std::fs::write(p.join("manifest.json"), r#"{"Name":"X","Version":"1.0.0","UUID":"com.x","CodePath":"plugin.js","Actions":[]}"#).unwrap();
        std::fs::write(p.join("plugin.js"), "v1").unwrap();
        std::fs::create_dir_all(legacy.join("x.sdPlugin")).unwrap();
        std::fs::write(legacy.join("x.sdPlugin/config.json"), "{\"apiKey\":\"legacy\"}").unwrap();

        install_bundled_plugins(&bundled, &user, Some(&legacy));
        let cfg = user.join("x.sdPlugin/config.json");
        assert_eq!(std::fs::read_to_string(&cfg).unwrap(), "{\"apiKey\":\"legacy\"}");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&cfg).unwrap().permissions().mode() & 0o777, 0o600);
        }

        // An existing config is never overwritten, also not on a second run.
        std::fs::write(&cfg, "{\"apiKey\":\"user\"}").unwrap();
        install_bundled_plugins(&bundled, &user, Some(&legacy));
        assert_eq!(std::fs::read_to_string(&cfg).unwrap(), "{\"apiKey\":\"user\"}");

        // An already-installed copy without config (same version) still gets it.
        std::fs::remove_file(&cfg).unwrap();
        assert!(install_bundled_plugins(&bundled, &user, Some(&legacy)).is_empty());
        assert_eq!(std::fs::read_to_string(&cfg).unwrap(), "{\"apiKey\":\"legacy\"}");
        std::fs::remove_dir_all(&root).unwrap();
    }
}
