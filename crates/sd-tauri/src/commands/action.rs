use std::process::Command;

pub fn is_safe_url(url: &str) -> bool {
    url.starts_with("http://") || url.starts_with("https://")
}

/// Execute a host-side action ("command", "hotkey", "launch", "open-url",
/// "http-request", "multi-action"). Unknown action types are an error.
#[tauri::command(async)]
pub fn execute_action(action_type: String, settings: String) -> Result<(), String> {
    let settings: serde_json::Value = serde_json::from_str(&settings)
        .map_err(|e| format!("Invalid settings JSON: {}", e))?;

    if action_type == "multi-action" {
        let steps = parse_multi_action_steps(&settings)?;
        // Reject unknown step types up front instead of failing silently later.
        for (t, _, _) in &steps {
            if !is_host_action(t) {
                return Err(format!("Unknown action type in multi-action step: {}", t));
            }
        }
        std::thread::spawn(move || {
            for (t, s, delay) in &steps {
                if let Err(e) = execute_single(t, s) {
                    tracing::error!("Multi-action step {} failed: {}", t, e);
                }
                if *delay > 0 { std::thread::sleep(std::time::Duration::from_millis(*delay)); }
            }
        });
    } else {
        tracing::info!("Action: {} ", action_type);
        execute_single(&action_type, &settings)?;
    }

    Ok(())
}

const HOST_ACTIONS: &[&str] = &["command", "hotkey", "launch", "open-url", "http-request"];

fn is_host_action(action_type: &str) -> bool {
    HOST_ACTIONS.contains(&action_type)
}

/// Parse multi-action steps: `settings.steps` may be an array or a JSON
/// string holding one (the UI's format). Each step names its action with
/// "actionId" (UI) or "actionType" and may carry "settings" and "delayMs".
fn parse_multi_action_steps(settings: &serde_json::Value) -> Result<Vec<(String, serde_json::Value, u64)>, String> {
    let steps = match settings.get("steps") {
        None | Some(serde_json::Value::Null) => return Ok(vec![]),
        Some(serde_json::Value::Array(a)) => a.clone(),
        Some(serde_json::Value::String(s)) if s.trim().is_empty() => return Ok(vec![]),
        Some(serde_json::Value::String(s)) => serde_json::from_str::<Vec<serde_json::Value>>(s)
            .map_err(|e| format!("Invalid multi-action steps JSON: {}", e))?,
        Some(_) => return Err("multi-action \"steps\" must be an array or a JSON string".into()),
    };
    steps.iter().map(|step| {
        let t = step.get("actionId").or_else(|| step.get("actionType"))
            .and_then(|v| v.as_str())
            .ok_or("multi-action step is missing \"actionId\"")?
            .to_string();
        let s = step.get("settings").cloned().unwrap_or_else(|| serde_json::json!({}));
        let delay = match step.get("delayMs") {
            Some(serde_json::Value::String(d)) => d.trim().parse().unwrap_or(0),
            Some(v) => v.as_u64().unwrap_or(0),
            None => 0,
        };
        Ok((t, s, delay))
    }).collect()
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
            if !url.is_empty() {
                if !is_safe_url(url) {
                    return Err(format!("Only http(s) URLs can be opened: {}", url));
                }
                open_url(url)?;
            }
        }
        "http-request" => {
            let url = s.get("url").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let method = s.get("method").and_then(|v| v.as_str()).unwrap_or("POST").to_string();
            let headers = s.get("headers").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let body = s.get("body").and_then(|v| v.as_str()).unwrap_or("").to_string();
            if !url.is_empty() {
                if !is_safe_url(&url) {
                    return Err(format!("Only http(s) URLs are allowed: {}", url));
                }
                let method = parse_http_method(&method)?;
                std::thread::spawn(move || {
                    match execute_http(&url, method.clone(), &headers, &body) {
                        Ok(st) => tracing::info!("HTTP {}: {}", method, st),
                        Err(e) => tracing::error!("HTTP {} failed: {}", method, e),
                    }
                });
            }
        }
        other => return Err(format!("Unknown action type: {}", other)),
    }
    Ok(())
}

