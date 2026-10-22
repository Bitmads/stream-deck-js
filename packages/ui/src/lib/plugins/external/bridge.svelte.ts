// Bridge between deck input/scene state and external (Elgato-SDK) plugins (contract C4).
//
// Host → plugin: willAppear/willDisappear for every external-action key/encoder on the active
// scene of every connected deck, keyDown/keyUp, dialRotate/dialDown/dialUp and
// didReceiveSettings — sent through the `plugin_send_event` Tauri command.
// Plugin → host: the backend forwards context-bound commands as the "plugin-command" event;
// visual commands become store runtime overrides, settings are persisted per context.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { untrack } from "svelte";
import { store } from "../../stores/store.svelte";
import { getAllPlugins, isEnabled } from "../../stores/plugins.svelte";
import {
  asSettingsObject, buildAppearEvent, buildDialEvent, buildDidReceiveSettings, buildKeyEvent,
  commandToOverride, encoderCoordinates, keyCoordinates, parsePluginMessage,
  type ActionRef, type Controller, type DialEventName, type KeyEventName,
} from "./payload";

const FLASH_MS = 1500;
/**
 * Marks the context of an external action run as a multi-action step (`<key context>#step<n>`).
 * Such contexts are not addressable: parseContext rejects them, and replies to them (setTitle,
 * setSettings, ...) are ignored, as Elgato does for in-multi-action instances.
 */
const MULTI_STEP_MARK = "#step";
const MULTI_STEP_CONTEXT = /#step\d+$/;

interface Appearance {
  pluginUuid: string;
  action: string;
  context: string;
  device: string;
  controller: Controller;
  index: number;
}

/** Currently appeared action instances, keyed by `${context}|${action}`. */
const appeared = new Map<string, Appearance>();
const flashTimers = new Map<string, number>();

// ─── Action → plugin lookup ──────────────────────────────────

/** Manifest UUID of the enabled external plugin that provides `actionId`, if any. */
function pluginForAction(actionId: string | undefined): string | null {
  if (!actionId || actionId === "none") return null;
  for (const p of getAllPlugins()) {
    if (p.type !== "external" || !isEnabled(p.id)) continue;
    if (p.actions?.some(a => a.id === actionId)) return p.id;
  }
  return null;
}

/** True when `actionId` belongs to an enabled external plugin. */
export function isExternalAction(actionId: string): boolean {
  return pluginForAction(actionId) !== null;
}

// ─── Sending ─────────────────────────────────────────────────

async function sendToPlugin(pluginUuid: string, message: object): Promise<void> {
  await invoke("plugin_send_event", { pluginUuid, message: JSON.stringify(message) });
}

function sendQuiet(pluginUuid: string, message: object, what: string) {
  sendToPlugin(pluginUuid, message).catch(e => console.debug(`[Plugins] ${what} not delivered to ${pluginUuid}:`, e));
}

function columnsFor(serial: string): number {
  return store.devices.find(d => d.serial === serial)?.columns ?? 1;
}

function coordinatesFor(serial: string, controller: Controller, index: number) {
  return controller === "Encoder" ? encoderCoordinates(index) : keyCoordinates(index, columnsFor(serial));
}

function refFor(a: Pick<Appearance, "action" | "context" | "device" | "controller" | "index">): ActionRef {
  return {
    action: a.action,
    context: a.context,
    device: a.device,
    settings: asSettingsObject(store.getPluginSettings(a.context)),
    coordinates: coordinatesFor(a.device, a.controller, a.index),
  };
}

function stateFor(context: string): number | undefined {
  return store.runtimeOverrides[context]?.state;
}

// ─── Visibility tracking (willAppear / willDisappear) ────────

