//! Locating a Node.js runtime for JavaScript plugins.
//!
//! GUI launches (a .desktop file, Finder, the Start menu) usually get a PATH
//! without version managers, so a bare `node` may resolve to an ancient
//! system build. We therefore look at the common version-manager install
//! locations as well as PATH and pick the newest runtime that satisfies the
//! plugin's requirement.

use crate::{Error, Result};
use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::process::Command;

/// Oldest Node.js major version plugins are run with.
pub const MIN_NODE_MAJOR: u32 = 18;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct NodeVersion {
    pub major: u32,
    pub minor: u32,
    pub patch: u32,
}

impl NodeVersion {
    /// Parse `v20.11.1`, `20.11.1`, `20.11` or `20` (surrounding whitespace allowed).
    pub fn parse(s: &str) -> Option<Self> {
        let s = s.trim();
        let s = s.strip_prefix('v').or_else(|| s.strip_prefix('V')).unwrap_or(s);
        let mut parts = s.split('.');
        let major = parts.next()?.trim().parse().ok()?;
        let num = |p: Option<&str>| -> Option<u32> {
            match p {
                None => Some(0),
                // Tolerate suffixes such as "1-nightly".
                Some(t) => t.split(|c: char| !c.is_ascii_digit()).next()?.parse().ok().or(Some(0)),
            }
        };
        let minor = num(parts.next())?;
        let patch = num(parts.next())?;
        Some(Self { major, minor, patch })
    }
}

impl std::fmt::Display for NodeVersion {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "v{}.{}.{}", self.major, self.minor, self.patch)
    }
}

/// Minimum major version for a plugin: max(18, manifest `Nodejs.Version` major).
pub fn required_major(manifest_version: Option<&str>) -> u32 {
    manifest_version
        .and_then(NodeVersion::parse)
        .map(|v| v.major.max(MIN_NODE_MAJOR))
        .unwrap_or(MIN_NODE_MAJOR)
}

/// Pick the highest version whose major is at least `min_major`.
pub fn select_best(candidates: &[(PathBuf, NodeVersion)], min_major: u32) -> Option<(PathBuf, NodeVersion)> {
    candidates
        .iter()
        .filter(|(_, v)| v.major >= min_major)
        .max_by_key(|(_, v)| *v)
        .cloned()
}

fn node_exe_name() -> &'static str {
    if cfg!(windows) { "node.exe" } else { "node" }
}

/// Children of `dir` that are directories, sorted for determinism.
fn subdirs(dir: &Path) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = std::fs::read_dir(dir)
        .map(|rd| rd.filter_map(|e| e.ok()).map(|e| e.path()).filter(|p| p.is_dir()).collect())
        .unwrap_or_default();
    out.sort();
    out
}

/// Candidate node executables, in search order: nvm, volta, fnm, then PATH,
/// then a few well-known system locations. Only existing files are returned,
/// without duplicates.
pub fn candidate_paths(home: Option<&Path>, path_env: Option<&OsStr>, env: &dyn Fn(&str) -> Option<PathBuf>) -> Vec<PathBuf> {
    let exe = node_exe_name();
    let mut out: Vec<PathBuf> = Vec::new();

    // nvm: $NVM_DIR or ~/.nvm, versions/node/<ver>/bin/node
    let mut nvm_roots = Vec::new();
    if let Some(d) = env("NVM_DIR") { nvm_roots.push(d); }
    if let Some(h) = home { nvm_roots.push(h.join(".nvm")); }
    for root in nvm_roots {
        for v in subdirs(&root.join("versions").join("node")) {
            out.push(v.join("bin").join(exe));
        }
    }

    // volta: $VOLTA_HOME or ~/.volta, bin/node (a shim that runs the default toolchain)
    if let Some(d) = env("VOLTA_HOME") { out.push(d.join("bin").join(exe)); }
    if let Some(h) = home { out.push(h.join(".volta").join("bin").join(exe)); }

    // fnm: $FNM_DIR, ~/.local/share/fnm, ~/.fnm, ~/Library/Application Support/fnm
    let mut fnm_roots = Vec::new();
    if let Some(d) = env("FNM_DIR") { fnm_roots.push(d); }
    if let Some(d) = env("XDG_DATA_HOME") { fnm_roots.push(d.join("fnm")); }
    if let Some(h) = home {
        fnm_roots.push(h.join(".local").join("share").join("fnm"));
        fnm_roots.push(h.join(".fnm"));
        fnm_roots.push(h.join("Library").join("Application Support").join("fnm"));
    }
    for root in fnm_roots {
        for v in subdirs(&root.join("node-versions")) {
            let inst = v.join("installation");
            out.push(inst.join("bin").join(exe));
            out.push(inst.join(exe)); // Windows layout
        }
    }

    // PATH
    if let Some(p) = path_env {
        for dir in std::env::split_paths(p) {
            out.push(dir.join(exe));
        }
    }

    // Well-known locations missing from GUI PATHs
    if cfg!(unix) {
        for d in ["/usr/local/bin", "/opt/homebrew/bin", "/usr/bin"] {
            out.push(Path::new(d).join(exe));
        }
    }

    let mut seen = std::collections::HashSet::new();
    out.into_iter()
        .filter(|p| p.is_file())
        .filter(|p| seen.insert(std::fs::canonicalize(p).unwrap_or_else(|_| p.clone())))
        .collect()
}

