//! HID transport for Stream Deck devices.
//!
//! Protocol reference (ground truth): @elgato-stream-deck/core
//! (github.com/Julusian/node-elgato-stream-deck, packages/core/src) and the bundled
//! node_modules/elgato-stream-deck 4.1.0:
//! - input: node hid-device.ts only accepts reports whose first byte (report ID) is 0x01 and
//!   strips it; services/input/gen1.ts (buttons only at `keyDataOffset + hidIndex`) and
//!   services/input/gen2.ts (type byte 0x00 keys / 0x02 LCD touch / 0x03 encoders).
//! - key images: services/imageWriter/headerGenerator.ts (gen1 16-byte 0x02 0x01 header,
//!   gen2 8-byte 0x02 0x07 header, Plus LCD 16-byte 0x02 0x0c header, Neo LCD 8-byte 0x02 0x0b
//!   header) and imageWriter.ts (Original: 2 x 8191-byte packets, others 1024-byte packets).
//! - brightness: services/properties/gen1.ts (17-byte 0x05 report), gen2.ts (32-byte 0x03 0x08).

use super::profile::{self, DeviceProfile, KeyImageWriter, ProtocolVersion, ELGATO_VENDOR_ID};
use crate::Result;
use serde::Serialize;
use std::collections::HashMap;
use std::ffi::CString;
use tracing::{info, warn};

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "type")]
pub enum DeviceEvent {
    #[serde(rename = "key")]
    KeyPress { serial: String, index: u8, pressed: bool },
    #[serde(rename = "encoder_press")]
    EncoderPress { serial: String, index: u8, pressed: bool },
    #[serde(rename = "encoder_rotate")]
    EncoderRotate { serial: String, index: u8, delta: i8 },
    #[serde(rename = "lcd_short_press")]
    LcdShortPress { serial: String, x: u16, y: u16 },
    #[serde(rename = "lcd_long_press")]
    LcdLongPress { serial: String, x: u16, y: u16 },
    #[serde(rename = "lcd_swipe")]
    LcdSwipe { serial: String, from_x: u16, from_y: u16, to_x: u16, to_y: u16 },
}

/// Output report size used by every model except the Original's key images.
pub const HID_PACKET_SIZE: usize = 1024;
const ORIGINAL_PACKET_SIZE: usize = 8191;
const GEN1_HEADER_SIZE: usize = 16;
const GEN2_HEADER_SIZE: usize = 8;
const PLUS_LCD_HEADER_SIZE: usize = 16;
const NEO_LCD_HEADER_SIZE: usize = 8;
const INPUT_REPORT_ID: u8 = 0x01;

#[derive(Debug, Clone)]
pub struct ConnectedDevice {
    /// USB serial number, or [`fallback_serial`] of the HID path when the
    /// serial string is unreadable. Never contains ':' (the UI's context
    /// separator).
    pub serial: String,
    pub profile: &'static DeviceProfile,
    path: CString,
}

struct OpenHandle {
    handle: hidapi::HidDevice,
    profile: &'static DeviceProfile,
    path: CString,
}

pub struct DeviceManager {
    /// None when hidapi failed to initialise; retried on every enumerate().
    api: Option<hidapi::HidApi>,
    devices: HashMap<String, ConnectedDevice>,
    open_handles: HashMap<String, OpenHandle>,
    /// Per serial: how many times a handle was opened. Changes on every
    /// (re)open, so the UI can tell that a deck needs a full repaint even
    /// when the serial list is unchanged (replug, USB reset, failed I/O).
    open_generations: HashMap<String, u64>,
}

impl Default for DeviceManager {
    fn default() -> Self {
        Self::new()
    }
}

impl DeviceManager {
    /// Never panics: if the HID backend cannot be initialised the manager starts without devices
    /// and `enumerate()` returns the init error (and retries) until it succeeds.
    pub fn new() -> Self {
        let api = match hidapi::HidApi::new() {
            Ok(api) => Some(api),
            Err(e) => {
                warn!("HID API unavailable, running without devices: {}", e);
                None
            }
        };
        Self { api, devices: HashMap::new(), open_handles: HashMap::new(), open_generations: HashMap::new() }
    }

