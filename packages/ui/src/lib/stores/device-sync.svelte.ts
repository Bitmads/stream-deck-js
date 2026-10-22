// Hardware sync (contract C3): renders and pushes the keys and the LCD strip of EVERY connected
// device's active scene, independent of which device or UI tab is shown in the editor.
//
// One reactive effect per device resolves each key's (and the strip's) render inputs. Resolution
// reads only the variables a key actually uses, so e.g. time.seconds re-runs a device's effect only
// if one of its keys or its strip shows it. Each key/strip has a fingerprint of its resolved inputs;
// it is rendered and sent only when that fingerprint changes. Device (re)open and profile reload bump
// the device epoch in the store, which resets the fingerprints and re-sends everything.

import { invoke } from "@tauri-apps/api/core";
import { store } from "./store.svelte";
import { deviceKeyCount, deviceKeyPixelSize, type DeviceInfo } from "../types/profile";
import { resolveKeyInputs, keyFingerprint, renderResolvedKey, keyDesignSize, type ResolvedKeyInputs } from "../utils/render-key";
import { resolveStripInputs, stripFingerprint, renderResolvedStrip, type ResolvedStrip } from "../utils/render-strip";
import { isRemoteUrl, peekImageDataUrl } from "../utils/image-cache";

const FLUSH_DELAY_MS = 30;
const RETRY_BASE_MS = 15_000;
/** First retry delay after a failed send (HID write error, device briefly not open). */
const SEND_RETRY_BASE_MS = 1_000;
const MAX_RETRIES = 5;
/** Wait before fetching a not-yet-cached remote image, so a URL being typed is not fetched per keystroke. */
const REMOTE_IMAGE_SETTLE_MS = 500;
const EMPTY = "empty";

interface KeyJob { kind: "key"; index: number; fp: string; inputs: ResolvedKeyInputs | null; attempt: number; }
interface StripJob { kind: "strip"; fp: string; inputs: ResolvedStrip; attempt: number; }

interface DeviceState {
  serial: string;
  epoch: number;
  info: DeviceInfo;
  /** Fingerprint last scheduled per key index / for the strip (what the hardware will show). */
  keyFp: Map<number, string>;
  stripFp: string | null;
  pending: Map<string, KeyJob | StripJob>;
  flushTimer: number | undefined;
  retryTimers: Set<number>;
  /** Monotonic generation per key/strip so a slow older render never overwrites a newer one. */
  gen: Map<string, number>;
  disposed: boolean;
}

function jobKey(job: KeyJob | StripJob): string {
  return job.kind === "key" ? `k${job.index}` : "strip";
}

function newState(info: DeviceInfo): DeviceState {
  return {
    serial: info.serial, epoch: -1, info,
    keyFp: new Map(), stripFp: null, pending: new Map(),
    flushTimer: undefined, retryTimers: new Set(), gen: new Map(), disposed: false,
  };
}

function disposeState(st: DeviceState) {
  st.disposed = true;
  clearTimeout(st.flushTimer);
  for (const t of st.retryTimers) clearTimeout(t);
  st.retryTimers.clear();
  st.pending.clear();
}

function schedule(st: DeviceState, job: KeyJob | StripJob) {
  st.pending.set(jobKey(job), job);
  if (st.flushTimer === undefined) {
    st.flushTimer = window.setTimeout(() => {
      st.flushTimer = undefined;
      const jobs = [...st.pending.values()];
      st.pending.clear();
      for (const j of jobs) void runJob(st, j);
    }, FLUSH_DELAY_MS);
  }
}

/** Forget what was sent so the next effect run re-sends it (after the retries of a failed send). */
function forget(st: DeviceState, job: KeyJob | StripJob) {
  if (job.kind === "key") { if (st.keyFp.get(job.index) === job.fp) st.keyFp.delete(job.index); }
  else if (st.stripFp === job.fp) st.stripFp = null;
}

function isCurrent(st: DeviceState, job: KeyJob | StripJob): boolean {
  if (st.disposed) return false;
  return job.kind === "key" ? st.keyFp.get(job.index) === job.fp : st.stripFp === job.fp;
}

function scheduleRetry(st: DeviceState, job: KeyJob | StripJob, baseMs = RETRY_BASE_MS) {
  if (job.attempt >= MAX_RETRIES) return;
  const t = window.setTimeout(() => {
    st.retryTimers.delete(t);
    if (isCurrent(st, job)) schedule(st, { ...job, attempt: job.attempt + 1 } as KeyJob | StripJob);
  }, baseMs * 2 ** job.attempt);
  st.retryTimers.add(t);
}

