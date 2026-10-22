// Window-trigger matching (focused window → scene). Pure: no Svelte or Tauri imports.

import type { Scene } from "../types/profile";

/** Windows that never trigger a scene change (the app itself and its dialogs, file managers). */
const IGNORED_APPS = ["open stream deck", "zenity", "gdialog", "nemo", "nautilus", "thunar"];

export function isIgnoredWindow(appName: string, windowTitle: string): boolean {
  const app = appName.toLowerCase();
  return IGNORED_APPS.some(a => app.includes(a)) || windowTitle.toLowerCase().includes("open stream deck");
}

/** `regex:<pattern>` is a case-insensitive regex (invalid → no match); anything else is a case-insensitive "contains". */
export function matchWindowPattern(value: string, pattern: string): boolean {
  if (pattern.startsWith("regex:")) {
    try {
      return new RegExp(pattern.slice(6), "i").test(value);
    } catch { return false; }
  }
  return value.toLowerCase().includes(pattern.toLowerCase());
}

/** Id of the scene whose matching window trigger has the highest priority (first wins on a tie), or null. */
export function pickTriggerScene(scenes: Scene[], appName: string, windowTitle: string): string | null {
  let bestScene: string | null = null;
  let bestPriority = -Infinity;
  for (const scene of scenes) {
    for (const trigger of scene.triggers ?? []) {
      if (trigger.type !== "window") continue;
      const appPattern = trigger.app_name?.trim() ?? "";
      const titlePattern = trigger.window_title?.trim() ?? "";
      // A trigger with no criteria would match every window: it stays inactive until configured.
      if (!appPattern && !titlePattern) continue;
      const appMatch = !appPattern || matchWindowPattern(appName, appPattern);
      const titleMatch = !titlePattern || matchWindowPattern(windowTitle, titlePattern);
      if (appMatch && titleMatch && (trigger.priority ?? 0) > bestPriority) {
        bestPriority = trigger.priority ?? 0;
        bestScene = scene.id;
      }
    }
  }
  return bestScene;
}