    fn api_mut(&mut self) -> Result<&mut hidapi::HidApi> {
        if self.api.is_none() {
            let api = hidapi::HidApi::new()
                .map_err(|e| crate::Error::Device(format!("HID API unavailable: {}", e)))?;
            info!("HID API initialised");
            self.api = Some(api);
        }
        Ok(self.api.as_mut().expect("initialised above"))
    }

    /// Rescan USB, auto-open new devices, drop handles of removed or re-plugged devices.
    /// Returned list is sorted by serial.
    pub fn enumerate(&mut self) -> Result<Vec<ConnectedDevice>> {
        let api = self.api_mut()?;
        api.refresh_devices().map_err(|e| crate::Error::Device(e.to_string()))?;

        let mut found: HashMap<String, ConnectedDevice> = HashMap::new();
        for hid_info in api.device_list() {
            if hid_info.vendor_id() != ELGATO_VENDOR_ID { continue; }
            let Some(prof) = profile::profile_by_pid(hid_info.product_id()) else { continue };
            let serial = match hid_info.serial_number() {
                Some(s) if !s.trim().is_empty() => s.to_string(),
                _ => fallback_serial(hid_info.path()),
            };
            found.entry(serial.clone()).or_insert(ConnectedDevice {
                serial,
                profile: prof,
                path: hid_info.path().to_owned(),
            });
        }
        self.devices = found;

        // Drop handles whose device disappeared or came back on a different path (re-plug).
        let devices = &self.devices;
        self.open_handles.retain(|serial, h| {
            let keep = devices.get(serial).is_some_and(|d| d.path == h.path);
            if !keep { info!("Closed device {}", serial); }
            keep
        });

        let mut serials: Vec<String> = self.devices.keys().cloned().collect();
        serials.sort();
        for serial in &serials {
            if !self.open_handles.contains_key(serial) {
                if let Err(e) = self.open(serial) {
                    warn!("Failed to auto-open {}: {}", serial, e);
                }
            }
        }

        Ok(serials.iter().filter_map(|s| self.devices.get(s).cloned()).collect())
    }

    /// Open an enumerated device. No-op when it is already open on the same HID path.
    pub fn open(&mut self, serial: &str) -> Result<()> {
        let dev = self.devices.get(serial)
            .ok_or_else(|| crate::Error::Device(format!("Device {} not found", serial)))?;
        if self.open_handles.get(serial).is_some_and(|h| h.path == dev.path) {
            return Ok(());
        }
        let api = self.api.as_ref()
            .ok_or_else(|| crate::Error::Device("HID API unavailable".into()))?;
        let handle = api.open_path(&dev.path)
            .map_err(|e| crate::Error::Device(format!("Failed to open device: {}", e)))?;
        handle.set_blocking_mode(false)
            .map_err(|e| crate::Error::Device(format!("Failed to set non-blocking: {}", e)))?;

        info!("Opened device {} ({})", dev.profile.display_name, serial);
        self.open_handles.insert(serial.to_string(), OpenHandle {
            handle,
            profile: dev.profile,
            path: dev.path.clone(),
        });
        *self.open_generations.entry(serial.to_string()).or_insert(0) += 1;
        Ok(())
    }

    /// Number of times a handle for `serial` has been opened (0 = never).
    /// A new value means the device was reopened and lost its display state.
    pub fn open_generation(&self, serial: &str) -> u64 {
        self.open_generations.get(serial).copied().unwrap_or(0)
    }

    pub fn get_device(&self, serial: &str) -> Option<&ConnectedDevice> {
        self.devices.get(serial)
    }

    pub fn is_device_open(&self, serial: &str) -> bool {
        self.open_handles.contains_key(serial)
    }

