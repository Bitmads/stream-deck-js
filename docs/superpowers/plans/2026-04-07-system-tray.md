# System Tray & Background Operation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Open Stream Deck run as a background tray app — close hides to tray, optional start-on-boot and start-minimized, with settings UI.

**Architecture:** Rust backend builds the tray icon + menu in Tauri's `.setup()` hook and intercepts `CloseRequested` to hide the window. An `AtomicBool` controls hide-vs-quit at runtime. The autostart plugin handles OS-level login items. Frontend gets a new General section in Settings with three toggles.

**Tech Stack:** Tauri v2 tray API, `tauri-plugin-autostart`, Svelte 5 runes, existing JSON file storage.

**Spec:** `docs/superpowers/specs/2026-04-07-system-tray-design.md`

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `crates/sd-tauri/Cargo.toml` | Modify | Add `tauri-plugin-autostart` dependency |
| `crates/sd-tauri/tauri.conf.json` | Modify | Set window `visible: false`, add autostart plugin |
| `crates/sd-tauri/capabilities/default.json` | Modify | Add autostart permissions |
| `crates/sd-tauri/src/state.rs` | Modify | Add `minimize_to_tray: AtomicBool` to `AppState` |
| `crates/sd-tauri/src/commands/app_settings.rs` | Create | `set_minimize_to_tray` + `get_app_settings` commands |
| `crates/sd-tauri/src/commands/mod.rs` | Modify | Add `pub mod app_settings;` |
| `crates/sd-tauri/src/main.rs` | Modify | Tray builder, close interception, settings loading, autostart plugin, new commands |
| `packages/ui/package.json` | Modify | Add `@tauri-apps/plugin-autostart` dependency |
| `packages/ui/src/pages/Settings.svelte` | Modify | Add General section with three toggles |

---

## Task 1: Add Dependencies

**Files:**
- Modify: `crates/sd-tauri/Cargo.toml:24-25`
- Modify: `packages/ui/package.json:16-17`

- [ ] **Step 1: Add Rust autostart plugin dependency**

In `crates/sd-tauri/Cargo.toml`, add after line 25 (`tauri-plugin-shell = "2"`):

```toml
tauri-plugin-autostart = "2"
```

- [ ] **Step 2: Add frontend autostart JS bindings**

In `packages/ui/package.json`, add to `dependencies` after the `@tauri-apps/plugin-shell` line:

```json
"@tauri-apps/plugin-autostart": "^2.0.0",
```

- [ ] **Step 3: Install dependencies**

Run:
```bash
cd /media/nvme4tb/DEV/stream-deck-js && pnpm install
```
Expected: lockfile updated, no errors.

- [ ] **Step 4: Verify Rust compiles**

Run:
```bash
cd /media/nvme4tb/DEV/stream-deck-js/crates/sd-tauri && cargo check
```
Expected: compiles successfully (warnings OK).

- [ ] **Step 5: Commit**

```bash
git add crates/sd-tauri/Cargo.toml packages/ui/package.json pnpm-lock.yaml Cargo.lock
git commit -m "deps: add tauri-plugin-autostart for system tray feature"
```

---

## Task 2: Configure Tauri — Window Visibility, Autostart Plugin, Permissions

**Files:**
- Modify: `crates/sd-tauri/tauri.conf.json:14-23`
- Modify: `crates/sd-tauri/tauri.conf.json:42-46`
- Modify: `crates/sd-tauri/capabilities/default.json:5-8`

- [ ] **Step 1: Set window to hidden by default**

In `crates/sd-tauri/tauri.conf.json`, inside the window object (line 14-23), add `"visible": false` so the app doesn't flash a window on startup. The setup hook will show it unless start-minimized is on.

Change:

```json
    "windows": [
      {
        "title": "Open Stream Deck",
        "width": 1200,
        "height": 800,
        "minWidth": 900,
        "minHeight": 600,
        "resizable": true,
        "center": true
      }
    ],
```

To:

```json
    "windows": [
      {
        "title": "Open Stream Deck",
        "width": 1200,
        "height": 800,
        "minWidth": 900,
        "minHeight": 600,
        "resizable": true,
        "center": true,
        "visible": false
      }
    ],
```

