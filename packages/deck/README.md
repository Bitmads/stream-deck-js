# @open-stream-deck/deck

Deck-as-code for Open Stream Deck. A deck file is TypeScript that describes devices, scenes, keys,
encoders and the touch strip with builder functions. The CLI turns it into the persisted profile
model (`packages/ui/src/lib/types/profile.ts`), validates it against everything the app relies on,
and merges it into a profile, either as a dry run, into a file, or live.

Runs on Node 22 with `--experimental-strip-types`. There is no build step. Imports use explicit
`.ts` extensions, and the code uses no enums, namespaces or parameter properties.

## Where decks live

Personal decks contain device serials, Home Assistant entity ids and hostnames. Keep them in
`<repo>/decks/`, which is gitignored. `examples/example.deck.ts` is a generic example with fake
serials and entity ids. Copy it to get started:

```bash
mkdir -p decks && cp packages/deck/examples/example.deck.ts decks/home.deck.ts
# then change the import in decks/home.deck.ts to "../packages/deck/src/index.ts"
```

## CLI

```bash
pnpm --filter @open-stream-deck/deck deck build <deck.ts> [options] [--dry-run | --out <file> | --apply]
```

Relative paths are resolved against the directory you ran the command from.

| Mode | What it does |
|---|---|
| `--dry-run` (default) | Prints a table per scene for keys, encoders and strip items, a merge summary and the validation report. Writes nothing. |
| `--out <file>` | Writes the merged profile JSON to `<file>`. Refuses paths inside the app config dir. |
| `--apply` | Merges into the live profile, then updates `ha_config.json` and `plugins.json` (see below). |

| Option | |
|---|---|
| `--profile <name>` | Profile to merge into (default `default`). |
| `--config-dir <dir>` | App config dir. Default: the app's own, `~/.config/open-stream-deck` on Linux (`$XDG_CONFIG_HOME` is honoured). |
| `--base <file>` | Base profile for `--dry-run`/`--out`. Default: the stored profile, read only. |
| `--ha-states <file>` | Home Assistant states JSON (`GET /api/states` output). Referenced entities and attributes are checked against it. The tool never contacts Home Assistant. |
| `--prune` | Drop scenes on the deck's devices that the deck does not define. |
| `--force-cold` | With `--apply`: write the files even though an app process is running and its API is unreachable. |

Exit code: 0 when validation passes, 1 on validation errors or a failed apply, 2 on usage errors.
`--out` and `--apply` write nothing when there are validation errors.

### Apply

- **Hot.** Used when the app answers `GET http://127.0.0.1:8484/api/health`. The tool does
  `GET /api/profile/{name}`, merges, then `PUT /api/profile/{name}`. Profile routes accept loopback
  requests without an API key. The app writes the file atomically, keeps a `.bak`, and reloads both
  the profile and the HA watch list. The running app owns `plugins.json`, so any required plugin
  that is disabled is listed as something to enable on the Plugins page. A pending, unsaved editor
  edit (500 ms autosave window) is discarded by the reload. If `--profile` is not the app's
  `activeProfile`, the app switches to that profile.

  Hot apply stops before writing anything when the profile API refuses a keyless loopback
  request, or answers 404 with anything other than the app's own "Profile ... not found". Both
  mean the running app is an older build without `/api/profile`. If the PUT fails,
  `ha_config.json` is restored.
- **Cold.** Used when the API does not answer. The tool atomically writes
  `profile_<name>.json` (temp file, fsync, rename, mode 0600), and in `plugins.json` it enables
  required plugins that are explicitly disabled. If an `sd-tauri` / `open-stream-deck` process is
  running but its API is unreachable (for example `apiBind` is set to a LAN address), cold mode
  refuses unless `--force-cold` is given.
- **Both modes** add every `ha.<entity>` referenced by a template, plus `deck.watch`, to
  `ha_config.json` `watched`. This is a read-modify-write that keeps `url`, `token` and every
  other key; the token is never printed. Before any file changes, it is copied to
  `<config>/deck-backups/<YYYYMMDD-HHMMSS-mmm>/` with mode 0600. In hot mode the profile backup is
  the content returned by the API.

### Merge semantics

- Only the deck's devices are touched. Other devices, `favorites`, `recent`, `name` and a legacy
  top-level layout stay exactly as they were.
- On a deck device, the deck's scenes come first, in deck order. The first scene is the
  window-trigger fallback.
- A deck scene whose id already exists replaces that scene in place, so anything referencing that
  id keeps working. To take over an existing scene, give it its id: `scene("main", { id: "<existing uuid>" })`.
- Scenes the deck does not define are kept after the deck's scenes, in their previous order.
  `--prune` removes them instead.
