use super::profile::{self, DeviceProfile, ProtocolVersion, ELGATO_VENDOR_ID};
use crate::Result;
use serde::Serialize;
use std::collections::HashMap;
use tracing::{info, warn};

/// Input events from the device.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type")]
pub enum DeviceEvent {
    #[serde(rename = "key")]
    KeyPress { index: u8, pressed: bool },
    #[serde(rename = "encoder_press")]
    EncoderPress { index: u8, pressed: bool },
    #[serde(rename = "encoder_rotate")]
    EncoderRotate { index: u8, delta: i8 },
    #[serde(rename = "lcd_short_press")]
    LcdShortPress { x: u16, y: u16 },
    #[serde(rename = "lcd_long_press")]
    LcdLongPress { x: u16, y: u16 },
    #[serde(rename = "lcd_swipe")]
    LcdSwipe { from_x: u16, from_y: u16, to_x: u16, to_y: u16 },
}

const PACKET_SIZE_V2: usize = 1024;
const HEADER_SIZE_V2: usize = 8;

/// Info about a connected device, referencing its static profile.
#[derive(Debug, Clone)]
pub struct ConnectedDevice {
    pub serial: String,
    pub profile: &'static DeviceProfile,
    pub firmware_version: String,
}

pub struct DeviceManager {
    devices: HashMap<String, ConnectedDevice>,
    api: hidapi::HidApi,
    open_handle: Option<OpenHandle>,
}

struct OpenHandle {
    handle: hidapi::HidDevice,
    profile: &'static DeviceProfile,
}

impl DeviceManager {
    pub fn new() -> Self {
        let api = hidapi::HidApi::new().expect("Failed to initialize HID API");
        Self { devices: HashMap::new(), api, open_handle: None }
    }

    pub fn enumerate(&mut self) -> Result<Vec<ConnectedDevice>> {
        self.api.refresh_devices().map_err(|e| crate::Error::Device(e.to_string()))?;
        self.devices.clear();

        for hid_info in self.api.device_list() {
            if hid_info.vendor_id() != ELGATO_VENDOR_ID { continue; }
            if let Some(prof) = profile::profile_by_pid(hid_info.product_id()) {
                let serial = hid_info.serial_number().unwrap_or("unknown").to_string();
                self.devices.insert(serial.clone(), ConnectedDevice {
                    serial, profile: prof, firmware_version: String::new(),
                });
            }
        }

        if self.open_handle.is_none() && !self.devices.is_empty() {
            if let Some(dev) = self.devices.values().next().cloned() {
                match self.open(&dev.serial) {
                    Ok(()) => info!("Auto-opened {} ({})", dev.profile.display_name, dev.serial),
                    Err(e) => warn!("Failed to auto-open device: {}", e),
                }
            }
        }

        Ok(self.devices.values().cloned().collect())
    }

    pub fn open(&mut self, serial: &str) -> Result<()> {
        let dev = self.devices.get(serial)
            .ok_or_else(|| crate::Error::Device(format!("Device {} not found", serial)))?;
        let prof = dev.profile;

        // Refresh HID API to pick up re-attached devices (e.g., after suspend/resume)
        let _ = self.api.refresh_devices();

        let handle = self.api.open_serial(ELGATO_VENDOR_ID, prof.usb_pid, serial)
            .map_err(|e| crate::Error::Device(format!("Failed to open device: {}", e)))?;
        handle.set_blocking_mode(false)
            .map_err(|e| crate::Error::Device(format!("Failed to set non-blocking: {}", e)))?;

        self.open_handle = Some(OpenHandle { handle, profile: prof });
        info!("Opened device {} ({})", prof.display_name, serial);
        Ok(())
    }

    pub fn get_device(&self, serial: &str) -> Option<&ConnectedDevice> {
        self.devices.get(serial)
    }

    pub fn is_open(&self) -> bool {
        self.open_handle.is_some()
    }

