<script lang="ts">
  import { invoke } from "@tauri-apps/api/core";
  import { listen } from "@tauri-apps/api/event";
  import { untrack } from "svelte";
  import Sidebar from "./components/layout/Sidebar.svelte";
  import Header from "./components/layout/Header.svelte";
  import MainPanel from "./components/layout/MainPanel.svelte";
  import PropertyPanel from "./components/layout/PropertyPanel.svelte";
  import StatusBar from "./components/layout/StatusBar.svelte";
  import { refreshDevices } from "./lib/stores/devices.svelte";
  import { undo, redo, initStore, store } from "./lib/stores/editor.svelte";
  import { startDeviceSync } from "./lib/stores/device-sync.svelte";
  import { initVariables } from "./lib/stores/variables.svelte";
  import { registerPlugin, initPluginRegistry } from "./lib/stores/plugins.svelte";
  import { haPluginDef, reloadHaWatchList } from "./lib/plugins/homeassistant";
  import { systemActionsPluginDef } from "./lib/plugins/system";
  import { httpActionsPluginDef } from "./lib/plugins/http";
  import { navigationPluginDef } from "./lib/plugins/navigation";
  import { utilitiesPluginDef } from "./lib/plugins/utilities";
  import { multiActionPluginDef } from "./lib/plugins/multi-action";
  import { initExternalBridge, isExternalAction, dispatchKey, dispatchEncoder } from "./lib/plugins/external/bridge.svelte";

  let currentView = $state<"editor" | "plugins" | "profiles" | "settings">("editor");

  /** Undo/redo shortcuts must not steal native text undo from inputs and editable content. */
  function isEditableTarget(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) return false;
    if (target.isContentEditable) return true;
    return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement;
  }

  // Keyboard shortcuts
  $effect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (!(e.ctrlKey || e.metaKey) || isEditableTarget(e.target)) return;
      const key = e.key.toLowerCase();
      if (key === "z" && !e.shiftKey) {
        e.preventDefault();
        undo();
      } else if ((key === "z" && e.shiftKey) || key === "y") {
        e.preventDefault();
        redo();
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  });

  // Startup: load profile, plugins and devices, then start hardware sync and the plugin bridge.
  $effect(() => {
    let stopSync: (() => void) | null = null;
    let stopBridge: (() => void) | null = null;
    let disposed = false;
    untrack(async () => {
      await initStore();
      initVariables();
      registerPlugin(systemActionsPluginDef);
      registerPlugin(httpActionsPluginDef);
      registerPlugin(navigationPluginDef);
      registerPlugin(utilitiesPluginDef);
      registerPlugin(multiActionPluginDef);
      registerPlugin(haPluginDef);
      await initPluginRegistry();
      await refreshDevices();
      if (disposed) return;
      stopSync = startDeviceSync();
      stopBridge = initExternalBridge();
    });
    const interval = setInterval(() => untrack(() => refreshDevices()), 5000);
    return () => {
      disposed = true;
      clearInterval(interval);
      stopSync?.();
      stopBridge?.();
    };
  });

  // Profile replaced/reloaded from outside (REST API): reload from disk, then the HA watch list.
  $effect(() => {
    const unlisten = listen<{ name?: string }>("profile-reload", async (event) => {
      try {
        await store.reloadProfileFromDisk(event.payload?.name || undefined);
      } catch (e) {
        console.error("[Profile] Reload failed:", e);
      }
      try {
        await reloadHaWatchList();
      } catch (e) {
        console.error("[HA] Watch list reload failed:", e);
      }
    });
    return () => { unlisten.then(fn => fn()); };
  });

  /** Scene a key was pressed in, so its keyUp goes to the same context even if the scene changes. */
  const pressedKeyScene = new Map<string, string>();
  const pressedEncoderScene = new Map<string, string>();

  function handleKey(serial: string, index: number, pressed: boolean) {
    const id = `${serial}:${index}`;
    if (!pressed) {
      const sceneId = pressedKeyScene.get(id);
      pressedKeyScene.delete(id);
      if (sceneId) dispatchKey(serial, sceneId, index, "keyUp");
      return;
    }
    // Show the pressed key in the editor (select, never toggle off).
    if (serial === store.boundSerial && store.selectedKeyIndex !== index) store.selectKey(index);
    const sceneId = store.getActiveSceneId(serial);
    if (!sceneId) return;
    const key = store.getEffectiveKey(serial, sceneId, index);
    if (!key) return;
    if (isExternalAction(key.action.id)) {
      pressedKeyScene.set(id, sceneId);
      dispatchKey(serial, sceneId, index, "keyDown");
      return;
    }
    // Errors are logged and surfaced in store.lastError by the dispatcher.
    store.executeKeyAction(serial, index).catch(() => {});
  }

  function encoderIsExternal(serial: string, index: number, rotate: boolean): { external: boolean; sceneId: string | null } {
    const scene = store.getActiveScene(serial);
    const cfg = scene?.encoders?.[String(index)];
    if (!scene || !cfg) return { external: false, sceneId: scene?.id ?? null };
    const primary = rotate ? cfg.rotateAction : cfg.pressAction;
    const secondary = rotate ? cfg.pressAction : cfg.rotateAction;
    const id = primary?.id && primary.id !== "none" ? primary.id : secondary?.id;
    return { external: !!id && isExternalAction(id), sceneId: scene.id };
  }

  function handleEncoderPress(serial: string, index: number, pressed: boolean) {
    const id = `${serial}:${index}`;
    if (!pressed) {
      const sceneId = pressedEncoderScene.get(id);
      pressedEncoderScene.delete(id);
      if (sceneId) dispatchEncoder(serial, sceneId, index, "dialUp");
      return;
    }
    if (serial === store.boundSerial && store.selectedEncoderIndex !== index) store.selectEncoder(index);
    const { external, sceneId } = encoderIsExternal(serial, index, false);
    if (external && sceneId) {
      pressedEncoderScene.set(id, sceneId);
      dispatchEncoder(serial, sceneId, index, "dialDown");
    } else {
      store.handleEncoderPressForDevice(serial, index);
    }
  }

  function handleEncoderRotate(serial: string, index: number, delta: number) {
    const { external, sceneId } = encoderIsExternal(serial, index, true);
    if (external && sceneId) dispatchEncoder(serial, sceneId, index, "dialRotate", delta);
    else store.handleEncoderRotateForDevice(serial, index, delta);
  }

  // Device input events (keys, encoders, LCD touch) — handles ALL devices
  $effect(() => {
    const unlisten = listen<any>("device-event", (event) => {
      const e = event.payload;
      const serial: string = e.serial || store.currentSerial || "";
      if (!serial) return;
      switch (e.type) {
        case "key":
          handleKey(serial, e.index, !!e.pressed);
          break;
        case "encoder_press":
          handleEncoderPress(serial, e.index, !!e.pressed);
          break;
        case "encoder_rotate":
          handleEncoderRotate(serial, e.index, e.delta);
          break;
        case "lcd_short_press":
          store.handleStripTapForDevice(serial, e.x, e.y);
          break;
        case "lcd_long_press":
          store.handleStripLongPressForDevice(serial, e.x, e.y);
          break;
        case "lcd_swipe":
          store.handleStripSwipeForDevice(serial, e.from_x, e.from_y, e.to_x, e.to_y);
          break;
      }
    });
    return () => { unlisten.then(fn => fn()); };
  });

  // Start key listener + window watcher on backend
  $effect(() => {
    invoke("start_key_listener").catch((e) => console.error("Key listener failed to start:", e));
    invoke("start_window_watcher").catch((e) => console.error("Window watcher failed to start:", e));
  });

  // Active window changed → match scene triggers
  $effect(() => {
    const unlisten = listen<{ app_name: string; title: string }>("active-window-changed", (event) => {
      const { app_name, title } = event.payload;
      untrack(() => store.applyWindowTriggers(app_name, title));
    });
    return () => { unlisten.then(fn => fn()); };
  });
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
