# System Tray & Background Operation

## Summary

Add system tray support so Open Stream Deck runs as a background app. The window is for editing; day-to-day use is headless with the Stream Deck devices active. Closing the window hides to tray by default instead of quitting.

## Settings

Three new toggles in a **General** section at the top of the Settings page:

| Setting | Default | Description |
|---------|---------|-------------|
| Minimize to tray on close | **On** | X button hides window to tray instead of quitting |
| Start minimized | **Off** | App launches hidden to tray (no window flash) |
| Start on boot | **Off** | App launches at OS login |

All settings persisted together via existing `save_json_file`/`load_json_file` commands with filename `app_settings`.

## Tray Icon Behavior

- **Left-click:** Show and focus the main window.
- **Right-click:** Context menu with:
  - **Show** — bring window to front
  - **Quit** — exit the app entirely

## Architecture

### Rust Backend (`main.rs`)

**Tray setup** in `.setup()` hook:
- Build a `TrayIconBuilder` with a right-click menu (Show, Quit).
- `on_tray_icon_event`: left-click shows/focuses the main window.
- `on_menu_event`: "show" shows the window, "quit" calls `app.exit(0)`.

**Close interception** via `on_window_event`:
- On `WindowEvent::CloseRequested`, check the minimize-to-tray setting.
- If enabled: `event.prevent_close()`, then `window.hide()`.
- If disabled: let the close proceed normally (app quits).

**Runtime state:**
- `AtomicBool` in Tauri managed state for the minimize-to-tray flag (checked on every close event without locking).
- Loaded from `app_settings` JSON file on startup.

**New Tauri command:** `set_minimize_to_tray(enabled: bool)` — updates the `AtomicBool` so the setting takes effect immediately without restart.

**Start minimized:**
- Set window `visible: false` in `tauri.conf.json`.
- In `.setup()`, if "start minimized" is **not** enabled, explicitly call `window.show()`.
- This avoids a window flash on startup when start-minimized is on.

**Start on boot:**
- Add `tauri-plugin-autostart` dependency.
- Register the plugin in the builder.
- New Tauri commands: `enable_autostart()`, `disable_autostart()`, `is_autostart_enabled()`.

### Frontend (`Settings.svelte`)

**General section** added at the top of the Settings page, before Home Assistant:

```
┌─ General ─────────────────────────────────────────┐
│                                                    │
│  Minimize to tray on close          [====toggle]   │
│  Keep running in the background                    │
│                                                    │
│  Start minimized                    [    toggle]   │
│  Launch hidden in the system tray                  │
│                                                    │
│  Start on boot                      [    toggle]   │
│  Automatically start at login                      │
│                                                    │
└────────────────────────────────────────────────────┘
```

**Data flow:**
1. On mount: `load_json_file("app_settings")` to get current values.
2. Toggle change: call `set_minimize_to_tray(value)` for immediate effect + `save_json_file("app_settings", ...)` for persistence.
3. Autostart toggles call `enable_autostart()` / `disable_autostart()` directly (plugin manages OS-level registration).

### Cross-Platform

| Concern | How it's handled |
|---------|-----------------|
| Tray icon | Tauri `tray-icon` feature (already enabled). Works on Windows, macOS, Linux. |
| macOS menu bar | `iconAsTemplate: true` already set in `tauri.conf.json` |
| Autostart (Windows) | Registry via `tauri-plugin-autostart` |
| Autostart (macOS) | LaunchAgent via `tauri-plugin-autostart` |
| Autostart (Linux) | XDG autostart via `tauri-plugin-autostart` |
| Window hide/show | Tauri window API — cross-platform |

### Capabilities

Add to `capabilities/default.json`:
- Autostart plugin permissions (as required by `tauri-plugin-autostart`)

## Out of Scope

- Notification balloons / badge counts
- Custom tray icon states (e.g., different icon when a device is disconnected)
- Theme / appearance settings (future General section addition)

## Files to Modify

| File | Change |
|------|--------|
| `crates/sd-tauri/Cargo.toml` | Add `tauri-plugin-autostart` dependency |
| `crates/sd-tauri/tauri.conf.json` | Set window `visible: false`, add autostart plugin config |
| `crates/sd-tauri/capabilities/default.json` | Add autostart permissions |
| `crates/sd-tauri/src/main.rs` | Tray builder, close interception, app settings loading, autostart plugin, new commands |
| `packages/ui/src/pages/Settings.svelte` | General section with three toggles |