// Thin re-export layer — all state lives in store.svelte.ts
import { store } from "./store.svelte";
import type { ActionContext } from "./store.svelte";
export { ACTION_TYPES, store, registerActionType, unregisterActionType, executePluginAction } from "./store.svelte";
export type {
  ActionDef, TextConfig, IconConfig, KeyAssignment, SceneTrigger,
  EncoderConfig, StripItem, StripConfig, Scene, DeviceInfo, DeviceConfig, SavedProfile,
  RuntimeOverride, ControllerKind, ActionContext, ActionExecutor, ParsedContext,
} from "./store.svelte";

// Scene getters (edited device unless a serial is given)
export function getScenes(serial?: string) { return store.getScenes(serial); }
export function getActiveScene(serial?: string) { return store.getActiveScene(serial); }
export function getActiveSceneId(serial?: string) { return store.getActiveSceneId(serial); }
export function getSceneStack(serial?: string) { return store.getSceneStack(serial); }

// Scene mutations
export function createScene(name: string) { return store.createScene(name); }
export function deleteScene(id: string) { store.deleteScene(id); }
export function renameScene(id: string, name: string) { store.renameScene(id, name); }
export function updateSceneTriggers(id: string, triggers: Parameters<typeof store.updateSceneTriggers>[1]) { store.updateSceneTriggers(id, triggers); }
export function duplicateScene(id: string) { return store.duplicateScene(id); }

// Scene navigation (edited device unless a serial is given)
export function switchScene(id: string, preserveSelection?: boolean, serial?: string) { store.switchScene(id, preserveSelection, serial); }
export function pushScene(id: string, serial?: string) { store.pushScene(id, serial); }
export function popScene(serial?: string) { store.popScene(serial); }

// Selection
export function getSelectedKeyIndex() { return store.selectedKeyIndex; }
export function getSelectedEncoderIndex() { return store.selectedEncoderIndex; }
export function selectKey(index: number | null) { store.selectKey(index); }
export function selectEncoder(index: number | null) { store.selectEncoder(index); }

// Key methods
export function getKeyAssignment(index: number) { return store.getKeyAssignment(index); }
export function getKeyAssignmentForDevice(serial: string, index: number) { return store.getKeyAssignmentForDevice(serial, index); }
export function getEffectiveKey(serial: string, sceneId: string, index: number) { return store.getEffectiveKey(serial, sceneId, index); }
export function isPinnedOverlay(index: number) { return store.isPinnedOverlay(index); }
export function getEncoderConfigForDevice(serial: string, index: number) { return store.getEncoderConfigForDevice(serial, index); }
export function assignAction(keyIndex: number, action: Parameters<typeof store.assignAction>[1]) { store.assignAction(keyIndex, action); }
export function swapKeys(from: number, to: number) { store.swapKeys(from, to); }
export function updateKeySetting(keyIndex: number, key: string, value: string) { store.updateKeySetting(keyIndex, key, value); }
export function setKeySettings(keyIndex: number, settings: Record<string, string>) { store.setKeySettings(keyIndex, settings); }
export function setKeyBackgroundColor(keyIndex: number, color: string) { store.setKeyBackgroundColor(keyIndex, color); }
export function setKeyImage(keyIndex: number, dataUrl: string, filePath?: string) { store.setKeyImage(keyIndex, dataUrl, filePath); }
export function removeKeyImage(keyIndex: number) { store.removeKeyImage(keyIndex); }
export function setKeyImageUrl(keyIndex: number, url: string, fit?: Parameters<typeof store.setKeyImageUrl>[2]) { store.setKeyImageUrl(keyIndex, url, fit); }
export function setKeyImageFit(keyIndex: number, fit: Parameters<typeof store.setKeyImageFit>[1]) { store.setKeyImageFit(keyIndex, fit); }
export function setKeyText(keyIndex: number, textConfig: Parameters<typeof store.setKeyText>[1], textIndex?: number) { store.setKeyText(keyIndex, textConfig, textIndex); }
export function addKeyText(keyIndex: number) { store.addKeyText(keyIndex); }
export function removeKeyText(keyIndex: number, textIndex: number) { store.removeKeyText(keyIndex, textIndex); }
export function getKeyTexts(keyIndex: number) { return store.getKeyTexts(keyIndex); }
export function setKeyIcon(keyIndex: number, iconConfig: Parameters<typeof store.setKeyIcon>[1], iconIndex?: number) { store.setKeyIcon(keyIndex, iconConfig, iconIndex); }
export function removeKeyIcon(keyIndex: number) { store.removeKeyIcon(keyIndex); }
export function getKeyIcons(keyIndex: number) { return store.getKeyIcons(keyIndex); }
export function addKeyIcon(keyIndex: number) { store.addKeyIcon(keyIndex); }
export function removeKeyIconAt(keyIndex: number, iconIndex: number) { store.removeKeyIconAt(keyIndex, iconIndex); }
export function togglePinned(keyIndex: number) { store.togglePinned(keyIndex); }
export function isPinned(keyIndex: number) { return store.isPinned(keyIndex); }
export function clearKey(keyIndex: number) { store.clearKey(keyIndex); }
export function getEditorKeyOverride(keyIndex: number) { return store.getEditorKeyOverride(keyIndex); }

