use super::manifest::PluginManifest;
use super::node::{self, NodeVersion};
use super::protocol::{AppInfo, PluginInfo, RegistrationInfo};
use crate::Result;
use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::process::{Child, Command};
use std::time::{Duration, Instant};
use tracing::{error, info, warn};

/// At most this many automatic restarts within [`RESTART_WINDOW`].
pub const MAX_RESTARTS: usize = 5;
/// Sliding window for counting automatic restarts.
pub const RESTART_WINDOW: Duration = Duration::from_secs(10 * 60);
/// Upper bound for the delay before an automatic restart.
const MAX_BACKOFF: Duration = Duration::from_secs(60);

/// Manages plugin discovery and subprocess lifecycle.
pub struct PluginManager {
    plugin_dirs: Vec<PathBuf>,
    manifests: HashMap<String, (PluginManifest, PathBuf)>, // uuid -> (manifest, dir)
    processes: HashMap<String, Child>,
    supervision: HashMap<String, Supervision>,
    /// `nodePath` app setting; overrides discovery when set.
    node_path: Option<PathBuf>,
    /// Cached node installations; cleared by `set_node_path()`. Filled by
    /// [`PluginManager::set_node_installations`] (probed outside the manager's
    /// lock) or, as a fallback, lazily in `spawn`.
    node_installations: Option<Vec<(PathBuf, NodeVersion)>>,
}

/// Restart bookkeeping per plugin. Survives restarts; cleared by a manual stop.
#[derive(Debug, Default)]
struct Supervision {
    /// Timestamps of automatic restarts inside the sliding window.
    restarts: VecDeque<Instant>,
    /// Automatic restarts since the plugin was last stopped by the user.
    total_restarts: u32,
    /// When the next automatic restart is due.
    pending_restart: Option<Instant>,
    /// Gave up restarting (crash limit hit or the plugin could not be spawned).
    failed: bool,
    error: Option<String>,
}

/// Process-level status of one plugin (the WebSocket connection state is
/// tracked by the host's plugin server, not here).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PluginProcessStatus {
    pub uuid: String,
    pub running: bool,
    pub restarts: u32,
    pub error: Option<String>,
}

fn backoff_for(previous_restarts: usize) -> Duration {
    let secs = 1u64 << previous_restarts.min(6);
    Duration::from_secs(secs).min(MAX_BACKOFF)
}

impl PluginManager {
    pub fn new(plugin_dirs: Vec<PathBuf>) -> Self {
        Self {
            plugin_dirs,
            manifests: HashMap::new(),
            processes: HashMap::new(),
            supervision: HashMap::new(),
            node_path: None,
            node_installations: None,
        }
    }

    /// Add a directory to scan (lower priority than the existing ones).
    pub fn add_plugin_dir(&mut self, dir: PathBuf) {
        if !self.plugin_dirs.contains(&dir) {
            self.plugin_dirs.push(dir);
        }
    }

    /// Use a specific node executable instead of searching for one. Also
    /// forgets the cached installations, so the next start probes again.
    pub fn set_node_path(&mut self, path: Option<PathBuf>) {
        self.node_path = path;
        self.node_installations = None;
    }

    /// True when starting a JavaScript plugin would have to probe the node
    /// installations first. Callers can then run
    /// [`node::discover_installations`] (which spawns `node --version` per
    /// candidate) without holding the manager's lock, and hand the result to
    /// [`PluginManager::set_node_installations`].
    pub fn needs_node_probe(&self) -> bool {
        self.node_path.is_none() && self.node_installations.is_none()
    }

    pub fn set_node_installations(&mut self, installs: Vec<(PathBuf, NodeVersion)>) {
        self.node_installations = Some(installs);
    }

    /// Scan all plugin directories for *.sdPlugin folders containing manifest.json.
    /// Missing directories are skipped (never created here).
    pub fn discover(&mut self) -> Result<Vec<&PluginManifest>> {
        self.manifests.clear();

        for plugins_dir in &self.plugin_dirs {
            if !plugins_dir.is_dir() {
                continue;
            }

            let entries = match std::fs::read_dir(plugins_dir) {
                Ok(e) => e,
                Err(e) => { warn!("Failed to read plugins dir {}: {}", plugins_dir.display(), e); continue; }
            };

            for entry in entries {
                let entry = match entry {
                    Ok(e) => e,
                    Err(e) => { warn!("Failed to read dir entry: {}", e); continue; }
                };
                let path = entry.path();

                if !path.is_dir() { continue; }
                let name = path.file_name().unwrap_or_default().to_string_lossy();
                if !name.ends_with(".sdPlugin") { continue; }

                let manifest_path = path.join("manifest.json");
                if !manifest_path.exists() {
                    warn!("Plugin dir {} has no manifest.json", path.display());
                    continue;
                }

                match std::fs::read_to_string(&manifest_path) {
                    Ok(json) => match serde_json::from_str::<PluginManifest>(&json) {
                        Ok(manifest) => {
                            if !self.manifests.contains_key(&manifest.uuid) {
                                info!("Discovered plugin: {} ({})", manifest.name, manifest.uuid);
                                self.manifests.insert(manifest.uuid.clone(), (manifest, path));
                            }
                        }
                        Err(e) => warn!("Failed to parse {}: {}", manifest_path.display(), e),
                    },
                    Err(e) => warn!("Failed to read {}: {}", manifest_path.display(), e),
                }
            }
        }

        Ok(self.manifests.values().map(|(m, _)| m).collect())
    }

