# Open Stream Deck

A cross-platform, open-source Stream Deck controller with a visual GUI, Elgato SDK-compatible plugin system, and deep Home Assistant integration.

Built with **Tauri v2** (Rust backend) + **Svelte 5** (frontend).

## Features

- **Visual key editor** with icon browser, multi-layer text, custom backgrounds, and live preview
- **Scenes** with triggers (window focus, key press, manual) and stack-based navigation (push/switch)
- **Profiles** with per-device scene layouts, saved to disk and switchable at runtime
- **Multi-device support** -- connect multiple Stream Decks simultaneously, each with independent scenes
- **Variable system** with template syntax (`{{$var.name}}`), filters (`|round`, `|f2c`, `|upper`, etc.), conditional mapping (`|map:on=#ff9800:*=#000`), and regex replace (`|replace:-=`)
- **Built-in variables** -- `time.now`, `time.date`, `time.hours`, `time.minutes`, `time.seconds`, `window.title`, `window.app`
- **Home Assistant WebSocket integration** -- direct entity/service access, watched entities auto-sync to variables, two-way binding
- **Stream Deck+ support** -- 4 rotary encoders, 800x100 LCD touchstrip with bar indicators, tap/long press/swipe gestures
- **Elgato SDK-compatible plugin system** -- discovers `.sdPlugin` folders, launches subprocesses, communicates over WebSocket using the standard Elgato protocol (registerPlugin, keyDown/keyUp, willAppear, setTitle, setImage, etc.)
- **HTTP REST API** on port 8484 -- endpoints for variables, devices, brightness, and action execution
- **API key security** -- keys generated and stored in your OS keychain (GNOME Keyring / macOS Keychain / Windows Credential Manager), Bearer token auth with constant-time comparison
- **Chrome extension** -- syncs pinned tabs and active tab info to Stream Deck variables (`chrome.pinned.*`, `chrome.active.*`)
- **Action types** -- Hotkey, Launch App, Shell Command, Open URL, HTTP Request, Switch Scene, Back, Multi-Action (sequenced with delays), Timer, Counter, HA Service Call, HA Custom JSON
- **Undo/redo** for key edits
- **Cross-platform** -- Linux, macOS, Windows

## Supported Devices

| Device | USB PID | Keys | Extras | Status |
|--------|---------|------|--------|--------|
| Stream Deck Original | `0x0060` | 5x3 (72px, BMP) | -- | Working |
| Stream Deck Original V2 | `0x006d` | 5x3 (72px, JPEG) | -- | Working |
| Stream Deck Mini | `0x0063` | 3x2 (80px, BMP) | -- | Working |
| Stream Deck Mini V2 | `0x0090` | 3x2 (80px, JPEG) | -- | Working |
| Stream Deck XL | `0x006c` | 8x4 (96px, JPEG) | -- | Working |
| Stream Deck XL V2 | `0x008f` | 8x4 (96px, JPEG) | -- | Working |
| Stream Deck MK.2 | `0x0080` | 5x3 (72px, JPEG) | -- | Working |
| Stream Deck Pedal | `0x0086` | 3 pedals | No display | Working |
| Stream Deck + | `0x0084` | 4x2 (120px, JPEG) | 4 encoders, 800x100 LCD touchstrip | Working |
| Stream Deck Neo | `0x009a` | 5x3 (72px, JPEG) | -- | Working |

## Stream Deck+ Details

The Stream Deck+ has hardware beyond standard keys:

- **4 rotary encoders** -- press and rotate events. Each encoder can be bound to a press action and a rotate action with configurable step, min, max, and label. Values support variable templates (`{{$var}}`).
- **800x100 LCD touchstrip** -- renders strip items with backgrounds, icons, text layers, and bar indicators (progress fills with configurable position, color, and value range). Colors and values support variable templates including `{{$var|rgb}}` and `{{$var|kelvin}}`.
- **Touch gestures** -- the touchstrip reports tap (short press with x/y coordinates), long press, and swipe (from/to coordinates). Each strip item can bind separate actions to tap, long press, and swipe events.

## Variable System

Variables are key-value strings that can be referenced anywhere text is rendered on keys or the LCD strip.

**Syntax:** `{{$variable.name}}` or `{{$variable.name|filter}}`

