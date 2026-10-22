// Plugin/action context ids: `${serial}:${sceneId}:${controller}:${index}`.
// Parsing takes the serial from the first segment and the controller/index from the last two, so a
// ":" inside the scene id still round-trips (serials never contain ":").

import type { ControllerKind } from "../types/profile";

export interface ParsedContext {
  serial: string;
  sceneId: string;
  controller: ControllerKind;
  index: number;
}

export function makeContext(serial: string, sceneId: string, controller: ControllerKind, index: number): string {
  return `${serial}:${sceneId}:${controller}:${index}`;
}

export function parseContext(ctx: string): ParsedContext | null {
  if (typeof ctx !== "string") return null;
  const parts = ctx.split(":");
  if (parts.length < 4) return null;
  const indexStr = parts[parts.length - 1];
  const controller = parts[parts.length - 2];
  if (controller !== "Keypad" && controller !== "Encoder") return null;
  if (!/^\d+$/.test(indexStr)) return null;
  const head = parts.slice(0, -2);
  // serial is the first segment; the scene id is everything between serial and controller
  const serial = head[0];
  const sceneId = head.slice(1).join(":");
  if (!serial || !sceneId) return null;
  return { serial, sceneId, controller, index: Number(indexStr) };
}