function collectVisible(): Map<string, Appearance> {
  const visible = new Map<string, Appearance>();
  const add = (a: Appearance) => visible.set(`${a.context}|${a.action}`, a);
  for (const serial of store.getConnectedSerials()) {
    const scene = store.getActiveScene(serial);
    if (!scene) continue;
    // Keys shown on the active scene: its own keys plus keys pinned on other scenes of the device.
    // Contexts use the active scene id; settings resolve to the pinned key through findKeyOwner.
    const indices = new Set<number>();
    for (const s of store.getScenes(serial)) for (const idx of Object.keys(s.keys)) indices.add(Number(idx));
    for (const index of indices) {
      const ka = store.getEffectiveKey(serial, scene.id, index);
      const pluginUuid = pluginForAction(ka?.action?.id);
      if (!ka || !pluginUuid) continue;
      add({ pluginUuid, action: ka.action.id, device: serial, controller: "Keypad", index,
        context: store.makeContext(serial, scene.id, "Keypad", index) });
    }
    for (const [idx, enc] of Object.entries(scene.encoders ?? {})) {
      const index = Number(idx);
      const context = store.makeContext(serial, scene.id, "Encoder", index);
      for (const actionId of new Set([enc?.rotateAction?.id, enc?.pressAction?.id])) {
        const pluginUuid = pluginForAction(actionId);
        if (pluginUuid && actionId) add({ pluginUuid, action: actionId, device: serial, controller: "Encoder", index, context });
      }
    }
  }
  return visible;
}

function sendAppear(a: Appearance) {
  sendQuiet(a.pluginUuid, buildAppearEvent("willAppear", refFor(a), a.controller, stateFor(a.context)), "willAppear");
}

function reconcile(visible: Map<string, Appearance>) {
  for (const [key, a] of appeared) {
    if (visible.has(key)) continue;
    appeared.delete(key);
    sendQuiet(a.pluginUuid, buildAppearEvent("willDisappear", refFor(a), a.controller, stateFor(a.context)), "willDisappear");
  }
  for (const [key, a] of visible) {
    if (appeared.has(key)) continue;
    appeared.set(key, a);
    sendAppear(a);
  }
}

// ─── Physical input ──────────────────────────────────────────

/** Forward a key press/release on an external-action key to its plugin. No-op for other actions. */
export function dispatchKey(serial: string, sceneId: string, keyIndex: number, kind: KeyEventName) {
  const scene = store.getActiveScene(serial);
  if (!scene || scene.id !== sceneId) return;
  // Includes a key pinned on another scene, as App resolves it.
  const ka = store.getEffectiveKey(serial, sceneId, keyIndex);
  const pluginUuid = pluginForAction(ka?.action?.id);
  if (!ka || !pluginUuid) return;
  const context = store.makeContext(serial, sceneId, "Keypad", keyIndex);
  const ref = refFor({ action: ka.action.id, context, device: serial, controller: "Keypad", index: keyIndex });
  sendToPlugin(pluginUuid, buildKeyEvent(kind, ref, { state: stateFor(context) }))
    .catch(e => console.warn(`[Plugins] ${kind} for ${ka.action.label} not delivered (plugin ${pluginUuid} not connected?):`, e));
}

/**
 * Forward an encoder event to the external action configured for it. Rotation goes to the
 * rotate action, press/release to the press action; when that slot is empty ("none") the
 * other slot's external action receives it (an Elgato encoder action handles both).
 */
export function dispatchEncoder(serial: string, sceneId: string, encIndex: number, kind: DialEventName, ticks?: number) {
  const scene = store.getActiveScene(serial);
  if (!scene || scene.id !== sceneId) return;
  const enc = scene.encoders?.[String(encIndex)];
  if (!enc) return;
  const primary = kind === "dialRotate" ? enc.rotateAction : enc.pressAction;
  const secondary = kind === "dialRotate" ? enc.pressAction : enc.rotateAction;
  let actionId = primary?.id;
  let pluginUuid = pluginForAction(actionId);
  if (!pluginUuid && (!actionId || actionId === "none")) {
    actionId = secondary?.id;
    pluginUuid = pluginForAction(actionId);
  }
  if (!pluginUuid || !actionId) return;
  const context = store.makeContext(serial, sceneId, "Encoder", encIndex);
  const ref = refFor({ action: actionId, context, device: serial, controller: "Encoder", index: encIndex });
  sendToPlugin(pluginUuid, buildDialEvent(kind, ref, ticks))
    .catch(e => console.warn(`[Plugins] ${kind} not delivered (plugin ${pluginUuid} not connected?):`, e));
}

