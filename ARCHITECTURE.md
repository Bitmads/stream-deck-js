# Architecture Guide

## Overview

Open Stream Deck is a cross-platform Stream Deck controller built with Tauri v2 (Rust) + Svelte 5 (TypeScript). It supports the Elgato Stream Deck models listed in the README, including the Plus with encoders and LCD touchstrip.

```
┌────────────────────────────────────────────────────────┐
│                   Tauri v2 Desktop App                  │
├─────────────────────┬──────────────────────────────────┤
│  Svelte 5 Frontend  │  Rust Backend                    │
│  (WebKitGTK)        │                                  │
│                     │  sd-core (library)               │
│  AppStore class     │    device/ (HID, profiles)       │
│  PropertyPanel      │    image/  (decode, encode)      │
│  DeviceGrid         │    profile/ (atomic writes)      │
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
│   │   │   ├── profile.rs      # DEVICE_PROFILES registry (geometry, protocol, transforms)
│   │   │   ├── manager.rs      # HID comm, input parsing, key/LCD packet writers, brightness
│   │   │   └── mod.rs
│   │   ├── image/
│   │   │   └── renderer.rs     # decode_base64_image, encode_key_image (BMP/JPEG), encode_lcd_image
│   │   ├── profile/
│   │   │   └── storage.rs      # atomic_write, write_profile_file (.bak), name/shape validation
│   │   ├── plugin/
│   │   │   ├── protocol.rs     # Host-handled plugin messages + variable extension
│   │   │   ├── lifecycle.rs    # Plugin subprocess manager (restart policy, stop_all)
│   │   │   ├── node.rs         # Node.js discovery (nodePath, nvm, volta, fnm, PATH)
│   │   │   └── manifest.rs     # manifest.json parser
│   │   └── platform/
│   │       └── active_window.rs
│   └── sd-tauri/src/
│       ├── main.rs             # App setup, tray, command registration, event forwarding
│       ├── state.rs            # AppState (device_manager, plugin_manager, plugin_hub, var_tx, profile_tx)
│       ├── api_server.rs       # HTTP REST API (axum, port 8484)
│       ├── ws_server.rs        # Plugin WebSocket server (PluginHub)
│       └── commands/
│           ├── device.rs       # list/open/brightness/key image/LCD/key listener
│           ├── action.rs       # execute_action (shell, hotkey, http, etc.)
│           ├── app_settings.rs # app_settings.json (minimizeToTray, apiBind, nodePath, ...)
│           ├── plugin.rs       # external plugins: discover/start/stop/status/send/config
│           ├── proxy.rs        # remote image fetch as data: URL
│           ├── storage.rs      # JSON file read/write (atomic, 0600)
│           ├── variables.rs    # get/set/list/delete variables
│           ├── api_keys.rs     # Generate/list/revoke API keys (OS keychain)
│           └── window.rs       # Active window watcher
├── packages/
│   ├── ui/
│   │   ├── scripts/build-icon-assets.mjs  # Regenerates src/assets/icons/*.json
│   │   └── src/
│   │       ├── App.svelte          # Root: event routing, keyboard shortcuts, init
│   │       ├── lib/
│   │       │   ├── stores/
│   │       │   │   ├── store.svelte.ts       # AppStore class (ALL state, executeAction)
│   │       │   │   ├── device-sync.svelte.ts # Renders + pushes every connected device
│   │       │   │   ├── plugins.svelte.ts     # Plugin registry, external plugin discovery
│   │       │   │   └── editor/devices/variables.svelte.ts # Re-exports from store
│   │       │   ├── plugins/
│   │       │   │   ├── homeassistant/        # HA WebSocket client, controls mapping, settings
│   │       │   │   ├── multi-action/         # Step parsing, executor, MultiActionEditor
│   │       │   │   ├── external/             # Bridge to external (.sdPlugin) plugins
│   │       │   │   └── system, http, navigation, utilities
│   │       │   ├── types/profile.ts          # Persisted profile types
│   │       │   └── utils/
│   │       │       ├── render-key.ts         # Key renderer (shared by preview and device)
│   │       │       ├── render-strip.ts       # LCD strip renderer (shared by preview and device)
│   │       │       ├── template.ts           # {{$var|filter}} resolution
│   │       │       └── icon-svg, font, draw-text, image-cache, context, profile
│   │       ├── components/
│   │       │   ├── device/
│   │       │   │   ├── DeviceGrid.svelte  # Key grid, LCD strip preview, encoder dials
│   │       │   │   └── KeySlot.svelte     # Single key preview (never writes to the device)
│   │       │   ├── input/
│   │       │   │   ├── ActionSettingsEditor.svelte # Settings UI for every built-in action
│   │       │   │   ├── HAEntityPicker.svelte
│   │       │   │   └── VarInput.svelte    # Text input with {{$ autocomplete
│   │       │   ├── layout/
│   │       │   │   ├── PropertyPanel.svelte # Right panel (Look/Icons/Action tabs)
│   │       │   │   ├── Header.svelte       # Tabs, scene bar, device selector
│   │       │   │   ├── Sidebar.svelte      # Recent/favorite actions
│   │       │   │   ├── MainPanel.svelte    # Editor/Profiles/Plugins/Settings routing
│   │       │   │   ├── StatusBar.svelte    # Status, load/action errors
│   │       │   │   └── TriggerEditor.svelte
│   │       │   ├── icon/
│   │       │   │   ├── IconBrowser.svelte  # Icon sets, lazy loaded
│   │       │   │   └── TextConfig.svelte   # Font/size/weight/color/alignment editor
│   │       │   └── plugin/
│   │       │       └── PluginConfig.svelte # config.schema.json form for external plugins
│   │       └── pages/
│   │           ├── Profiles.svelte
│   │           ├── Plugins.svelte
│   │           └── Settings.svelte  # API keys/bind + HA connection + Node path
│   └── plugin-sdk/              # TypeScript SDK for external plugins
├── plugins/
│   ├── chrome-pinned-tabs/      # Chrome extension
│   └── stock-quotes.sdPlugin/   # Example external plugin
└── examples/
    └── homeassistant/           # HA setup guide + YAML examples
```

