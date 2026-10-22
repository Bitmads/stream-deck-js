use crate::Result;
use image::DynamicImage;
use std::io::Cursor;

/// Decode a base64 data URL (e.g. "data:image/jpeg;base64,...") to raw image bytes.
pub fn decode_base64_image(data_url: &str) -> Result<Vec<u8>> {
    let base64_data = data_url.find(",").map(|i| &data_url[i + 1..]).unwrap_or(data_url);
    use base64::Engine;
    base64::engine::general_purpose::STANDARD
        .decode(base64_data)
        .map_err(|e| crate::Error::Image(format!("Invalid base64: {}", e)))
}

/// Take raw image bytes, resize to target dimensions, optionally rotate 180°, encode as JPEG.
pub fn encode_image_for_device(raw_bytes: &[u8], size: u32, rotate: bool) -> Result<Vec<u8>> {
    let img = image::load_from_memory(raw_bytes)
        .map_err(|e| crate::Error::Image(format!("Invalid image: {}", e)))?;
    let resized = img.resize_exact(size, size, image::imageops::FilterType::Lanczos3);
    if rotate {
        encode_jpeg(&resized.rotate180())
    } else {
        encode_jpeg(&resized)
    }
}

/// Create a blank (black) JPEG at the given size, rotated for the device.
pub fn create_blank_jpeg(size: u32) -> Result<Vec<u8>> {
    let img = DynamicImage::ImageRgb8(
        image::ImageBuffer::from_pixel(size, size, image::Rgb([0, 0, 0]))
    );
    encode_jpeg(&img)
}

fn encode_jpeg(img: &DynamicImage) -> Result<Vec<u8>> {
    let rgb = img.to_rgb8();
    let mut buf = Cursor::new(Vec::new());
    rgb.write_to(&mut buf, image::ImageFormat::Jpeg)
        .map_err(|e| crate::Error::Image(format!("JPEG encode failed: {}", e)))?;
    Ok(buf.into_inner())
}