    pub fn get_plugin_dir(&self, uuid: &str) -> Option<&Path> {
        self.manifests.get(uuid).map(|(_, dir)| dir.as_path())
    }

    /// True while a process for `uuid` was started by this manager and has
    /// not been stopped or given up on. Used to authenticate plugin
    /// registrations on the WebSocket server.
    pub fn is_managed(&self, uuid: &str) -> bool {
        self.processes.contains_key(uuid)
            || self.supervision.get(uuid).map(|s| s.pending_restart.is_some()).unwrap_or(false)
    }

    /// Start a plugin subprocess. A no-op if it is already running.
    ///
    /// A manual start clears a previous "failed" state but keeps the restart
    /// history, so a plugin that keeps crashing is not restarted forever.
    pub fn start_plugin(&mut self, uuid: &str, ws_port: u16) -> Result<()> {
        if let Some(child) = self.processes.get_mut(uuid) {
            match child.try_wait() {
                Ok(None) => return Ok(()),
                _ => { self.processes.remove(uuid); }
            }
        }

        {
            let sup = self.supervision.entry(uuid.to_string()).or_default();
            sup.failed = false;
            sup.pending_restart = None;
        }

        match self.spawn(uuid, ws_port) {
            Ok(child) => {
                self.processes.insert(uuid.to_string(), child);
                if let Some(sup) = self.supervision.get_mut(uuid) { sup.error = None; }
                Ok(())
            }
            Err(e) => {
                let sup = self.supervision.entry(uuid.to_string()).or_default();
                sup.failed = true;
                sup.error = Some(e.to_string());
                Err(e)
            }
        }
    }

    fn spawn(&mut self, uuid: &str, ws_port: u16) -> Result<Child> {
        let (manifest, dir) = self.manifests.get(uuid)
            .ok_or_else(|| crate::Error::Plugin(format!("Plugin {} not found", uuid)))?;
        let (manifest, dir) = (manifest.clone(), dir.clone());

        let code_path = manifest.code_path.as_deref()
            .ok_or_else(|| crate::Error::Plugin("No CodePath in manifest".into()))?;
        let full_path = dir.join(code_path);

        let info = RegistrationInfo {
            application: AppInfo {
                language: "en".to_string(),
                platform: std::env::consts::OS.to_string(),
                platform_version: String::new(),
                version: env!("CARGO_PKG_VERSION").to_string(),
            },
            plugin: PluginInfo { uuid: uuid.to_string(), version: manifest.version.clone() },
            devices: vec![],
            device_pixel_ratio: 1,
        };
        let info_json = serde_json::to_string(&info)?;

        // The plugin registers with its manifest UUID, so WebSocket sessions
        // are keyed by the same id the host and UI use.
        let args = [
            "-port".to_string(), ws_port.to_string(),
            "-pluginUUID".to_string(), uuid.to_string(),
            "-registerEvent".to_string(), "registerPlugin".to_string(),
            "-info".to_string(), info_json,
        ];

        let is_js = full_path.extension().map(|e| e == "js" || e == "mjs" || e == "cjs").unwrap_or(false);
        let mut cmd = if is_js {
            let min_major = node::required_major(manifest.nodejs.as_ref().and_then(|n| n.version.as_deref()));
            // A configured nodePath is used as-is; installations are only
            // probed for auto-detection.
            let installs: &[(PathBuf, NodeVersion)] = if self.node_path.is_some() {
                &[]
            } else {
                self.node_installations.get_or_insert_with(node::discover_installations)
            };
            let (node_exe, version) = node::resolve(self.node_path.as_deref(), installs, min_major)?;
            info!("Starting plugin {} from {} with node {} ({})", uuid, full_path.display(), version, node_exe.display());
            let mut c = Command::new(node_exe);
            c.arg(&full_path);
            c
        } else {
            info!("Starting plugin {} from {}", uuid, full_path.display());
            Command::new(&full_path)
        };

        // Release builds of the app are GUI-subsystem processes on Windows;
        // without this every node.exe plugin would get a visible console.
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }

        cmd.args(&args)
            .current_dir(&dir)
            .spawn()
            .map_err(|e| crate::Error::Plugin(format!("Failed to start plugin: {}", e)))
    }

    /// Stop a plugin subprocess and forget its restart history.
    pub fn stop_plugin(&mut self, uuid: &str) -> Result<()> {
        if let Some(mut child) = self.processes.remove(uuid) {
            info!("Stopping plugin {}", uuid);
            let _ = child.kill();
            let _ = child.wait();
        }
        self.supervision.remove(uuid);
        Ok(())
    }

    /// Stop all plugins (called on app exit).
    pub fn stop_all(&mut self) {
        let uuids: Vec<String> = self.processes.keys().cloned().collect();
        for uuid in uuids {
            let _ = self.stop_plugin(&uuid);
        }
        self.supervision.clear();
    }

    /// Detect exited plugins and restart them with exponential backoff, at
    /// most [`MAX_RESTARTS`] times per [`RESTART_WINDOW`]. Call periodically.
    pub fn check_health(&mut self, ws_port: u16) {
        self.check_health_at(ws_port, Instant::now());
    }

    fn check_health_at(&mut self, ws_port: u16, now: Instant) {
        let mut exited = vec![];
        for (uuid, child) in &mut self.processes {
            match child.try_wait() {
                Ok(Some(status)) => exited.push((uuid.clone(), status.to_string())),
                Ok(None) => {}
                Err(e) => warn!("Failed to check plugin {} status: {}", uuid, e),
            }
        }

        for (uuid, status) in exited {
            self.processes.remove(&uuid);
            let sup = self.supervision.entry(uuid.clone()).or_default();
            while sup.restarts.front().map(|t| now.duration_since(*t) > RESTART_WINDOW).unwrap_or(false) {
                sup.restarts.pop_front();
            }
            if sup.restarts.len() >= MAX_RESTARTS {
                let msg = format!(
                    "Plugin exited with {} after {} restarts within {} minutes; not restarting",
                    status, sup.restarts.len(), RESTART_WINDOW.as_secs() / 60
                );
                error!("Plugin {}: {}", uuid, msg);
                sup.failed = true;
                sup.pending_restart = None;
                sup.error = Some(msg);
            } else {
                let delay = backoff_for(sup.restarts.len());
                warn!("Plugin {} exited with {}, restarting in {}s ({}/{})",
                    uuid, status, delay.as_secs(), sup.restarts.len() + 1, MAX_RESTARTS);
                sup.pending_restart = Some(now + delay);
                sup.error = Some(format!("Plugin exited with {}", status));
            }
        }

        let due: Vec<String> = self.supervision.iter()
            .filter(|(_, s)| s.pending_restart.map(|t| t <= now).unwrap_or(false))
            .map(|(u, _)| u.clone())
            .collect();
        for uuid in due {
            if let Some(sup) = self.supervision.get_mut(&uuid) {
                sup.pending_restart = None;
                sup.restarts.push_back(now);
                sup.total_restarts += 1;
            }
            match self.spawn(&uuid, ws_port) {
                Ok(child) => { self.processes.insert(uuid, child); }
                Err(e) => {
                    error!("Failed to restart plugin {}: {}", uuid, e);
                    if let Some(sup) = self.supervision.get_mut(&uuid) {
                        sup.failed = true;
                        sup.error = Some(e.to_string());
                    }
                }
            }
        }
    }

    /// Status of every discovered or started plugin, sorted by uuid.
    pub fn status(&mut self) -> Vec<PluginProcessStatus> {
        let mut uuids: Vec<String> = self.manifests.keys()
            .chain(self.processes.keys())
            .chain(self.supervision.keys())
            .cloned()
            .collect();
        uuids.sort();
        uuids.dedup();
        uuids.into_iter().map(|uuid| {
            let running = self.processes.get_mut(&uuid)
                .map(|c| matches!(c.try_wait(), Ok(None)))
                .unwrap_or(false);
            let sup = self.supervision.get(&uuid);
            PluginProcessStatus {
                running,
                restarts: sup.map(|s| s.total_restarts).unwrap_or(0),
                error: sup.and_then(|s| s.error.clone()),
                uuid,
            }
        }).collect()
    }

    pub fn list_discovered(&self) -> Vec<&PluginManifest> {
        self.manifests.values().map(|(m, _)| m).collect()
    }
}