## State Management

All reactive state lives in one `AppStore` class (`store.svelte.ts`):

```typescript
class AppStore {
  // Devices
  devices, selectedDevice, deviceLoading, deviceError

  // Scenes: per device (profileDevices[serial].activeSceneId / sceneStack);
  // navigation, timers and counters take a serial
  scenes, activeSceneId, sceneStack  // views of the edited device

  // Selection (mutually exclusive)
  selectedKeyIndex, selectedEncoderIndex, selectedStripItemId

  // Profile
  activeProfileName, profileDevices (per-device deep-cloned configs)

  // Variables
  variables, varRevision, locallySetVars (echo suppression)

  // Runtime (never persisted)
  runtimeOverrides   // per context: title/image/state/flash from timers, counters, plugins
  loadError, lastError

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
    pub image_format: ImageFormat, // Bmp, Jpeg or None (Pedal)
    pub protocol_version: ProtocolVersion, // V1 (gen1) or V2 (gen2)
    pub key_data_offset: usize,    // HID report byte offset (after the report ID)
    pub key_rtl: bool,             // Original reports keys right to left
    pub key_transform: PixelTransform, // per-model flip/rotate of key images
    pub key_writer: KeyImageWriter,    // packet layout (Original, Mini, gen2)
    pub touch_button_count: u8,    // Neo page buttons
    pub encoder_count: u8,         // 0 or 4 (Plus)
    pub lcd_strip_width: u16,      // 0 or 800
    pub lcd_strip_height: u16,     // 0 or 100
    pub info_lcd_width: u16,       // Neo info screen (248x58)
    pub has_lcd_strip: bool,
    pub has_dials: bool,
    // ...
}
```

Adding a model that uses an existing packet layout = adding one entry to this array. Layouts follow
the upstream node-elgato-stream-deck library and are covered by unit tests in sd-core.

## Variable System

Templates: `{{$varName}}`, `{{$varName|filter1|filter2}}`, `{{$varName|default:fallback}}`. Implemented in `utils/template.ts` (pure, unit-tested); `store.resolveTemplate(text)` calls it with the store's variables.

