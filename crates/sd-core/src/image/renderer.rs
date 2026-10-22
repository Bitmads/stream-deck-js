//! Device-native image encoding. Rendering happens in the frontend canvas; this module turns
//! the rendered PNG/JPEG into the exact payload a given Stream Deck model expects.
//!
//! Reference: @elgato-stream-deck/core packages/core/src/util.ts (`transformImageBuffer`,
//! `writeBMPHeader`), services/imagePacker/{bitmap,jpeg}.ts.

use crate::device::profile::{DeviceProfile, ImageFormat, PixelTransform};
use crate::Result;
use image::{DynamicImage, RgbImage};
use std::io::Cursor;

/// Upstream default JPEG quality (node_modules/elgato-stream-deck/dist/jpeg.js DEFAULT_QUALITY).
const JPEG_QUALITY: u8 = 95;
pub const BMP_HEADER_LENGTH: usize = 54;

/// Decode a base64 data URL (e.g. "data:image/jpeg;base64,...") to raw image bytes.
pub fn decode_base64_image(data_url: &str) -> Result<Vec<u8>> {
    let base64_data = data_url.find(',').map(|i| &data_url[i + 1..]).unwrap_or(data_url);
    use base64::Engine;
    base64::engine::general_purpose::STANDARD
        .decode(base64_data)
        .map_err(|e| crate::Error::Image(format!("Invalid base64: {}", e)))
}

/// Decode an encoded image (PNG/JPEG), resize it to the model's key size and encode it in the
/// model's native key format (BMP for gen1, JPEG for gen2) with the model's pixel transform.
pub fn encode_key_image(raw_bytes: &[u8], profile: &DeviceProfile) -> Result<Vec<u8>> {
    ensure_key_display(profile)?;
    let img = image::load_from_memory(raw_bytes)
        .map_err(|e| crate::Error::Image(format!("Invalid image: {}", e)))?;
    let size = profile.key_pixel_size as u32;
    let rgb = resize_rgb(&img, size, size);
    encode_key_rgb(&rgb, profile)
}

/// A black key image in the model's native format.
pub fn blank_key_image(profile: &DeviceProfile) -> Result<Vec<u8>> {
    ensure_key_display(profile)?;
    let size = profile.key_pixel_size as u32;
    encode_key_rgb(&RgbImage::new(size, size), profile)
}

/// Decode an encoded image, resize it to `width`x`height` and JPEG-encode it with `transform`
/// (LCD strip on the Plus, info screen on the Neo).
pub fn encode_lcd_image(raw_bytes: &[u8], width: u16, height: u16, transform: PixelTransform) -> Result<Vec<u8>> {
    if width == 0 || height == 0 {
        return Err(crate::Error::Image("LCD region must not be empty".into()));
    }
    let img = image::load_from_memory(raw_bytes)
        .map_err(|e| crate::Error::Image(format!("Invalid image: {}", e)))?;
    let rgb = resize_rgb(&img, width as u32, height as u32);
    encode_jpeg(&transform_rgb(&rgb, transform))
}

fn ensure_key_display(profile: &DeviceProfile) -> Result<()> {
    if profile.has_key_display() {
        Ok(())
    } else {
        Err(crate::Error::Image(format!("{} has no key displays", profile.display_name)))
    }
}

fn resize_rgb(img: &DynamicImage, width: u32, height: u32) -> RgbImage {
    if img.width() == width && img.height() == height {
        img.to_rgb8()
    } else {
        img.resize_exact(width, height, image::imageops::FilterType::Lanczos3).to_rgb8()
    }
}

fn encode_key_rgb(rgb: &RgbImage, profile: &DeviceProfile) -> Result<Vec<u8>> {
    let transformed = transform_rgb(rgb, profile.key_transform);
    match profile.image_format {
        ImageFormat::Jpeg => encode_jpeg(&transformed),
        ImageFormat::Bmp => Ok(encode_bmp(&transformed, profile.bmp_ppm)),
        ImageFormat::None => Err(crate::Error::Image(format!("{} has no key displays", profile.display_name))),
    }
}

/// Port of upstream `transformImageBuffer`: target pixel (x, y) reads source pixel (x2, y2) where
/// x2/y2 are the optionally flipped coordinates, swapped when `rotate` is set.
pub fn transform_rgb(src: &RgbImage, t: PixelTransform) -> RgbImage {
    if t == PixelTransform::NONE {
        return src.clone();
    }
    let (w, h) = (src.width(), src.height());
    let (tw, th) = if t.rotate { (h, w) } else { (w, h) };
    let mut out = RgbImage::new(tw, th);
    for y in 0..th {
        for x in 0..tw {
            let mut x2 = if t.x_flip { tw - x - 1 } else { x };
            let mut y2 = if t.y_flip { th - y - 1 } else { y };
            if t.rotate {
                std::mem::swap(&mut x2, &mut y2);
            }
            out.put_pixel(x, y, *src.get_pixel(x2, y2));
        }
    }
    out
}