    pub fn profile_for(&self, serial: &str) -> Option<&'static DeviceProfile> {
        self.open_handles.get(serial).map(|h| h.profile)
    }

    /// Read all pending input from every open device. A handle whose read fails (unplugged,
    /// USB reset) is closed; the next enumerate() reopens it.
    pub fn read_input(&mut self) -> Result<Vec<DeviceEvent>> {
        let mut all = Vec::new();
        let mut dead = Vec::new();
        for (serial, h) in &self.open_handles {
            let mut buf = [0u8; 512];
            loop {
                match h.handle.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => all.extend(parse_input_report(&buf[..n], h.profile, serial)),
                    Err(e) => {
                        warn!("Read from {} failed, closing handle: {}", serial, e);
                        dead.push(serial.clone());
                        break;
                    }
                }
            }
        }
        for serial in dead {
            self.open_handles.remove(&serial);
        }
        Ok(all)
    }

    fn open_handle(&self, serial: &str) -> Result<&OpenHandle> {
        self.open_handles.get(serial)
            .ok_or_else(|| crate::Error::Device(format!("Device {} not open", serial)))
    }

    /// Write packets; on failure close the handle so the next enumerate() reopens it.
    fn write_packets(&mut self, serial: &str, packets: &[Vec<u8>]) -> Result<()> {
        let h = self.open_handle(serial)?;
        let mut failure = None;
        for packet in packets {
            if let Err(e) = h.handle.write(packet) {
                failure = Some(e.to_string());
                break;
            }
        }
        if let Some(e) = failure {
            warn!("Write to {} failed, closing handle: {}", serial, e);
            self.open_handles.remove(serial);
            return Err(crate::Error::Device(format!("Write failed: {}", e)));
        }
        Ok(())
    }

    /// Send a key image. `payload` must already be in the model's native format
    /// (see `crate::image::encode_key_image`). `key_index` is the logical (row-major,
    /// left-to-right) key index.
    pub fn set_key_image(&mut self, serial: &str, key_index: u8, payload: &[u8]) -> Result<()> {
        let prof = self.open_handle(serial)?.profile;
        if !prof.has_key_display() {
            return Err(crate::Error::Device(format!("{} has no key displays", prof.display_name)));
        }
        if key_index >= prof.key_count() {
            return Err(crate::Error::Device(format!(
                "Key index {} out of range (0-{}) for {}", key_index, prof.key_count() - 1, prof.display_name
            )));
        }
        let hid_key = prof.hid_key_index(key_index);
        let packets = match prof.protocol_version {
            ProtocolVersion::V1 => gen1_key_packets(prof, hid_key, payload)?,
            ProtocolVersion::V2 => gen2_key_packets(hid_key, payload),
        };
        self.write_packets(serial, &packets)
    }

    /// Set the brightness (0-100) of one device.
    pub fn set_brightness(&self, serial: &str, percent: u8) -> Result<()> {
        let h = self.open_handle(serial)?;
        let report = brightness_report(h.profile, percent);
        h.handle.send_feature_report(&report)
            .map_err(|e| crate::Error::Device(format!("Brightness failed for {}: {}", serial, e)))
    }

    /// Send an LCD image. Plus: a JPEG for the rect (x, y, w, h) inside the 800x100 strip.
    /// Neo: the whole 248x58 info screen (x = y = 0, full size). The JPEG must already carry the
    /// model's LCD transform (`profile.lcd_transform`).
    pub fn set_lcd_image(&mut self, serial: &str, x: u16, y: u16, w: u16, h: u16, jpeg_data: &[u8]) -> Result<()> {
        let prof = self.open_handle(serial)?.profile;
        let packets = if prof.has_lcd_strip {
            let fits = w > 0 && h > 0
                && x as u32 + w as u32 <= prof.lcd_strip_width as u32
                && y as u32 + h as u32 <= prof.lcd_strip_height as u32;
            if !fits {
                return Err(crate::Error::Device(format!(
                    "LCD rect {}x{}+{}+{} outside {}x{} strip", w, h, x, y, prof.lcd_strip_width, prof.lcd_strip_height
                )));
            }
            plus_lcd_packets(x, y, w, h, jpeg_data)
        } else if prof.has_info_lcd() {
            if (x, y, w, h) != (0, 0, prof.info_lcd_width, prof.info_lcd_height) {
                return Err(crate::Error::Device(format!(
                    "{} info screen only accepts a full {}x{} image", prof.display_name, prof.info_lcd_width, prof.info_lcd_height
                )));
            }
            neo_info_lcd_packets(jpeg_data)
        } else {
            return Err(crate::Error::Device("Device has no LCD".into()));
        };
        self.write_packets(serial, &packets)
    }
}

/// Device id for a deck whose USB serial is unreadable: `path-` plus the HID
/// path with every character outside `[A-Za-z0-9]` replaced by '-'. Stable
/// for a given path and free of ':' (the UI splits contexts on ':').
pub fn fallback_serial(path: &std::ffi::CStr) -> String {
    let p: String = path.to_string_lossy()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    format!("path-{}", p.trim_start_matches('-'))
}