impl Drop for PluginManager {
    fn drop(&mut self) {
        self.stop_all();
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    /// A plugin dir containing one native plugin whose executable is `script`.
    fn fixture(script: &str) -> (PathBuf, PluginManager) {
        let root = std::env::temp_dir().join(format!("sd-core-plugin-test-{}", uuid::Uuid::new_v4().simple()));
        let dir = root.join("test.sdPlugin");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("manifest.json"), r#"{
            "Name": "Test", "Version": "1.0.0", "UUID": "com.test.plugin",
            "CodePath": "run.sh", "Actions": []
        }"#).unwrap();
        let exe = dir.join("run.sh");
        std::fs::write(&exe, script).unwrap();
        std::fs::set_permissions(&exe, std::fs::Permissions::from_mode(0o755)).unwrap();
        let mut pm = PluginManager::new(vec![root.clone(), root.join("missing")]);
        pm.discover().unwrap();
        assert!(!root.join("missing").exists(), "discover must not create directories");
        (root, pm)
    }

    fn wait_exit(pm: &mut PluginManager, uuid: &str) {
        for _ in 0..200 {
            if let Some(c) = pm.processes.get_mut(uuid) {
                if matches!(c.try_wait(), Ok(Some(_))) { return; }
            } else { return; }
            std::thread::sleep(Duration::from_millis(10));
        }
        panic!("plugin did not exit");
    }

    #[test]
    fn start_is_noop_while_running_and_stop_all_kills() {
        let (root, mut pm) = fixture("#!/bin/sh\nexec sleep 30\n");
        pm.start_plugin("com.test.plugin", 1).unwrap();
        let pid = pm.processes["com.test.plugin"].id();
        pm.start_plugin("com.test.plugin", 1).unwrap();
        assert_eq!(pm.processes["com.test.plugin"].id(), pid, "second start must not spawn a new process");
        assert!(pm.is_managed("com.test.plugin"));
        let st = pm.status();
        assert!(st.iter().any(|s| s.uuid == "com.test.plugin" && s.running));
        pm.stop_all();
        assert!(pm.processes.is_empty());
        assert!(!pm.is_managed("com.test.plugin"));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn crash_loop_is_capped_and_counter_survives_restarts() {
        let (root, mut pm) = fixture("#!/bin/sh\nexit 1\n");
        let uuid = "com.test.plugin";
        pm.start_plugin(uuid, 1).unwrap();
        let mut now = Instant::now();
        for i in 0..MAX_RESTARTS {
            wait_exit(&mut pm, uuid);
            pm.check_health_at(1, now); // detects exit, schedules restart
            assert!(!pm.processes.contains_key(uuid));
            now += MAX_BACKOFF;
            pm.check_health_at(1, now); // restart is due
            assert!(pm.processes.contains_key(uuid), "restart {} should have happened", i + 1);
            assert_eq!(pm.supervision[uuid].total_restarts as usize, i + 1);
        }
        wait_exit(&mut pm, uuid);
        pm.check_health_at(1, now);
        now += MAX_BACKOFF;
        pm.check_health_at(1, now);
        assert!(!pm.processes.contains_key(uuid), "must give up after {} restarts", MAX_RESTARTS);
        let st = pm.status().into_iter().find(|s| s.uuid == uuid).unwrap();
        assert!(!st.running);
        assert_eq!(st.restarts as usize, MAX_RESTARTS);
        assert!(st.error.unwrap().contains("not restarting"));

        // A manual start gets one more attempt, but the history is kept.
        pm.start_plugin(uuid, 1).unwrap();
        wait_exit(&mut pm, uuid);
        pm.check_health_at(1, now);
        assert!(pm.supervision[uuid].failed);

        // Restarts older than the window no longer count.
        now += RESTART_WINDOW + Duration::from_secs(1);
        pm.start_plugin(uuid, 1).unwrap();
        wait_exit(&mut pm, uuid);
        pm.check_health_at(1, now);
        assert!(pm.supervision[uuid].pending_restart.is_some());

        // A manual stop clears the history.
        pm.stop_plugin(uuid).unwrap();
        assert!(!pm.supervision.contains_key(uuid));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn backoff_grows_and_is_capped() {
        assert_eq!(backoff_for(0), Duration::from_secs(1));
        assert_eq!(backoff_for(1), Duration::from_secs(2));
        assert_eq!(backoff_for(4), Duration::from_secs(16));
        assert_eq!(backoff_for(10), MAX_BACKOFF);
    }

    #[test]
    fn spawn_failure_marks_failed_without_loop() {
        let (root, mut pm) = fixture("#!/bin/sh\nexit 0\n");
        std::fs::remove_file(root.join("test.sdPlugin/run.sh")).unwrap();
        assert!(pm.start_plugin("com.test.plugin", 1).is_err());
        pm.check_health_at(1, Instant::now() + MAX_BACKOFF);
        assert!(pm.processes.is_empty());
        let st = pm.status().into_iter().find(|s| s.uuid == "com.test.plugin").unwrap();
        assert!(st.error.is_some());
        std::fs::remove_dir_all(root).unwrap();
    }
}
