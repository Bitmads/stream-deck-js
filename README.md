# Open Stream Deck

An open-source Stream Deck controller with a visual GUI, a plugin system that speaks a subset of the Elgato SDK protocol, and Home Assistant integration.

Built with **Tauri v2** (Rust backend) + **Svelte 5** (frontend). Developed and used on Linux with a Stream Deck +; macOS and Windows builds exist but are untested.

## Features

- **Visual key editor** with icon browser, multi-layer text, custom backgrounds, and live preview
- **Scenes** with triggers (window focus, manual) and stack-based navigation (push/switch)
- **Profiles** with per-device scene layouts, saved to disk and switchable at runtime
- **Multi-device support** -- every connected deck shows its own active scene and has its own navigation stack, independent of which deck is selected in the editor
- **Variable system** with template syntax (`{{$var.name}}`), filters (`|round`, `|f2c`, `|upper`, etc.), conditional mapping (`|map:on=#ff9800:*=#000`), replace (`|replace:-=`) and defaults (`|default:--`)
- **Built-in variables** -- `time.now`, `time.date`, `time.hours`, `time.minutes`, `time.seconds`, `window.title`, `window.app`
- **Conditional icons** -- a key can hold several icons, each shown when a template equals a value
- **Home Assistant WebSocket integration** -- direct entity/service access, watched entities auto-sync to variables, two-way binding
- **Stream Deck+ support** -- 4 rotary encoders, 800x100 LCD touchstrip with bar indicators, tap/long press/swipe gestures
- **Elgato SDK-style plugin system** -- discovers `.sdPlugin` folders, launches them with Node.js, and talks to them over a local WebSocket using a subset of the Elgato protocol (see [Plugin System](#plugin-system))
- **HTTP REST API** on port 8484 -- endpoints for variables, devices, brightness, action execution and profile replace/reload
- **API key security** -- keys generated and stored in your OS keychain, Bearer token auth with constant-time comparison; without a key only local clients are served
- **Chrome extension** -- syncs pinned tabs and active tab info to Stream Deck variables (`chrome.pinned.*`, `chrome.active.*`)
- **Action types** -- Hotkey, Launch App, Shell Command, Open URL, HTTP Request, Switch Scene, Back, Multi-Action (sequenced with delays), Timer, Counter, HA Service Call, HA Custom JSON
- **Undo/redo** (Ctrl+Z / Ctrl+Shift+Z or Ctrl+Y, outside text fields) for key edits, per scene
- **System tray** -- closing the window hides it to the tray (configurable); optional start on login and start minimized; a second launch shows the running instance

## Supported Devices

| Device | USB PID | Keys | Extras | Status |
|--------|---------|------|--------|--------|
| Stream Deck + | `0x0084` | 4x2 (120px, JPEG) | 4 encoders, 800x100 LCD touchstrip | **Tested on hardware** |
| Stream Deck Original | `0x0060` | 5x3 (72px, BMP) | -- | Untested on hardware |
| Stream Deck Original V2 | `0x006d` | 5x3 (72px, JPEG) | -- | Untested on hardware |
| Stream Deck MK.2 | `0x0080`, `0x00a5` | 5x3 (72px, JPEG) | -- | Untested on hardware |
| Stream Deck Mini / Mini V2 | `0x0063`, `0x0090`, `0x00b3` | 3x2 (80px, BMP) | -- | Untested on hardware |
| Stream Deck 6 Module | `0x00b8` | 3x2 (80px, BMP) | -- | Untested on hardware |
| Stream Deck XL / XL V2 | `0x006c`, `0x008f` | 8x4 (96px, JPEG) | -- | Untested on hardware |
| Stream Deck 15 / 32 Module | `0x00b9`, `0x00e4`, `0x00ba` | 5x3 (72px) / 8x4 (96px), JPEG | -- | Untested on hardware |
| Stream Deck Pedal | `0x0086` | 3 pedals | No display | Untested on hardware |
| Stream Deck Neo | `0x009a` | 4x2 (96px, JPEG) | 2 touch page buttons, 248x58 info screen | Untested on hardware; the info screen and page buttons are not used by the UI |

Only the Stream Deck + has been tried on a real device. Every other model is implemented from the
upstream [node-elgato-stream-deck](https://github.com/Julusian/node-elgato-stream-deck) model
definitions (geometry, input report offsets, BMP/JPEG packet layouts, image flips) and covered by unit
tests in `crates/sd-core`, but has not been tested on hardware.

## Stream Deck+ Details

The Stream Deck+ has hardware beyond standard keys:

- **4 rotary encoders** -- press and rotate events. Each encoder can be bound to a press action and a rotate action with configurable step, min, max, and label. Values support variable templates (`{{$var}}`).
- **800x100 LCD touchstrip** -- renders strip items with backgrounds, icons, text layers, and bar indicators (progress fills with configurable position, color, and value range). Colors and values support variable templates including `{{$var|rgb}}` and `{{$var|kelvin}}`.
- **Touch gestures** -- the touchstrip reports tap (short press with x/y coordinates), long press, and swipe (from/to coordinates). Each strip item can bind separate actions to tap, long press, and swipe events.

## Variable System

Variables are key-value strings. Templates work in key and strip text, text/background/bar colors, image URLs, encoder/bar values and ranges, conditional icons, and action settings (resolved when the action runs; values substituted into Shell Command and Launch App are shell-quoted).

**Syntax:** `{{$variable.name}}` or `{{$variable.name|filter}}`

- The `$` is optional. An expression ends at the first `}}`, and filters are separated by `|`.
- Templates nest, innermost first: `{{$stock.{{$deck.pos|map:0=BTC:1=NVDA}}.price}}` picks the variable by another variable. Substituted values are never re-parsed as templates.
- A variable that is not set renders as an empty string; filters are skipped while there is no value. Use `default:` to show something else: `{{$temp|round|default:--}}` (also used when the value is empty).
- Numeric filters on non-numeric input give an empty string (never `NaN` or `0`).
- For older profiles, a segment that is not a filter name is used as a fallback text when the variable is unset (`{{$x|N/A}}`).

**Built-in variables:**

| Variable | Source | Example |
|----------|--------|---------|
| `{{$time.now}}` | Clock (1s update) | `14:30` |
| `{{$time.date}}` | Clock | `3/26/2026` |
| `{{$time.hours}}` / `{{$time.minutes}}` / `{{$time.seconds}}` | Clock, two digits | `09` |
| `{{$window.title}}` | Active window tracker (500ms) | `main.rs - VS Code` |
| `{{$window.app}}` | Active window tracker | `Code` |

**Filters** (chain with `|`):

| Filter | Example | Result |
|--------|---------|--------|
| `round` | `{{$temp\|round}}` | `27` |
| `round1` / `round2` | `{{$temp\|round1}}` | `27.6` |
| `floor` / `ceil` / `abs` | `{{$val\|floor}}` | `27` |
| `percent` | `{{$ratio\|percent}}` | `75%` |
| `upper` / `lower` / `trim` | `{{$name\|upper}}` | `HELLO` |
| `f2c` / `c2f` | `{{$temp\|f2c\|round}}` | `27` |
| `kelvin` | `{{$ct\|kelvin}}` | `#ffd4a0` |
| `rgb` | `{{$color\|rgb}}` (`255, 136, 0` or `[255,136,0]`) | `#ff8800` |
| `map:k=v:*=d` | `{{$state\|map:on=#f90:*=#000}}` | `#f90` or `#000`; no match and no `*` keeps the value |
| `replace:s=r` | `{{$text\|replace:-=}}` | remove dashes |
| `replace:/re/f=r` | `{{$text\|replace:/\\d+/g=}}` | remove numbers |
| `default:x` | `{{$temp\|default:--}}` | `--` when the variable is unset or empty |

In `map:` and `replace:` arguments, `\:` and `\=` stand for a literal `:` and `=`.
Colors from templates must resolve to `#hex`, `rgb()`/`rgba()`, `hsl()`/`hsla()` or a CSS color name; anything else falls back to the default color.

**Autocomplete:** Type `{{$` in any text field to see available variables with current values.

**External variables** can be set via the REST API (`PUT /api/variables/{name}`) or from Home Assistant watched entities (`ha.<entity_id>.<attribute>`).

**Home Assistant statistics** (long-term statistics of watched sensors, refreshed every 5 minutes and on reconnect):

| Variable | Source | Value |
|---|---|---|
| `ha.<sensor>.stats.today`, `ha.<sensor>.stats.month` | energy sensors (`device_class: energy`, `state_class: total`/`total_increasing`) | kWh since midnight / the 1st (HA time zone) |
| `ha.<sensor>.stats.avg_24h`, `ha.<sensor>.stats.max_24h` | power sensors (`device_class: power`, `state_class: measurement`) | W over the last 24 h (5-minute statistics) |
| `ha.<sensor>.stats.chart_24h` | power sensors | PNG data URL of the 24 h curve (use as a strip/key image URL) |
| `ha_stats.power_now` | all watched power sensors | W, current sum |
| `ha_stats.energy_today`, `ha_stats.energy_month` | all watched energy sensors | kWh, sums |

## Plugin System

Plugins use the Elgato Stream Deck SDK folder format, with a subset of its protocol:

- Place a folder named `*.sdPlugin` in `~/.config/open-stream-deck/plugins` (debug builds also scan the repo's `plugins/`)
- Include a `manifest.json` with `Name`, `UUID`, `Version`, `CodePath`, `Actions` and optionally `Nodejs.Version`
- The app runs `CodePath` (a `.js`/`.mjs`/`.cjs` file with Node.js, anything else as an executable) with `-port`, `-pluginUUID` (the manifest UUID), `-registerEvent registerPlugin` and `-info`
- Node.js resolution: the **Node.js path for plugins** setting (`nodePath`) is used as-is if set (it must still meet the minimum version); otherwise nvm, volta, fnm, `PATH` and `/usr/local/bin`, `/opt/homebrew/bin`, `/usr/bin` are searched and the highest version >= max(18, manifest `Nodejs.Version`) is used
- Only plugins the app started may register (one live connection per plugin, no browser origins); nothing is processed before `registerPlugin`
- Action contexts are `<serial>:<sceneId>:<Keypad|Encoder>:<index>`
- Plugin settings: a `config.schema.json` next to the manifest gets a settings form on the Plugins page, saved to the plugin's `config.json`
- App to plugin: `willAppear`/`willDisappear`, `keyDown`/`keyUp`, `dialRotate`/`dialDown`/`dialUp`, `didReceiveSettings`, `didReceiveGlobalSettings`
- Plugin to app: `setTitle`, `setImage`, `setState`, `showOk`, `showAlert`, `setSettings`/`getSettings`, `setGlobalSettings`/`getGlobalSettings`, `openUrl` (http/https only), `logMessage`
- Not supported: property inspectors (`sendToPropertyInspector`, `registerPropertyInspector`), `switchToProfile`, `setFeedback`/`setFeedbackLayout`
- Extended with `setVariable`/`getVariable` for the Open Stream Deck variable system
- Crash handling: at most 5 automatic restarts per 10 minutes with exponential backoff (1s, doubling, up to 60s), after which the plugin is marked failed (see the Plugins page). All plugin processes are stopped when the app quits

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
- Debounced sync on tab events, periodic re-sync every minute
- Talks to `http://127.0.0.1:8484` only
- Load the extension in Chrome via `chrome://extensions` (Developer mode, Load unpacked). If you generated API keys, open the extension's options and paste a key

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
| POST | `/api/actions/execute` | Yes* | Execute an action (`{"action_type": "...", "settings": {...}}`); unknown types return 400 |
| GET | `/api/profile/{name}` | Yes** | Read `profile_<name>.json` |
| PUT | `/api/profile/{name}` | Yes** | Replace `profile_<name>.json` (body: full profile JSON with a `devices` object, up to 64 MB); written atomically with one `.bak` copy, then loaded in the UI |
| POST | `/api/profile/reload` | Yes** | Load a profile from disk (`{"name": "work"}`; empty body or no `name` = `default`); 404 if the file does not exist |

\*Without any API key, only local (loopback) clients are served and every other client gets 403. Once a key exists, every endpoint except `/api/health` needs `Authorization: Bearer <key>`, and any stored, non-revoked key is accepted. Until the stored keys have been read from the OS keychain (at startup, or while the keychain is locked) the API answers 503 unless a valid key is sent; it never falls back to keyless access.

\*\*The profile endpoints are always allowed from local clients without a key; remote clients need a key.

The file format is described in [ARCHITECTURE.md](ARCHITECTURE.md#persistence) and typed in `packages/ui/src/lib/types/profile.ts`. Profile names are 1-64 characters. Loading a profile through `PUT` or `reload` whose name differs from the active one makes it the active profile (remembered in `app_settings.json`). If the file is broken, the UI keeps its current state, shows the error and does not overwrite the file. A file edited by hand also wins over a pending UI autosave: the UI reloads instead of overwriting it.

The listen address comes from `apiBind` in `~/.config/open-stream-deck/app_settings.json` (also editable in **Settings**, default `0.0.0.0`). Use `127.0.0.1` if nothing on your network needs the API.

## Security

- API keys are generated in the app: **Settings** > **API Keys** > **Generate Key**
- Keys are stored in your OS keychain: Secret Service (such as GNOME Keyring) on Linux, Keychain on macOS, Credential Manager on Windows (only the Linux backend has been tested)
- Add the key as a `Bearer` token in the `Authorization` header for REST API requests. Every stored key works until it is revoked
- Constant-time comparison prevents timing attacks
- Without any API key, the API serves only loopback clients. Loopback requests are also refused when they carry a non-local `Host` or a foreign web `Origin`, which blocks DNS rebinding and drive-by web pages
- **The API can run shell commands** (`/api/actions/execute` with `command`/`launch`). Anyone holding a key can do that, so treat keys like passwords, and generate one before exposing the API to your LAN (for example for Home Assistant)
- Profiles and config files are written atomically with mode `0600`
- Plugin WebSocket server binds to `127.0.0.1` only, rejects browser origins and only accepts plugins the app launched

## Prerequisites

### System Dependencies

**Linux (Debian/Ubuntu):**

```bash
sudo apt-get install -y libwebkit2gtk-4.1-dev librsvg2-dev patchelf \
  libssl-dev libgtk-3-dev libayatana-appindicator3-dev libsoup-3.0-dev \
  libjavascriptcoregtk-4.1-dev libudev-dev libhidapi-dev
```

The **Hotkey** action uses `xdotool` on Linux (X11): `sudo apt-get install -y xdotool`.

**Rust:**

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
```

**Node.js 20+** and **pnpm**:

```bash
corepack enable pnpm
```

**Tauri CLI:**

```bash
cargo install tauri-cli --version '^2' --locked
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

# Checks and tests
cargo test --workspace
pnpm --filter @open-stream-deck/ui check
pnpm --filter @open-stream-deck/ui test
```

## Project Structure

```
open-stream-deck/
├── crates/
│   ├── sd-core/              # Core library
│   │   ├── device/           #   Device profiles, HID manager, input parsing (keys, encoders, LCD touch)
│   │   ├── image/            #   Key/LCD image encoding (BMP for gen1, JPEG for gen2, per-model flips)
│   │   ├── platform/         #   Active window detection
│   │   ├── plugin/           #   Plugin manifest, Node discovery, lifecycle (start/stop/restart policy), protocol types
│   │   └── profile/          #   Atomic file writes, profile .bak, profile name/shape validation
│   └── sd-tauri/             # Tauri app shell
│       ├── api_server.rs     #   HTTP REST API (Axum, port 8484)
│       ├── ws_server.rs      #   Plugin WebSocket server (PluginHub)
│       ├── commands/         #   Tauri IPC commands (action, api_keys, app_settings, device, plugin, proxy, storage, variables, window)
│       ├── state.rs          #   Shared app state
│       └── main.rs           #   Entry point, system tray, state init
├── packages/
│   ├── ui/                   # Svelte 5 frontend
│   │   ├── components/       #   DeviceGrid, KeySlot, IconBrowser, TextConfig, PropertyPanel, ActionSettingsEditor, etc.
│   │   ├── pages/            #   Settings (HA, API keys, Node path), Profiles, Plugins
│   │   └── lib/
│   │       ├── stores/       #   AppStore (the profile model), device-sync (renders and pushes every device)
│   │       ├── plugins/      #   Built-in action plugins (Home Assistant, multi-action, ...) and the external plugin bridge
│   │       ├── types/        #   Persisted profile types
│   │       └── utils/        #   Key/strip renderers, templates, icons, image cache
│   ├── deck/                 # Deck-as-code: build, validate and apply profiles from TypeScript
│   └── plugin-sdk/           # TypeScript SDK for external plugins
├── plugins/
│   ├── chrome-pinned-tabs/   # Chrome extension for tab sync
│   └── stock-quotes.sdPlugin/ # Example external plugin
└── examples/
    └── homeassistant/        # HA config examples and setup guide
```

## License

MIT