fn brightness_report(profile: &DeviceProfile, percent: u8) -> Vec<u8> {
    let percent = percent.min(100);
    match profile.protocol_version {
        ProtocolVersion::V1 => {
            let mut r = vec![0u8; 17];
            r[..6].copy_from_slice(&[0x05, 0x55, 0xaa, 0xd1, 0x01, percent]);
            r
        }
        ProtocolVersion::V2 => {
            let mut r = vec![0u8; 32];
            r[..3].copy_from_slice(&[0x03, 0x08, percent]);
            r
        }
    }
}

/// Parse one raw HID input report (including the leading report-ID byte, as hidapi returns it).
pub fn parse_input_report(buf: &[u8], profile: &DeviceProfile, serial: &str) -> Vec<DeviceEvent> {
    let mut events = Vec::new();
    if buf.first() != Some(&INPUT_REPORT_ID) { return events; }
    let data = &buf[1..];

    // Gen1 and the Pedal send button-only reports; other gen2 models prefix a type byte.
    let typed = profile.protocol_version == ProtocolVersion::V2 && profile.has_key_display();
    if !typed {
        push_buttons(&mut events, data, profile, serial);
        return events;
    }

    match data.first() {
        Some(0x00) => push_buttons(&mut events, data, profile, serial),
        Some(0x02) if profile.has_lcd_strip && data.len() >= 9 => {
            let x = u16::from_le_bytes([data[5], data[6]]);
            let y = u16::from_le_bytes([data[7], data[8]]);
            let serial = serial.to_string();
            match data[3] {
                1 => events.push(DeviceEvent::LcdShortPress { serial, x, y }),
                2 => events.push(DeviceEvent::LcdLongPress { serial, x, y }),
                3 if data.len() >= 13 => {
                    let to_x = u16::from_le_bytes([data[9], data[10]]);
                    let to_y = u16::from_le_bytes([data[11], data[12]]);
                    events.push(DeviceEvent::LcdSwipe { serial, from_x: x, from_y: y, to_x, to_y });
                }
                _ => {}
            }
        }
        Some(0x03) if profile.has_dials && data.len() >= 4 => {
            let subtype = data[3];
            for i in 0..profile.encoder_count {
                let Some(&value) = data.get(4 + i as usize) else { break };
                match subtype {
                    0x00 => events.push(DeviceEvent::EncoderPress { serial: serial.to_string(), index: i, pressed: value != 0 }),
                    0x01 => {
                        let delta = value as i8;
                        if delta != 0 {
                            events.push(DeviceEvent::EncoderRotate { serial: serial.to_string(), index: i, delta });
                        }
                    }
                    _ => {}
                }
            }
        }
        _ => {}
    }
    events
}

fn push_buttons(events: &mut Vec<DeviceEvent>, data: &[u8], profile: &DeviceProfile, serial: &str) {
    for i in 0..profile.button_count() {
        let pos = profile.key_data_offset + profile.hid_key_index(i) as usize;
        let Some(&b) = data.get(pos) else { continue };
        events.push(DeviceEvent::KeyPress { serial: serial.to_string(), index: i, pressed: b != 0 });
    }
}

/// Split `payload` into `packet_size` reports, writing a header into each via `header`
/// (args: packet, part index, is_last, body length).
fn chunk_packets(
    payload: &[u8],
    packet_size: usize,
    header_size: usize,
    header: impl Fn(&mut [u8], u16, bool, usize),
) -> Vec<Vec<u8>> {
    let max_payload = packet_size - header_size;
    payload.chunks(max_payload).enumerate().map(|(part, chunk)| {
        let mut packet = vec![0u8; packet_size];
        let is_last = (part + 1) * max_payload >= payload.len();
        header(&mut packet, part as u16, is_last, chunk.len());
        packet[header_size..header_size + chunk.len()].copy_from_slice(chunk);
        packet
    }).collect()
}

fn gen1_header(packet: &mut [u8], hid_key: u8, part: u16, is_last: bool) {
    packet[0] = 0x02;
    packet[1] = 0x01;
    packet[2..4].copy_from_slice(&part.to_le_bytes());
    packet[4] = is_last as u8;
    packet[5] = hid_key + 1;
}

