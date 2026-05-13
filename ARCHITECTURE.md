# Architecture Guide

## Overview

Open Stream Deck is a cross-platform Stream Deck controller built with Tauri v2 (Rust) + Svelte 5 (TypeScript). It supports all Elgato Stream Deck models including the Plus with encoders and LCD touchstrip.

```
┌────────────────────────────────────────────────────────┐
│                   Tauri v2 Desktop App                  │
├─────────────────────┬──────────────────────────────────┤
│  Svelte 5 Frontend  │  Rust Backend                    │
│  (WebKitGTK)        │                                  │
│                     │  sd-core (library)               │
│  AppStore class     │    device/ (HID, profiles)       │
│  PropertyPanel      │    image/  (decode, encode)      │
│  DeviceGrid         │    profile/ (schema, storage)    │
│  HA Plugin          │    plugin/  (protocol, lifecycle)│
│                     │    platform/ (active window)     │
│     ↕ IPC           │                                  │
│  (invoke/listen)    │  sd-tauri (app shell)            │
│                     │    commands/ (IPC handlers)       │
│                     │    api_server.rs (axum HTTP)      │
│                     │    ws_server.rs  (plugin WS)      │
│                     │    state.rs (AppState)            │
└─────────────────────┴──────────────────────────────────┘
```

## Directory Structure

```
open-stream-deck/
├── crates/
│   ├── sd-core/src/
│   │   ├── device/
│   │   │   ├── profile.rs      # DEVICE_PROFILES registry (all 10 models)
│   │   │   ├── manager.rs      # HID comm, read_input, set_key_image, set_lcd_image
│   │   │   └── mod.rs
│   │   ├── image/
│   │   │   └── renderer.rs     # decode_base64_image, encode_image_for_device
│   │   ├── profile/
│   │   │   ├── schema.rs       # Scene, KeyConfig, SceneTrigger types
│   │   │   └── storage.rs      # ProfileStore with scene stack navigation
│   │   ├── plugin/
│   │   │   ├── protocol.rs     # Elgato SDK message types + variable extension
│   │   │   ├── lifecycle.rs    # Plugin subprocess manager
│   │   │   └── manifest.rs     # manifest.json parser
│   │   └── platform/
│   │       └── active_window.rs
│   └── sd-tauri/src/
│       ├── main.rs             # App setup, command registration
│       ├── state.rs            # AppState (device_manager, variables, var_tx)
│       ├── api_server.rs       # HTTP REST API (axum, port 8484)
│       ├── ws_server.rs        # Plugin WebSocket server
│       └── commands/
│           ├── device.rs       # list/open/brightness/key image/LCD/key listener
│           ├── action.rs       # execute_action (shell, hotkey, http, etc.)
│           ├── profile.rs      # CRUD, persistence, import/export
│           ├── storage.rs      # Raw JSON file read/write
│           ├── variables.rs    # get/set/list/delete variables
│           ├── api_keys.rs     # Generate/list/revoke API keys (OS keychain)
│           └── window.rs       # Active window watcher
├── packages/
│   ├── ui/src/
│   │   ├── App.svelte          # Root: event handling, keyboard shortcuts, init
│   │   ├── lib/
│   │   │   ├── stores/
│   │   │   │   ├── store.svelte.ts    # AppStore class (ALL state)
│   │   │   │   ├── editor.svelte.ts   # Re-exports from store
│   │   │   │   ├── devices.svelte.ts  # Re-exports from store
│   │   │   │   └── variables.svelte.ts # Re-exports from store
│   │   │   ├── plugins/
│   │   │   │   └── homeassistant/
│   │   │   │       ├── client.ts      # HA WebSocket client
│   │   │   │       └── index.ts       # Plugin registration
│   │   │   └── utils/
│   │   │       └── render-key.ts      # Canvas renderer (keys + strip segments)
│   │   ├── components/
│   │   │   ├── device/
│   │   │   │   ├── DeviceGrid.svelte  # Key grid, LCD strip canvas, encoder dials
│   │   │   │   └── KeySlot.svelte     # Single key preview + device sync
│   │   │   ├── layout/
│   │   │   │   ├── PropertyPanel.svelte # Right panel (Look/Icons/Action tabs)
│   │   │   │   ├── Header.svelte       # Tabs, scene bar, device selector
│   │   │   │   ├── Sidebar.svelte      # Recent/favorite actions
│   │   │   │   ├── MainPanel.svelte    # Editor/Profiles/Plugins/Settings routing
│   │   │   │   ├── StatusBar.svelte
│   │   │   │   └── TriggerEditor.svelte
│   │   │   ├── icon/
│   │   │   │   ├── IconBrowser.svelte  # 63K icons, 12 sets, lazy loaded
│   │   │   │   └── TextConfig.svelte   # Font/size/weight/color/alignment editor
│   │   │   └── plugin/
│   │   │       └── PropertyInspector.svelte
│   │   └── pages/
│   │       ├── Profiles.svelte
│   │       ├── Plugins.svelte
│   │       └── Settings.svelte  # API keys + HA connection + watched entities
│   └── plugin-sdk/              # @open-streamdeck/sdk npm package
├── plugins/
│   └── chrome-pinned-tabs/      # Chrome extension
└── examples/
    └── homeassistant/           # HA setup guide + YAML examples
```

