// RFC 4122 name-based UUID (version 5, SHA-1), used for deterministic scene ids.

import { createHash } from "node:crypto";

/** Namespace of deck scene ids: sceneId(slug) = uuidv5(slug, DECK_SCENE_NAMESPACE). Never change it. */
export const DECK_SCENE_NAMESPACE = "f09c68c1-4b45-48f6-9a8a-b8853172aa09";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(s: string): boolean {
  return UUID_RE.test(s);
}

export function uuidv5(name: string, namespace: string): string {
  if (!isUuid(namespace)) throw new Error(`Invalid namespace UUID "${namespace}"`);
  const ns = Buffer.from(namespace.replace(/-/g, ""), "hex");
  const hash = createHash("sha1").update(ns).update(Buffer.from(name, "utf8")).digest();
  const b = Buffer.from(hash.subarray(0, 16));
  b[6] = (b[6] & 0x0f) | 0x50;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Deterministic scene id for a deck scene slug. */
export function sceneIdFromSlug(slug: string): string {
  return uuidv5(slug, DECK_SCENE_NAMESPACE);
}