- The `$` is optional; the expression is matched by `/\{\{([^}]+)\}\}/` and split on `|`.
- Unset variable: filters are skipped and the result is `""`, unless `default:x` supplies a value. For older profiles, a segment that is not a known filter is used as a fallback literal when unset and ignored when set.
- `default:x` also replaces an empty value.
- Numeric filters return `""` for non-numeric input.
- `map:`/`replace:` arguments accept `\:` and `\=` escapes.
- Colors go through `resolveColor()` (accepts `#hex`, `rgb[a]()`, `hsl[a]()`, CSS names, else a fallback); numbers through `resolveNumber()` (fallback when unset or non-numeric).
- Action settings are resolved per value right before the executor runs. Settings listed in `RAW_SETTINGS` (JSON blobs: `multi-action.steps`, `ha-service.ha_service_data`, `ha-custom.ha_custom_json`) are passed raw and resolved per string value by their executor; values substituted into `SHELL_SETTINGS` (`command.command`, `launch.target`) are shell-quoted.

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
| `trim` | Strip surrounding whitespace | `{{$name\|trim}}` |
| `f2c` | Fahrenheit → Celsius | `{{$temp\|f2c\|round}}` |
| `c2f` | Celsius → Fahrenheit | `{{$temp\|c2f\|round}}` |
| `kelvin` | Color temp → hex color | `{{$ct\|kelvin}}` → `#ffd4a0` |
| `rgb` | `r, g, b` or `[r,g,b]` → hex color | `{{$color\|rgb}}` → `#ff8800` |

**Parametric filters:**

| Filter | Description | Example |
|--------|-------------|---------|
| `map:k=v:*=d` | Map value to result | `{{$state\|map:on=#ff9800:off=#000:*=#333}}` |
| `replace:s=r` | String replace (all) | `{{$text\|replace:-=}}` (remove dashes) |
| `replace:/re/f=r` | Regex replace | `{{$text\|replace:/\\d+/g=}}` (remove numbers) |
| `default:x` | Value when unset or empty | `{{$temp\|default:--}}` |

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

**External plugins:** `.sdPlugin` folders in `~/.config/open-stream-deck/plugins/` are auto-discovered (debug builds also scan the repo's `plugins/`; release builds install the bundled ones there). Enable starts the subprocess with a discovered Node.js (>= 18, or the manifest's `Nodejs.Version`), disable kills it. Crashes restart at most 5 times per 10 minutes with backoff, then the plugin is marked failed. All plugins are stopped on quit.

**Elgato SDK subset:** the plugin is started with `-pluginUUID` = its manifest UUID and must register with it; only plugins the app launched can register, and browser origins are rejected. Rust handles `openUrl`, `logMessage`, `setVariable`/`getVariable` and `setGlobalSettings`/`getGlobalSettings`. Every other message with a `context` is forwarded to the UI as the `plugin-command` event; `lib/plugins/external/bridge.svelte.ts` turns `setTitle`/`setImage`/`setState`/`showOk`/`showAlert` into runtime overrides and `setSettings`/`getSettings` into `settings.pluginSettings`. The bridge sends `willAppear`/`willDisappear`, `keyDown`/`keyUp` and `dialRotate`/`dialDown`/`dialUp` through the `plugin_send_event` command. Contexts are `<serial>:<sceneId>:<Keypad|Encoder>:<index>`. Property inspectors are not supported.

## Rendering Pipeline

**Keys:** `resolveKeyInputs()` resolves every template of a key (plus its runtime override) into plain values, then `renderResolvedKey(inputs, size)` (`utils/render-key.ts`) draws them with the Canvas API: bg color → bg image → active icon → text layers → ok/alert flash → JPEG data URL. Layouts are designed on a canvas of min(native key size, 96) px and drawn scaled to the native size, so Stream Deck + keys (120 px) are rendered at full resolution. KeySlot previews and device sync use the same functions. The active icon is the first icon whose `variable` template equals its `value`, else the first icon without a condition.

**Device push:** `startDeviceSync()` (`stores/device-sync.svelte.ts`, started once by App.svelte) watches every connected device's active scene. For each key and for the strip it fingerprints the fully resolved render inputs and re-renders/re-sends only when that fingerprint changes, so `time.*` ticks do not resend keys that do not use them. Scene switches, undo/redo, profile reloads and reconnects resync. The backend converts to BMP/JPEG and applies per-model flips.