- [ ] **Step 2: Add tray tooltip**

In `crates/sd-tauri/tauri.conf.json`, update the tray config (lines 25-28):

```json
    "trayIcon": {
      "iconPath": "icons/icon.png",
      "iconAsTemplate": true,
      "tooltip": "Open Stream Deck"
    },
```

- [ ] **Step 3: Add autostart plugin config**

In `crates/sd-tauri/tauri.conf.json`, add to the `plugins` object (after the `shell` entry at line 43-45):

```json
  "plugins": {
    "shell": {
      "open": true
    },
    "autostart": {
      "macOSLauncher": "LaunchAgent"
    }
  }
```

- [ ] **Step 4: Add autostart permissions to capabilities**

Replace `crates/sd-tauri/capabilities/default.json` with:

```json
{
  "identifier": "default",
  "description": "Default capabilities for Open Stream Deck",
  "windows": ["main"],
  "permissions": [
    "core:default",
    "shell:allow-open",
    "autostart:allow-enable",
    "autostart:allow-disable",
    "autostart:allow-is-enabled"
  ]
}
```

- [ ] **Step 5: Verify Rust compiles**

Run:
```bash
cd /media/nvme4tb/DEV/stream-deck-js/crates/sd-tauri && cargo check
```
Expected: compiles successfully.

- [ ] **Step 6: Commit**

```bash
git add crates/sd-tauri/tauri.conf.json crates/sd-tauri/capabilities/default.json
git commit -m "config: set window hidden by default, add autostart plugin and permissions"
```

---

## Task 3: Add `minimize_to_tray` Flag to AppState

**Files:**
- Modify: `crates/sd-tauri/src/state.rs:1-30`

- [ ] **Step 1: Add AtomicBool field to AppState**

Replace the full contents of `crates/sd-tauri/src/state.rs` with:

```rust
use sd_core::device::DeviceManager;
use sd_core::profile::ProfileStore;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use tokio::sync::broadcast;

#[derive(Clone, Debug, serde::Serialize)]
pub struct VarChangeEvent {
    pub name: String,
    pub value: String,
}

pub struct AppState {
    pub profile_store: Arc<RwLock<ProfileStore>>,
    pub device_manager: Arc<Mutex<DeviceManager>>,
    pub variables: Arc<Mutex<HashMap<String, String>>>,
    pub var_tx: broadcast::Sender<VarChangeEvent>,
    pub minimize_to_tray: Arc<AtomicBool>,
}

impl AppState {
    pub fn new() -> Self {
        let (var_tx, _) = broadcast::channel(64);
        Self {
            profile_store: Arc::new(RwLock::new(ProfileStore::new())),
            device_manager: Arc::new(Mutex::new(DeviceManager::new())),
            variables: Arc::new(Mutex::new(HashMap::new())),
            var_tx,
            minimize_to_tray: Arc::new(AtomicBool::new(true)), // default: on
        }
    }

    pub fn should_minimize_to_tray(&self) -> bool {
        self.minimize_to_tray.load(Ordering::Relaxed)
    }

    pub fn set_minimize_to_tray(&self, enabled: bool) {
        self.minimize_to_tray.store(enabled, Ordering::Relaxed);
    }
}
```

- [ ] **Step 2: Verify it compiles**

Run:
```bash
cd /media/nvme4tb/DEV/stream-deck-js/crates/sd-tauri && cargo check
```
Expected: compiles (there's an existing `AtomicBool` in main.rs managed state — that's for the key listener, separate concern).

- [ ] **Step 3: Commit**

```bash
git add crates/sd-tauri/src/state.rs
git commit -m "feat: add minimize_to_tray flag to AppState"
```

---

## Task 4: Create App Settings Commands

**Files:**
- Create: `crates/sd-tauri/src/commands/app_settings.rs`
- Modify: `crates/sd-tauri/src/commands/mod.rs`

- [ ] **Step 1: Create app_settings.rs**

Create `crates/sd-tauri/src/commands/app_settings.rs`:

