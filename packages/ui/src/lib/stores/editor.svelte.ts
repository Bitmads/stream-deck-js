// Thin re-export layer — all state lives in store.svelte.ts
import { store } from "./store.svelte";
export { ACTION_TYPES, store, registerActionType, unregisterActionType, executePluginAction } from "./store.svelte";
export type {
  ActionDef, TextConfig, IconConfig, KeyAssignment, SceneTrigger,
  EncoderConfig, StripItem, StripConfig, Scene, DeviceInfo,
} from "./store.svelte";

// Scene getters
export function getScenes() { return store.getScenes(); }
export function getActiveScene() { return store.getActiveScene(); }
export function getActiveSceneId() { return store.getActiveSceneId(); }
export function getSceneStack() { return store.getSceneStack(); }

// Scene mutations
export function createScene(name: string) { return store.createScene(name); }
export function deleteScene(id: string) { store.deleteScene(id); }
export function renameScene(id: string, name: string) { store.renameScene(id, name); }
export function updateSceneTriggers(id: string, triggers: Parameters<typeof store.updateSceneTriggers>[1]) { store.updateSceneTriggers(id, triggers); }
export function duplicateScene(id: string) { return store.duplicateScene(id); }

// Scene navigation
export function switchScene(id: string, preserveSelection?: boolean) { store.switchScene(id, preserveSelection); }
export function pushScene(id: string) { store.pushScene(id); }
export function popScene() { store.popScene(); }

// Selection
export function getSelectedKeyIndex() { return store.selectedKeyIndex; }
export function getSelectedEncoderIndex() { return store.selectedEncoderIndex; }
export function selectKey(index: number | null) { store.selectKey(index); }
export function selectEncoder(index: number | null) { store.selectEncoder(index); }

// Key methods
export function getKeyAssignment(index: number) { return store.getKeyAssignment(index); }
export function assignAction(keyIndex: number, action: Parameters<typeof store.assignAction>[1]) { store.assignAction(keyIndex, action); }
export function swapKeys(from: number, to: number) { store.swapKeys(from, to); }
export function updateKeySetting(keyIndex: number, key: string, value: string) { store.updateKeySetting(keyIndex, key, value); }
export function setKeyBackgroundColor(keyIndex: number, color: string) { store.setKeyBackgroundColor(keyIndex, color); }
export function setKeyImage(keyIndex: number, dataUrl: string, filePath?: string) { store.setKeyImage(keyIndex, dataUrl, filePath); }
export function removeKeyImage(keyIndex: number) { store.removeKeyImage(keyIndex); }
export function setKeyText(keyIndex: number, textConfig: Parameters<typeof store.setKeyText>[1], textIndex?: number) { store.setKeyText(keyIndex, textConfig, textIndex); }
export function addKeyText(keyIndex: number) { store.addKeyText(keyIndex); }
export function removeKeyText(keyIndex: number, textIndex: number) { store.removeKeyText(keyIndex, textIndex); }
export function getKeyTexts(keyIndex: number) { return store.getKeyTexts(keyIndex); }
export function setKeyIcon(keyIndex: number, iconConfig: Parameters<typeof store.setKeyIcon>[1]) { store.setKeyIcon(keyIndex, iconConfig); }
export function removeKeyIcon(keyIndex: number) { store.removeKeyIcon(keyIndex); }
export function togglePinned(keyIndex: number) { store.togglePinned(keyIndex); }
export function isPinned(keyIndex: number) { return store.isPinned(keyIndex); }
export function clearKey(keyIndex: number) { store.clearKey(keyIndex); }

// Encoder methods
export function defaultEncoderConfig() { return store.defaultEncoderConfig(); }
export function getEncoderConfig(index: number) { return store.getEncoderConfig(index); }
export function setEncoderConfig(index: number, config: Parameters<typeof store.setEncoderConfig>[1]) { store.setEncoderConfig(index, config); }
export function getEncoderResolved(index: number) { return store.getEncoderResolved(index); }
export function handleEncoderRotate(index: number, delta: number) { store.handleEncoderRotate(index, delta); }
export function handleEncoderPress(index: number) { store.handleEncoderPress(index); }

// Strip
export function getStripConfig() { return store.getStripConfig(); }
export function updateStrip(config: Parameters<typeof store.updateStrip>[0]) { store.updateStrip(config); }
export function addStripItem(item: Parameters<typeof store.addStripItem>[0]) { store.addStripItem(item); }
export function updateStripItem(id: string, partial: any) { store.updateStripItem(id, partial); }
export function removeStripItem(id: string) { store.removeStripItem(id); }
export function selectStripItem(id: string | null) { store.selectStripItem(id); }
export function handleStripTap(x: number, y: number) { store.handleStripTap(x, y); }
export function handleStripLongPress(x: number, y: number) { store.handleStripLongPress(x, y); }
export function handleStripSwipe(fx: number, fy: number, tx: number, ty: number) { store.handleStripSwipe(fx, fy, tx, ty); }
export function getSelectedStripItemId() { return store.selectedStripItemId; }

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

// Timer / Counter
export function handleTimerPress(keyIndex: number) { store.handleTimerPress(keyIndex); }
export function handleCounterPress(keyIndex: number) { store.handleCounterPress(keyIndex); }

// Profile
export function getActiveProfileName() { return store.activeProfileName; }
export async function loadProfile(name: string) { return store.loadProfile(name); }
export async function listProfiles() { return store.listProfiles(); }
export async function createProfile(name: string) { return store.createProfile(name); }
export async function deleteProfile(name: string) { return store.deleteProfile(name); }
export async function initStore() { return store.initStore(); }
export function switchToDevice(serial: string, prevSerial?: string | null) { store.switchToDevice(serial, prevSerial); }