- `activeSceneId` is kept if that scene still exists; otherwise it becomes the deck's first
  scene. `brightness` is kept unless the deck sets it.

## Deck file

```ts
import { defineDeck, device, scene, key, text, icon, ha, haToggle, haDial, haSlider, nav, strip } from "../packages/deck/src/index.ts";

const home = scene("home", {
  keys: {
    0: key({ action: haToggle("light.desk"), bg: ha("light.desk", "rgb_color", "rgb|default:#202020"), icon: icon("tabler:bulb") }),
    1: key({ action: nav.push("media"), text: "Media" }),
  },
  encoders: { 0: haDial("light.desk", { label: "Desk" }) },
  strip: strip([haSlider(0, "light.desk")]),
});
const media = scene("media", { keys: { 0: key({ action: nav.back(), icon: icon("tabler:arrow-back-up") }) } });

export default defineDeck({ devices: [device("<SERIAL>", "plus", [home, media])] });
```

The default export may also be a function, sync or async, that returns the deck.

## Builder API

All builders return complete objects in the persisted shape:

- Settings values are strings.
- `ActionDef`s are copies of the built-in plugin definitions.
- Keys carry both the canonical `texts`/`icons` arrays and the legacy `text`/`icon` mirror of the
  first element.
- Strip gestures always carry their `*Settings` object. The app only fires a gesture whose settings
  object exists.

### Actions (`ActionSpec = { action: ActionDef; settings: Record<string, string> }`)

| Builder | Result |
|---|---|
| `none()` | No action. |
| `haService(domain, service, entity?, data?)` | `ha-service`. `data` becomes `ha_service_data` JSON; string values may contain templates. |
| `haToggle(entity)` | `<domain>.toggle` on the entity. |
| `haScript(entity, variables?)` | `script.turn_on` with the script as target. |
| `haAttrControl(entity, control, value?)` | Sets a numeric attribute through an HA control (see the table below). A key needs `value`. Encoders and strip tap/swipe supply the value. |
| `haCustom(message)` | `ha-custom`, a raw HA WebSocket message. |
| `nav.push(ref)` / `nav.switch(ref)` / `nav.back()` | `switch-scene` / `back`. `ref` is a scene slug or a `scene()` result. It resolves to the scene id on the same device. |
| `hotkey("ctrl+shift+t")` | `hotkey` with `key: "t"`, `modifiers: "ctrl, shift"`. |
| `command(cmd)` / `launch(target)` / `openUrl(url)` | `command` / `launch` / `open-url`. |
| `httpRequest(url, { method?, headers?, body? })` | `http-request`. |
| `timer(seconds)` / `counter(start?)` | `timer` / `counter`. Keys only. |
| `multi([spec, { action: spec, delayMs }])` | `multi-action`. Steps are serialized like the UI does. |

### Keys and visuals

| Builder | Result |
|---|---|
| `key({ action?, bg?, text?, icon?, imageUrl?, imageFit?, pinned? })` | `KeyAssignment`. `text` takes a string or `TextConfig` (or an array). `icon` takes `"set:name"` or an `IconConfig` (or an array; put conditional icons first and an unconditional default last). |
| `text(content, Partial<TextConfig>)` | `TextConfig` with the UI defaults: sans-serif 14px, white, centred. |
| `icon("set:name", { color?, size?, when?: { variable, value } })` | `IconConfig` read offline from `@iconify/json`. Aliases are resolved, per-icon and set-level sizes are applied (default 16), and the body and viewBox are the same as in the UI icon browser. |
| `ha(entity, attr = "state", filters = "")` | `"{{$ha.<entity>.<attr>\|filters}}"`. |

Key coordinates use the design canvas, `min(native key size, 96)` px. Plus keys (120 px) are
designed at 96 px and scaled up.

### Encoders

| Builder | Result |
|---|---|
| `encoder({ press?, rotate?, label?, value?, min?, max?, step?, wrap? })` | `EncoderConfig`. `value`/`min`/`max` are stored as strings and can be templates. `wrap: true` continues at `min` after `max` (and vice versa), e.g. to scroll a list bound to a local variable. |
| `haDial(entity, { control?, label?, press?, min?, max?, step? })` | Bound to an HA attribute. The default control comes from the domain, and press defaults to `<domain>.toggle`. |

| Control | Domain (default for) | Service / attr | Range, step |
|---|---|---|---|
| `brightness` | light | `turn_on` / `brightness` | 0-255, 5 |
| `color_temp` | light | `turn_on` / `color_temp_kelvin` | 2000-6500, 100 |
| `volume` | media_player | `volume_set` / `volume_level` | 0-1, 0.05 |
| `temperature` | climate | `set_temperature` / `temperature` | 16-30, 0.5 |
| `position` | cover | `set_cover_position` / `position` (reads `current_position`) | 0-100, 5 |
| `percentage` | fan | `set_percentage` / `percentage` | 0-100, 10 |
| `value` | number, input_number | `set_value` / `value` (reads `state`) | 0-100, 1 |
| `humidity` | humidifier | `set_humidity` / `humidity` | 0-100, 1 |

