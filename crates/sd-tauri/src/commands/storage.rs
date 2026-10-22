/// Simple raw JSON file storage for frontend state.
/// Files are stored at ~/.config/open-stream-deck/<filename>.json

#[tauri::command]
pub fn save_json_file(filename: String, content: String) -> Result<(), String> {
    let dir = config_dir()?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(format!("{}.json", sanitize_filename(&filename)));
    std::fs::write(&path, &content).map_err(|e| e.to_string())?;
    tracing::info!("Saved {} ({} bytes)", path.display(), content.len());
    Ok(())
}

#[tauri::command]
pub fn load_json_file(filename: String) -> Result<Option<String>, String> {
    let dir = config_dir()?;
    let path = dir.join(format!("{}.json", sanitize_filename(&filename)));
    if !path.exists() {
        return Ok(None);
    }
    let content = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    Ok(Some(content))
}

#[tauri::command]
pub fn list_json_files() -> Result<Vec<String>, String> {
    let dir = config_dir()?;
    if !dir.exists() { return Ok(vec![]); }
    let mut files = vec![];
    for entry in std::fs::read_dir(&dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if path.extension().map(|e| e == "json").unwrap_or(false) {
            if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) {
                files.push(stem.to_string());
            }
        }
    }
    Ok(files)
}

#[tauri::command]
pub fn delete_json_file(filename: String) -> Result<(), String> {
    let dir = config_dir()?;
    let path = dir.join(format!("{}.json", sanitize_filename(&filename)));
    if path.exists() {
        std::fs::remove_file(&path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn config_dir() -> Result<std::path::PathBuf, String> {
    let base = dirs::config_dir().ok_or("Could not determine config directory")?;
    Ok(base.join("open-stream-deck"))
}

fn sanitize_filename(name: &str) -> String {
    name.chars().map(|c| if c.is_alphanumeric() || c == '-' || c == '_' { c } else { '_' }).collect()
}
