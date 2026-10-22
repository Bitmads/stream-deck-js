// Touch-strip (LCD) rendering shared by the device sync and the editor preview, so preview == device.
//
// resolveStripInputs() is pure and reads only the variables the strip uses; stripFingerprint() of
// the result lets callers skip unchanged strips. renderStrip() loads all images first and then draws
// synchronously, so overlapping renders never interleave on one canvas.
// Item coordinates are in the 800x100 design space; other LCD sizes are scaled.

import type { StripConfig, StripItem } from "../types/profile";
import { resolveColor, resolveNumber, resolveTemplate, type VarLookup } from "./template";
import { drawTextLayer, drawImageFit, type ResolvedTextLayer } from "./draw-text";
import { iconToDataUrl } from "./icon-svg";
import { loadImage } from "./image-cache";
import { ensureFontLoaded, isCustomFontFamily } from "./font";
import { getDefaultVarLookup, resolveImageUrl, fingerprintOf } from "./render-key";

export const STRIP_DESIGN_WIDTH = 800;
export const STRIP_DESIGN_HEIGHT = 100;
export const DEFAULT_STRIP_BACKGROUND = "#0a0a1a";

export interface ResolvedStripItem {
  id: string;
  x: number; y: number; w: number; h: number;
  background: string | null;
  bar: { ratio: number; color: string; position: "bottom" | "full" | "left"; thickness: number } | null;
  image: string;
  imageFit: "fill" | "cover" | "contain" | "none";
  icon: { svgBody: string; viewBox: string; color: string; size: number } | null;
  texts: ResolvedTextLayer[];
}

export interface ResolvedStrip {
  background: string;
  items: ResolvedStripItem[];
}

function resolveItem(item: StripItem, lookup: VarLookup): ResolvedStripItem {
  let bar: ResolvedStripItem["bar"] = null;
  if (item.bar) {
    const val = resolveNumber(item.bar.value, lookup, 0);
    const min = resolveNumber(item.bar.min, lookup, 0);
    const max = resolveNumber(item.bar.max, lookup, 100);
    const ratio = max > min ? Math.max(0, Math.min(1, (val - min) / (max - min))) : 0;
    bar = {
      ratio,
      color: resolveColor(item.bar.color || "#03a9f4", lookup, "#03a9f4"),
      position: item.bar.position === "full" || item.bar.position === "left" ? item.bar.position : "bottom",
      thickness: Number(item.bar.height) > 0 ? Number(item.bar.height) : 8,
    };
  }
  const icon = item.icon && item.icon.svgBody ? {
    svgBody: item.icon.svgBody, viewBox: item.icon.viewBox,
    color: resolveColor(item.icon.color || "#ffffff", lookup, "#ffffff"),
    size: Math.max(1, Math.min(Number(item.icon.size) > 0 ? Number(item.icon.size) : 48, item.h - 4)),
  } : null;
  const texts: ResolvedTextLayer[] = [];
  for (const t of item.texts || []) {
    if (!t || t.hidden || !t.text) continue;
    const text = resolveTemplate(t.text, lookup);
    if (!text) continue;
    texts.push({
      text,
      fontFamily: t.fontFamily || "sans-serif",
      fontSize: Number(t.fontSize) > 0 ? Number(t.fontSize) : 14,
      fontWeight: t.fontWeight, fontStyle: t.fontStyle,
      color: resolveColor(t.color || "#ffffff", lookup, "#ffffff"),
      hAlign: t.hAlign, vAlign: t.vAlign, anchor: t.anchor,
      useAbsolutePos: !!t.useAbsolutePos, x: t.x, y: t.y, wrap: t.wrap,
      shadow: t.shadow ? { ...t.shadow, color: resolveColor(t.shadow.color, lookup, "#000000") } : undefined,
      stroke: t.stroke ? { ...t.stroke, color: resolveColor(t.stroke.color, lookup, "#000000") } : undefined,
    });
  }
  return {
    id: item.id,
    x: Number(item.x) || 0, y: Number(item.y) || 0, w: Number(item.w) || 0, h: Number(item.h) || 0,
    background: item.backgroundColor ? resolveColor(item.backgroundColor, lookup, "#333333") : null,
    bar,
    image: item.imageDataUrl || resolveImageUrl(item.imageUrl, lookup),
    imageFit: item.imageFit || "fill",
    icon,
    texts,
  };
}

/** Resolve everything that affects the strip's pixels. Pure; reads only the variables the strip uses. */
export function resolveStripInputs(strip: StripConfig | undefined | null, lookup: VarLookup = getDefaultVarLookup()): ResolvedStrip {
  return {
    background: resolveColor(strip?.backgroundColor || DEFAULT_STRIP_BACKGROUND, lookup, DEFAULT_STRIP_BACKGROUND),
    items: (strip?.items || []).map(it => resolveItem(it, lookup)),
  };
}

