use serde::Serialize;

/// All per-device-model data in one place. Adding a new device = adding one entry here.
///
/// Ground truth for the protocol values below is the Elgato driver library
/// `@elgato-stream-deck/core` (github.com/Julusian/node-elgato-stream-deck, packages/core/src:
/// models/definitions.ts, modelInfo.ts, registry.ts, models/original.ts, models/6-key.ts,
/// models/generic-gen2.ts, models/plus.ts, models/neo.ts) and the older bundled copy in
/// node_modules/elgato-stream-deck (dist/models/{base,original,mini,base-gen2}.js).
#[derive(Debug, Clone, Serialize)]
pub struct DeviceProfile {
    pub id: &'static str,
    pub display_name: &'static str,
    pub usb_pid: u16,
    /// Grid of LCD keys (`columns * rows` keys, indices row-major, left to right).
    pub columns: u8,
    pub rows: u8,
    /// Native key image size in pixels (square). 0 = keys have no display (Pedal).
    pub key_pixel_size: u16,
    pub image_format: ImageFormat,
    pub protocol_version: ProtocolVersion,
    /// Offset of the first key byte in an input report AFTER the report-ID byte is stripped
    /// (upstream `keyDataOffset`: 0 for gen1, 3 for gen2).
    pub key_data_offset: usize,
    /// Gen1 Original reports and addresses keys right-to-left (upstream `rtl: true`).
    pub key_rtl: bool,
    /// Pixel transform applied to key images before encoding.
    pub key_transform: PixelTransform,
    /// Pixels-per-metre written into the BMP header (gen1 only).
    pub bmp_ppm: i32,
    /// How key image payloads are split into HID output reports.
    pub key_writer: KeyImageWriter,
    /// Extra non-LCD touch buttons reported after the key grid (Neo: 2 page buttons, hid 8/9).
    pub touch_button_count: u8,
    pub has_lcd_strip: bool,
    pub has_dials: bool,
    pub encoder_count: u8,
    pub lcd_strip_width: u16,
    pub lcd_strip_height: u16,
    /// Non-touch info screen (Neo 248x58). 0x0 when absent.
    pub info_lcd_width: u16,
    pub info_lcd_height: u16,
    /// Pixel transform applied to LCD strip / info screen images before JPEG encoding.
    pub lcd_transform: PixelTransform,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum ImageFormat {
    /// 24-bit BGR bitmap with a 54-byte BITMAPINFOHEADER (gen1).
    Bmp,
    Jpeg,
    /// Device has no key displays.
    None,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum ProtocolVersion {
    /// Gen1: input report = [0x01, key bytes...], image header 0x02 0x01 (16 bytes),
    /// brightness feature report 0x05 (17 bytes).
    V1,
    /// Gen2: input report = [0x01, type, len16, data...], image header 0x02 0x07 (8 bytes),
    /// brightness feature report 0x03 0x08 (32 bytes).
    V2,
}

/// Pixel transform, same semantics as upstream `transformImageBuffer` (util.ts):
/// for target pixel (x, y): apply x/y flips, then swap axes when `rotate`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct PixelTransform {
    pub x_flip: bool,
    pub y_flip: bool,
    pub rotate: bool,
}

impl PixelTransform {
    pub const NONE: Self = Self { x_flip: false, y_flip: false, rotate: false };
    /// 180 degrees (gen2 default: `{ xFlip: true, yFlip: true }`).
    pub const ROTATE_180: Self = Self { x_flip: true, y_flip: true, rotate: false };
    /// Original: `{ xFlip: true }`.
    pub const X_FLIP: Self = Self { x_flip: true, y_flip: false, rotate: false };
    /// Mini / 6-key: `{ rotate: true, yFlip: true }`.
    pub const ROTATE_Y_FLIP: Self = Self { x_flip: false, y_flip: true, rotate: true };
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum KeyImageWriter {
    /// Original (0x0060): payload split equally into exactly 2 packets of 8191 bytes,
    /// part indices 1 and 2 (upstream StreamdeckOriginalImageWriter).
    OriginalTwoPart,
    /// 1024-byte packets, part index from 0 (upstream StreamdeckDefaultImageWriter).
    Chunked1024,
    /// No key displays.
    None,
}

impl DeviceProfile {
    /// Number of LCD keys in the grid.
    pub fn key_count(&self) -> u8 {
        self.columns * self.rows
    }

    /// Grid keys plus extra touch buttons (all reported as KeyPress events).
    pub fn button_count(&self) -> u8 {
        self.key_count() + self.touch_button_count
    }

