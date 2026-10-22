//! On-disk storage for profiles and other JSON config files.
//!
//! The canonical profile format is owned by the UI (see `profile_<name>.json`
//! under `~/.config/open-stream-deck`); this module only provides validation,
//! name sanitization and crash-safe writes.

mod storage;

pub use storage::{
    atomic_write, backup_path, sanitize_profile_name, validate_profile_json,
    write_profile_file, PROFILE_NAME_MAX_LEN,
};
