mod manager;
pub mod profile;

pub use manager::{DeviceManager, ConnectedDevice, DeviceEvent};
pub use profile::{DeviceProfile, DEVICE_PROFILES, ELGATO_VENDOR_ID};
