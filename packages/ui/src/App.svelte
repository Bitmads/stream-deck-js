<script lang="ts">
  import { invoke } from "@tauri-apps/api/core";
  import { listen } from "@tauri-apps/api/event";
  import Sidebar from "./components/layout/Sidebar.svelte";
  import Header from "./components/layout/Header.svelte";
  import MainPanel from "./components/layout/MainPanel.svelte";
  import PropertyPanel from "./components/layout/PropertyPanel.svelte";
  import StatusBar from "./components/layout/StatusBar.svelte";
  import { refreshDevices } from "./lib/stores/devices.svelte";
  import {
    selectKey, selectEncoder, getKeyAssignment, pushScene, popScene, switchScene,
    getScenes, getActiveSceneId, undo, redo, handleTimerPress, handleCounterPress,
    handleEncoderRotate, handleEncoderPress, handleStripTap, handleStripLongPress, handleStripSwipe,
    initStore, executePluginAction,
  } from "./lib/stores/editor.svelte";
  import { initVariables, resolveTemplate } from "./lib/stores/variables.svelte";
  import { registerPlugin, initPluginRegistry } from "./lib/stores/plugins.svelte";
  import { haPluginDef } from "./lib/plugins/homeassistant";
  import { systemActionsPluginDef } from "./lib/plugins/system";
  import { httpActionsPluginDef } from "./lib/plugins/http";
  import { navigationPluginDef } from "./lib/plugins/navigation";
  import { utilitiesPluginDef } from "./lib/plugins/utilities";
  import { multiActionPluginDef } from "./lib/plugins/multi-action";

  let currentView = $state<"editor" | "plugins" | "profiles" | "settings">("editor");

  // Keyboard shortcuts
  $effect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
        e.preventDefault();
        undo();
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'z' && e.shiftKey) {
        e.preventDefault();
        redo();
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'y') {
        e.preventDefault();
        redo();
      }
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  });

  // Startup: load profile + detect devices (run once, not tracked by Svelte)
  import { untrack } from "svelte";
  $effect(() => {
    untrack(async () => {
      await initStore();
      initVariables();
      // Register all plugins
      registerPlugin(systemActionsPluginDef);
      registerPlugin(httpActionsPluginDef);
      registerPlugin(navigationPluginDef);
      registerPlugin(utilitiesPluginDef);
      registerPlugin(multiActionPluginDef);
      registerPlugin(haPluginDef);
      await initPluginRegistry();
      await refreshDevices();
    });
    const interval = setInterval(() => untrack(() => refreshDevices()), 5000);
    return () => clearInterval(interval);
  });

  // Device input events (keys, encoders, LCD touch)
  $effect(() => {
    const unlisten = listen<any>("device-event", (event) => {
      const e = event.payload;
      if (e.type === "lcd_short_press" || e.type === "lcd_swipe" || e.type === "lcd_long_press") {
        console.log(`[HID EVENT] ${e.type}`, e);
      }
      switch (e.type) {
        case "key":
          if (e.pressed) {
            selectKey(e.index);
            executeKeyAction(e.index);
          }
          break;
        case "encoder_press":
          if (e.pressed) {
            selectEncoder(e.index);
            handleEncoderPress(e.index);
          }
          break;
        case "encoder_rotate":
          handleEncoderRotate(e.index, e.delta);
          break;
        case "lcd_short_press":
          handleStripTap(e.x, e.y);
          break;
        case "lcd_long_press":
          handleStripLongPress(e.x, e.y);
          break;
        case "lcd_swipe":
          handleStripSwipe(e.from_x, e.from_y, e.to_x, e.to_y);
          break;
      }
    });
    return () => { unlisten.then(fn => fn()); };
  });

  // Start key listener + window watcher on backend
  $effect(() => {
    invoke("start_key_listener").catch(() => {});
    invoke("start_window_watcher").catch(() => {});
  });

  // Active window changed → match scene triggers
  $effect(() => {
    const unlisten = listen<{ app_name: string; title: string }>("active-window-changed", (event) => {
      const { app_name, title } = event.payload;
      console.log("[WindowWatcher] app:", app_name, "title:", title);
      matchWindowTrigger(app_name, title);
    });
    return () => { unlisten.then(fn => fn()); };
  });

  // Track whether the current scene was activated by a window trigger (not manual user action)
  let sceneSetByTrigger = false;

  function matchWindowTrigger(appName: string, windowTitle: string) {
    const ignoredApps = ["open stream deck", "zenity", "gdialog", "nemo", "nautilus", "thunar"];
    if (ignoredApps.some(a => appName.toLowerCase().includes(a)) || windowTitle.toLowerCase().includes("open stream deck")) {
      return;
    }

    const scenes = getScenes();
    const currentId = getActiveSceneId();

    let bestScene: string | null = null;
    let bestPriority = -Infinity;

    for (const scene of scenes) {
      for (const trigger of scene.triggers) {
        if (trigger.type !== "window") continue;
        const appMatch = !trigger.app_name || matchPattern(appName, trigger.app_name);
        const titleMatch = !trigger.window_title || matchPattern(windowTitle, trigger.window_title);
        if (appMatch && titleMatch && (trigger.priority ?? 0) > bestPriority) {
          bestPriority = trigger.priority ?? 0;
          bestScene = scene.id;
        }
      }
    }

    if (bestScene && bestScene !== currentId) {
      // A window trigger matched — switch to it
      sceneSetByTrigger = true;
      switchScene(bestScene);
    } else if (!bestScene && sceneSetByTrigger && currentId !== scenes[0]?.id) {
      // Only fall back to default if the CURRENT scene was set by a trigger.
      // If the user manually switched, don't override them.
      sceneSetByTrigger = false;
      if (scenes[0]) switchScene(scenes[0].id);
    }
  }

  function matchPattern(value: string, pattern: string): boolean {
    // Support simple wildcards and regex
    if (pattern.startsWith("regex:")) {
      try {
        return new RegExp(pattern.slice(6), "i").test(value);
      } catch { return false; }
    }
    // Simple case-insensitive contains
    return value.toLowerCase().includes(pattern.toLowerCase());
  }

  async function executeKeyAction(keyIndex: number) {
    const assignment = getKeyAssignment(keyIndex);
    if (!assignment) return;

    const { action, settings } = assignment;

    if (action.id === "switch-scene" && settings.sceneId) {
      settings.mode === "switch" ? switchScene(settings.sceneId) : pushScene(settings.sceneId);
      return;
    }
    if (action.id === "back") {
      popScene();
      return;
    }
    if (action.id === "timer") {
      handleTimerPress(keyIndex);
      return;
    }
    if (action.id === "counter") {
      handleCounterPress(keyIndex);
      return;
    }

    try {
      // Resolve {{variables}} in all setting values
      const resolved: Record<string, string> = {};
      for (const [k, v] of Object.entries(settings)) resolved[k] = resolveTemplate(v);

      // Execute via plugin executor
      await executePluginAction(action.id, resolved);
    } catch (e) {
      console.error("Action execution failed:", e);
    }
  }
</script>

<div class="app-layout">
  <Header bind:currentView />
  <div class="app-body">
    <Sidebar {currentView} />
    <MainPanel {currentView} />
    <PropertyPanel />
  </div>
  <StatusBar />
</div>

<style>
  .app-layout { display: flex; flex-direction: column; height: 100vh; width: 100%; overflow: hidden; }
  .app-body { display: flex; flex: 1; min-height: 0; overflow: hidden; }
</style>