/**
 * Run an external action as a multi-action step: keyDown + keyUp with isInMultiAction=true,
 * addressed to a per-step context derived from the multi-action key's context, so plugin replies
 * never land on the multi-action key itself (they are ignored, see MULTI_STEP_MARK). Step settings
 * are sent as the action's settings (a `pluginSettings` JSON string, when present, is used as the
 * settings object).
 */
export async function dispatchMultiActionStep(
  actionId: string,
  settings: Record<string, string>,
  ctx: { serial: string; sceneId?: string; keyIndex?: number } | undefined,
  stepIndex = 0,
) {
  const pluginUuid = pluginForAction(actionId);
  if (!pluginUuid) throw new Error(`External action ${actionId} has no enabled plugin`);
  if (!ctx?.serial || ctx.keyIndex === undefined) {
    throw new Error(`External action ${actionId} in a multi-action needs a key context`);
  }
  const sceneId = ctx.sceneId ?? store.getActiveScene(ctx.serial)?.id;
  if (!sceneId) throw new Error(`No active scene on ${ctx.serial}`);
  // Plain key/value step settings get their {{$var}} templates resolved per value; a
  // pluginSettings JSON document is the plugin's own data and is passed through as-is.
  let stepSettings: Record<string, unknown> = store.resolveSettings(settings);
  if (settings.pluginSettings) {
    try { stepSettings = asSettingsObject(JSON.parse(settings.pluginSettings)); }
    catch { throw new Error(`Invalid pluginSettings JSON for ${actionId}`); }
  }
  const context = `${store.makeContext(ctx.serial, sceneId, "Keypad", ctx.keyIndex)}${MULTI_STEP_MARK}${stepIndex}`;
  const ref: ActionRef = {
    action: actionId, context, device: ctx.serial, settings: stepSettings,
    coordinates: keyCoordinates(ctx.keyIndex, columnsFor(ctx.serial)),
  };
  await sendToPlugin(pluginUuid, buildKeyEvent("keyDown", ref, { isInMultiAction: true }));
  await sendToPlugin(pluginUuid, buildKeyEvent("keyUp", ref, { isInMultiAction: true }));
}

// ─── Plugin → host commands ──────────────────────────────────

/**
 * `pluginUuid`'s action currently configured at a context, or null when the context shows no action
 * of that plugin. Gates every plugin command, so a plugin can only change its own keys/encoders.
 */
function actionAtContext(context: string, pluginUuid: string): Appearance | null {
  for (const a of appeared.values()) {
    if (a.context === context && a.pluginUuid === pluginUuid) return a;
  }
  const parsed = store.parseContext(context);
  if (!parsed) return null;
  const scene = store.getActiveScene(parsed.serial);
  if (!scene || scene.id !== parsed.sceneId) return null;
  let actionId: string | undefined;
  if (parsed.controller === "Keypad") {
    actionId = store.getEffectiveKey(parsed.serial, parsed.sceneId, parsed.index)?.action?.id;
  } else {
    const enc = scene.encoders?.[String(parsed.index)];
    actionId = [enc?.rotateAction?.id, enc?.pressAction?.id].find(id => pluginForAction(id) === pluginUuid);
  }
  if (!actionId || pluginForAction(actionId) !== pluginUuid) return null;
  return { pluginUuid, action: actionId, context, device: parsed.serial, controller: parsed.controller, index: parsed.index };
}

