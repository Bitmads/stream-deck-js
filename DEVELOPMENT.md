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
- `sd-core` — Pure library, no Tauri dependency. Device HID, image processing, profile schemas, plugin protocol.
- `sd-tauri` — Tauri app shell. IPC commands, HTTP API server, WebSocket server, state.

Frontend in `packages/ui/`:
- State in `src/lib/stores/store.svelte.ts` (AppStore class)
- Components in `src/components/`
- Pages in `src/pages/`
- HA plugin in `src/lib/plugins/homeassistant/`

## Adding a New Device

Edit `crates/sd-core/src/device/profile.rs`, add one entry to `DEVICE_PROFILES`:

```rust
DeviceProfile {
    id: "new_device",
    display_name: "Stream Deck New",
    usb_pid: 0xNNNN,
    columns: 5, rows: 3,
    key_pixel_size: 72,
    image_format: ImageFormat::Jpeg,
    protocol_version: ProtocolVersion::V2,
    key_data_offset: 4,
    has_lcd_strip: false, has_dials: false,
    encoder_count: 0, lcd_strip_width: 0, lcd_strip_height: 0,
    rotate_image: true, // false for Plus/Neo
},
```

No other code changes needed. The frontend auto-adapts grid layout, encoder display, and LCD strip from the profile data.

## Adding a New Action Type

**Built-in (Rust-executed):**
1. Add handling in `crates/sd-tauri/src/commands/action.rs` → `execute_single()`
2. Add to `BUILTIN_ACTIONS` in `store.svelte.ts`
3. Add default settings in `getDefaultSettings()`
4. Add UI in `PropertyPanel.svelte` (inside the action settings block)

**Plugin-executed (frontend):**
```typescript
import { registerActionType } from "./stores/store.svelte";

registerActionType(
  { id: "my-action", label: "My Action", icon: "X", color: "#ff0000" },
  async (settings) => {
    // Execute the action with resolved settings
  }
);
```

## Adding a New Variable Filter

Edit `AppStore.FILTERS` in `store.svelte.ts`:

```typescript
private static FILTERS: Record<string, (val: string) => string> = {
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
    min: 0, max: 100, step: 1
  });
}
```

## Key Patterns

**Mutation flow:** User action → store method → update state → `revision++` → `scheduleSave()` → `saveAndSync(keyIndex)` (for keys) or `syncStrip()` (for strip).

**Variable flow:** Source (HA/API/timer) → `setVariableLocal()` → `varRevision++` → KeySlot `$effect` re-fires → preview + debounced device push.

**Selection:** `selectedKeyIndex`, `selectedEncoderIndex`, `selectedStripItemId` are mutually exclusive. Setting one clears the others.

**Deep clone:** Always use `JSON.parse(JSON.stringify(...))` when moving data between devices in `profileDevices`. Shallow spread shares Scene objects.

**Echo suppression:** After `setVariable()` (local), `setVariableLocal()` (remote) is ignored for 500ms for that variable name.

## Testing

```bash
# Rust check
cargo check --workspace

# Frontend build
pnpm --filter @open-stream-deck/ui build

# Full app
cargo tauri dev

# Production
cargo tauri build
```

## Common Issues

**"No device open"** — Device not detected. Check USB permissions (udev rules), `lsusb | grep Elgato`.

**Settings lost on restart** — Check `~/.config/open-stream-deck/profile_default.json` exists and has data. Ensure `initStore` awaits before `refreshDevices`.

**Variables not updating on device** — Check `stripUsesVariable()` returns true. Check echo suppression isn't blocking (500ms window). Check KeySlot `usedVarValues` tracks the variable.

**HA "Not connected"** — Token expired or HA unreachable. Settings → HA → reconnect. Auto-reconnect happens after 5s on disconnect.

**Stream Deck+ images upside down** — `rotate_image` flag in device profile. Plus/Neo = false, others = true.
