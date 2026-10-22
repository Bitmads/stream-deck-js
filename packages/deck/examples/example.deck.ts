// Example deck (fake serials and entity ids). Copy it to <repo>/decks/ (gitignored) and adjust:
//
//   pnpm --filter @open-stream-deck/deck deck build decks/home.deck.ts --dry-run
//
// Import path from <repo>/decks/: "../packages/deck/src/index.ts".

import {
  command, defineDeck, device, ha, haDial, haScript, haSlider, haToggle, hotkey, icon, key, multi, nav, panel,
  scene, strip, text, windowTrigger,
} from "../src/index.ts";

const LIGHT = "light.living_room";
const HUMIDIFIER = "humidifier.bedroom";
const TV = "media_player.living_room_tv";
const PLUG = "switch.coffee_maker";
const TEMP = "sensor.outdoor_temperature";

const back = key({ action: nav.back(), bg: "#303030", icon: icon("tabler:arrow-back-up", { size: 44 }) });

const home = scene("home", {
  name: "Home",
  keys: {
    0: key({
      action: haToggle(LIGHT),
      bg: ha(LIGHT, "rgb_color", "rgb|default:#202020"),
      icon: icon("tabler:bulb", { size: 44 }),
      text: text(ha(LIGHT, "state", "upper"), { vAlign: "bottom", fontSize: 13, fontWeight: "bold" }),
    }),
    1: key({
      action: haToggle(PLUG),
      bg: ha(PLUG, "state", "map:on=#2e7d32:*=#202020"),
      icon: [
        icon("tabler:coffee", { size: 44, when: { variable: ha(PLUG), value: "on" } }),
        icon("tabler:coffee-off", { size: 44 }),
      ],
      text: text("Coffee", { vAlign: "bottom", fontSize: 13 }),
    }),
    2: key({
      bg: "#1c3d5a",
      text: [
        text(`${ha(TEMP, "state", "round1|default:--")}°`, { fontSize: 24, fontWeight: "bold" }),
        text("Outside", { vAlign: "bottom", fontSize: 12 }),
      ],
    }),
    3: key({ action: haScript("script.good_night"), bg: "#311b92", icon: icon("tabler:moon", { size: 44 }), text: text("Night", { vAlign: "bottom", fontSize: 13 }) }),
    4: key({ action: nav.push("media"), bg: "#4a148c", icon: icon("tabler:device-tv", { size: 44 }), text: text("Media", { vAlign: "bottom", fontSize: 13 }) }),
    5: key({
      action: multi([haToggle(LIGHT), { action: haToggle(PLUG), delayMs: 500 }]),
      bg: "#5d4037",
      icon: icon("tabler:sunrise", { size: 44 }),
      text: text("Morning", { vAlign: "bottom", fontSize: 13 }),
    }),
    7: key({ action: command("xdg-open https://example.org"), bg: "#263238", icon: icon("lucide:globe", { size: 44 }) }),
  },
  encoders: {
    0: haDial(LIGHT, { label: "Light" }),
    1: haDial(HUMIDIFIER, { label: "Humidity" }),
    2: haDial(TV, { label: "Volume" }),
  },
  strip: strip([
    haSlider(0, LIGHT, {
      bg: "#1a1a2e",
      barColor: ha(LIGHT, "rgb_color", "rgb|default:#ffd54f"),
      icon: icon("lucide:lamp-floor", { size: 40 }),
      text: text(ha(LIGHT, "brightness", "default:0"), { hAlign: "right", vAlign: "bottom", fontSize: 14 }),
    }),
    panel(1, {
      bg: "#102027",
      text: [
        text("Humidity", { vAlign: "top", fontSize: 13 }),
        text(`${ha(HUMIDIFIER, "current_humidity", "default:--")}% → ${ha(HUMIDIFIER, "humidity", "default:--")}%`, { fontSize: 18, fontWeight: "bold" }),
      ],
      tap: haToggle(HUMIDIFIER),
    }),
    haSlider(2, TV, { bg: "#1b0f2e", icon: icon("tabler:volume", { size: 40 }), barPosition: "bottom" }),
  ]),
});

const media = scene("media", {
  name: "Media",
  triggers: [windowTrigger({ app: "vlc", priority: 10 })],
  keys: {
    0: back,
    1: key({ action: hotkey("space"), bg: "#212121", icon: icon("tabler:player-play", { size: 44 }) }),
    2: key({ action: hotkey("ctrl+left"), bg: "#212121", icon: icon("tabler:player-skip-back", { size: 44 }) }),
    3: key({ action: hotkey("ctrl+right"), bg: "#212121", icon: icon("tabler:player-skip-forward", { size: 44 }) }),
    4: key({ action: haToggle(TV), bg: ha(TV, "state", "map:playing=#1565c0:*=#212121"), icon: icon("tabler:device-tv", { size: 44 }) }),
  },
  encoders: {
    0: haDial(TV, { label: "Volume" }),
  },
});

export default defineDeck({
  devices: [
    device("EXAMPLE-PLUS-0001", "plus", [home, media], { brightness: 70 }),
  ],
});