## State Management

All reactive state lives in one `AppStore` class (`store.svelte.ts`):

```typescript
class AppStore {
  // Devices
  devices, selectedDevice, deviceLoading, deviceError

  // Scenes (per active device)
  scenes, activeSceneId, sceneStack

  // Selection (mutually exclusive)
  selectedKeyIndex, selectedEncoderIndex, selectedStripItemId

  // Profile
  activeProfileName, profileDevices (per-device deep-cloned configs)

  // Variables
  variables, varRevision, locallySetVars (echo suppression)

  // All mutations are methods on this class
}
```

The old store files (`editor.svelte.ts`, `devices.svelte.ts`, `variables.svelte.ts`) are thin re-export wrappers. Components import from these wrappers — same function names, zero component changes needed.

## Device Profile System

All device-specific data lives in `DEVICE_PROFILES` (a static array in `profile.rs`):

```rust
pub struct DeviceProfile {
    pub id: &'static str,          // "plus", "xl_v2", etc.
    pub usb_pid: u16,              // USB product ID
    pub columns: u8, pub rows: u8, // Key grid layout
    pub key_pixel_size: u16,       // 72, 96, 120, etc.
    pub image_format: ImageFormat, // Bmp or Jpeg
    pub protocol_version: ProtocolVersion, // V1 or V2
    pub key_data_offset: usize,    // HID report byte offset
    pub encoder_count: u8,         // 0 or 4 (Plus)
    pub lcd_strip_width: u16,      // 0 or 800
    pub lcd_strip_height: u16,     // 0 or 100
    pub rotate_image: bool,        // true for Original/Mini/XL/MK2
    pub has_lcd_strip: bool,
    pub has_dials: bool,
}
```

Adding a new device model = adding one entry to this array. Zero code changes.

## Variable System

Templates: `{{$varName}}` or `{{$varName|filter1|filter2}}` or `{{$varName|fallback}}`

Resolution pipeline: `store.resolveTemplate(text)` → replaces patterns → applies filter chain.

**Simple filters:**

| Filter | Description | Example |
|--------|-------------|---------|
| `round` | Round to integer | `{{$temp\|round}}` → `27` |
| `round1` | 1 decimal place | `{{$temp\|round1}}` → `27.6` |
| `round2` | 2 decimal places | `{{$temp\|round2}}` → `27.59` |
| `floor` | Round down | `{{$val\|floor}}` |
| `ceil` | Round up | `{{$val\|ceil}}` |
| `abs` | Absolute value | `{{$val\|abs}}` |
| `percent` | × 100 + % | `{{$ratio\|percent}}` → `75%` |
| `upper` | Uppercase | `{{$name\|upper}}` |
| `lower` | Lowercase | `{{$name\|lower}}` |
| `f2c` | Fahrenheit → Celsius | `{{$temp\|f2c\|round}}` |
| `c2f` | Celsius → Fahrenheit | `{{$temp\|c2f\|round}}` |
| `kelvin` | Color temp → hex color | `{{$ct\|kelvin}}` → `#ffd4a0` |
| `rgb` | RGB array → hex color | `{{$color\|rgb}}` → `#ff8800` |

