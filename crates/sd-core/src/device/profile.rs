use serde::{Deserialize, Serialize};

/// All per-device-model data in one place. Adding a new device = adding one entry here.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeviceProfile {
    pub id: &'static str,
    pub display_name: &'static str,
    pub usb_pid: u16,
    pub columns: u8,
    pub rows: u8,
    pub key_pixel_size: u16,
    pub image_format: ImageFormat,
    pub protocol_version: ProtocolVersion,
    pub key_data_offset: usize,
    pub has_lcd_strip: bool,
    pub has_dials: bool,
    pub encoder_count: u8,
    pub lcd_strip_width: u16,
    pub lcd_strip_height: u16,
    pub rotate_image: bool,  // true = rotate 180° (Original, Mini, XL, MK2), false = no rotation (Plus, Neo)
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub enum ImageFormat { Bmp, Jpeg }

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub enum ProtocolVersion { V1, V2 }

impl DeviceProfile {
    pub fn key_count(&self) -> u8 {
        self.columns * self.rows
    }
}

pub const ELGATO_VENDOR_ID: u16 = 0x0fd9;

/// The single source of truth for all supported devices.
/// To add a new device: add one entry here. Nothing else changes.
pub static DEVICE_PROFILES: &[DeviceProfile] = &[
    DeviceProfile {
        id: "original",
        display_name: "Stream Deck Original",
        usb_pid: 0x0060,
        columns: 5, rows: 3,
        key_pixel_size: 72,
        image_format: ImageFormat::Bmp,
        protocol_version: ProtocolVersion::V1,
        key_data_offset: 1,
        has_lcd_strip: false, has_dials: false,
        encoder_count: 0, lcd_strip_width: 0, lcd_strip_height: 0,
        rotate_image: true,
    },
    DeviceProfile {
        id: "original_v2",
        display_name: "Stream Deck Original V2",
        usb_pid: 0x006d,
        columns: 5, rows: 3,
        key_pixel_size: 72,
        image_format: ImageFormat::Jpeg,
        protocol_version: ProtocolVersion::V2,
        key_data_offset: 4,
        has_lcd_strip: false, has_dials: false,
        encoder_count: 0, lcd_strip_width: 0, lcd_strip_height: 0,
        rotate_image: true,
    },
    DeviceProfile {
        id: "mini",
        display_name: "Stream Deck Mini",
        usb_pid: 0x0063,
        columns: 3, rows: 2,
        key_pixel_size: 80,
        image_format: ImageFormat::Bmp,
        protocol_version: ProtocolVersion::V1,
        key_data_offset: 1,
        has_lcd_strip: false, has_dials: false,
        encoder_count: 0, lcd_strip_width: 0, lcd_strip_height: 0,
        rotate_image: true,
    },
    DeviceProfile {
        id: "mini_v2",
        display_name: "Stream Deck Mini V2",
        usb_pid: 0x0090,
        columns: 3, rows: 2,
        key_pixel_size: 80,
        image_format: ImageFormat::Jpeg,
        protocol_version: ProtocolVersion::V2,
        key_data_offset: 4,
        has_lcd_strip: false, has_dials: false,
        encoder_count: 0, lcd_strip_width: 0, lcd_strip_height: 0,
        rotate_image: true,
    },
    DeviceProfile {
        id: "xl",
        display_name: "Stream Deck XL",
        usb_pid: 0x006c,
        columns: 8, rows: 4,
        key_pixel_size: 96,
        image_format: ImageFormat::Jpeg,
        protocol_version: ProtocolVersion::V2,
        key_data_offset: 4,
        has_lcd_strip: false, has_dials: false,
        encoder_count: 0, lcd_strip_width: 0, lcd_strip_height: 0,
        rotate_image: true,
    },
    DeviceProfile {
        id: "xl_v2",
        display_name: "Stream Deck XL V2",
        usb_pid: 0x008f,
        columns: 8, rows: 4,
        key_pixel_size: 96,
        image_format: ImageFormat::Jpeg,
        protocol_version: ProtocolVersion::V2,
        key_data_offset: 4,
        has_lcd_strip: false, has_dials: false,
        encoder_count: 0, lcd_strip_width: 0, lcd_strip_height: 0,
        rotate_image: true,
    },
    DeviceProfile {
        id: "mk2",
        display_name: "Stream Deck MK.2",
        usb_pid: 0x0080,
        columns: 5, rows: 3,
        key_pixel_size: 72,
        image_format: ImageFormat::Jpeg,
        protocol_version: ProtocolVersion::V2,
        key_data_offset: 4,
        has_lcd_strip: false, has_dials: false,
        encoder_count: 0, lcd_strip_width: 0, lcd_strip_height: 0,
        rotate_image: true,
    },
    DeviceProfile {
        id: "pedal",
        display_name: "Stream Deck Pedal",
        usb_pid: 0x0086,
        columns: 3, rows: 1,
        key_pixel_size: 0,
        image_format: ImageFormat::Jpeg,
        protocol_version: ProtocolVersion::V2,
        key_data_offset: 4,
        has_lcd_strip: false, has_dials: false,
        encoder_count: 0, lcd_strip_width: 0, lcd_strip_height: 0,
        rotate_image: true,
    },
    DeviceProfile {
        id: "plus",
        display_name: "Stream Deck +",
        usb_pid: 0x0084,
        columns: 4, rows: 2,
        key_pixel_size: 120,
        image_format: ImageFormat::Jpeg,
        protocol_version: ProtocolVersion::V2,
        key_data_offset: 4,
        has_lcd_strip: true, has_dials: true,
        encoder_count: 4, lcd_strip_width: 800, lcd_strip_height: 100,
        rotate_image: false,
    },
    DeviceProfile {
        id: "neo",
        display_name: "Stream Deck Neo",
        usb_pid: 0x009a,
        columns: 5, rows: 3,
        key_pixel_size: 72,
        image_format: ImageFormat::Jpeg,
        protocol_version: ProtocolVersion::V2,
        key_data_offset: 4,
        has_lcd_strip: false, has_dials: false,
        encoder_count: 0, lcd_strip_width: 0, lcd_strip_height: 0,
        rotate_image: false,
    },
];

/// Lookup a device profile by USB product ID.
pub fn profile_by_pid(pid: u16) -> Option<&'static DeviceProfile> {
    DEVICE_PROFILES.iter().find(|p| p.usb_pid == pid)
}

/// Lookup a device profile by string ID.
pub fn profile_by_id(id: &str) -> Option<&'static DeviceProfile> {
    DEVICE_PROFILES.iter().find(|p| p.id == id)
}