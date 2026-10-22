# Development Guide

## Prerequisites

**System (Linux/Debian/Ubuntu):**
```bash
sudo apt-get install -y libwebkit2gtk-4.1-dev librsvg2-dev patchelf \
  libssl-dev libgtk-3-dev libayatana-appindicator3-dev libsoup-3.0-dev \
  libjavascriptcoregtk-4.1-dev libudev-dev libhidapi-dev
```

**Rust:**
```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
```

**Node.js 20+ and pnpm:**
```bash
corepack enable pnpm
```

**Tauri CLI:**
```bash
cargo install tauri-cli --version '^2' --locked
```

**Stream Deck USB permissions (Linux):**
```bash
sudo bash -c 'echo "SUBSYSTEM==\"usb\", ATTRS{idVendor}==\"0fd9\", TAG+=\"uaccess\"" > /etc/udev/rules.d/70-streamdeck.rules'
sudo udevadm control --reload-rules && sudo udevadm trigger
```
Unplug and replug your Stream Deck after this.

## Running

```bash
pnpm install
cargo tauri dev
```

DevTools opens automatically in debug mode. Frontend hot-reloads via Vite on port 5173.

## Project Layout

Two Rust crates in `crates/`:
- `sd-core` — Pure library, no Tauri dependency. Device HID and packet formats, image encoding, atomic file writes, plugin lifecycle and Node discovery.
- `sd-tauri` — Tauri app shell. IPC commands, HTTP API server, WebSocket server, state.

Frontend in `packages/ui/`:
- State in `src/lib/stores/store.svelte.ts` (AppStore class)
- Components in `src/components/`
- Pages in `src/pages/`
- Built-in action plugins in `src/lib/plugins/` (homeassistant, multi-action, system, http, navigation, utilities)
- External (.sdPlugin) bridge in `src/lib/plugins/external/`
- Device rendering/push in `src/lib/stores/device-sync.svelte.ts`, renderers in `src/lib/utils/`

## Adding a New Device

Edit `crates/sd-core/src/device/profile.rs`, add one entry to `DEVICE_PROFILES`:

```rust
// A gen2 (JPEG) grid model:
gen2_grid("new_device", "Stream Deck New", 0xNNNN, 5, 3, 72),
```