function needsFetch(job: KeyJob | StripJob): boolean {
  const urls = job.kind === "key" ? [job.inputs?.image ?? ""] : job.inputs.items.map(i => i.image);
  return urls.some(u => u && isRemoteUrl(u) && peekImageDataUrl(u) === undefined);
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

async function runJob(st: DeviceState, job: KeyJob | StripJob) {
  const k = jobKey(job);
  const gen = (st.gen.get(k) ?? 0) + 1;
  st.gen.set(k, gen);
  const serial = st.serial;
  const stale = () => st.gen.get(k) !== gen || !isCurrent(st, job);
  try {
    if (needsFetch(job)) {
      await sleep(REMOTE_IMAGE_SETTLE_MS);
      if (stale()) return;
    }
    if (job.kind === "key") {
      if (!job.inputs) {
        await invoke("clear_key", { serial, keyIndex: job.index });
        return;
      }
      const size = deviceKeyPixelSize(st.info);
      const { dataUrl, incomplete } = await renderResolvedKey(job.inputs, size, keyDesignSize(size));
      if (stale()) return;
      await invoke("send_rendered_image", { serial, keyIndex: job.index, imageData: dataUrl });
      if (incomplete) scheduleRetry(st, job);
    } else {
      const w = st.info.lcd_width || 800, h = st.info.lcd_height || 100;
      const canvas = document.createElement("canvas");
      canvas.width = w; canvas.height = h;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("No 2D canvas context");
      const { incomplete } = await renderResolvedStrip(ctx, job.inputs, { width: w, height: h });
      if (stale()) return;
      const imageData = canvas.toDataURL("image/jpeg", 0.9);
      await invoke("send_lcd_image", { serial, x: 0, y: 0, w, h, imageData });
      if (incomplete) scheduleRetry(st, job);
    }
  } catch (e) {
    console.warn(`[DeviceSync] ${serial} ${k} failed:`, e);
    // Nothing reactive changes after a failed send of a static key, so retry it with backoff. Once
    // the retries are used up, forget it so the next reactive change (or a reopen) re-sends it.
    if (st.gen.get(k) === gen && isCurrent(st, job) && job.attempt < MAX_RETRIES) scheduleRetry(st, job, SEND_RETRY_BASE_MS);
    else forget(st, job);
  }
}

/** Compute fingerprints for one device and schedule renders for what changed. Runs inside an effect. */
function syncDevice(st: DeviceState, info: DeviceInfo) {
  const epoch = store.deviceEpochs[info.serial] ?? 0;
  if (st.epoch !== epoch) {
    st.epoch = epoch;
    st.keyFp.clear();
    st.stripFp = null;
  }
  st.info = info;

  const sceneId = store.getActiveSceneId(info.serial);
  const keySize = deviceKeyPixelSize(info);

  if (keySize > 0) {
    const count = deviceKeyCount(info);
    for (let i = 0; i < count; i++) {
      const key = sceneId ? store.getEffectiveKey(info.serial, sceneId, i) : undefined;
      let fp: string;
      let inputs: ResolvedKeyInputs | null = null;
      if (key && sceneId) {
        inputs = resolveKeyInputs(key, store.lookupVar, store.getKeyOverride(info.serial, sceneId, i, key));
        fp = keyFingerprint(inputs, keySize);
      } else {
        fp = EMPTY;
      }
      if (st.keyFp.get(i) === fp) continue;
      st.keyFp.set(i, fp);
      schedule(st, { kind: "key", index: i, fp, inputs, attempt: 0 });
    }
  }

  if (info.has_lcd_strip) {
    const scene = store.getActiveScene(info.serial);
    const inputs = resolveStripInputs(scene?.strip, store.lookupVar);
    const fp = stripFingerprint(inputs, info.lcd_width || 800, info.lcd_height || 100);
    if (st.stripFp !== fp) {
      st.stripFp = fp;
      schedule(st, { kind: "strip", fp, inputs, attempt: 0 });
    }
  }
}

/** Start syncing all connected devices to hardware. Call once at startup; returns a stop function. */
export function startDeviceSync(): () => void {
  const states = new Map<string, DeviceState>();

  const stopEffects = $effect.root(() => {
    $effect(() => {
      const devices = store.devices;
      const serials = new Set(devices.map(d => d.serial));
      for (const [serial, st] of states) {
        if (!serials.has(serial)) { disposeState(st); states.delete(serial); }
      }
      for (const info of devices) {
        let st = states.get(info.serial);
        if (!st) { st = newState(info); states.set(info.serial, st); }
        const state = st;
        // Per-device child effect: only this device re-syncs when its scenes/variables change.
        $effect(() => syncDevice(state, info));
      }
    });
  });

  return () => {
    stopEffects();
    for (const st of states.values()) disposeState(st);
    states.clear();
  };
}
