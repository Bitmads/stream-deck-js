pub mod lifecycle;
pub mod manifest;
pub mod protocol;

pub use lifecycle::PluginManager;
pub use manifest::PluginManifest;
pub use protocol::{PluginEvent, PluginCommand, RegistrationInfo};
