use crate::state::AppState;
use sd_core::device::profile::ImageFormat;
use sd_core::device::{DeviceManager, DeviceProfile};
use sd_core::image::{blank_key_image, decode_base64_image, encode_key_image, encode_lcd_image};
use serde::Serialize;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use tauri::{AppHandle, Emitter, State};

#[derive(Debug, Clone, Serialize)]
pub struct DeviceInfoDto {
    pub serial: String,
    pub model: String,
    pub model_id: String,
    pub columns: u8,
    pub rows: u8,
    /// Native key image size in pixels (kept for existing callers; same as key_pixel_size).
    pub key_size: u16,
    /// Native key image size in pixels (Plus = 120). 0 when keys have no display (Pedal).
    pub key_pixel_size: u16,
    /// Number of LCD keys (columns * rows).
    pub key_count: u8,
    /// Extra touch buttons reported as key indices key_count.. (Neo page buttons).
    pub touch_button_count: u8,
    /// False for models whose keys have no display (Pedal): skip key rendering.
    pub has_key_display: bool,
    /// "bmp" | "jpeg" | "none" — informational; encoding is done by the backend.
    pub image_format: String,
    pub has_lcd_strip: bool,
    pub has_dials: bool,
    pub encoder_count: u8,
    pub lcd_width: u16,
    pub lcd_height: u16,
    /// Non-touch info screen (Neo 248x58), written with send_lcd_image(x=0, y=0, w, h). 0 when absent.
    pub info_lcd_width: u16,
    pub info_lcd_height: u16,
    /// Changes whenever the backend (re)opens the device's HID handle (replug,
    /// USB reset, recovery after a failed read/write). The UI repaints the
    /// whole deck when it changes. 0 when the device is not open yet.
    pub open_generation: u64,
}

impl DeviceInfoDto {
    fn from_connected(dev: &sd_core::device::ConnectedDevice, open_generation: u64) -> Self {
        let p = dev.profile;
        Self {
            serial: dev.serial.clone(),
            model: p.display_name.to_string(),
            model_id: p.id.to_string(),
            columns: p.columns,
            rows: p.rows,
            key_size: p.key_pixel_size,
            key_pixel_size: p.key_pixel_size,
            key_count: p.key_count(),
            touch_button_count: p.touch_button_count,
            has_key_display: p.has_key_display(),
            image_format: match p.image_format {
                ImageFormat::Bmp => "bmp",
                ImageFormat::Jpeg => "jpeg",
                ImageFormat::None => "none",
            }.to_string(),
            has_lcd_strip: p.has_lcd_strip,
            has_dials: p.has_dials,
            encoder_count: p.encoder_count,
            lcd_width: p.lcd_strip_width,
            lcd_height: p.lcd_strip_height,
            info_lcd_width: p.info_lcd_width,
            info_lcd_height: p.info_lcd_height,
            open_generation,
        }
    }
}

/// Lock the device manager, recovering from a poisoned mutex (a panic elsewhere must not
/// disable every device command for the rest of the session).
fn lock(dm: &Mutex<DeviceManager>) -> MutexGuard<'_, DeviceManager> {
    dm.lock().unwrap_or_else(|e| e.into_inner())
}

/// Look up the open device's profile and release the lock, so image work runs unlocked.
fn open_profile(state: &AppState, serial: &str) -> Result<&'static DeviceProfile, String> {
    lock(&state.device_manager)
        .profile_for(serial)
        .ok_or_else(|| format!("Device {} not open", serial))
}

#[tauri::command(async)]
pub fn list_devices(state: State<AppState>) -> Result<Vec<DeviceInfoDto>, String> {
    let mut dm = lock(&state.device_manager);
    let devices = dm.enumerate().map_err(|e| e.to_string())?;
    Ok(devices.iter().map(|d| DeviceInfoDto::from_connected(d, dm.open_generation(&d.serial))).collect())
}