function flash(context: string, kind: "ok" | "alert") {
  store.setRuntimeOverride(context, { flash: kind });
  const prev = flashTimers.get(context);
  if (prev !== undefined) clearTimeout(prev);
  flashTimers.set(context, window.setTimeout(() => {
    flashTimers.delete(context);
    store.setRuntimeOverride(context, { flash: undefined });
  }, FLASH_MS));
}

function handlePluginCommand(pluginUuid: string, raw: string) {
  const msg = parsePluginMessage(raw);
  if (!msg) { console.warn(`[Plugins] Unparseable command from ${pluginUuid}`); return; }
  const context = msg.context;
  if (typeof context === "string" && MULTI_STEP_CONTEXT.test(context)) {
    console.debug(`[Plugins] Ignoring ${msg.event} from ${pluginUuid} for a multi-action step`);
    return;
  }
  if (!context || !store.parseContext(context)) {
    console.warn(`[Plugins] ${msg.event} from ${pluginUuid} has an unknown context:`, context);
    return;
  }
  const a = actionAtContext(context, pluginUuid);
  if (!a) {
    console.warn(`[Plugins] Ignoring ${msg.event} from ${pluginUuid}: no action of this plugin at`, context);
    return;
  }

  switch (msg.event) {
    case "setTitle":
    case "setImage":
    case "setState": {
      const patch = commandToOverride(msg.event, msg.payload);
      if (patch) store.setRuntimeOverride(context, patch);
      else console.warn(`[Plugins] Invalid ${msg.event} payload from ${pluginUuid}`);
      return;
    }
    case "showOk":
      flash(context, "ok");
      return;
    case "showAlert":
      flash(context, "alert");
      return;
    case "setSettings":
      store.setPluginSettings(context, asSettingsObject(msg.payload));
      return;
    case "getSettings":
      sendQuiet(pluginUuid, buildDidReceiveSettings(refFor(a), stateFor(context)), "didReceiveSettings");
      return;
    default:
      // sendToPropertyInspector, setFeedback, setFeedbackLayout: this host has no property
      // inspector and no per-encoder feedback layouts, so these have no target.
      console.debug(`[Plugins] ${msg.event} from ${pluginUuid} is not supported by this host`);
  }
}

function clearPluginOverrides(pluginUuid: string) {
  for (const a of appeared.values()) {
    if (a.pluginUuid === pluginUuid) store.clearRuntimeOverride(a.context);
  }
}

// ─── Init ────────────────────────────────────────────────────

/** Start the bridge. Call once at startup; returns a cleanup function. */
export function initExternalBridge(): () => void {
  const unlisteners: Promise<UnlistenFn>[] = [];

  unlisteners.push(listen<{ plugin_uuid: string; message: string }>("plugin-command", (e) => {
    try { handlePluginCommand(e.payload.plugin_uuid, e.payload.message); }
    catch (err) { console.error("[Plugins] Failed to handle plugin command:", err); }
  }));

  unlisteners.push(listen<{ plugin_uuid: string }>("plugin-connected", (e) => {
    const uuid = e.payload.plugin_uuid;
    for (const a of appeared.values()) if (a.pluginUuid === uuid) sendAppear(a);
  }));

  unlisteners.push(listen<{ plugin_uuid: string }>("plugin-disconnected", (e) => {
    // Titles/images set by a plugin that went away would otherwise stay stale.
    clearPluginOverrides(e.payload.plugin_uuid);
  }));

  const stopEffects = $effect.root(() => {
    $effect(() => {
      const visible = collectVisible();
      untrack(() => reconcile(visible));
    });
  });

  return () => {
    stopEffects();
    for (const u of unlisteners) u.then(fn => fn()).catch(() => {});
    for (const t of flashTimers.values()) clearTimeout(t);
    flashTimers.clear();
    appeared.clear();
  };
}
