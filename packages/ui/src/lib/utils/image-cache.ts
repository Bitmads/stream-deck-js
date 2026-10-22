// Shared image loading for key/strip rendering and previews.
//
// Remote http(s) images are fetched through the backend (`fetch_image_as_data_url`) and drawn from
// the returned data URL, so the canvas is never tainted. A failed fetch throws instead of falling back
// to a cross-origin <img>. Fetched data URLs live in one bounded LRU shared by every renderer, and
// concurrent requests for the same URL share one fetch.

import { invoke } from "@tauri-apps/api/core";

const MAX_ENTRIES = 50;
const dataUrlCache = new Map<string, string>();
const inflight = new Map<string, Promise<string>>();

function lruGet(key: string): string | undefined {
  const v = dataUrlCache.get(key);
  if (v !== undefined) { dataUrlCache.delete(key); dataUrlCache.set(key, v); }
  return v;
}

function lruSet(key: string, value: string) {
  dataUrlCache.delete(key);
  dataUrlCache.set(key, value);
  while (dataUrlCache.size > MAX_ENTRIES) {
    const oldest = dataUrlCache.keys().next().value;
    if (oldest === undefined) break;
    dataUrlCache.delete(oldest);
  }
}

export function isRemoteUrl(src: string): boolean {
  return /^https?:\/\//i.test(src);
}

/** A complete, parseable http(s) URL (partially typed URLs are rejected so they are not fetched). */
export function isFetchableUrl(src: string): boolean {
  if (!isRemoteUrl(src)) return false;
  try {
    const u = new URL(src);
    return (u.protocol === "http:" || u.protocol === "https:") && u.hostname.length > 0;
  } catch { return false; }
}

/** Cached data URL for a remote image, if already fetched (no fetch). */
export function peekImageDataUrl(src: string): string | undefined {
  return isRemoteUrl(src) ? lruGet(src) : src;
}

/** Resolve any image source to something safe to draw: data URLs pass through, remote URLs are fetched. */
export async function resolveImageSrc(src: string): Promise<string> {
  if (!isRemoteUrl(src)) return src;
  if (!isFetchableUrl(src)) throw new Error(`Invalid image URL: ${src}`);
  const cached = lruGet(src);
  if (cached) return cached;
  let p = inflight.get(src);
  if (!p) {
    p = invoke<string>("fetch_image_as_data_url", { url: src })
      .then((dataUrl) => { lruSet(src, dataUrl); return dataUrl; })
      .finally(() => { inflight.delete(src); });
    inflight.set(src, p);
  }
  return p;
}

export async function loadImage(src: string): Promise<HTMLImageElement> {
  const url = await resolveImageSrc(src);
  if (isRemoteUrl(url)) throw new Error("Refusing to draw a cross-origin image");
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Image failed to load"));
    img.src = url;
  });
}

export function clearImageCache() {
  dataUrlCache.clear();
}