// ─── Cross-platform helpers ──────────────────────────────────

/// `CREATE_NO_WINDOW` process creation flag (Win32).
#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// `Command::new` that opens no console window on Windows: release builds
/// are GUI-subsystem processes, so every console child (cmd, powershell)
/// would otherwise get a visible console of its own.
fn command(program: &str) -> Command {
    #[allow(unused_mut)]
    let mut c = Command::new(program);
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        c.creation_flags(CREATE_NO_WINDOW);
    }
    c
}

fn run_shell_command(cmd: &str) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        command("cmd").args(["/C", cmd]).spawn().map_err(|e| e.to_string())?;
    }
    #[cfg(not(target_os = "windows"))]
    {
        command("sh").arg("-c").arg(cmd).spawn().map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn launch_app(target: &str) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        command("cmd").args(["/C", "start", "", target]).spawn().map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "macos")]
    {
        command("open").arg(target).spawn().map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "linux")]
    {
        // Try the target as-is first (direct executable or shell command)
        command("sh").arg("-c").arg(target).spawn().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Open an http(s) URL in the default browser. Never goes through a shell:
/// on Windows `cmd /C start` would interpret `&`, `|` or `^` in the URL as
/// command separators, so the URL handler is invoked directly.
pub fn open_url(url: &str) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let arg = windows_url_arg(url);
        command("rundll32")
            .args(["url.dll,FileProtocolHandler", arg.as_str()])
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "macos")]
    {
        command("open").arg(url).spawn().map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "linux")]
    {
        command("xdg-open").arg(url).spawn().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Percent-encode the characters that would make Windows quote or split the
/// rundll32 argument (whitespace, `"`, control characters). They are not
/// valid unencoded in a URL anyway.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn windows_url_arg(url: &str) -> String {
    let mut out = String::with_capacity(url.len());
    for c in url.chars() {
        if c == '"' || c.is_whitespace() || c.is_control() {
            let mut buf = [0u8; 4];
            for b in c.encode_utf8(&mut buf).bytes() {
                out.push_str(&format!("%{:02X}", b));
            }
        } else {
            out.push(c);
        }
    }
    out
}

/// Normalise a modifier name to its xdotool keysym-style name.
fn normalize_modifier(m: &str) -> String {
    match m.to_ascii_lowercase().as_str() {
        "ctrl" | "control" | "ctl" => "ctrl".into(),
        "alt" | "option" | "opt" => "alt".into(),
        "shift" => "shift".into(),
        "super" | "win" | "windows" | "meta" | "cmd" | "command" => "super".into(),
        other => other.to_string(),
    }
}

/// Build a "+"-joined combo (xdotool syntax) from a key and a modifier list
/// written as "ctrl, shift", "ctrl+shift" or "ctrl shift".
pub fn build_hotkey_combo(key: &str, modifiers: &str) -> String {
    modifiers
        .split(|c: char| c == ',' || c == '+' || c.is_whitespace())
        .filter(|s| !s.is_empty())
        .map(normalize_modifier)
        .chain(std::iter::once(key.trim().to_string()))
        .collect::<Vec<_>>()
        .join("+")
}

