# Open Stream Deck + Home Assistant Setup Guide

This guide covers the built-in WebSocket integration (recommended) and the REST API fallback method.

---

## Method 1: WebSocket Integration (Recommended)

The app connects directly to Home Assistant over WebSocket. This gives you real-time entity states, service calls, entity discovery, and auto-variable sync -- all without writing any HA automations.

### Step 1: Create a Long-Lived Access Token in HA

1. Open your Home Assistant UI
2. Click your profile icon (bottom left of the sidebar)
3. Scroll to **Long-Lived Access Tokens**
4. Click **Create Token**, name it "Open Stream Deck"
5. **Copy the token** (it is only shown once)

### Step 2: Connect in Open Stream Deck

1. In the app, go to **Settings**
2. Under **Home Assistant**, enter:
   - **URL**: Your HA instance URL (e.g. `http://homeassistant.local:8123` or `https://your-ha-domain.com`)
   - **Token**: The long-lived access token from Step 1
3. Click **Connect**
4. The status indicator turns green and shows the entity count (e.g. "Connected (247 entities)")

The connection persists across app restarts. If it drops, the app reconnects with a backoff from 1 to 10 seconds; an invalid token stops reconnecting until you press **Connect** again, and the error is shown in Settings.

### Step 3: Watch Entities

Watched entities automatically sync their state and all attributes to app variables.

1. In **Settings** > **Home Assistant** > **Watched Entities**, type an entity name in the search box
2. Click an entity to add it to the watch list
3. Its state and attributes immediately become available as variables

For example, watching `light.living_room` creates these variables:

| Variable | Example value |
|----------|---------------|
| `ha.light.living_room.state` | `on` |
| `ha.light.living_room.friendly_name` | `Living Room` |
| `ha.light.living_room.brightness` | `178` |
| `ha.light.living_room.color_temp_kelvin` | `3200` |
| `ha.light.living_room.min_color_temp_kelvin` | `2000` |
| `ha.light.living_room.max_color_temp_kelvin` | `6500` |

Use these in any key text layer, encoder binding, or strip item: `{{$ha.light.living_room.brightness}}`

Variables exist only for watched entities. Object-valued attributes are skipped and lists are joined with `, `. Level attributes that Home Assistant drops while the entity is off (`brightness`, `volume_level`, `percentage`, `current_position`, `current_tilt_position`) become `0`; any other attribute that disappears becomes an empty string. Picking a control in the HA Service Call action adds the entity to the watch list automatically.

### Step 4: Configure Actions

#### HA Service Call (key press)

1. Click a key in the editor
2. In the action list, select **HA Service Call**
3. Search for an entity (e.g. `light.living_room`)
4. The app auto-detects available services for that entity's domain and shows controllable attributes (brightness, color temp, volume, etc.)
5. Choose a service (e.g. `light.toggle`) and optionally configure service data
6. Press the physical key to trigger the service call

#### HA Custom JSON

For advanced use, select the **HA Custom JSON** action type and provide raw WebSocket JSON:

```json
{
  "domain": "light",
  "service": "turn_on",
  "service_data": { "brightness": 200, "color_temp_kelvin": 3000 },
  "target": { "entity_id": "light.living_room" }
}
```

### Step 5: Stream Deck+ Encoder Setup

Encoders are ideal for continuous controls like brightness, volume, and color temperature.

1. Select an encoder slot in the editor
2. Set the **rotate action** to **HA Service Call**
3. Pick an entity (e.g. `light.living_room`)
4. Select a control attribute (e.g. Brightness)
5. The min/max/step are auto-detected from the entity's attributes
6. Rotating the dial calls the HA service with the adjusted value

Controls detected automatically per domain:

| Domain | Control | Service | Attribute | Range |
|--------|---------|---------|-----------|-------|
| light | Brightness | `turn_on` | `brightness` | 0-255 (step 5) |
| light | Color Temperature | `turn_on` | `color_temp_kelvin` | entity min/max (default 2000-6500), step 100 |
| media_player | Volume | `volume_set` | `volume_level` | 0-1 (step 0.05) |
| climate | Temperature | `set_temperature` | `temperature` | entity min/max (default 16-30), step `target_temp_step` (default 0.5) |
| cover | Position | `set_cover_position` | `position` (current value read from `current_position`) | 0-100 (step 5) |
| fan | Speed | `set_percentage` | `percentage` | 0-100, step `percentage_step` (default 10) |
| number/input_number | Value | `set_value` | `value` (current value read from the state) | entity min/max/step |