**LCD strip:** `renderStrip(ctx, strip, opts)` (`utils/render-strip.ts`) draws the full strip (bg, bar, icon, texts) for both the DeviceGrid preview and the device, pushed via `send_lcd_image`.

## Network Services

| Service | Port | Bind | Auth | Purpose |
|---------|------|------|------|---------|
| HTTP API | 8484 | `apiBind` (default 0.0.0.0) | `/api/health` public. No key: loopback only (local Host, no foreign Origin). Keys: Bearer (any stored key); `/api/profile/*` also open to loopback. 503 until keychain read | External control (HA, scripts) |
| Plugin WS | random | 127.0.0.1 | Only launched plugin UUIDs, no browser origins | Elgato SDK plugins |
| HA WS | N/A | outbound | Long-lived token | HA state sync + service calls |

## Persistence

Profile: `~/.config/open-stream-deck/profile_<name>.json` (one previous copy kept as `profile_<name>.json.bak`)
Active profile + app settings: `~/.config/open-stream-deck/app_settings.json` (`activeProfile`, `apiBind`, `nodePath`, `minimizeToTray`, `startMinimized`)
HA config: `~/.config/open-stream-deck/ha_config.json`
Built-in plugin enable/disable state: `~/.config/open-stream-deck/plugins.json`
External plugins: `~/.config/open-stream-deck/plugins/<name>.sdPlugin/` (settings form values in its `config.json`)
Plugin global settings: `~/.config/open-stream-deck/plugin_global_<encoded uuid>.json`
API keys: OS keychain (Secret Service / macOS Keychain / Windows Credential Manager)

All JSON writes are atomic (temp file, fsync, rename) with mode 0600. A profile that fails to parse is never overwritten: the UI keeps its state and shows the error. UI saves are debounced (500 ms, flushed when the window is hidden) and carry the content stamp of the file as last loaded; if the file changed on disk in the meantime the save is refused and the UI reloads the file instead.

Profiles can be edited outside the app: `PUT /api/profile/{name}` writes a new file and the UI reloads it (`profile-reload` event); `POST /api/profile/reload` reloads after editing the file by hand.

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

Field types are in `packages/ui/src/lib/types/profile.ts`; `utils/profile.ts` parses and validates a file (`parseProfileJson`) and writes it (`serializeProfile`). Key points:

- Keys and encoders are keyed by index strings (`"0"`, `"1"`, ...); key indices are row-major. Strip items are an array with unique `id`s.
- A key (`KeyAssignment`) has `action` (`{id, label, icon, color}`), `settings` (string values), `backgroundColor`, optional `imageDataUrl` / `imageUrl` + `imageFit`, `texts[]`, `icons[]` and `pinned`. `text` and `icon` are legacy single-layer fields still read when `texts` / `icons` are absent.
- An encoder has `pressAction`/`pressSettings`, `rotateAction`/`rotateSettings`, `label`, and `value`/`min`/`max` (strings, numbers or templates) plus a numeric `step`.
- The strip (`StripConfig`) has a `backgroundColor` and `items[]` with a rectangle on the 800x100 strip, visuals, an optional `bar`, and tap/long-press/swipe actions with their settings.
- Scene `triggers` are `{type: "window" | "manual", app_name?, window_title?, priority?, mode?}`. Window patterns are case-insensitive substrings or `regex:<pattern>`; the highest `priority` wins, and a window trigger with neither field set never matches. A matching trigger switches the selected device to its scene (`mode` is not used).
- `DeviceConfig.brightness` (0-100) is applied when the device opens.
- Legacy single-device files (top-level `scenes` / `activeSceneId`) are migrated onto the first bound device.
- Pinned keys are shown in the device's other scenes where that slot is empty, as a render-time overlay; they are never copied.
- Runtime state (timer countdowns, counter titles, plugin `setTitle`/`setImage`/`setState`) lives in `store.runtimeOverrides` and is never written into key text. Counter values are stored in the key's `value` setting.

## Build & Run

```bash
pnpm install
cargo tauri dev          # Development (hot reload)
cargo tauri build        # Production build
cargo test --workspace
pnpm --filter @open-stream-deck/ui check
pnpm --filter @open-stream-deck/ui test
```

Frontend builds with Vite, icons lazy-loaded per set. Regenerate the icon JSON with `pnpm --filter @open-stream-deck/ui icons`.