/// 24-bit BGR bitmap: 54-byte header (BITMAPFILEHEADER + BITMAPINFOHEADER, positive height)
/// followed by rows in buffer order, exactly as upstream `BitmapButtonLcdImagePacker` +
/// `writeBMPHeader` produce them (no row padding: key sizes 72/80 are multiples of 4).
pub fn encode_bmp(img: &RgbImage, ppm: i32) -> Vec<u8> {
    let (w, h) = (img.width(), img.height());
    let image_bytes = (w * h * 3) as usize;
    let mut buf = Vec::with_capacity(BMP_HEADER_LENGTH + image_bytes);
    buf.extend_from_slice(b"BM");
    buf.extend_from_slice(&((image_bytes + BMP_HEADER_LENGTH) as u32).to_le_bytes());
    buf.extend_from_slice(&0i16.to_le_bytes());
    buf.extend_from_slice(&0i16.to_le_bytes());
    buf.extend_from_slice(&(BMP_HEADER_LENGTH as u32).to_le_bytes());
    buf.extend_from_slice(&40u32.to_le_bytes()); // DIB header size
    buf.extend_from_slice(&(w as i32).to_le_bytes());
    buf.extend_from_slice(&(h as i32).to_le_bytes());
    buf.extend_from_slice(&1i16.to_le_bytes()); // colour planes
    buf.extend_from_slice(&24i16.to_le_bytes()); // bit depth
    buf.extend_from_slice(&0i32.to_le_bytes()); // compression
    buf.extend_from_slice(&(image_bytes as i32).to_le_bytes());
    buf.extend_from_slice(&ppm.to_le_bytes());
    buf.extend_from_slice(&ppm.to_le_bytes());
    buf.extend_from_slice(&0i32.to_le_bytes()); // palette size
    buf.extend_from_slice(&0i32.to_le_bytes()); // important colours
    for p in img.pixels() {
        buf.extend_from_slice(&[p[2], p[1], p[0]]);
    }
    buf
}

fn encode_jpeg(img: &RgbImage) -> Result<Vec<u8>> {
    let mut buf = Cursor::new(Vec::new());
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut buf, JPEG_QUALITY)
        .encode_image(img)
        .map_err(|e| crate::Error::Image(format!("JPEG encode failed: {}", e)))?;
    Ok(buf.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::device::profile::profile_by_pid;

    fn png(w: u32, h: u32) -> Vec<u8> {
        let img = RgbImage::from_fn(w, h, |x, y| image::Rgb([x as u8, y as u8, 7]));
        let mut out = Cursor::new(Vec::new());
        DynamicImage::ImageRgb8(img).write_to(&mut out, image::ImageFormat::Png).unwrap();
        out.into_inner()
    }

    #[test]
    fn bmp_sizes_and_header() {
        let orig = profile_by_pid(0x0060).unwrap();
        let bmp = encode_key_image(&png(72, 72), orig).unwrap();
        assert_eq!(bmp.len(), 54 + 72 * 72 * 3);
        assert_eq!(&bmp[0..2], b"BM");
        assert_eq!(u32::from_le_bytes(bmp[2..6].try_into().unwrap()), 54 + 15552);
        assert_eq!(i32::from_le_bytes(bmp[18..22].try_into().unwrap()), 72);
        assert_eq!(i32::from_le_bytes(bmp[22..26].try_into().unwrap()), 72);
        assert_eq!(i16::from_le_bytes(bmp[28..30].try_into().unwrap()), 24);
        assert_eq!(i32::from_le_bytes(bmp[38..42].try_into().unwrap()), 3780);

        let mini = profile_by_pid(0x0063).unwrap();
        let bmp = blank_key_image(mini).unwrap();
        assert_eq!(bmp.len(), 54 + 80 * 80 * 3);
        assert_eq!(i32::from_le_bytes(bmp[38..42].try_into().unwrap()), 2835);
    }

    #[test]
    fn bmp_pixels_are_bgr_and_transformed() {
        // Original: xFlip. Target (0,0) = source (71,0) -> R=71, G=0, B=7, stored as BGR.
        let orig = profile_by_pid(0x0060).unwrap();
        let bmp = encode_key_image(&png(72, 72), orig).unwrap();
        assert_eq!(&bmp[54..57], &[7, 0, 71]);
        // Mini: rotate+yFlip. Target (x,y) = source (79-y, x); target (0,0) = source (79,0).
        let mini = profile_by_pid(0x0063).unwrap();
        let bmp = encode_key_image(&png(80, 80), mini).unwrap();
        assert_eq!(&bmp[54..57], &[7, 0, 79]);
        // Target (1,0) = source (79,1)
        assert_eq!(&bmp[57..60], &[7, 1, 79]);
    }

    #[test]
    fn transform_matches_upstream() {
        let src = RgbImage::from_fn(3, 2, |x, y| image::Rgb([x as u8, y as u8, 0]));
        let r = transform_rgb(&src, PixelTransform::ROTATE_180);
        assert_eq!(r.get_pixel(0, 0).0, [2, 1, 0]);
        let r = transform_rgb(&src, PixelTransform::ROTATE_Y_FLIP);
        assert_eq!(r.dimensions(), (2, 3));
        // target (x,y): x2 = x, y2 = 2-y, swapped -> source (2-y, x)
        assert_eq!(r.get_pixel(0, 0).0, [2, 0, 0]);
        assert_eq!(r.get_pixel(1, 2).0, [0, 1, 0]);
    }

    #[test]
    fn jpeg_key_and_lcd() {
        let plus = profile_by_pid(0x0084).unwrap();
        let jpg = encode_key_image(&png(96, 96), plus).unwrap();
        assert_eq!(&jpg[0..2], &[0xff, 0xd8]);
        let decoded = image::load_from_memory(&jpg).unwrap();
        assert_eq!((decoded.width(), decoded.height()), (120, 120));

        let lcd = encode_lcd_image(&png(800, 100), 200, 100, PixelTransform::NONE).unwrap();
        let decoded = image::load_from_memory(&lcd).unwrap();
        assert_eq!((decoded.width(), decoded.height()), (200, 100));
    }

    #[test]
    fn pedal_has_no_key_images() {
        let pedal = profile_by_pid(0x0086).unwrap();
        assert!(encode_key_image(&png(10, 10), pedal).is_err());
        assert!(blank_key_image(pedal).is_err());
    }
}