### Step 6: LCD Touchstrip Setup (Stream Deck+)

The touchstrip can display live data and respond to touch gestures.

#### Brightness bar example

1. Add a strip item in the editor
2. Set the **bar** properties:
   - **value**: `{{$ha.light.living_room.brightness}}`
   - **min**: `0`
   - **max**: `255`
   - **color**: `{{$ha.light.living_room.color_temp_kelvin|kelvin}}` (shows the actual light color)
   - **position**: `bottom`
3. Add a text layer: `{{$ha.light.living_room.brightness|round}}`

#### Tap as slider

Bind the strip item's **tap action** to **HA Service Call** with the brightness attribute. When tapped, the x-coordinate is mapped as a ratio (0-1) across the strip item's width, scaled to the control's min-max range and snapped to its step, so fractional ranges such as volume 0-1 work. Tapping the middle of a brightness bar sets brightness to about half (130).

#### Long press for toggle

Bind the strip item's **long press action** to **HA Service Call** with service `light.toggle`. A long press on the bar toggles the light on/off.

#### Swipe to adjust

Bind the strip item's **swipe action** to **HA Service Call** with the brightness attribute. The swipe destination x-coordinate (`to_ratio`) is mapped to the control's range in the same way.

### Two-Way Binding

The integration is fully two-way:

- **HA to Deck**: When a watched entity's state changes in Home Assistant (e.g. someone turns on a light from the HA app, a physical switch, or another automation), the Stream Deck variables update in real-time and the display re-renders immediately.
- **Deck to HA**: When you press a key, rotate an encoder, or gesture on the touchstrip, the app calls the HA service over WebSocket. Home Assistant processes the command, the entity state changes, and the state_changed event flows back to update the deck display.

No polling. The WebSocket subscription to `state_changed` events provides instant updates.

### Variable Filters

Filters transform variable values for display or color rendering. Use them with a pipe: `{{$variable|filter}}`

| Filter | Purpose | Example input | Example output |
|--------|---------|---------------|----------------|
| `kelvin` | Color temp to hex color | `3200` | `#ffb46b` |
| `rgb` | Comma-separated RGB to hex | `255,128,0` | `#ff8000` |
| `round` | Round to nearest integer | `22.7` | `23` |
| `floor` | Round down | `22.7` | `22` |
| `ceil` | Round up | `22.1` | `23` |
| `percent` | Decimal to percentage | `0.75` | `75%` |
| `round1` | One decimal | `22.66` | `22.7` |
| `f2c` | Fahrenheit to Celsius | `72.5` | `22.5` |
| `upper` | Uppercase | `on` | `ON` |
| `lower` | Lowercase | `ON` | `on` |
| `map:` | Map values | `on` with `map:on=#f90:*=#000` | `#f90` |
| `default:` | Value while unset/empty | (unset) with `default:--` | `--` |

