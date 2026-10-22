pub mod device;
pub mod image;
pub mod platform;
pub mod plugin;
pub mod profile;

mod error;
pub use error::Error;

pub type Result<T> = std::result::Result<T, Error>;