These are the same ids, services, attributes and fallback ranges as `HAClient.getEntityControls`.
`humidity` is the exception: the client has no humidifier control. It works on encoders, which send
an absolute value, but strip tap/swipe cannot map a touch position onto it. The validator reports
that as an error.

### Touch strip (800x100 design space)

| Builder | Result |
|---|---|
| `panel(i, opts)` | The item above encoder `i`: `x = i*200`, 200x100, id `panel-<i>`. |
| `stripItem({ x, y, w, h }, opts)` | An item at any position. |
| `bar(value, { min?, max?, color?, position?, height? })` | `StripBar`. |
| `haSlider(i, entity, { control?, barColor?, barPosition?, ...opts })` | Panel `i` with a bar bound to the attribute. Tap and swipe set the value, and long press toggles. |
| `strip(items, { bg? })` | `StripConfig`. |

Item options are `{ id?, bg?, imageUrl?, imageFit?, icon?, text?, bar?, tap?, longPress?, swipe? }`.

### Scenes, devices, deck

| Builder | Result |
|---|---|
| `scene(slug, { id?, name?, keys?, encoders?, strip?, triggers? })` | `{ slug, scene }`. The id is `uuidv5(slug)` (stable across runs) unless `id` is given. Triggers default to `[manual()]`. |
| `windowTrigger({ app?, title?, priority?, mode? })` | Window trigger. Needs `app` and/or `title`; `"regex:<re>"` is supported. |
| `manual()` | Manual trigger. |
| `device(serial, model, scenes, { brightness? })` | A device. `model` is a `devices.ts` id: `plus`, `xl`, `mk2`, `original_v2`, `mini`, `neo`, `pedal`, ... |
| `defineDeck({ devices, watch? })` | The deck. `watch` lists extra HA entities to watch. |

## Validation

Errors block `--out` and `--apply`:

- Unknown device model, or a duplicate serial.
- Key index outside the model's grid (touch buttons on the Neo are allowed, with a warning).
  Encoder index of `encoder_count` or higher. A strip on a model without one.
- Strip items outside 800x100. Missing or duplicate strip item ids. A gesture action without its
  `*Settings` object.
- Incomplete `ActionDef`, unknown action id (multi-action steps included), or a non-string setting
  value.
- Scene references that do not resolve to a scene on the same device (deck scenes plus the scenes
  that survive the merge). Duplicate scene ids, or integer-like scene ids (JavaScript would reorder
  them before the others).
- Template syntax:
  - Unterminated `{{`, or `}` inside an expression.
  - Empty variable name.
  - `map:` entries without `=` (escape `:` and `=` inside keys and values as `\:` / `\=`).
  - `|` inside a `map:`/`replace:`/`default:` argument.
  - Invalid `replace:/re/` regex.
- HA attribute controls without a value where none is supplied (keys, long press, multi-action
  steps). Touch-position gestures on attributes the client cannot map.
- `ha_service_data` / `ha_custom_json` that is not a JSON object. Required fields of hotkey,
  command, launch, open-url and http-request. Timer or counter outside a key.
- Fonts that are not in the UI font list (`sans-serif`, `serif`, `monospace`, `Roboto`, `Inter`,
  `Source Sans 3`, `Fira Code`, `JetBrains Mono`, `Orbitron`). Colors that are neither usable CSS
  colors nor templates. Encoder or bar `value`/`min`/`max` that are neither a number nor a template.
- With `--ha-states`: entities that do not exist (each reported once), and object attributes
  (these are never published as variables).
- Scenes the app's profile parser would reject.

Warnings do not block:

- Font size below 12 px (legibility).
- Unknown filters (they only act as fallback text).
- A conditional icon without an unconditional default.
- An `ActionDef` that differs from the plugin definition.
- Attributes the entity does not currently report.
- Disabled required plugins.
- Scenes the app would normalize on load.

## Tests

```bash
pnpm --filter @open-stream-deck/deck test    # vitest
pnpm --filter @open-stream-deck/deck check   # tsc --noEmit
```

Drift tests fail when the UI or the Rust core changes something this package copies:

- `devices.ts` against `crates/sd-core/src/device/profile.rs`.
- The `ActionDef`s, plugin ids and dispatcher-handled actions against the UI plugins and
  `store.executeAction`.
- The font list against `TextConfig.svelte`.
- HA controls against `client.ts`.
- Icon output against the UI's bundled icon sets.
