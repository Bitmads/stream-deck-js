use super::manifest::PluginManifest;
use crate::Result;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::{Child, Command};
use tracing::{info, warn, error};

/// Manages plugin discovery, installation, and subprocess lifecycle.
pub struct PluginManager {
    plugin_dirs: Vec<PathBuf>,
    manifests: HashMap<String, (PluginManifest, PathBuf)>, // uuid -> (manifest, dir)
    processes: HashMap<String, PluginProcess>,
}

struct PluginProcess {
    child: Child,
    restart_count: u32,
}

impl PluginManager {
    pub fn new(plugin_dirs: Vec<PathBuf>) -> Self {
        Self {
            plugin_dirs,
            manifests: HashMap::new(),
            processes: HashMap::new(),
        }
    }

    /// Scan all plugin directories for *.sdPlugin folders containing manifest.json.
    pub fn discover(&mut self) -> Result<Vec<&PluginManifest>> {
        self.manifests.clear();

        for plugins_dir in &self.plugin_dirs {
            if !plugins_dir.exists() {
                if let Err(e) = std::fs::create_dir_all(plugins_dir) {
                    warn!("Failed to create plugins dir {}: {}", plugins_dir.display(), e);
                }
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

    /// Start a plugin subprocess.
    pub fn start_plugin(&mut self, uuid: &str, ws_port: u16) -> Result<()> {
        let (manifest, dir) = self.manifests.get(uuid)
            .ok_or_else(|| crate::Error::Plugin(format!("Plugin {} not found", uuid)))?;

        let code_path = manifest.code_path.as_deref()
            .ok_or_else(|| crate::Error::Plugin("No CodePath in manifest".into()))?;

        let full_path = dir.join(code_path);
        let reg_uuid = uuid::Uuid::new_v4().to_string();

        // Build registration info JSON
        let info_json = serde_json::json!({
            "application": {
                "language": "en",
                "platform": std::env::consts::OS,
                "platformVersion": "",
                "version": "0.1.0"
            },
            "plugin": {
                "uuid": uuid,
                "version": &manifest.version
            },
            "devices": [],
            "devicePixelRatio": 1
        });

        let args = vec![
            "-port".to_string(), ws_port.to_string(),
            "-pluginUUID".to_string(), reg_uuid.clone(),
            "-registerEvent".to_string(), "registerPlugin".to_string(),
            "-info".to_string(), info_json.to_string(),
        ];

        info!("Starting plugin {} from {}", uuid, full_path.display());

        // Determine if we need node to run it
        let child = if full_path.extension().map(|e| e == "js" || e == "mjs" || e == "cjs").unwrap_or(false) {
            Command::new("node")
                .arg(&full_path)
                .args(&args)
                .current_dir(dir)
                .spawn()
                .map_err(|e| crate::Error::Plugin(format!("Failed to start plugin: {}", e)))?
        } else {
            Command::new(&full_path)
                .args(&args)
                .current_dir(dir)
                .spawn()
                .map_err(|e| crate::Error::Plugin(format!("Failed to start plugin: {}", e)))?
        };

        self.processes.insert(uuid.to_string(), PluginProcess {
            child,
            restart_count: 0,
        });

        Ok(())
    }

    /// Stop a plugin subprocess.
    pub fn stop_plugin(&mut self, uuid: &str) -> Result<()> {
        if let Some(mut proc) = self.processes.remove(uuid) {
            info!("Stopping plugin {}", uuid);
            let _ = proc.child.kill();
            let _ = proc.child.wait();
        }
        Ok(())
    }

    /// Stop all plugins.
    pub fn stop_all(&mut self) {
        let uuids: Vec<String> = self.processes.keys().cloned().collect();
        for uuid in uuids {
            let _ = self.stop_plugin(&uuid);
        }
    }

    /// Check for crashed plugins and restart them (up to 5 times).
    pub fn check_health(&mut self, ws_port: u16) {
        let mut to_restart = vec![];

        for (uuid, proc) in &mut self.processes {
            match proc.child.try_wait() {
                Ok(Some(status)) => {
                    if proc.restart_count < 5 {
                        warn!("Plugin {} exited with {}, restarting ({}/5)", uuid, status, proc.restart_count + 1);
                        proc.restart_count += 1;
                        to_restart.push(uuid.clone());
                    } else {
                        error!("Plugin {} crashed too many times, disabling", uuid);
                    }
                }
                Ok(None) => {} // Still running
                Err(e) => warn!("Failed to check plugin {} status: {}", uuid, e),
            }
        }

        for uuid in to_restart {
            self.processes.remove(&uuid);
            let _ = self.start_plugin(&uuid, ws_port);
        }
    }

    pub fn list_discovered(&self) -> Vec<&PluginManifest> {
        self.manifests.values().map(|(m, _)| m).collect()
    }

    pub fn running_count(&self) -> usize {
        self.processes.len()
    }
}
