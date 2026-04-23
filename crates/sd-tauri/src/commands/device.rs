use crate::state::AppState;
use sd_core::image::{decode_base64_image, encode_image_for_device, create_blank_jpeg};
use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};

#[derive(Debug, Clone, Serialize)]
pub struct DeviceInfoDto {
    pub serial: String,
    pub model: String,
    pub model_id: String,
    pub columns: u8,
    pub rows: u8,
    pub key_size: u16,
    pub has_lcd_strip: bool,
    pub has_dials: bool,
    pub encoder_count: u8,
    pub lcd_width: u16,
    pub lcd_height: u16,
}

impl DeviceInfoDto {
    fn from_connected(dev: &sd_core::device::ConnectedDevice) -> Self {
        let p = dev.profile;
        Self {
            serial: dev.serial.clone(),
            model: p.display_name.to_string(),
            model_id: p.id.to_string(),
            columns: p.columns,
            rows: p.rows,
            key_size: p.key_pixel_size,
            has_lcd_strip: p.has_lcd_strip,
            has_dials: p.has_dials,
            encoder_count: p.encoder_count,
            lcd_width: p.lcd_strip_width,
            lcd_height: p.lcd_strip_height,
        }
    }
}

#[tauri::command]
pub fn list_devices(state: State<AppState>) -> Result<Vec<DeviceInfoDto>, String> {
    let mut mgr = state.device_manager.lock().map_err(|e| e.to_string())?;
    let devices = mgr.enumerate().map_err(|e| e.to_string())?;
    Ok(devices.iter().map(DeviceInfoDto::from_connected).collect())
}

#[tauri::command]
pub fn open_device(state: State<AppState>, serial: String) -> Result<(), String> {
    let mut mgr = state.device_manager.lock().map_err(|e| e.to_string())?;
    mgr.open(&serial).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_device_info(state: State<AppState>, serial: String) -> Option<DeviceInfoDto> {
    let mgr = state.device_manager.lock().ok()?;
    mgr.get_device(&serial).map(DeviceInfoDto::from_connected)
}

#[tauri::command]
pub fn send_rendered_image(state: State<AppState>, serial: String, key_index: u8, image_data: String) -> Result<(), String> {
    let mgr = state.device_manager.lock().map_err(|e| e.to_string())?;
    let prof = mgr.profile_for(&serial).ok_or("Device not open")?;
    let raw = decode_base64_image(&image_data).map_err(|e| e.to_string())?;
    let jpeg = encode_image_for_device(&raw, prof.key_pixel_size as u32, prof.rotate_image).map_err(|e| e.to_string())?;
    mgr.set_key_image(&serial, key_index, &jpeg).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn clear_key(state: State<AppState>, serial: String, key_index: u8) -> Result<(), String> {
    let mgr = state.device_manager.lock().map_err(|e| e.to_string())?;
    let prof = mgr.profile_for(&serial).ok_or("Device not open")?;
    let jpeg = create_blank_jpeg(prof.key_pixel_size as u32).map_err(|e| e.to_string())?;
    mgr.set_key_image(&serial, key_index, &jpeg).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn send_lcd_image(state: State<AppState>, serial: String, x: u16, y: u16, w: u16, h: u16, image_data: String) -> Result<(), String> {
    let mgr = state.device_manager.lock().map_err(|e| e.to_string())?;
    let raw = decode_base64_image(&image_data).map_err(|e| e.to_string())?;
    let img = image::load_from_memory(&raw).map_err(|e| format!("Invalid image: {}", e))?;
    let resized = img.resize_exact(w as u32, h as u32, image::imageops::FilterType::Lanczos3);
    let rgb = resized.to_rgb8();
    let mut jpeg_buf = std::io::Cursor::new(Vec::new());
    rgb.write_to(&mut jpeg_buf, image::ImageFormat::Jpeg).map_err(|e| format!("JPEG: {}", e))?;
    mgr.set_lcd_image(&serial, x, y, w, h, &jpeg_buf.into_inner()).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn set_brightness(state: State<AppState>, percent: u8) -> Result<(), String> {
    let mgr = state.device_manager.lock().map_err(|e| e.to_string())?;
    mgr.set_brightness(percent).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn start_key_listener(
    app: AppHandle,
    state: State<AppState>,
    running: State<Arc<AtomicBool>>,
) -> Result<(), String> {
    if running.load(Ordering::Relaxed) { return Ok(()); }
    running.store(true, Ordering::Relaxed);

    let dm = state.device_manager.clone();
    let flag = (*running).clone();

    std::thread::spawn(move || {
        // Per-device state keyed by serial
        let mut prev_keys: HashMap<String, Vec<bool>> = HashMap::new();
        let mut prev_encoders: HashMap<String, Vec<bool>> = HashMap::new();

        while flag.load(Ordering::Relaxed) {
            let events = dm.lock().ok()
                .and_then(|m| m.read_input().ok())
                .unwrap_or_default();

            for event in &events {
                use sd_core::device::DeviceEvent;
                match event {
                    DeviceEvent::KeyPress { serial, index, pressed } => {
                        let keys = prev_keys.entry(serial.clone()).or_insert_with(|| vec![false; 32]);
                        let was = keys.get(*index as usize).copied().unwrap_or(false);
                        if *pressed != was {
                            if let Some(s) = keys.get_mut(*index as usize) { *s = *pressed; }
                            let _ = app.emit("device-event", event);
                        }
                    }
                    DeviceEvent::EncoderPress { serial, index, pressed } => {
                        let encs = prev_encoders.entry(serial.clone()).or_insert_with(|| vec![false; 8]);
                        let was = encs.get(*index as usize).copied().unwrap_or(false);
                        if *pressed != was {
                            if let Some(s) = encs.get_mut(*index as usize) { *s = *pressed; }
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

use std::collections::HashMap;
