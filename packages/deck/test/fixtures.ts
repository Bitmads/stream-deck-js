// Shared test decks (fake serials and entity ids).

import {
  defineDeck, device, ha, haDial, haSlider, haToggle, icon, key, multi, nav, panel, scene, strip, text, windowTrigger,
  type DeckSpec,
} from "../src/index.ts";
import type { SavedProfile, Scene } from "../../ui/src/lib/types/profile.ts";

export const PLUS = "TEST-PLUS-1";
export const OTHER = "TEST-MK2-2";
export const LIGHT = "light.test_lamp";

export function sampleDeck(): DeckSpec {
  const home = scene("home", {
    name: "Home",
    keys: {
      0: key({ action: haToggle(LIGHT), bg: ha(LIGHT, "rgb_color", "rgb"), icon: icon("tabler:bulb"), text: "Lamp" }),
      1: key({ action: nav.push("sub"), text: text("Sub", { fontSize: 14 }) }),
      2: key({ action: multi([haToggle(LIGHT), { action: nav.switch("sub"), delayMs: 100 }]) }),
    },
    encoders: { 0: haDial(LIGHT, { label: "Lamp" }) },
    strip: strip([haSlider(0, LIGHT), panel(3, { text: "Hi" })]),
  });
  const sub = scene("sub", {
    name: "Sub",
    triggers: [windowTrigger({ app: "firefox" })],
    keys: { 0: key({ action: nav.back(), icon: icon("tabler:arrow-back-up") }) },
  });
  return defineDeck({ devices: [device(PLUS, "plus", [home, sub])] });
}

function plainScene(id: string, name: string): Scene {
  return { id, name, keys: { "3": { action: { id: "none", label: "None", icon: "", color: "#333" }, settings: {}, backgroundColor: "#123456" } }, triggers: [{ type: "manual" }] };
}

/** A stored profile with a deck device scene and another device. */
export function storedProfile(): SavedProfile {
  return {
    name: "default",
    devices: {
      [PLUS]: {
        scenes: {
          "old-scene-1": plainScene("old-scene-1", "Old 1"),
          "old-scene-2": plainScene("old-scene-2", "Old 2"),
        },
        activeSceneId: "old-scene-2",
        brightness: 40,
      },
      [OTHER]: {
        scenes: { "other-scene": plainScene("other-scene", "Other") },
        activeSceneId: "other-scene",
      },
    },
    favorites: ["ha-service"],
    recent: ["back"],
  };
}