fn send_hotkey(key: &str, modifiers: &str) -> Result<(), String> {
    let combo = build_hotkey_combo(key, modifiers);

    #[cfg(target_os = "linux")]
    {
        command("xdotool").arg("key").arg(&combo).spawn().map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "macos")]
    {
        // Convert combo to osascript keystroke
        let script = build_applescript_keystroke(&combo);
        command("osascript").arg("-e").arg(&script).spawn().map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "windows")]
    {
        // Use PowerShell SendKeys as a basic approach
        let ps_keys = combo_to_sendkeys(&combo);
        command("powershell")
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

fn parse_http_method(method: &str) -> Result<reqwest::Method, String> {
    let m = method.trim().to_ascii_uppercase();
    let m = if m.is_empty() { "POST".to_string() } else { m };
    reqwest::Method::from_bytes(m.as_bytes()).map_err(|_| format!("Invalid HTTP method: {}", method))
}

fn execute_http(url: &str, method: reqwest::Method, headers_str: &str, body: &str) -> Result<String, String> {
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;
    let sends_body = !body.is_empty() && method != reqwest::Method::GET && method != reqwest::Method::HEAD;
    let mut b = client.request(method, url);
    let mut has_content_type = false;
    for line in headers_str.lines() {
        if let Some((k, v)) = line.split_once(':') {
            let k = k.trim(); let v = v.trim();
            if !k.is_empty() {
                has_content_type |= k.eq_ignore_ascii_case("content-type");
                b = b.header(k, v);
            }
        }
    }
    if sends_body {
        if !has_content_type {
            b = b.header("Content-Type", "application/json");
        }
        b = b.body(body.to_string());
    }
    let resp = b.send().map_err(|e| e.to_string())?;
    Ok(resp.status().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hotkey_modifiers_accept_comma_plus_and_space_lists() {
        assert_eq!(build_hotkey_combo("F5", ""), "F5");
        assert_eq!(build_hotkey_combo("F5", "ctrl, shift"), "ctrl+shift+F5");
        assert_eq!(build_hotkey_combo("F5", "ctrl+shift"), "ctrl+shift+F5");
        assert_eq!(build_hotkey_combo("t", " Control  Alt "), "ctrl+alt+t");
        assert_eq!(build_hotkey_combo("l", "cmd,"), "super+l");
        assert_eq!(build_hotkey_combo("Delete", "ctrl,alt"), "ctrl+alt+Delete");
    }

    #[test]
    fn http_methods_are_not_rewritten() {
        assert_eq!(parse_http_method("patch").unwrap(), reqwest::Method::PATCH);
        assert_eq!(parse_http_method("GET").unwrap(), reqwest::Method::GET);
        assert_eq!(parse_http_method("").unwrap(), reqwest::Method::POST);
        assert!(parse_http_method("BAD METHOD").is_err());
    }

    #[test]
    fn windows_url_arg_encodes_quotes_and_whitespace_only() {
        assert_eq!(windows_url_arg("https://x.example/?a=1&b=2|c^d"), "https://x.example/?a=1&b=2|c^d");
        assert_eq!(windows_url_arg("https://x.example/a b\"c\td"), "https://x.example/a%20b%22c%09d");
    }

    #[test]
    fn unknown_actions_are_errors() {
        assert!(execute_action("no-such-action".into(), "{}".into()).unwrap_err().contains("Unknown action type"));
        // Empty settings for a known action are a no-op, not an error.
        assert!(execute_action("command".into(), "{}".into()).is_ok());
    }

    #[test]
    fn multi_action_steps_accept_ui_string_format() {
        let ui = serde_json::json!({ "steps": r#"[{"actionId":"open-url","actionLabel":"Open","settings":{"url":"https://x"},"delayMs":250}]"# });
        let steps = parse_multi_action_steps(&ui).unwrap();
        assert_eq!(steps.len(), 1);
        assert_eq!(steps[0].0, "open-url");
        assert_eq!(steps[0].1["url"], "https://x");
        assert_eq!(steps[0].2, 250);
        let arr = serde_json::json!({ "steps": [{"actionType":"command","settings":{"command":"true"}}] });
        assert_eq!(parse_multi_action_steps(&arr).unwrap()[0].0, "command");
        assert!(parse_multi_action_steps(&serde_json::json!({"steps":"[oops"})).is_err());
        assert!(execute_action("multi-action".into(), r#"{"steps":[{"actionId":"switch-scene"}]}"#.into()).is_err());
    }
}