/** Stable fingerprint of a strip's resolved inputs at a given output size. */
export function stripFingerprint(resolved: ResolvedStrip, width: number, height: number): string {
  return fingerprintOf([width, height, resolved]);
}

export interface RenderStripOptions {
  lookup?: VarLookup;
  /** Output size in px (defaults to the canvas size). */
  width?: number;
  height?: number;
  /** Editor preview: outline this item. */
  selectedItemId?: string | null;
}

/** Draw resolved strip inputs. Returns incomplete=true when an image/icon failed to load. */
export async function renderResolvedStrip(
  ctx: CanvasRenderingContext2D,
  resolved: ResolvedStrip,
  opts: { width?: number; height?: number; selectedItemId?: string | null } = {},
): Promise<{ incomplete: boolean }> {
  const width = opts.width ?? ctx.canvas.width;
  const height = opts.height ?? ctx.canvas.height;
  const sx = width / STRIP_DESIGN_WIDTH, sy = height / STRIP_DESIGN_HEIGHT;
  let incomplete = false;

  // Preload images, icons and fonts.
  const images = new Map<string, HTMLImageElement>();
  const icons = new Map<string, HTMLImageElement>();
  for (const it of resolved.items) {
    if (it.image) {
      try { images.set(it.id, await loadImage(it.image)); } catch { incomplete = true; }
    }
    if (it.icon) {
      try { icons.set(it.id, await loadImage(iconToDataUrl(it.icon, it.icon.color, it.icon.size * Math.max(sx, sy)))); }
      catch { incomplete = true; }
    }
    for (const t of it.texts) {
      if (isCustomFontFamily(t.fontFamily)) await ensureFontLoaded(t.fontFamily, t.fontWeight, t.fontStyle);
    }
  }

  ctx.save();
  ctx.setTransform(sx, 0, 0, sy, 0, 0);
  ctx.fillStyle = resolved.background;
  ctx.fillRect(0, 0, STRIP_DESIGN_WIDTH, STRIP_DESIGN_HEIGHT);

  for (const it of resolved.items) {
    const { x, y, w, h } = it;
    ctx.save();
    ctx.beginPath(); ctx.roundRect(x, y, w, h, 4); ctx.clip();

    if (it.background) {
      ctx.fillStyle = it.background;
      ctx.fillRect(x, y, w, h);
    }

    if (it.bar) {
      const { ratio, color, position, thickness } = it.bar;
      if (position === "full") {
        ctx.fillStyle = color;
        ctx.fillRect(x, y, w * ratio, h);
      } else if (position === "left") {
        ctx.fillStyle = "rgba(255,255,255,0.1)";
        ctx.fillRect(x, y, thickness, h);
        ctx.fillStyle = color;
        ctx.fillRect(x, y + h * (1 - ratio), thickness, h * ratio);
      } else {
        ctx.fillStyle = "rgba(255,255,255,0.1)";
        ctx.beginPath(); ctx.roundRect(x + 4, y + h - thickness - 4, w - 8, thickness, 3); ctx.fill();
        ctx.fillStyle = color;
        ctx.beginPath(); ctx.roundRect(x + 4, y + h - thickness - 4, (w - 8) * ratio, thickness, 3); ctx.fill();
      }
    }

    const img = images.get(it.id);
    if (img) drawImageFit(ctx, img, { x, y, w, h }, it.imageFit);

    const iconImg = icons.get(it.id);
    if (iconImg && it.icon) {
      const s = it.icon.size;
      ctx.drawImage(iconImg, x + (w - s) / 2, y + (h - s) / 2, s, s);
    }

    for (const t of it.texts) drawTextLayer(ctx, t, { x, y, w, h }, { padding: 4, squash: true });

    ctx.restore();

    if (opts.selectedItemId && it.id === opts.selectedItemId) {
      ctx.strokeStyle = "#0078ff"; ctx.lineWidth = 2;
      ctx.strokeRect(x, y, w, h);
    }
  }
  ctx.restore();
  return { incomplete };
}

/** Render a strip config onto a canvas context (preview or offscreen device canvas). */
export async function renderStrip(
  canvasCtx: CanvasRenderingContext2D,
  strip: StripConfig | undefined | null,
  opts: RenderStripOptions = {},
): Promise<{ incomplete: boolean }> {
  const resolved = resolveStripInputs(strip, opts.lookup ?? getDefaultVarLookup());
  return renderResolvedStrip(canvasCtx, resolved, opts);
}