**Parametric filters:**

| Filter | Description | Example |
|--------|-------------|---------|
| `map:k=v:*=d` | Map value to result | `{{$state\|map:on=#ff9800:off=#000:*=#333}}` |
| `replace:s=r` | String replace (all) | `{{$text\|replace:-=}}` (remove dashes) |
| `replace:/re/f=r` | Regex replace | `{{$text\|replace:/\\d+/g=}}` (remove numbers) |

Variables update from: HA WebSocket (state_changed), REST API, time (1s interval), active window (500ms), plugins.

Autocomplete: Type `{{$` in any text field to see available variables with current values.

Echo suppression: When a variable is set locally (e.g., encoder rotation), incoming remote updates (HA echo-back) for that variable are suppressed for 500ms to prevent flicker.

## Plugin Architecture

All actions are registered through plugins. Built-in plugin groups:

| Plugin | Actions | Description |
|--------|---------|-------------|
| System Actions | hotkey, launch, command, open-url | Cross-platform system commands |
| HTTP Actions | http-request | HTTP client with method/headers/body |
| Navigation | switch-scene, back | Scene stack navigation |
| Utilities | timer, counter | Countdown timer, tap counter |
| Multi-Action | multi-action | Sequential action execution with delays |
| Home Assistant | ha-service, ha-custom | HA WebSocket service calls |

**Plugin management:** Plugins page with enable/disable toggles. Plugin state persisted in `plugins.json`. Disabled plugins' actions are removed from the action picker but key assignments are preserved.

**Plugin settings:** Enabled plugins with a `settingsComponent` render a dynamic section on the Settings page.

**External plugins:** `.sdPlugin` folders in `~/.config/open-stream-deck/plugins/` are auto-discovered. Enable starts the subprocess, disable kills it.

**Elgato SDK compatibility:** WebSocket server on localhost implements the Elgato registration protocol. Plugin subprocesses connect, register, and exchange events (keyDown, keyUp, willAppear, setImage, setTitle, etc.).

## Rendering Pipeline

**Keys:** `renderKeyToDataUrl(assignment, width, height)` → Canvas API → layers: bg color → bg image → SVG icon → text layers (with variable resolution) → base64 JPEG.

**Device push:** KeySlot `$effect` tracks assignment + used variables. Renders preview immediately, debounced 300ms device push via `send_rendered_image` Tauri command.

**LCD strip:** Store renders full 800x100 canvas with all strip items (bg, bar, icon, texts). Pushed via `send_lcd_image`. Triggered by config changes and variable changes (50ms debounce, only if variable is used by a strip item).

## Network Services

| Service | Port | Bind | Auth | Purpose |
|---------|------|------|------|---------|
| HTTP API | 8484 | 0.0.0.0 | Bearer token | External control (HA, scripts) |
| Plugin WS | random | 127.0.0.1 | Registration UUID | Elgato SDK plugins |
| HA WS | N/A | outbound | Long-lived token | HA state sync + service calls |

## Persistence

Profile: `~/.config/open-stream-deck/profile_<name>.json`
HA config: `~/.config/open-stream-deck/ha_config.json`
API keys: OS keychain (GNOME Keyring / macOS Keychain / Windows Credential Manager)

Profile format:
```json
{
  "name": "default",
  "devices": {
    "<serial>": {
      "scenes": { "<uuid>": { "keys": {}, "encoders": {}, "strip": {}, "triggers": [] } },
      "activeSceneId": "<uuid>"
    }
  },
  "favorites": [],
  "recent": []
}
```

Deep-cloned on device switch to prevent reference sharing between devices.

## Build & Run

```bash
pnpm install
cargo tauri dev          # Development (hot reload)
cargo tauri build        # Production build
```

Frontend builds with Vite, icons lazy-loaded per set (12 sets, 63K total).