#[tauri::command(async)]
pub fn open_device(state: State<AppState>, serial: String) -> Result<(), String> {
    lock(&state.device_manager).open(&serial).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_device_info(state: State<AppState>, serial: String) -> Option<DeviceInfoDto> {
    let dm = lock(&state.device_manager);
    dm.get_device(&serial).map(|d| DeviceInfoDto::from_connected(d, dm.open_generation(&d.serial)))
}

#[tauri::command(async)]
pub fn send_rendered_image(state: State<AppState>, serial: String, key_index: u8, image_data: String) -> Result<(), String> {
    let prof = open_profile(&state, &serial)?;
    let raw = decode_base64_image(&image_data).map_err(|e| e.to_string())?;
    let payload = encode_key_image(&raw, prof).map_err(|e| e.to_string())?;
    lock(&state.device_manager).set_key_image(&serial, key_index, &payload).map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub fn clear_key(state: State<AppState>, serial: String, key_index: u8) -> Result<(), String> {
    let prof = open_profile(&state, &serial)?;
    let payload = blank_key_image(prof).map_err(|e| e.to_string())?;
    lock(&state.device_manager).set_key_image(&serial, key_index, &payload).map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub fn send_lcd_image(state: State<AppState>, serial: String, x: u16, y: u16, w: u16, h: u16, image_data: String) -> Result<(), String> {
    let prof = open_profile(&state, &serial)?;
    let raw = decode_base64_image(&image_data).map_err(|e| e.to_string())?;
    let jpeg = encode_lcd_image(&raw, w, h, prof.lcd_transform).map_err(|e| e.to_string())?;
    lock(&state.device_manager).set_lcd_image(&serial, x, y, w, h, &jpeg).map_err(|e| e.to_string())
}

/// Set the brightness (0-100) of one device.
#[tauri::command(async)]
pub fn set_brightness(state: State<AppState>, serial: String, percent: u8) -> Result<(), String> {
    lock(&state.device_manager).set_brightness(&serial, percent).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn start_key_listener(
    app: AppHandle,
    state: State<AppState>,
    running: State<Arc<AtomicBool>>,
) -> Result<(), String> {
    if running.swap(true, Ordering::SeqCst) { return Ok(()); }

    let dm = state.device_manager.clone();
    let flag = (*running).clone();

    std::thread::spawn(move || {
        // Per-device state keyed by serial (sized on demand, so any button count works).
        let mut prev_keys: HashMap<String, Vec<bool>> = HashMap::new();
        let mut prev_encoders: HashMap<String, Vec<bool>> = HashMap::new();

        fn changed(states: &mut Vec<bool>, index: u8, pressed: bool) -> bool {
            let i = index as usize;
            if states.len() <= i { states.resize(i + 1, false); }
            let was = states[i];
            states[i] = pressed;
            was != pressed
        }

        while flag.load(Ordering::Relaxed) {
            let events = match lock(&dm).read_input() {
                Ok(events) => events,
                Err(e) => {
                    tracing::warn!("Device input read failed: {}", e);
                    Vec::new()
                }
            };

            for event in &events {
                use sd_core::device::DeviceEvent;
                match event {
                    DeviceEvent::KeyPress { serial, index, pressed } => {
                        if changed(prev_keys.entry(serial.clone()).or_default(), *index, *pressed) {
                            tracing::debug!("[KEY] serial={} index={} pressed={}", serial, index, pressed);
                            let _ = app.emit("device-event", event);
                        }
                    }
                    DeviceEvent::EncoderPress { serial, index, pressed } => {
                        if changed(prev_encoders.entry(serial.clone()).or_default(), *index, *pressed) {
                            let _ = app.emit("device-event", event);
                        }
                    }
                    DeviceEvent::EncoderRotate { .. } |
                    DeviceEvent::LcdShortPress { .. } |
                    DeviceEvent::LcdLongPress { .. } |
                    DeviceEvent::LcdSwipe { .. } => {
                        let _ = app.emit("device-event", event);
                    }
                }
            }
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
    });
    Ok(())
}

#[tauri::command]
pub fn stop_key_listener(running: State<Arc<AtomicBool>>) -> Result<(), String> {
    running.store(false, Ordering::Relaxed);
    Ok(())
}
