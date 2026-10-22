import { describe, it, expect } from "vitest";
import { isIgnoredWindow, matchWindowPattern, pickTriggerScene } from "./window-trigger";
import type { Scene } from "../types/profile";

const scene = (id: string, triggers: Scene["triggers"]): Scene => ({ id, name: id, keys: {}, triggers });

describe("window triggers", () => {
  it("matches regex: patterns case-insensitively and plain patterns as contains", () => {
    expect(matchWindowPattern("Google-chrome", "regex:^google-chrome$")).toBe(true);
    expect(matchWindowPattern("google-chrome-beta", "regex:^google-chrome$")).toBe(false);
    expect(matchWindowPattern("jetbrains-phpstorm", "PhpStorm")).toBe(true);
    expect(matchWindowPattern("x", "regex:(")).toBe(false);
  });

  it("ignores the app's own windows and file managers", () => {
    expect(isIgnoredWindow("open-stream-deck", "Open Stream Deck")).toBe(true);
    expect(isIgnoredWindow("Nautilus", "Home")).toBe(true);
    expect(isIgnoredWindow("kitty", "~")).toBe(false);
  });

  it("picks the highest-priority match and skips empty or manual triggers", () => {
    const scenes = [
      scene("home", [{ type: "manual" }]),
      scene("any", [{ type: "window", app_name: " ", window_title: "" }]),
      scene("low", [{ type: "window", app_name: "kitty" }]),
      scene("high", [{ type: "window", app_name: "regex:^kitty$", window_title: "vim", priority: 5 }]),
    ];
    expect(pickTriggerScene(scenes, "kitty", "vim main.ts")).toBe("high");
    expect(pickTriggerScene(scenes, "kitty", "bash")).toBe("low");
    expect(pickTriggerScene(scenes, "firefox", "vim")).toBeNull();
  });
});