The full list is in the main [README](../../README.md#variable-system). A variable that does not exist yet renders as an empty string (or the `default:` value).

Common patterns:
- Background color from light temp: `{{$ha.light.living_room.color_temp_kelvin|kelvin}}`
- Background color from RGB light: `{{$ha.light.living_room.rgb_color|rgb}}`
- Show a placeholder until HA has synced: `{{$ha.sensor.outdoor_temp.state|round1|default:--}}`
- State label: `{{$ha.light.living_room.state|upper}}`

---

## Method 2: REST API (HA Automations Push to Deck)

If you cannot use WebSocket (e.g. the deck is on a different network), Home Assistant can push variable updates to the deck's REST API.

### Step 1: Generate an API Key in Open Stream Deck

An API key is required: without any key the API only answers requests from the PC itself, and Home Assistant gets `403 Forbidden`.

1. Go to **Settings** > **API Keys**
2. Type a name (e.g. "Home Assistant") and click **Generate Key**
3. **Copy the key** (it is only shown once)
4. Click "I've saved it"

### Step 2: Add REST Command in HA

Open `configuration.yaml` in Home Assistant and add:

```yaml
rest_command:
  deck_set_variable:
    url: "http://YOUR_PC_IP:8484/api/variables/{{ name }}"
    method: PUT
    headers:
      Authorization: "Bearer YOUR_API_KEY_HERE"
    content_type: "application/json"
    payload: '{"value": "{{ value }}"}'
```

Replace `YOUR_PC_IP` with your PC's IP and `YOUR_API_KEY_HERE` with the key from Step 1.

Reload: **Developer Tools** > **YAML** > **REST commands** > **Reload**

### Step 3: Create Automations

Create automations that trigger on entity state changes and call the REST command to push the new value.

**Temperature sensor:**
```yaml
automation:
  - alias: "Deck: Living room temp"
    trigger:
      - platform: state
        entity_id: sensor.living_room_temperature
    action:
      - service: rest_command.deck_set_variable
        data:
          name: "ha.temp.living"
          value: "{{ states('sensor.living_room_temperature') }}C"
```

**Light status:**
```yaml
  - alias: "Deck: Living room light"
    trigger:
      - platform: state
        entity_id: light.living_room
    action:
      - service: rest_command.deck_set_variable
        data:
          name: "ha.light.living"
          value: "{{ 'ON' if is_state('light.living_room', 'on') else 'OFF' }}"
      - service: rest_command.deck_set_variable
        data:
          name: "ha.light.living.brightness"
          value: "{{ state_attr('light.living_room', 'brightness') | default(0) | int }}"
```

### Step 4: Configure Keys

Use the REST-pushed variables in key text layers:
- `{{$ha.temp.living}}` shows `22C`
- `{{$ha.light.living}}` shows `ON`
- `{{$ha.light.living.brightness|round}}` shows `178`

---

## Deck to HA (Button Press Triggers HA)

For both methods, you can trigger HA from the deck:

**Option A (WebSocket, recommended):** Use the **HA Service Call** action type. It calls HA services directly over the WebSocket connection. No webhook setup needed.

**Option B (HTTP Webhook):** Use the **HTTP Request** action type:
- URL: `http://YOUR_HA_IP:8123/api/webhook/your-webhook-id`
- Method: POST
- Webhooks don't need authentication (the webhook ID is the secret)

Set up a webhook automation in HA: **Settings** > **Automations** > **Add Trigger** > **Webhook** > set an ID like `deck-lights` > **Add Action** > your desired action.

---

## Variable Reference

| Variable pattern | Source | Example |
|-----------------|--------|---------|
| `{{$ha.<entity_id>.state}}` | Watched entity (WebSocket) | `on` |
| `{{$ha.<entity_id>.<attr>}}` | Watched entity attribute | `178` |
| `{{$ha.temp.living}}` | REST API push | `22C` |
| `{{$time.now}}` | Built-in clock | `14:30` |
| `{{$time.date}}` | Built-in clock | `3/26/2026` |
| `{{$window.title}}` | Active window tracker | `main.rs - VS Code` |
| `{{$window.app}}` | Active window tracker | `Code` |
| `{{$chrome.pinned.0.title}}` | Chrome extension | `GitHub` |

Mix static text and variables: `Bedroom: {{$ha.sensor.bedroom_temp.state|round}}C`

---

## Network Requirements

- **WebSocket method**: Your PC must be able to reach HA on its configured port (default 8123)
- **REST method**: HA must be able to reach your PC on port **8484**
- Both devices should be on the same network (or properly routed)

## Security

- API keys protect the REST API at port 8484. Generate them in **Settings** > **API Keys**. Every stored key works until revoked
- Without any key, only local clients on the PC can use the API (Home Assistant gets 403)
- The API can run shell commands on your PC through `/api/actions/execute`, so keep the key secret
- The listen address is configurable in **Settings** (`apiBind`, default `0.0.0.0`)
- Keys are stored in your OS keychain (Secret Service such as GNOME Keyring / macOS Keychain / Windows Credential Manager)
- The WebSocket connection to HA uses a long-lived access token (stored in app config)
- The plugin WebSocket server binds to localhost only and is not network-accessible

## Summary

| Direction | Method | Auth |
|-----------|--------|------|
| Deck to HA (WebSocket) | HA Service Call action over WebSocket | HA long-lived access token |
| Deck to HA (HTTP) | HTTP Request action to HA webhook | No (webhook ID is the secret) |
| HA to Deck (WebSocket) | Watched entities auto-sync | HA long-lived access token |
| HA to Deck (REST) | `rest_command.deck_set_variable` to port 8484 | API key in Bearer header |