Models with a different input report, packet layout or pixel transform need a full `DeviceProfile`
entry (see the Original, Mini, Pedal, Plus and Neo entries). Check the values against the upstream
[node-elgato-stream-deck](https://github.com/Julusian/node-elgato-stream-deck) model definitions and
add a unit test next to the existing ones. The frontend adapts the grid, key pixel size, encoders and
LCD strip from `list_devices`.

## Adding a New Action Type

Every action is registered by a plugin (`PluginDef` in `src/lib/stores/plugins.svelte.ts`) and run
through `store.executeAction(actionId, settings, ctx)`, which resolves templates per setting value and
then calls the plugin's executor:

```typescript
// src/lib/plugins/my-plugin/index.ts
import type { PluginDef } from "../../stores/plugins.svelte";

const MY_ACTION = { id: "my-action", label: "My Action", icon: "X", color: "#ff0000" };

export const myPluginDef: PluginDef = {
  id: "my-plugin",
  name: "My Plugin",
  description: "Does something",
  version: "1.0.0",
  author: "Me",
  icon: "X",
  type: "builtin",
  actions: [MY_ACTION],
  actionExecutors: {
    // settings are already template-resolved; ctx = { serial, sceneId?, keyIndex? }
    "my-action": async (settings, ctx) => { /* ... throw on failure ... */ },
  },
};
```

Then:
1. Register it in `App.svelte` next to the other `registerPlugin(...)` calls.
2. Add default settings in `getDefaultSettings()` in `store.svelte.ts`.
3. Add its settings UI in `src/components/input/ActionSettingsEditor.svelte` (used for keys, encoders and strip gestures) and, if needed, in `MultiActionEditor.svelte`.
4. If it runs in Rust, add a branch in `crates/sd-tauri/src/commands/action.rs` → `execute_single()` and call `invoke("execute_action", ...)` from the executor. Unknown action types return an error.

Settings that hold a JSON blob must be listed in `RAW_SETTINGS` in `store.svelte.ts` so the executor can
parse first and resolve templates per value. Settings run by `sh -c` belong in `SHELL_SETTINGS` so
substituted variables are shell-quoted.

## Adding a New Variable Filter

Edit `FILTERS` in `src/lib/utils/template.ts` and add a test in `template.test.ts`:

```typescript
export const FILTERS: Record<string, (val: string) => string> = {
  // existing filters...
  myfilter: (v) => v.toUpperCase() + "!",
};
```

Usage: `{{$varName|myfilter}}`

## Adding a New HA Entity Control

Edit `getEntityControls()` in `packages/ui/src/lib/plugins/homeassistant/client.ts`. Controls are detected from entity attributes:

```typescript
if (attrs.some_attribute !== undefined) {
  controls.push({
    id: "some_attr", label: "Some Control",
    domain, service: "set_something", attr: "some_attribute",
    min: 0, max: 100, step: 1,
    readAttr: "some_attribute", // attribute that holds the current value, if it differs from attr
  });
}
```

## Key Patterns

**Mutation flow:** User action → store method → update state → `scheduleSave()` (debounced, flushed on page hide). Device sync notices the changed state and re-renders only the keys/strip whose resolved inputs changed.

**Variable flow:** Source (HA/API/timer) → `setVariableLocal()` → `variables[name]` changes → device-sync and KeySlot previews that read that variable re-render.

**Runtime display (timers, counters, plugins):** use `store.setRuntimeOverride(ctx, {title, image, state, flash})`; never write runtime values into persisted key text.

**Selection:** `selectedKeyIndex`, `selectedEncoderIndex`, `selectedStripItemId` are mutually exclusive. Setting one clears the others.

**Copying profile data:** use `cloneJson()` from `src/lib/utils/profile.ts` when copying scenes, keys or settings (duplicate scene, undo snapshots). A shallow spread shares nested objects.

**Echo suppression:** After `setVariable()` (local), `setVariableLocal()` (remote) is ignored for 500ms for that variable name.

## Testing

```bash
# Rust
cargo test --workspace
cargo clippy --workspace --all-targets

# Frontend
pnpm --filter @open-stream-deck/ui check
pnpm --filter @open-stream-deck/ui test
pnpm --filter @open-stream-deck/ui build

# Deck-as-code generator
pnpm --filter @open-stream-deck/deck test
pnpm --filter @open-stream-deck/deck check

# Full app
cargo tauri dev

# Production
cargo tauri build
```

CI (`.github/workflows/ci.yml`) runs `cargo check --workspace`, `cargo test --workspace` and the UI `check`, `test` and `build` scripts. UI tests (vitest) cover templates, rendering inputs, the store (navigation, saving, overrides), profile parsing (including a redacted real profile fixture in `src/lib/utils/__fixtures__/`), multi-action steps, HA value mapping and the external plugin payloads.

## External Plugins

`plugins/stock-quotes.sdPlugin` is the example plugin. It is not part of the pnpm workspace; its bundled `plugin.js` is built with esbuild and shipped as an app resource by `cargo tauri build`:

```bash
cd plugins/stock-quotes.sdPlugin
npm ci
npm run build       # writes plugin.js
npm run typecheck
```

During `cargo tauri dev` the repository's `plugins/` folder is scanned directly; release builds copy the bundled plugins into `~/.config/open-stream-deck/plugins/`.

`packages/deck` builds, validates and applies profiles from TypeScript deck files (`pnpm --filter @open-stream-deck/deck deck build <deck.ts> --dry-run`); see `packages/deck/README.md`. Personal decks belong in the gitignored `decks/` folder.

`packages/plugin-sdk` (`pnpm --filter @open-streamdeck/sdk build`) is a TypeScript helper for writing plugins against the subset of the protocol listed in the README.

## Common Issues

**"No device open"** — Device not detected. Check USB permissions (udev rules), `lsusb | grep Elgato`.

**Settings lost on restart** — Check `~/.config/open-stream-deck/profile_<name>.json` (and `activeProfile` in `app_settings.json`). If the file fails to parse, the status bar shows the error and the app refuses to overwrite it; a previous copy is in `profile_<name>.json.bak`.

**Variables not updating on device** — Check the variable exists (`GET /api/variables`) and that echo suppression isn't holding it (500ms window after a local set). Device sync fingerprints resolved inputs, so a key only resends when its own output changes.

**HA "Not connected"** — Token expired or HA unreachable. Settings → HA shows the last error. Reconnects back off from 1s to 10s; an invalid token stops reconnecting until you press Connect again.

**Images upside down / mirrored** — per-model `key_transform` / `lcd_transform` in the device profile (matching upstream).

**External plugin "Failed"** — See the Plugins page error. Usually no Node.js >= 18 was found; set **Settings → Node.js path for plugins**.