/// Gen1 key image reports (BMP payload). `hid_key` is the device key index (already flipped for
/// right-to-left models).
pub fn gen1_key_packets(profile: &DeviceProfile, hid_key: u8, payload: &[u8]) -> Result<Vec<Vec<u8>>> {
    match profile.key_writer {
        KeyImageWriter::OriginalTwoPart => {
            let max_payload = ORIGINAL_PACKET_SIZE - GEN1_HEADER_SIZE;
            let half = payload.len() / 2;
            if payload.len() - half > max_payload {
                return Err(crate::Error::Device(format!("Image payload too large: {} bytes", payload.len())));
            }
            let mut packets = Vec::with_capacity(2);
            for (part, chunk) in [(1u16, &payload[..half]), (2u16, &payload[half..])] {
                let mut packet = vec![0u8; ORIGINAL_PACKET_SIZE];
                gen1_header(&mut packet, hid_key, part, part == 2);
                packet[GEN1_HEADER_SIZE..GEN1_HEADER_SIZE + chunk.len()].copy_from_slice(chunk);
                packets.push(packet);
            }
            Ok(packets)
        }
        KeyImageWriter::Chunked1024 => Ok(chunk_packets(payload, HID_PACKET_SIZE, GEN1_HEADER_SIZE, |p, part, last, _| {
            gen1_header(p, hid_key, part, last)
        })),
        KeyImageWriter::None => Err(crate::Error::Device(format!("{} has no key displays", profile.display_name))),
    }
}

/// Gen2 key image reports (JPEG payload): [0x02, 0x07, key, is_last, len16 LE, part16 LE].
pub fn gen2_key_packets(hid_key: u8, payload: &[u8]) -> Vec<Vec<u8>> {
    chunk_packets(payload, HID_PACKET_SIZE, GEN2_HEADER_SIZE, |p, part, last, len| {
        p[0] = 0x02;
        p[1] = 0x07;
        p[2] = hid_key;
        p[3] = last as u8;
        p[4..6].copy_from_slice(&(len as u16).to_le_bytes());
        p[6..8].copy_from_slice(&part.to_le_bytes());
    })
}

/// Stream Deck + touch strip reports: [0x02, 0x0c, x16, y16, w16, h16, is_last, part16, len16].
pub fn plus_lcd_packets(x: u16, y: u16, w: u16, h: u16, payload: &[u8]) -> Vec<Vec<u8>> {
    chunk_packets(payload, HID_PACKET_SIZE, PLUS_LCD_HEADER_SIZE, |p, part, last, len| {
        p[0] = 0x02;
        p[1] = 0x0c;
        p[2..4].copy_from_slice(&x.to_le_bytes());
        p[4..6].copy_from_slice(&y.to_le_bytes());
        p[6..8].copy_from_slice(&w.to_le_bytes());
        p[8..10].copy_from_slice(&h.to_le_bytes());
        p[10] = last as u8;
        p[11..13].copy_from_slice(&part.to_le_bytes());
        p[13..15].copy_from_slice(&(len as u16).to_le_bytes());
    })
}