// Encoder methods
export function defaultEncoderConfig() { return store.defaultEncoderConfig(); }
export function getEncoderConfig(index: number) { return store.getEncoderConfig(index); }
export function setEncoderConfig(index: number, config: Parameters<typeof store.setEncoderConfig>[1]) { store.setEncoderConfig(index, config); }
export function getEncoderResolved(index: number) { return store.getEncoderResolved(index); }
export function handleEncoderRotate(index: number, delta: number) { store.handleEncoderRotate(index, delta); }
export function handleEncoderPress(index: number) { store.handleEncoderPress(index); }

// Strip
export function getStripConfig() { return store.getStripConfig(); }
export function getStripConfigForDevice(serial: string) { return store.getStripConfigForDevice(serial); }
export function updateStrip(config: Parameters<typeof store.updateStrip>[0]) { store.updateStrip(config); }
export function addStripItem(item: Parameters<typeof store.addStripItem>[0]) { store.addStripItem(item); }
export function updateStripItem(id: string, partial: any) { store.updateStripItem(id, partial); }
export function removeStripItem(id: string) { store.removeStripItem(id); }
export function selectStripItem(id: string | null) { store.selectStripItem(id); }
export function handleStripTap(x: number, y: number) { store.handleStripTap(x, y); }
export function handleStripLongPress(x: number, y: number) { store.handleStripLongPress(x, y); }
export function handleStripSwipe(fx: number, fy: number, tx: number, ty: number) { store.handleStripSwipe(fx, fy, tx, ty); }
export function getSelectedStripItemId() { return store.selectedStripItemId; }

// Actions
export function executeAction(actionId: string, settings: Record<string, string>, ctx?: ActionContext) { return store.executeAction(actionId, settings, ctx); }
export function executeKeyAction(serial: string, keyIndex: number) { return store.executeKeyAction(serial, keyIndex); }
export function getDefaultSettings(actionId: string) { return store.getDefaultSettings(actionId); }

// Favorites / Recent
export function getRecentActions() { return store.getRecentActions(); }
export function getFavoriteActions() { return store.getFavoriteActions(); }
export function toggleFavorite(id: string) { store.toggleFavorite(id); }
export function isFavorite(id: string) { return store.isFavorite(id); }

// Helpers
export function findAction(id: string) { return store.findAction(id); }
export function searchActions(query: string) { return store.searchActions(query); }
export function defaultTextConfig() { return store.defaultTextConfig(); }

// Undo / Redo
export function undo() { store.undo(); }
export function redo() { store.redo(); }
export function canUndo() { return store.canUndo(); }
export function canRedo() { return store.canRedo(); }

// Timer / Counter on the edited device's active scene (physical presses go through executeAction)
export function handleTimerPress(keyIndex: number) {
  const serial = store.boundSerial, sceneId = store.getActiveSceneId();
  const key = store.getKeyAssignment(keyIndex);
  if (serial && sceneId && key) store.handleTimerPress(serial, sceneId, keyIndex, store.resolveActionSettings("timer", key.settings));
}
export function handleCounterPress(keyIndex: number) {
  const serial = store.boundSerial, sceneId = store.getActiveSceneId();
  if (serial && sceneId) store.handleCounterPress(serial, sceneId, keyIndex);
}

// Profile
export function getActiveProfileName() { return store.activeProfileName; }
export function getLoadError() { return store.loadError; }
export function getLastError() { return store.lastError; }
export async function loadProfile(name: string) { return store.loadProfile(name); }
export async function reloadProfileFromDisk(name?: string) { return store.reloadProfileFromDisk(name); }
export async function listProfiles() { return store.listProfiles(); }
export async function createProfile(name: string) { return store.createProfile(name); }
export async function deleteProfile(name: string) { return store.deleteProfile(name); }
export async function initStore() { return store.initStore(); }
export function switchToDevice(serial: string, prevSerial?: string | null) { store.switchToDevice(serial, prevSerial); }
