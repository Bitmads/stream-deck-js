// Thin re-export layer — all state lives in store.svelte.ts
import { store } from "./store.svelte";
export type { DeviceInfo } from "./store.svelte";

export function getDevices() { return store.devices; }
export function getSelectedDevice() { return store.selectedDevice; }
export function isLoading() { return store.deviceLoading; }
export function getError() { return store.deviceError; }
export async function refreshDevices() { return store.refreshDevices(); }
export async function selectDevice(device: Parameters<typeof store.selectDevice>[0]) { return store.selectDevice(device); }
