use std::process::Command;

pub fn is_safe_url(url: &str) -> bool {
    url.starts_with("http://") || url.starts_with("https://")
}

#[tauri::command]
pub fn execute_action(action_type: String, settings: String) -> Result<(), String> {
    let settings: serde_json::Value = serde_json::from_str(&settings)
        .map_err(|e| format!("Invalid settings JSON: {}", e))?;

    if action_type == "multi-action" {
        let steps = settings.get("steps").and_then(|v| v.as_array()).cloned().unwrap_or_default();
        std::thread::spawn(move || {
            for step in &steps {
                let t = step.get("actionType").and_then(|v| v.as_str()).unwrap_or("");
                let s = step.get("settings").cloned().unwrap_or_default();
                let delay = step.get("delayMs").and_then(|v| v.as_u64()).unwrap_or(0);
                let _ = execute_single(t, &s);
                if delay > 0 { std::thread::sleep(std::time::Duration::from_millis(delay)); }
            }
        });
    } else {
        tracing::info!("Action: {} ", action_type);
        execute_single(&action_type, &settings)?;
    }

    Ok(())
}

fn execute_single(action_type: &str, s: &serde_json::Value) -> Result<(), String> {
    match action_type {
        "command" => {
            let cmd = s.get("command").and_then(|v| v.as_str()).unwrap_or("");
            if !cmd.is_empty() {
                run_shell_command(cmd)?;
            }
        }
        "hotkey" => {
            let key = s.get("key").and_then(|v| v.as_str()).unwrap_or("");
            let mods = s.get("modifiers").and_then(|v| v.as_str()).unwrap_or("");
            if !key.is_empty() {
                send_hotkey(key, mods)?;
            }
        }
        "launch" => {
            let t = s.get("target").and_then(|v| v.as_str()).unwrap_or("");
            if !t.is_empty() {
                launch_app(t)?;
            }
        }
        "open-url" => {
            let url = s.get("url").and_then(|v| v.as_str()).unwrap_or("");
            if !url.is_empty() && is_safe_url(url) {
                open_url(url)?;
            }
        }
        "http-request" => {
            let url = s.get("url").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let method = s.get("method").and_then(|v| v.as_str()).unwrap_or("POST").to_string();
            let headers = s.get("headers").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let body = s.get("body").and_then(|v| v.as_str()).unwrap_or("").to_string();
            if !url.is_empty() {
                std::thread::spawn(move || {
                    match execute_http(&url, &method, &headers, &body) {
                        Ok(st) => tracing::info!("HTTP {}: {}", method, st),
                        Err(e) => tracing::error!("HTTP failed: {}", e),
                    }
                });
            }
        }
        _ => {}
    }
    Ok(())
}

// ─── Cross-platform helpers ──────────────────────────────────

fn run_shell_command(cmd: &str) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        Command::new("cmd").args(["/C", cmd]).spawn().map_err(|e| e.to_string())?;
    }
    #[cfg(not(target_os = "windows"))]
    {
        Command::new("sh").arg("-c").arg(cmd).spawn().map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn launch_app(target: &str) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        Command::new("cmd").args(["/C", "start", "", target]).spawn().map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "macos")]
    {
        Command::new("open").arg(target).spawn().map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "linux")]
    {
        // Try the target as-is first (direct executable or shell command)
        Command::new("sh").arg("-c").arg(target).spawn().map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn open_url(url: &str) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        Command::new("cmd").args(["/C", "start", "", url]).spawn().map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "macos")]
    {
        Command::new("open").arg(url).spawn().map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "linux")]
    {
        Command::new("xdg-open").arg(url).spawn().map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn send_hotkey(key: &str, modifiers: &str) -> Result<(), String> {
    let combo = if modifiers.is_empty() {
        key.to_string()
    } else {
        format!("{}+{}", modifiers, key)
    };

    #[cfg(target_os = "linux")]
    {
        Command::new("xdotool").arg("key").arg(&combo).spawn().map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "macos")]
    {
        // Convert combo to osascript keystroke
        let script = build_applescript_keystroke(&combo);
        Command::new("osascript").arg("-e").arg(&script).spawn().map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "windows")]
    {
        // Use PowerShell SendKeys as a basic approach
        let ps_keys = combo_to_sendkeys(&combo);
        Command::new("powershell")
            .args(["-Command", &format!(
                "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('{}')",
                ps_keys
            )])
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn build_applescript_keystroke(combo: &str) -> String {
    let parts: Vec<&str> = combo.split('+').collect();
    let key = parts.last().unwrap_or(&"");
    let mods: Vec<&str> = if parts.len() > 1 { parts[..parts.len()-1].to_vec() } else { vec![] };

    let mut using = Vec::new();
    for m in &mods {
        match m.to_lowercase().as_str() {
            "ctrl" | "control" => using.push("control down"),
            "alt" | "option" => using.push("option down"),
            "shift" => using.push("shift down"),
            "super" | "cmd" | "command" => using.push("command down"),
            _ => {}
        }
    }

    if using.is_empty() {
        format!("tell application \"System Events\" to keystroke \"{}\"", key)
    } else {
        format!(
            "tell application \"System Events\" to keystroke \"{}\" using {{{}}}",
            key,
            using.join(", ")
        )
    }
}

#[cfg(target_os = "windows")]
fn combo_to_sendkeys(combo: &str) -> String {
    let parts: Vec<&str> = combo.split('+').collect();
    let key = parts.last().unwrap_or(&"");
    let mods: Vec<&str> = if parts.len() > 1 { parts[..parts.len()-1].to_vec() } else { vec![] };

    let mut prefix = String::new();
    for m in &mods {
        match m.to_lowercase().as_str() {
            "ctrl" | "control" => prefix.push('^'),
            "alt" => prefix.push('%'),
            "shift" => prefix.push('+'),
            _ => {}
        }
    }
    format!("{}{}", prefix, key)
}

fn execute_http(url: &str, method: &str, headers_str: &str, body: &str) -> Result<String, String> {
    let client = reqwest::blocking::Client::new();
    let mut b = match method {
        "GET" => client.get(url),
        "PUT" => client.put(url),
        "DELETE" => client.delete(url),
        _ => client.post(url),
    };
    for line in headers_str.lines() {
        if let Some((k, v)) = line.split_once(':') {
            let k = k.trim(); let v = v.trim();
            if !k.is_empty() { b = b.header(k, v); }
        }
    }
    if !body.is_empty() && method != "GET" {
        b = b.header("Content-Type", "application/json").body(body.to_string());
    }
    let resp = b.send().map_err(|e| e.to_string())?;
    Ok(resp.status().to_string())
}