**Built-in variables:**

| Variable | Source | Example |
|----------|--------|---------|
| `{{$time.now}}` | Clock (1s update) | `14:30` |
| `{{$time.date}}` | Clock | `3/26/2026` |
| `{{$window.title}}` | Active window tracker | `main.rs - VS Code` |
| `{{$window.app}}` | Active window tracker | `Code` |

**Filters** (chain with `|`):

| Filter | Example | Result |
|--------|---------|--------|
| `round` | `{{$temp\|round}}` | `27` |
| `round1` / `round2` | `{{$temp\|round1}}` | `27.6` |
| `floor` / `ceil` / `abs` | `{{$val\|floor}}` | `27` |
| `percent` | `{{$ratio\|percent}}` | `75%` |
| `upper` / `lower` | `{{$name\|upper}}` | `HELLO` |
| `f2c` / `c2f` | `{{$temp\|f2c\|round}}` | `27` |
| `kelvin` | `{{$ct\|kelvin}}` | `#ffd4a0` |
| `rgb` | `{{$color\|rgb}}` | `#ff8800` |
| `map:k=v:*=d` | `{{$state\|map:on=#f90:*=#000}}` | `#f90` or `#000` |
| `replace:s=r` | `{{$text\|replace:-=}}` | remove dashes |
| `replace:/re/f=r` | `{{$text\|replace:/\\d+/g=}}` | remove numbers |

**Autocomplete:** Type `{{$` in any text field to see available variables with current values.

**External variables** can be set via the REST API (`PUT /api/variables/{name}`) or from Home Assistant watched entities (`ha.<entity_id>.<attribute>`).

## Plugin System

Plugins follow the Elgato Stream Deck SDK format:

- Place a folder named `*.sdPlugin` in the plugins directory
- Include a `manifest.json` with `Name`, `UUID`, `Version`, `CodePath`, and `Actions`
- The app discovers plugins on startup, launches the CodePath as a subprocess, and communicates over WebSocket
- Supports the standard protocol: `registerPlugin`, `keyDown`/`keyUp`, `willAppear`/`willDisappear`, `setTitle`, `setImage`, `setState`, `setSettings`/`getSettings`, `setGlobalSettings`/`getGlobalSettings`, `showAlert`, `showOk`, `openUrl`, `logMessage`, `switchToProfile`, `sendToPropertyInspector`
- Extended with `setVariable`/`getVariable` for the Open Stream Deck variable system
- Plugin health monitoring with automatic restart (up to 5 times on crash)

## Home Assistant Integration

The app connects to Home Assistant over WebSocket for real-time entity state and service calls. See [examples/homeassistant/SETUP.md](examples/homeassistant/SETUP.md) for the full setup guide.

**Key capabilities:**

- WebSocket connection configured in Settings (HA URL + long-lived access token)
- Watched entities auto-sync all attributes to app variables (e.g. `{{$ha.light.living_room.brightness}}`)
- HA Service Call action type with entity picker and auto-detected controls (brightness, color temp, volume, temperature, position, percentage)
- Encoder dials bound to HA attributes (rotate to adjust brightness/volume/temperature)
- LCD touchstrip bars showing live values with swipe-to-set and tap-as-slider
- Two-way binding: HA state changes update Stream Deck displays, Stream Deck actions call HA services
- Also supports REST API integration (HA automations pushing variables to the deck via `rest_command`)

## Chrome Extension

The bundled Chrome extension (`plugins/chrome-pinned-tabs/`) syncs browser state to Stream Deck variables:

- `chrome.pinned.count` -- number of pinned tabs
- `chrome.pinned.{i}.title`, `.url`, `.id`, `.favicon` -- per-tab info
- `chrome.active.title`, `.url`, `.id` -- currently active tab
- Debounced sync on tab events, periodic re-sync every 30 seconds
- Load the extension in Chrome via `chrome://extensions` (Developer mode, Load unpacked)

## HTTP REST API