```rust
use crate::state::AppState;
use tauri::State;

/// Called from frontend when the user toggles "minimize to tray on close".
/// Updates the in-memory flag so it takes effect immediately.
#[tauri::command]
pub fn set_minimize_to_tray(enabled: bool, state: State<'_, AppState>) {
    state.set_minimize_to_tray(enabled);
    tracing::info!("minimize_to_tray set to {}", enabled);
}
```

- [ ] **Step 2: Register the module**

In `crates/sd-tauri/src/commands/mod.rs`, add after the existing modules:

```rust
pub mod app_settings;
```

- [ ] **Step 3: Verify it compiles**

Run:
```bash
cd /media/nvme4tb/DEV/stream-deck-js/crates/sd-tauri && cargo check
```
Expected: compiles (command not wired to invoke_handler yet — that's Task 5).

- [ ] **Step 4: Commit**

```bash
git add crates/sd-tauri/src/commands/app_settings.rs crates/sd-tauri/src/commands/mod.rs
git commit -m "feat: add set_minimize_to_tray Tauri command"
```

---

## Task 5: Wire Up Tray Icon, Close Interception, and Startup Logic in main.rs

This is the core task. It modifies `main.rs` to:
- Load saved settings on startup
- Build the tray icon with right-click menu
- Intercept window close to hide instead of quit
- Show window on startup unless start-minimized is enabled
- Register the autostart plugin and the new command

**Files:**
- Modify: `crates/sd-tauri/src/main.rs`

- [ ] **Step 1: Update imports**

Replace the imports at the top of `main.rs` (lines 8-11):

```rust
use state::AppState;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use tauri::{Emitter, Manager};
```

With:

```rust
use state::AppState;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use tauri::{
    menu::{MenuBuilder, MenuItemBuilder},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Emitter, Manager, WindowEvent,
};
```

- [ ] **Step 2: Add helper to load app settings from disk**

After the `const API_BIND` line (line 14), add:

```rust
/// Load app_settings.json and return (minimize_to_tray, start_minimized).
/// Returns defaults (true, false) if file doesn't exist or is malformed.
fn load_app_settings() -> (bool, bool) {
    let base = match dirs::config_dir() {
        Some(d) => d.join("open-stream-deck"),
        None => return (true, false),
    };
    let path = base.join("app_settings.json");
    let content = match std::fs::read_to_string(&path) {
        Ok(c) => c,
        Err(_) => return (true, false),
    };
    let json: serde_json::Value = match serde_json::from_str(&content) {
        Ok(v) => v,
        Err(_) => return (true, false),
    };
    let minimize = json.get("minimizeToTray").and_then(|v| v.as_bool()).unwrap_or(true);
    let start_min = json.get("startMinimized").and_then(|v| v.as_bool()).unwrap_or(false);
    (minimize, start_min)
}
```

- [ ] **Step 3: Load settings before builder, apply minimize_to_tray default**

Inside `fn main()`, after `commands::api_keys::load_api_key_on_startup();` (line 23) and before `api_server::start_api_server(` (line 26), add:

```rust
    // Load app settings (tray behavior, start-minimized)
    let (minimize_to_tray, start_minimized) = load_app_settings();
```

- [ ] **Step 4: Register autostart plugin in the builder**

After `.plugin(tauri_plugin_shell::init())` (line 38), add:

```rust
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
```

- [ ] **Step 5: Apply minimize_to_tray setting to state before setup**

After `.manage(Arc::new(AtomicBool::new(false)))` (line 40), but before `.setup(|app| {`, add code that sets the flag from the loaded setting. Since `app_state` is moved into `.manage()` before this point, we need to set it before manage. So adjust the flow:

After line 19 (`let var_rx = app_state.var_tx.subscribe();`) add:

```rust
    // Load app settings (tray behavior, start-minimized)
    let (minimize_to_tray_default, start_minimized) = load_app_settings();
    app_state.set_minimize_to_tray(minimize_to_tray_default);
```

(Remove the load from Step 3 location — it goes here instead, before `app_state` is consumed.)

- [ ] **Step 6: Build tray icon inside `.setup()`**

Inside the `.setup(|app| { ... })` closure, after the devtools block (lines 42-46), add the tray builder:

```rust
            // Build system tray
            let show = MenuItemBuilder::with_id("show", "Show").build(app)?;
            let quit = MenuItemBuilder::with_id("quit", "Quit").build(app)?;
            let menu = MenuBuilder::new(app).items(&[&show, &quit]).build()?;

            let _tray = TrayIconBuilder::new()
                .menu(&menu)
                .menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "show" => {
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.unminimize();
                            let _ = w.set_focus();
                        }
                    }
                    "quit" => {
                        app.exit(0);
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.unminimize();
                            let _ = w.set_focus();
                        }
                    }
                })
                .build(app)?;
```

- [ ] **Step 7: Show window on startup (unless start-minimized)**

Still inside `.setup()`, after the tray builder code, add:

```rust
            // Show window unless start-minimized is enabled
            if !start_minimized {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.show();
                    let _ = w.set_focus();
                }
            }
```

- [ ] **Step 8: Add close interception via on_window_event**

After `.setup(|app| { ... })` closes (after `Ok(())` / `})`), and before `.invoke_handler(...)`, add:

```rust
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let state = window.state::<AppState>();
                if state.should_minimize_to_tray() {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
```

- [ ] **Step 9: Register the new command in invoke_handler**

In the `invoke_handler` list (after line 110 `commands::api_keys::revoke_api_key,`), add:

```rust
            commands::app_settings::set_minimize_to_tray,
```

- [ ] **Step 10: Verify it compiles**

Run:
```bash
cd /media/nvme4tb/DEV/stream-deck-js/crates/sd-tauri && cargo check
```
Expected: compiles successfully.

- [ ] **Step 11: Commit**

```bash
git add crates/sd-tauri/src/main.rs
git commit -m "feat: wire up system tray, close-to-hide, start-minimized, autostart plugin"
```

---

## Task 6: Add General Settings Section to Frontend

**Files:**
- Modify: `packages/ui/src/pages/Settings.svelte:1-227`

- [ ] **Step 1: Add settings state and load/save functions**

In the `<script>` block of `Settings.svelte`, after the existing imports (line 2-3), add the autostart import:

```typescript
  import { enable, disable, isEnabled } from "@tauri-apps/plugin-autostart";
```

After the `let copied = $state(false);` line (line 14), add the app settings state and functions:

```typescript
  // App settings
  let minimizeToTray = $state(true);
  let startMinimized = $state(false);
  let startOnBoot = $state(false);

  async function loadAppSettings() {
    const raw = await invoke<string | null>("load_json_file", { filename: "app_settings" });
    if (raw) {
      const settings = JSON.parse(raw);
      minimizeToTray = settings.minimizeToTray ?? true;
      startMinimized = settings.startMinimized ?? false;
    }
    startOnBoot = await isEnabled();
  }

  async function saveAppSettings() {
    const content = JSON.stringify({ minimizeToTray, startMinimized });
    await invoke("save_json_file", { filename: "app_settings", content });
  }

  async function toggleMinimizeToTray() {
    minimizeToTray = !minimizeToTray;
    await invoke("set_minimize_to_tray", { enabled: minimizeToTray });
    await saveAppSettings();
  }

  async function toggleStartMinimized() {
    startMinimized = !startMinimized;
    await saveAppSettings();
  }

  async function toggleStartOnBoot() {
    startOnBoot = !startOnBoot;
    if (startOnBoot) {
      await enable();
    } else {
      await disable();
    }
  }
```

- [ ] **Step 2: Call loadAppSettings on mount**

After `loadHAConfig();` (line 76), add:

```typescript
  loadAppSettings();
```

- [ ] **Step 3: Add General section HTML**

In the template, after `<h2>Settings</h2>` (line 80) and before the Home Assistant section (line 82), add:

```svelte
  <div class="settings-section">
    <h3>General</h3>

    <label class="toggle-row" onclick={toggleMinimizeToTray}>
      <div class="toggle-text">
        <span class="toggle-label">Minimize to tray on close</span>
        <span class="toggle-hint">Keep running in the background when the window is closed</span>
      </div>
      <div class="toggle-switch" class:active={minimizeToTray}>
        <div class="toggle-knob"></div>
      </div>
    </label>

    <label class="toggle-row" onclick={toggleStartMinimized}>
      <div class="toggle-text">
        <span class="toggle-label">Start minimized</span>
        <span class="toggle-hint">Launch hidden in the system tray</span>
      </div>
      <div class="toggle-switch" class:active={startMinimized}>
        <div class="toggle-knob"></div>
      </div>
    </label>

    <label class="toggle-row" onclick={toggleStartOnBoot}>
      <div class="toggle-text">
        <span class="toggle-label">Start on boot</span>
        <span class="toggle-hint">Automatically start at login</span>
      </div>
      <div class="toggle-switch" class:active={startOnBoot}>
        <div class="toggle-knob"></div>
      </div>
    </label>
  </div>
```

- [ ] **Step 4: Add toggle CSS styles**

In the `<style>` block, after the existing styles (before the closing `</style>` tag), add:

```css
  .toggle-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px 0;
    cursor: pointer;
    user-select: none;
  }
  .toggle-row:not(:last-child) {
    border-bottom: 1px solid var(--border);
  }
  .toggle-text {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .toggle-label {
    font-size: 13px;
    color: var(--text-primary);
  }
  .toggle-hint {
    font-size: 11px;
    color: var(--text-muted);
  }
  .toggle-switch {
    position: relative;
    width: 36px;
    height: 20px;
    background: var(--bg-primary);
    border-radius: 10px;
    border: 1px solid var(--border);
    flex-shrink: 0;
    transition: background 0.2s;
  }
  .toggle-switch.active {
    background: var(--accent);
    border-color: var(--accent);
  }
  .toggle-knob {
    position: absolute;
    top: 2px;
    left: 2px;
    width: 14px;
    height: 14px;
    background: var(--text-primary);
    border-radius: 50%;
    transition: transform 0.2s;
  }
  .toggle-switch.active .toggle-knob {
    transform: translateX(16px);
  }
```

- [ ] **Step 5: Verify frontend builds**

Run:
```bash
cd /media/nvme4tb/DEV/stream-deck-js && pnpm --filter ui build
```
Expected: builds successfully.

- [ ] **Step 6: Commit**

```bash
git add packages/ui/src/pages/Settings.svelte
git commit -m "feat: add General settings section with tray, start-minimized, and autostart toggles"
```

---

## Task 7: Integration Test

Manual verification since this requires a physical display and tray.

- [ ] **Step 1: Run the full app**

```bash
cd /media/nvme4tb/DEV/stream-deck-js && cargo tauri dev
```

- [ ] **Step 2: Verify tray icon appears**

Expected: system tray shows the app icon with tooltip "Open Stream Deck".

- [ ] **Step 3: Verify window shows on startup**

Expected: window appears (start-minimized is off by default).

- [ ] **Step 4: Verify close hides to tray**

Click the X button. Expected: window disappears but tray icon remains. App is still running.

- [ ] **Step 5: Verify left-click tray shows window**

Left-click the tray icon. Expected: window reappears and is focused.

- [ ] **Step 6: Verify right-click menu**

Right-click tray icon. Expected: menu with "Show" and "Quit" items.

- [ ] **Step 7: Verify Settings toggles**

Open Settings. Expected: General section at top with three toggles. "Minimize to tray" is on, others are off.

- [ ] **Step 8: Test disable minimize-to-tray**

Toggle "Minimize to tray" off. Close the window. Expected: app quits entirely.

- [ ] **Step 9: Test start-minimized**

Toggle "Start minimized" on. Restart app (`cargo tauri dev` again). Expected: no window on startup, tray icon present. Left-click tray to show window.

- [ ] **Step 10: Test start-on-boot**

Toggle "Start on boot" on in settings. Check OS autostart entries:
- Linux: `ls ~/.config/autostart/` — should have an entry
- macOS: `ls ~/Library/LaunchAgents/` — should have a plist
- Windows: check `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` in registry

- [ ] **Step 11: Verify Quit from tray**

Right-click tray → Quit. Expected: app fully exits, no lingering processes.

- [ ] **Step 12: Commit any fixes**

If any fixes were needed during testing, commit them:

```bash
git add -u
git commit -m "fix: adjustments from integration testing of system tray"
```