    pub fn active_profile(&self) -> Option<&'static DeviceProfile> {
        self.open_handle.as_ref().map(|h| h.profile)
    }

    /// Read all pending input events: keys, encoders, LCD touch. Drains the HID buffer.
    pub fn read_input(&self) -> Result<Vec<DeviceEvent>> {
        let h = self.require_open()?;
        let mut all_events = Vec::new();
        let mut buf = [0u8; 512];
        loop {
            match h.handle.read(&mut buf) {
                Ok(n) if n > 0 => {
                    if let Ok(events) = self.parse_input_report(&buf[..n], h.profile) {
                        all_events.extend(events);
                    }
                }
                _ => break,
            }
        }
        Ok(all_events)
    }

    /// Legacy: read only key press states.
    pub fn read_keys(&self) -> Result<Vec<(u8, bool)>> {
        let events = self.read_input()?;
        Ok(events.into_iter().filter_map(|e| match e {
            DeviceEvent::KeyPress { index, pressed } => Some((index, pressed)),
            _ => None,
        }).collect())
    }

    fn parse_input_report(&self, buf: &[u8], profile: &DeviceProfile) -> Result<Vec<DeviceEvent>> {
        let mut events = Vec::new();
        if buf.len() < 2 { return Ok(events); }

        // On Linux hidapi, byte[0] is the HID report ID (always 0x01 for input).
        // The actual event type is at byte[1] for Gen2 devices.
        let event_type = if profile.protocol_version == ProtocolVersion::V1 {
            buf[0] // V1: no report ID prefix
        } else {
            buf[1] // V2: byte[0]=reportID, byte[1]=event type
        };

        tracing::debug!("HID input: len={} bytes[0..8]={:02x?} event_type=0x{:02x}",
            buf.len(), &buf[..buf.len().min(8)], event_type);

        match event_type {
            // Button input
            0x00 => {
                let offset = profile.key_data_offset;
                let count = profile.key_count() as usize;
                if buf.len() > offset {
                    for i in 0..count.min(buf.len() - offset) {
                        events.push(DeviceEvent::KeyPress {
                            index: i as u8,
                            pressed: buf[offset + i] != 0,
                        });
                    }
                }
            }
            // LCD/touch input (Stream Deck+)
            0x02 if profile.has_lcd_strip => {
                // V2 offsets: +1 for report ID prefix
                let base: usize = if profile.protocol_version == ProtocolVersion::V2 { 1 } else { 0 };
                if buf.len() >= base + 12 {
                    let touch_type = buf[base + 3];
                    let x = u16::from_le_bytes([buf[base + 5], buf[base + 6]]);
                    let y = u16::from_le_bytes([buf[base + 7], buf[base + 8]]);
                    match touch_type {
                        1 => events.push(DeviceEvent::LcdShortPress { x, y }),
                        2 => events.push(DeviceEvent::LcdLongPress { x, y }),
                        3 if buf.len() >= base + 13 => {
                            let to_x = u16::from_le_bytes([buf[base + 9], buf[base + 10]]);
                            let to_y = u16::from_le_bytes([buf[base + 11], buf[base + 12]]);
                            events.push(DeviceEvent::LcdSwipe { from_x: x, from_y: y, to_x, to_y });
                        }
                        _ => {}
                    }
                }
            }
            // Encoder input (Stream Deck+)
            0x03 if profile.has_dials => {
                let base: usize = if profile.protocol_version == ProtocolVersion::V2 { 1 } else { 0 };
                if buf.len() >= base + 5 {
                    let subtype = buf[base + 3];
                    for i in 0..profile.encoder_count {
                        let idx = base + 4 + i as usize;
                        if idx >= buf.len() { break; }
                        match subtype {
                            0x00 => {
                                events.push(DeviceEvent::EncoderPress {
                                    index: i,
                                    pressed: buf[idx] != 0,
                                });
                            }
                            0x01 => {
                                let delta = buf[idx] as i8;
                                if delta != 0 {
                                    events.push(DeviceEvent::EncoderRotate { index: i, delta });
                                }
                            }
                            _ => {}
                        }
                    }
                }
            }
            _ => {}
        }

        Ok(events)
    }

    pub fn set_key_image(&self, key_index: u8, image_data: &[u8]) -> Result<()> {
        let h = self.require_open()?;
        match h.profile.protocol_version {
            ProtocolVersion::V1 => self.write_image_v1(&h.handle, key_index, image_data),
            ProtocolVersion::V2 => self.write_image_v2(&h.handle, key_index, image_data),
        }
    }

    pub fn set_brightness(&self, percent: u8) -> Result<()> {
        let h = self.require_open()?;
        let mut report = [0u8; 32];
        match h.profile.protocol_version {
            ProtocolVersion::V1 => {
                report[0] = 0x05; report[1] = 0x55; report[2] = 0xaa;
                report[3] = 0xd1; report[4] = 0x01; report[5] = percent.min(100);
            }
            ProtocolVersion::V2 => {
                report[0] = 0x03; report[1] = 0x08; report[2] = percent.min(100);
            }
        }
        h.handle.send_feature_report(&report)
            .map_err(|e| crate::Error::Device(format!("Failed to set brightness: {}", e)))?;
        Ok(())
    }

    /// Write JPEG image data to the LCD strip at a given position.
    /// Stream Deck+ protocol: 16-byte header (0x02, 0x0c, x, y, w, h, isLast, partIndex, bodyLength).
    pub fn set_lcd_image(&self, x: u16, y: u16, w: u16, h: u16, jpeg_data: &[u8]) -> Result<()> {
        let h_dev = self.require_open()?;
        if !h_dev.profile.has_lcd_strip {
            return Err(crate::Error::Device("Device has no LCD strip".into()));
        }

        const LCD_HEADER: usize = 16;
        let max_payload = PACKET_SIZE_V2 - LCD_HEADER;
        let mut offset = 0;
        let mut page: u16 = 0;

        while offset < jpeg_data.len() {
            let chunk = (jpeg_data.len() - offset).min(max_payload);
            let is_last = offset + chunk >= jpeg_data.len();

            let mut packet = vec![0u8; PACKET_SIZE_V2];
            packet[0] = 0x02;
            packet[1] = 0x0c;
            // x, y, w, h as little-endian u16
            packet[2..4].copy_from_slice(&x.to_le_bytes());
            packet[4..6].copy_from_slice(&y.to_le_bytes());
            packet[6..8].copy_from_slice(&w.to_le_bytes());
            packet[8..10].copy_from_slice(&h.to_le_bytes());
            packet[10] = if is_last { 1 } else { 0 };
            packet[11..13].copy_from_slice(&page.to_le_bytes());
            // bodyLength as 3 bytes LE
            packet[13] = (chunk & 0xFF) as u8;
            packet[14] = ((chunk >> 8) & 0xFF) as u8;
            packet[15] = ((chunk >> 16) & 0xFF) as u8;

            packet[LCD_HEADER..LCD_HEADER + chunk]
                .copy_from_slice(&jpeg_data[offset..offset + chunk]);

            h_dev.handle.write(&packet)
                .map_err(|e| crate::Error::Device(format!("LCD write failed: {}", e)))?;

            offset += chunk;
            page += 1;
        }
        Ok(())
    }

    fn require_open(&self) -> Result<&OpenHandle> {
        self.open_handle.as_ref()
            .ok_or_else(|| crate::Error::Device("No device open".into()))
    }

    fn write_image_v2(&self, handle: &hidapi::HidDevice, key_index: u8, data: &[u8]) -> Result<()> {
        let max_payload = PACKET_SIZE_V2 - HEADER_SIZE_V2;
        let mut offset = 0;
        let mut page: u16 = 0;

        while offset < data.len() {
            let chunk = (data.len() - offset).min(max_payload);
            let is_last = offset + chunk >= data.len();

            let mut packet = vec![0u8; PACKET_SIZE_V2];
            packet[0] = 0x02;
            packet[1] = 0x07;
            packet[2] = key_index;
            packet[3] = if is_last { 1 } else { 0 };
            packet[4] = (chunk & 0xFF) as u8;
            packet[5] = ((chunk >> 8) & 0xFF) as u8;
            packet[6] = (page & 0xFF) as u8;
            packet[7] = ((page >> 8) & 0xFF) as u8;
            packet[HEADER_SIZE_V2..HEADER_SIZE_V2 + chunk]
                .copy_from_slice(&data[offset..offset + chunk]);

            handle.write(&packet)
                .map_err(|e| crate::Error::Device(format!("Write failed: {}", e)))?;

            offset += chunk;
            page += 1;
        }
        Ok(())
    }

    fn write_image_v1(&self, handle: &hidapi::HidDevice, key_index: u8, data: &[u8]) -> Result<()> {
        // V1 protocol uses different packet structure — 8191 byte pages, 16 byte header
        // For now delegate to V2 with a warning (covers OriginalV2 which is the common case)
        warn!("V1 image protocol: falling back to V2 for key {}", key_index);
        self.write_image_v2(handle, key_index, data)
    }
}