/// Run `<node> --version` and parse the result.
pub fn probe_version(node: &Path) -> Option<NodeVersion> {
    let out = Command::new(node).arg("--version").output().ok()?;
    if !out.status.success() {
        return None;
    }
    NodeVersion::parse(&String::from_utf8_lossy(&out.stdout))
}

/// Discover every node installation with its version.
pub fn discover_installations() -> Vec<(PathBuf, NodeVersion)> {
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from);
    let path_env = std::env::var_os("PATH");
    let env = |k: &str| std::env::var_os(k).filter(|v| !v.is_empty()).map(PathBuf::from);
    candidate_paths(home.as_deref(), path_env.as_deref(), &env)
        .into_iter()
        .filter_map(|p| probe_version(&p).map(|v| (p, v)))
        .collect()
}

/// Resolve the node executable for a plugin needing at least `min_major`.
///
/// `configured` (the `nodePath` app setting) wins when set; it must still meet
/// the minimum version. Otherwise the newest suitable discovered install is used.
pub fn resolve(configured: Option<&Path>, installations: &[(PathBuf, NodeVersion)], min_major: u32) -> Result<(PathBuf, NodeVersion)> {
    if let Some(path) = configured {
        let version = probe_version(path).ok_or_else(|| {
            Error::Plugin(format!("Configured nodePath {} is not a runnable Node.js executable", path.display()))
        })?;
        if version.major < min_major {
            return Err(Error::Plugin(format!(
                "Configured nodePath {} is Node.js {}, but this plugin needs Node.js {} or newer",
                path.display(), version, min_major
            )));
        }
        return Ok((path.to_path_buf(), version));
    }
    select_best(installations, min_major).ok_or_else(|| {
        let found = if installations.is_empty() {
            "no Node.js installation was found".to_string()
        } else {
            let list: Vec<String> = installations.iter().map(|(p, v)| format!("{} ({})", p.display(), v)).collect();
            format!("only older versions were found: {}", list.join(", "))
        };
        Error::Plugin(format!(
            "Node.js {} or newer is required to run this plugin, but {}. Install a newer Node.js (e.g. with nvm) or set \"nodePath\" in app_settings.json",
            min_major, found
        ))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(s: &str) -> NodeVersion { NodeVersion::parse(s).unwrap() }

    #[test]
    fn parses_versions() {
        assert_eq!(v("v20.11.1\n"), NodeVersion { major: 20, minor: 11, patch: 1 });
        assert_eq!(v("18"), NodeVersion { major: 18, minor: 0, patch: 0 });
        assert_eq!(v("22.3"), NodeVersion { major: 22, minor: 3, patch: 0 });
        assert_eq!(v("v23.0.0-nightly"), NodeVersion { major: 23, minor: 0, patch: 0 });
        assert!(NodeVersion::parse("").is_none());
        assert!(NodeVersion::parse("node").is_none());
    }

    #[test]
    fn required_major_has_floor_of_18() {
        assert_eq!(required_major(None), 18);
        assert_eq!(required_major(Some("16")), 18);
        assert_eq!(required_major(Some("20")), 20);
        assert_eq!(required_major(Some("garbage")), 18);
    }

    #[test]
    fn selects_highest_satisfying_version() {
        let c = vec![
            (PathBuf::from("/usr/bin/node"), v("v12.22.9")),
            (PathBuf::from("/nvm/v18/node"), v("v18.19.0")),
            (PathBuf::from("/nvm/v22/node"), v("v22.1.0")),
            (PathBuf::from("/nvm/v20/node"), v("v20.11.1")),
        ];
        assert_eq!(select_best(&c, 18).unwrap().0, PathBuf::from("/nvm/v22/node"));
        assert_eq!(select_best(&c, 23), None);
        let old = vec![(PathBuf::from("/usr/bin/node"), v("v12.22.9"))];
        assert_eq!(select_best(&old, 18), None);
        let err = resolve(None, &old, 18).unwrap_err().to_string();
        assert!(err.contains("only older versions"), "{err}");
        let err = resolve(None, &[], 20).unwrap_err().to_string();
        assert!(err.contains("Node.js 20 or newer"), "{err}");
    }

    #[test]
    fn candidate_paths_finds_nvm_and_dedupes() {
        let home = std::env::temp_dir().join(format!("sd-core-node-test-{}", uuid::Uuid::new_v4().simple()));
        let bin = home.join(".nvm/versions/node/v20.1.0/bin");
        std::fs::create_dir_all(&bin).unwrap();
        std::fs::write(bin.join(node_exe_name()), b"").unwrap();
        let path_env = std::env::join_paths([bin.clone(), bin.clone()]).unwrap();
        let none = |_: &str| None;
        let found = candidate_paths(Some(&home), Some(&path_env), &none);
        let ours: Vec<_> = found.iter().filter(|p| p.starts_with(&home)).collect();
        assert_eq!(ours.len(), 1);
        assert_eq!(ours[0], &bin.join(node_exe_name()));
        std::fs::remove_dir_all(&home).unwrap();
    }
}