    /// HID index for a logical button index (horizontal flip for right-to-left devices).
    /// Upstream controlsGenerator.ts `flipKeyIndex`.
    pub fn hid_key_index(&self, index: u8) -> u8 {
        if self.key_rtl && index < self.key_count() {
            let cols = self.columns;
            let row = index / cols;
            let col = index % cols;
            row * cols + (cols - 1 - col)
        } else {
            index
        }
    }

    pub fn has_key_display(&self) -> bool {
        self.key_pixel_size > 0 && self.image_format != ImageFormat::None
    }

    pub fn has_info_lcd(&self) -> bool {
        self.info_lcd_width > 0 && self.info_lcd_height > 0
    }
}

pub const ELGATO_VENDOR_ID: u16 = 0x0fd9;

const fn gen2_grid(
    id: &'static str,
    display_name: &'static str,
    usb_pid: u16,
    columns: u8,
    rows: u8,
    key_pixel_size: u16,
) -> DeviceProfile {
    DeviceProfile {
        id, display_name, usb_pid, columns, rows, key_pixel_size,
        image_format: ImageFormat::Jpeg,
        protocol_version: ProtocolVersion::V2,
        key_data_offset: 3,
        key_rtl: false,
        key_transform: PixelTransform::ROTATE_180,
        bmp_ppm: 0,
        key_writer: KeyImageWriter::Chunked1024,
        touch_button_count: 0,
        has_lcd_strip: false, has_dials: false,
        encoder_count: 0, lcd_strip_width: 0, lcd_strip_height: 0,
        info_lcd_width: 0, info_lcd_height: 0,
        lcd_transform: PixelTransform::NONE,
    }
}

/// Gen1 6-key (Mini family): 3x2 @ 80px BMP, rotate + yFlip, 1024-byte packets, PPM 2835
/// (upstream models/6-key.ts, definitions.ts sixKeyProperties).
const fn gen1_six_key(id: &'static str, display_name: &'static str, usb_pid: u16) -> DeviceProfile {
    DeviceProfile {
        id, display_name, usb_pid,
        columns: 3, rows: 2,
        key_pixel_size: 80,
        image_format: ImageFormat::Bmp,
        protocol_version: ProtocolVersion::V1,
        key_data_offset: 0,
        key_rtl: false,
        key_transform: PixelTransform::ROTATE_Y_FLIP,
        bmp_ppm: 2835,
        key_writer: KeyImageWriter::Chunked1024,
        touch_button_count: 0,
        has_lcd_strip: false, has_dials: false,
        encoder_count: 0, lcd_strip_width: 0, lcd_strip_height: 0,
        info_lcd_width: 0, info_lcd_height: 0,
        lcd_transform: PixelTransform::NONE,
    }
}

/// The single source of truth for all supported devices.
/// To add a new device: add one entry here. Nothing else changes.
pub static DEVICE_PROFILES: &[DeviceProfile] = &[
    // Original (gen1): 5x3 @ 72px BMP, keys right-to-left, xFlip, 2x8191-byte packets, PPM 3780
    // (upstream models/original.ts, definitions.ts originalProperties).
    DeviceProfile {
        id: "original",
        display_name: "Stream Deck Original",
        usb_pid: 0x0060,
        columns: 5, rows: 3,
        key_pixel_size: 72,
        image_format: ImageFormat::Bmp,
        protocol_version: ProtocolVersion::V1,
        key_data_offset: 0,
        key_rtl: true,
        key_transform: PixelTransform::X_FLIP,
        bmp_ppm: 3780,
        key_writer: KeyImageWriter::OriginalTwoPart,
        touch_button_count: 0,
        has_lcd_strip: false, has_dials: false,
        encoder_count: 0, lcd_strip_width: 0, lcd_strip_height: 0,
        info_lcd_width: 0, info_lcd_height: 0,
        lcd_transform: PixelTransform::NONE,
    },
    gen2_grid("original_v2", "Stream Deck Original V2", 0x006d, 5, 3, 72),
    gen1_six_key("mini", "Stream Deck Mini", 0x0063),
    // Upstream modelInfo.ts lists 0x0090 and 0x00b3 under DeviceModelId.MINI (6-key gen1 factory).
    gen1_six_key("mini_v2", "Stream Deck Mini V2", 0x0090),
    gen1_six_key("mini_v2_b3", "Stream Deck Mini", 0x00b3),
    gen1_six_key("module_6", "Stream Deck 6 Module", 0x00b8),
    gen2_grid("xl", "Stream Deck XL", 0x006c, 8, 4, 96),
    gen2_grid("xl_v2", "Stream Deck XL V2", 0x008f, 8, 4, 96),
    gen2_grid("mk2", "Stream Deck MK.2", 0x0080, 5, 3, 72),
    gen2_grid("mk2_scissor", "Stream Deck MK.2 (Scissor)", 0x00a5, 5, 3, 72),
    gen2_grid("module_15", "Stream Deck 15 Module", 0x00b9, 5, 3, 72),
    gen2_grid("module_15_scissor", "Stream Deck 15 Module (Scissor)", 0x00e4, 5, 3, 72),
    gen2_grid("module_32", "Stream Deck 32 Module", 0x00ba, 8, 4, 96),
    // Pedal: 3 buttons, no displays, button-only input at offset 3 (upstream models/pedal.ts).
    DeviceProfile {
        id: "pedal",
        display_name: "Stream Deck Pedal",
        usb_pid: 0x0086,
        columns: 3, rows: 1,
        key_pixel_size: 0,
        image_format: ImageFormat::None,
        protocol_version: ProtocolVersion::V2,
        key_data_offset: 3,
        key_rtl: false,
        key_transform: PixelTransform::NONE,
        bmp_ppm: 0,
        key_writer: KeyImageWriter::None,
        touch_button_count: 0,
        has_lcd_strip: false, has_dials: false,
        encoder_count: 0, lcd_strip_width: 0, lcd_strip_height: 0,
        info_lcd_width: 0, info_lcd_height: 0,
        lcd_transform: PixelTransform::NONE,
    },
    // Plus: 4x2 @ 120px, no key transform, 800x100 touch strip, 4 encoders (upstream models/plus.ts).
    DeviceProfile {
        id: "plus",
        display_name: "Stream Deck +",
        usb_pid: 0x0084,
        columns: 4, rows: 2,
        key_pixel_size: 120,
        image_format: ImageFormat::Jpeg,
        protocol_version: ProtocolVersion::V2,
        key_data_offset: 3,
        key_rtl: false,
        key_transform: PixelTransform::NONE,
        bmp_ppm: 0,
        key_writer: KeyImageWriter::Chunked1024,
        touch_button_count: 0,
        has_lcd_strip: true, has_dials: true,
        encoder_count: 4, lcd_strip_width: 800, lcd_strip_height: 100,
        info_lcd_width: 0, info_lcd_height: 0,
        lcd_transform: PixelTransform::NONE,
    },
    // Neo: 4x2 @ 96px (gen2 180-degree keys), 2 touch page buttons (hid 8, 9) and a 248x58 info
    // screen written with header 0x02 0x0b and xFlip+yFlip (upstream definitions.ts neoProperties,
    // models/neo.ts, services/lcdSegmentDisplay/neo.ts).
    DeviceProfile {
        id: "neo",
        display_name: "Stream Deck Neo",
        usb_pid: 0x009a,
        columns: 4, rows: 2,
        key_pixel_size: 96,
        image_format: ImageFormat::Jpeg,
        protocol_version: ProtocolVersion::V2,
        key_data_offset: 3,
        key_rtl: false,
        key_transform: PixelTransform::ROTATE_180,
        bmp_ppm: 0,
        key_writer: KeyImageWriter::Chunked1024,
        touch_button_count: 2,
        has_lcd_strip: false, has_dials: false,
        encoder_count: 0, lcd_strip_width: 0, lcd_strip_height: 0,
        info_lcd_width: 248, info_lcd_height: 58,
        lcd_transform: PixelTransform::ROTATE_180,
    },
];

/// Lookup a device profile by USB product ID.
pub fn profile_by_pid(pid: u16) -> Option<&'static DeviceProfile> {
    DEVICE_PROFILES.iter().find(|p| p.usb_pid == pid)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pids_and_ids_are_unique() {
        for (i, a) in DEVICE_PROFILES.iter().enumerate() {
            for b in &DEVICE_PROFILES[i + 1..] {
                assert_ne!(a.usb_pid, b.usb_pid, "{} / {}", a.id, b.id);
                assert_ne!(a.id, b.id);
            }
        }
    }

    #[test]
    fn original_rtl_mapping() {
        let p = profile_by_pid(0x0060).unwrap();
        let mapped: Vec<u8> = (0..15).map(|i| p.hid_key_index(i)).collect();
        assert_eq!(mapped, vec![4, 3, 2, 1, 0, 9, 8, 7, 6, 5, 14, 13, 12, 11, 10]);
        let mini = profile_by_pid(0x0063).unwrap();
        assert_eq!(mini.hid_key_index(2), 2);
    }

    #[test]
    fn neo_geometry() {
        let p = profile_by_pid(0x009a).unwrap();
        assert_eq!((p.columns, p.rows, p.key_pixel_size), (4, 2, 96));
        assert_eq!(p.button_count(), 10);
        assert!(p.has_info_lcd());
    }

    #[test]
    fn mini_v2_is_gen1() {
        let p = profile_by_pid(0x0090).unwrap();
        assert_eq!(p.protocol_version, ProtocolVersion::V1);
        assert_eq!(p.image_format, ImageFormat::Bmp);
    }
}
