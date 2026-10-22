// Shared text-layer drawing for keys and touch-strip items, so both lay text out identically.
//
// Layout rules:
// - Non-absolute: hAlign/vAlign position the text block inside the box (minus padding); anchor is ignored.
// - Absolute (useAbsolutePos): (x, y) is relative to the box origin; anchor picks which point of the
//   line attaches to x (start/center/end); y is the top of the first line.
// - wrap "word"/"char" wraps to the box width; "\n" always breaks lines.

import type { TextConfig } from "../types/profile";
import { cssFont } from "./font";

/** A text layer whose text and colors are already template-resolved. */
export type ResolvedTextLayer = Pick<TextConfig,
  "text" | "fontFamily" | "fontSize" | "fontWeight" | "fontStyle" | "color" |
  "hAlign" | "vAlign" | "anchor" | "useAbsolutePos" | "x" | "y" | "wrap" | "shadow" | "stroke">;

export interface TextBox { x: number; y: number; w: number; h: number; }

export interface DrawTextOptions {
  /** Inner padding of the box in px. */
  padding: number;
  /** Squeeze unwrapped lines that are wider than the box (canvas fillText maxWidth) instead of clipping. */
  squash?: boolean;
}

export function wrapText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number, mode: string): string[] {
  if (mode !== "word" && mode !== "char") return text.split("\n");
  if (maxWidth <= 0) return text.split("\n");
  const result: string[] = [];
  for (const paragraph of text.split("\n")) {
    if (mode === "word") {
      const words = paragraph.split(/(\s+)/);
      let line = "";
      for (const word of words) {
        const test = line + word;
        if (ctx.measureText(test).width > maxWidth && line.trim()) {
          result.push(line.trim());
          line = word.trimStart();
        } else {
          line = test;
        }
      }
      if (line.trim()) result.push(line.trim());
      else if (result.length === 0) result.push("");
    } else {
      let line = "";
      for (const ch of paragraph) {
        if (ctx.measureText(line + ch).width > maxWidth && line) {
          result.push(line);
          line = ch;
        } else {
          line += ch;
        }
      }
      if (line) result.push(line);
      else if (result.length === 0) result.push("");
    }
  }
  return result;
}

export function drawTextLayer(ctx: CanvasRenderingContext2D, t: ResolvedTextLayer, box: TextBox, opts: DrawTextOptions) {
  const fontSize = t.fontSize > 0 ? t.fontSize : 14;
  const lineHeight = fontSize * 1.2;
  const pad = opts.padding;

  ctx.save();
  ctx.font = cssFont(t.fontWeight, t.fontStyle, fontSize, t.fontFamily);
  ctx.fillStyle = t.color;
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";

  const innerW = box.w - pad * 2;
  const lines = wrapText(ctx, t.text, t.useAbsolutePos ? box.w : innerW, t.wrap || "none");
  const totalHeight = lines.length * lineHeight;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;

    let lineWidth = ctx.measureText(line).width;
    const maxW = opts.squash && lineWidth > innerW && innerW > 0 ? innerW : undefined;
    if (maxW !== undefined) lineWidth = maxW;

    let x: number;
    let y: number;
    if (t.useAbsolutePos) {
      const bx = box.x + (t.x ?? 0);
      const by = box.y + (t.y ?? 0);
      x = t.anchor === "center" ? bx - lineWidth / 2 : t.anchor === "end" ? bx - lineWidth : bx;
      y = by + i * lineHeight + fontSize;
    } else {
      x = t.hAlign === "left" ? box.x + pad
        : t.hAlign === "right" ? box.x + box.w - pad - lineWidth
        : box.x + (box.w - lineWidth) / 2;
      const top = t.vAlign === "top" ? box.y + pad
        : t.vAlign === "bottom" ? box.y + box.h - totalHeight - pad
        : box.y + (box.h - totalHeight) / 2;
      y = top + i * lineHeight + fontSize;
    }

    if (t.shadow) {
      ctx.shadowColor = t.shadow.color;
      ctx.shadowBlur = t.shadow.blur;
      ctx.shadowOffsetX = t.shadow.offsetX;
      ctx.shadowOffsetY = t.shadow.offsetY;
    }
    if (t.stroke && t.stroke.width > 0) {
      ctx.strokeStyle = t.stroke.color;
      ctx.lineWidth = t.stroke.width;
      ctx.lineJoin = "round";
      if (maxW !== undefined) ctx.strokeText(line, x, y, maxW); else ctx.strokeText(line, x, y);
    }
    if (maxW !== undefined) ctx.fillText(line, x, y, maxW); else ctx.fillText(line, x, y);
    if (t.shadow) {
      ctx.shadowColor = "transparent";
      ctx.shadowBlur = 0;
      ctx.shadowOffsetX = 0;
      ctx.shadowOffsetY = 0;
    }
  }
  ctx.restore();
}

/** Draw an image into a box with the given fit mode. */
export function drawImageFit(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement,
  box: TextBox,
  fit: "fill" | "cover" | "contain" | "none" | undefined,
) {
  const { x, y, w, h } = box;
  const iw = img.naturalWidth || img.width;
  const ih = img.naturalHeight || img.height;
  if (!iw || !ih) return;
  const mode = fit || "fill";
  if (mode === "fill") {
    ctx.drawImage(img, x, y, w, h);
  } else if (mode === "cover") {
    const sc = Math.max(w / iw, h / ih);
    const sw = w / sc, sh = h / sc;
    ctx.drawImage(img, (iw - sw) / 2, (ih - sh) / 2, sw, sh, x, y, w, h);
  } else if (mode === "contain") {
    const sc = Math.min(w / iw, h / ih);
    const dw = iw * sc, dh = ih * sc;
    ctx.drawImage(img, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
  } else {
    ctx.drawImage(img, x + (w - iw) / 2, y + (h - ih) / 2);
  }
}
