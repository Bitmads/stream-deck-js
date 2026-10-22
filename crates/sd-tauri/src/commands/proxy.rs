use base64::Engine;
use std::sync::OnceLock;
use std::time::Duration;

/// Largest image the proxy will fetch.
const MAX_IMAGE_BYTES: usize = 10 * 1024 * 1024;
const FETCH_TIMEOUT: Duration = Duration::from_secs(10);

fn client() -> Result<&'static reqwest::Client, String> {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    if let Some(c) = CLIENT.get() {
        return Ok(c);
    }
    let c = reqwest::Client::builder()
        .timeout(FETCH_TIMEOUT)
        .build()
        .map_err(|e| e.to_string())?;
    Ok(CLIENT.get_or_init(|| c))
}

/// Normalised `image/*` media type from a Content-Type header, if it is one.
fn image_media_type(content_type: &str) -> Option<String> {
    let mt = content_type.split(';').next().unwrap_or("").trim().to_ascii_lowercase();
    let valid = mt.starts_with("image/")
        && mt.len() > "image/".len()
        && mt.chars().all(|c| c.is_ascii_alphanumeric() || "/+-.".contains(c));
    valid.then_some(mt)
}

/// Fetch a remote image and return it as a `data:` URL (lets the UI draw
/// cross-origin images on a canvas without tainting it). http(s) only,
/// 10 s timeout, at most 10 MB, and the response must be `image/*` (or an
/// untyped body that sniffs as a known image format).
#[tauri::command]
pub async fn fetch_image_as_data_url(url: String) -> Result<String, String> {
    if !crate::commands::action::is_safe_url(&url) {
        return Err(format!("Only http(s) image URLs are supported: {}", url));
    }
    let mut resp = client()?.get(&url).send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("Image request failed: HTTP {}", resp.status()));
    }
    let content_type = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let declared = image_media_type(content_type);
    // Servers that send no type (or a generic one) get their bytes sniffed below.
    let generic = matches!(
        content_type.split(';').next().unwrap_or("").trim().to_ascii_lowercase().as_str(),
        "" | "application/octet-stream" | "binary/octet-stream"
    );
    if declared.is_none() && !generic {
        return Err(format!("Not an image (Content-Type: {:?})", content_type));
    }
    if resp.content_length().map(|n| n as usize > MAX_IMAGE_BYTES).unwrap_or(false) {
        return Err(format!("Image is larger than {} MB", MAX_IMAGE_BYTES / (1024 * 1024)));
    }

    let mut bytes = Vec::new();
    while let Some(chunk) = resp.chunk().await.map_err(|e| e.to_string())? {
        if bytes.len() + chunk.len() > MAX_IMAGE_BYTES {
            return Err(format!("Image is larger than {} MB", MAX_IMAGE_BYTES / (1024 * 1024)));
        }
        bytes.extend_from_slice(&chunk);
    }
    let media_type = match declared {
        Some(mt) => mt,
        None => image::guess_format(&bytes)
            .map(|f| f.to_mime_type().to_string())
            .map_err(|_| "Response is not a recognised image".to_string())?,
    };
    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Ok(format!("data:{};base64,{}", media_type, b64))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_image_content_types_pass() {
        assert_eq!(image_media_type("image/png").as_deref(), Some("image/png"));
        assert_eq!(image_media_type("Image/SVG+XML; charset=utf-8").as_deref(), Some("image/svg+xml"));
        assert_eq!(image_media_type("text/html"), None);
        assert_eq!(image_media_type("image/"), None);
        assert_eq!(image_media_type("image/png\"><script>"), None);
        assert_eq!(image_media_type(""), None);
    }
}