The app runs an HTTP server on port **8484** with the following endpoints:

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/api/health` | No | Health check (returns `ok`) |
| GET | `/api/devices` | Yes* | List connected devices |
| POST | `/api/devices/{serial}/brightness` | Yes* | Set device brightness (`{"percent": 80}`) |
| GET | `/api/variables` | Yes* | List all variables |
| GET | `/api/variables/{name}` | Yes* | Get a single variable |
| PUT | `/api/variables/{name}` | Yes* | Set a variable (`{"value": "..."}`) |
| DELETE | `/api/variables/{name}` | Yes* | Delete a variable |
| POST | `/api/actions/execute` | Yes* | Execute an action (`{"action_type": "...", "settings": {...}}`) |

*Auth is required only when at least one API key has been generated. Without any keys, the API runs open.

## Security

- API keys are generated in the app: **Settings** > **API Keys** > **Generate Key**
- Keys are stored encrypted in your OS keychain (GNOME Keyring / macOS Keychain / Windows Credential Manager)
- Add the key as a `Bearer` token in the `Authorization` header for REST API requests
- Constant-time comparison prevents timing attacks
- Without any API keys configured, the API accepts all requests (no auth required)
- Plugin WebSocket server binds to `127.0.0.1` only (localhost, not network-accessible)

## Prerequisites

### System Dependencies

**Linux (Debian/Ubuntu):**

```bash
sudo apt-get install -y libwebkit2gtk-4.1-dev librsvg2-dev patchelf \
  libssl-dev libgtk-3-dev libayatana-appindicator3-dev libsoup-3.0-dev \
  libjavascriptcoregtk-4.1-dev libudev-dev libhidapi-dev
```

**Rust:**

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
```

**Node.js 20+** and **pnpm**:

```bash
corepack enable pnpm
```

### Stream Deck USB Permissions (Linux)

On Linux, your user needs permission to access the Stream Deck USB device. Create a udev rule:

```bash
sudo bash -c 'echo "SUBSYSTEM==\"usb\", ATTRS{idVendor}==\"0fd9\", TAG+=\"uaccess\"" > /etc/udev/rules.d/70-streamdeck.rules'
sudo udevadm control --reload-rules
sudo udevadm trigger
```

Then **unplug and replug** your Stream Deck.

To verify it's accessible:

```bash
lsusb | grep Elgato
# Should show something like: Bus 003 Device 007: ID 0fd9:006d Elgato Systems GmbH Stream Deck original V2
```

## Development

```bash
# Install dependencies
pnpm install

# Run in development mode (opens the app with hot-reload)
cargo tauri dev

# Build for production
cargo tauri build
```

## Project Structure

```
open-stream-deck/
├── crates/
│   ├── sd-core/              # Core library
│   │   ├── device/           #   Device profiles, HID manager, input parsing (keys, encoders, LCD touch)
│   │   ├── image/            #   Key image rendering (SVG-based, JPEG/BMP output)
│   │   ├── platform/         #   Active window detection
│   │   ├── plugin/           #   Plugin manifest, lifecycle (discover/start/stop/health), WebSocket protocol
│   │   └── profile/          #   Profile schema (scenes, triggers, keys, encoders, strip config), storage
│   └── sd-tauri/             # Tauri app shell
│       ├── api_server.rs     #   HTTP REST API (Axum, port 8484)
│       ├── ws_server.rs      #   Plugin WebSocket server
│       ├── commands/         #   Tauri IPC commands (action, api_keys, device, profile, storage, variables, window)
│       ├── state.rs          #   Shared app state
│       └── main.rs           #   Entry point, system tray, state init
├── packages/
│   ├── ui/                   # Svelte 5 frontend
│   │   ├── components/       #   DeviceGrid, KeySlot, IconBrowser, TextConfig, PropertyPanel, TriggerEditor, etc.
│   │   ├── pages/            #   Settings (HA + API keys), Profiles, Plugins
│   │   └── lib/
│   │       ├── stores/       #   AppStore (scenes, keys, encoders, strip, variables, templates, undo/redo)
│   │       ├── plugins/      #   Home Assistant WebSocket client and plugin registration
│   │       └── utils/        #   Key rendering
│   ├── shared-types/         # Shared TypeScript types
│   └── plugin-sdk/           # Plugin SDK package
├── plugins/
│   ├── chrome-pinned-tabs/   # Chrome extension for tab sync
│   └── system-actions/       # System action plugin (in progress)
└── examples/
    └── homeassistant/        # HA config examples and setup guide
```

## License

MIT