/// Stream Deck Neo info screen reports: [0x02, 0x0b, 0, is_last, len16, part16].
pub fn neo_info_lcd_packets(payload: &[u8]) -> Vec<Vec<u8>> {
    chunk_packets(payload, HID_PACKET_SIZE, NEO_LCD_HEADER_SIZE, |p, part, last, len| {
        p[0] = 0x02;
        p[1] = 0x0b;
        p[2] = 0;
        p[3] = last as u8;
        p[4..6].copy_from_slice(&(len as u16).to_le_bytes());
        p[6..8].copy_from_slice(&part.to_le_bytes());
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::device::profile::profile_by_pid;

    fn p(pid: u16) -> &'static DeviceProfile { profile_by_pid(pid).unwrap() }

    fn pressed(events: &[DeviceEvent]) -> Vec<u8> {
        events.iter().filter_map(|e| match e {
            DeviceEvent::KeyPress { index, pressed: true, .. } => Some(*index),
            _ => None,
        }).collect()
    }

    #[test]
    fn v1_original_keys_rtl() {
        let prof = p(0x0060);
        // report id, then 15 key bytes in hid order; hid 0 is the top-right key.
        let mut buf = vec![0u8; 17];
        buf[0] = 0x01;
        buf[1] = 1; // hid 0 -> logical 4
        buf[1 + 7] = 1; // hid 7 -> logical 7 (centre)
        buf[1 + 10] = 1; // hid 10 -> logical 14
        let ev = parse_input_report(&buf, prof, "S");
        assert_eq!(ev.len(), 15);
        assert_eq!(pressed(&ev), vec![4, 7, 14]);
    }

    #[test]
    fn v1_mini_keys() {
        let prof = p(0x0063);
        let buf = [0x01, 0, 0, 1, 0, 0, 1, 0];
        assert_eq!(pressed(&parse_input_report(&buf, prof, "S")), vec![2, 5]);
        // Wrong report id is ignored
        assert!(parse_input_report(&[0x02, 1, 1], prof, "S").is_empty());
    }

    #[test]
    fn v2_keys() {
        let prof = p(0x0080);
        let mut buf = vec![0u8; 20];
        buf[0] = 0x01; buf[1] = 0x00; buf[2] = 15;
        buf[4] = 1; buf[4 + 14] = 1;
        let ev = parse_input_report(&buf, prof, "S");
        assert_eq!(ev.len(), 15);
        assert_eq!(pressed(&ev), vec![0, 14]);
    }

    #[test]
    fn neo_touch_buttons() {
        let prof = p(0x009a);
        let mut buf = vec![0u8; 16];
        buf[0] = 0x01;
        buf[4 + 9] = 1;
        let ev = parse_input_report(&buf, prof, "S");
        assert_eq!(ev.len(), 10);
        assert_eq!(pressed(&ev), vec![9]);
    }

    #[test]
    fn pedal_buttons() {
        let prof = p(0x0086);
        let buf = [0x01, 0x00, 0x03, 0x00, 0, 1, 0];
        assert_eq!(pressed(&parse_input_report(&buf, prof, "S")), vec![1]);
    }

    #[test]
    fn plus_keys_encoders_and_lcd() {
        let prof = p(0x0084);
        let s = "S".to_string();
        // keys
        let buf = [0x01, 0x00, 0x08, 0x00, 0, 0, 0, 0, 0, 0, 0, 1];
        assert_eq!(pressed(&parse_input_report(&buf, prof, "S")), vec![7]);
        // encoder press
        let buf = [0x01, 0x03, 0x05, 0x00, 0x00, 0, 1, 0, 0];
        let ev = parse_input_report(&buf, prof, "S");
        assert_eq!(ev.len(), 4);
        assert_eq!(ev[1], DeviceEvent::EncoderPress { serial: s.clone(), index: 1, pressed: true });
        // encoder rotate: enc0 +2, enc3 -1
        let buf = [0x01, 0x03, 0x05, 0x00, 0x01, 2, 0, 0, 0xff];
        let ev = parse_input_report(&buf, prof, "S");
        assert_eq!(ev, vec![
            DeviceEvent::EncoderRotate { serial: s.clone(), index: 0, delta: 2 },
            DeviceEvent::EncoderRotate { serial: s.clone(), index: 3, delta: -1 },
        ]);
        // LCD short press at (300, 50)
        let mut buf = vec![0x01, 0x02, 0x0e, 0x00, 0x01, 0x00];
        buf.extend_from_slice(&300u16.to_le_bytes());
        buf.extend_from_slice(&50u16.to_le_bytes());
        buf.extend_from_slice(&[0; 4]);
        assert_eq!(parse_input_report(&buf, prof, "S"), vec![DeviceEvent::LcdShortPress { serial: s.clone(), x: 300, y: 50 }]);
        // long press
        buf[4] = 0x02;
        assert_eq!(parse_input_report(&buf, prof, "S"), vec![DeviceEvent::LcdLongPress { serial: s.clone(), x: 300, y: 50 }]);
        // swipe 300,50 -> 700,40
        buf[4] = 0x03;
        buf[10..12].copy_from_slice(&700u16.to_le_bytes());
        buf[12..14].copy_from_slice(&40u16.to_le_bytes());
        assert_eq!(parse_input_report(&buf, prof, "S"), vec![DeviceEvent::LcdSwipe {
            serial: s, from_x: 300, from_y: 50, to_x: 700, to_y: 40,
        }]);
        // truncated touch report is ignored
        assert!(parse_input_report(&[0x01, 0x02, 0, 0, 1], prof, "S").is_empty());
    }

    #[test]
    fn original_key_packets() {
        let prof = p(0x0060);
        let payload: Vec<u8> = (0..54 + 72 * 72 * 3).map(|i| i as u8).collect();
        let packets = gen1_key_packets(prof, prof.hid_key_index(0), &payload).unwrap();
        assert_eq!(packets.len(), 2);
        assert!(packets.iter().all(|p| p.len() == 8191));
        assert_eq!(&packets[0][..6], &[0x02, 0x01, 0x01, 0x00, 0x00, 0x05]); // part 1, key hid 4 + 1
        assert_eq!(&packets[1][..6], &[0x02, 0x01, 0x02, 0x00, 0x01, 0x05]); // part 2, last
        let half = payload.len() / 2;
        assert_eq!(&packets[0][16..16 + half], &payload[..half]);
        assert_eq!(&packets[1][16..16 + half], &payload[half..]);
    }

    #[test]
    fn mini_key_packets() {
        let prof = p(0x0063);
        let payload = vec![0xabu8; 54 + 80 * 80 * 3];
        let packets = gen1_key_packets(prof, 2, &payload).unwrap();
        assert_eq!(packets.len(), payload.len().div_ceil(1008));
        assert!(packets.iter().all(|p| p.len() == 1024));
        assert_eq!(&packets[0][..6], &[0x02, 0x01, 0x00, 0x00, 0x00, 0x03]);
        let last = packets.last().unwrap();
        assert_eq!(u16::from_le_bytes([last[2], last[3]]) as usize, packets.len() - 1);
        assert_eq!(last[4], 1);
        assert_eq!(packets[packets.len() - 2][4], 0);
        let total: usize = packets.len() * 1008;
        assert!(total >= payload.len());
    }

    #[test]
    fn v2_key_packets() {
        let payload: Vec<u8> = (0..2500u32).map(|i| i as u8).collect();
        let packets = gen2_key_packets(7, &payload);
        assert_eq!(packets.len(), 3);
        assert_eq!(&packets[0][..8], &[0x02, 0x07, 7, 0, 0xf8, 0x03, 0, 0]); // 1016 bytes, part 0
        assert_eq!(&packets[1][..8], &[0x02, 0x07, 7, 0, 0xf8, 0x03, 1, 0]);
        assert_eq!(&packets[2][..8], &[0x02, 0x07, 7, 1, 0xd4, 0x01, 2, 0]); // 468 bytes, last
        assert_eq!(&packets[2][8..8 + 468], &payload[2032..]);
        // exact multiple: last flag on the final full chunk
        let packets = gen2_key_packets(0, &vec![1u8; 1016 * 2]);
        assert_eq!(packets.len(), 2);
        assert_eq!(packets[1][3], 1);
        assert_eq!(packets[0][3], 0);
    }

    #[test]
    fn lcd_packets() {
        let payload = vec![9u8; 1500];
        let packets = plus_lcd_packets(200, 0, 200, 100, &payload);
        assert_eq!(packets.len(), 2);
        assert_eq!(&packets[0][..16], &[0x02, 0x0c, 200, 0, 0, 0, 200, 0, 100, 0, 0, 0, 0, 0xf0, 0x03, 0]);
        assert_eq!(&packets[1][..16], &[0x02, 0x0c, 200, 0, 0, 0, 200, 0, 100, 0, 1, 1, 0, 0xec, 0x01, 0]);
        let packets = neo_info_lcd_packets(&payload);
        assert_eq!(packets.len(), 2);
        assert_eq!(&packets[0][..8], &[0x02, 0x0b, 0, 0, 0xf8, 0x03, 0, 0]);
        assert_eq!(&packets[1][..8], &[0x02, 0x0b, 0, 1, 0xe4, 0x01, 1, 0]);
    }

    #[test]
    fn fallback_serial_has_no_colon() {
        let s = fallback_serial(&CString::new("/dev/hidraw3").unwrap());
        assert_eq!(s, "path-dev-hidraw3");
        let mac = fallback_serial(&CString::new("DevSrvsID:4294970000").unwrap());
        assert_eq!(mac, "path-DevSrvsID-4294970000");
        assert!(!mac.contains(':'));
    }

    #[test]
    fn brightness_reports() {
        let v1 = brightness_report(p(0x0060), 150);
        assert_eq!(v1.len(), 17);
        assert_eq!(&v1[..6], &[0x05, 0x55, 0xaa, 0xd1, 0x01, 100]);
        let v2 = brightness_report(p(0x0084), 40);
        assert_eq!(v2.len(), 32);
        assert_eq!(&v2[..3], &[0x03, 0x08, 40]);
    }
}
