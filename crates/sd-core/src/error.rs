use thiserror::Error;

#[derive(Debug, Error)]
pub enum Error {
    #[error("Device error: {0}")]
    Device(String),

    #[error("Profile error: {0}")]
    Profile(String),

    #[error("Plugin error: {0}")]
    Plugin(String),

    #[error("Image error: {0}")]
    Image(String),

    #[error("Platform error: {0}")]
    Platform(String),

    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),

    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),
}
