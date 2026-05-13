import type { KeyAssignment } from "../stores/editor.svelte";
import { resolveTemplate } from "../stores/variables.svelte";

/**
 * Render complete key image on canvas.
 * Layers: bg color → bg image → SVG icon → text
 * Returns base64 JPEG data URL.
 */
export async function renderKeyToDataUrl(
  assignment: KeyAssignment,
  width: number = 72,
  height?: number
): Promise<string> {
  const w = width;
  const h = height ?? width;
  const size = Math.min(w, h); // for icon sizing
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d")!;

  // Layer 1: Background color (supports variables like {{$ha.light.color}})
  const bgColor = resolveTemplate(assignment.backgroundColor || "#000000");
  ctx.fillStyle = bgColor.startsWith("#") || bgColor.startsWith("rgb") ? bgColor : "#000000";
  ctx.fillRect(0, 0, w, h);

  // Layer 2: Background image (data URL or remote URL with variable support)
  const resolvedImgUrl = assignment.imageUrl ? resolveTemplate(assignment.imageUrl) : "";
  const imgSrc = assignment.imageDataUrl || (resolvedImgUrl && !resolvedImgUrl.includes("{{") ? resolvedImgUrl : "");
  if (imgSrc) {
    try {
      const img = await loadImage(imgSrc);
      ctx.drawImage(img, 0, 0, w, h);
    } catch {}
  }

  // Layer 3: SVG icon (centered)
  if (assignment.icon) {
    const iconSize = assignment.icon.size || 48;
    const color = assignment.icon.color || "#ffffff";
    // Use a <style> block to force color on ALL child elements — avoids inheritance issues when loading SVG as <img>
    const svgStr = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${assignment.icon.viewBox}" width="${iconSize}" height="${iconSize}"><style>*{fill:none;stroke:${color};stroke-width:2;stroke-linecap:round;stroke-linejoin:round;}</style>${assignment.icon.svgBody}</svg>`;

    try {
      const svgBase64 = btoa(unescape(encodeURIComponent(svgStr)));
      const dataUrl = `data:image/svg+xml;base64,${svgBase64}`;
      const img = await loadImage(dataUrl);
      const x = (w - iconSize) / 2;
      const y = (h - iconSize) / 2;
      ctx.drawImage(img, x, y, iconSize, iconSize);
    } catch (e) {
      console.error("Failed to render SVG icon:", e);
    }
  }

  // Layer 4: Text layers (ALWAYS on top of everything, with variable resolution)
  const texts = assignment.texts?.length ? assignment.texts : (assignment.text ? [assignment.text] : []);

  // Ensure custom fonts are loaded before drawing text on canvas
  const fontFamilies = texts
    .filter(t => t?.text && !t.hidden && t.fontFamily && !["sans-serif", "serif", "monospace"].includes(t.fontFamily))
    .map(t => t.fontFamily);
  for (const family of fontFamilies) {
    try { await document.fonts.load(`16px "${family}"`); } catch {}
  }

  for (const t of texts) {
    if (t?.text && !t.hidden) {
      const resolved = { ...t, text: resolveTemplate(t.text) };
      drawText(ctx, resolved, w, h);
    }
  }

  return canvas.toDataURL("image/jpeg", 0.92);
}

function wrapText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number, mode: string): string[] {
  if (mode === "none" || maxWidth <= 0) return text.split("\n");
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
      // char wrap
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

function drawText(
  ctx: CanvasRenderingContext2D,
  t: {
    text: string;
    fontFamily?: string;
    fontSize: number;
    fontWeight: string;
    fontStyle: string;
    color: string;
    hAlign: string;
    vAlign: string;
    anchor: string;
    useAbsolutePos: boolean;
    x?: number;
    y?: number;
    wrap?: string;
  },
  canvasW: number,
  canvasH?: number
) {
  const cw = canvasW;
  const ch = canvasH ?? canvasW;
  const lineHeight = t.fontSize * 1.2;

  const fontStyle = t.fontStyle === "italic" ? "italic " : "";
  const fontWeight = t.fontWeight === "bold" ? "bold " : "";
  const fontFamily = t.fontFamily || "sans-serif";
  ctx.font = `${fontStyle}${fontWeight}${t.fontSize}px ${fontFamily}`;
  ctx.fillStyle = t.color;

  const wrapMode = (t as any).wrap || "none";
  const maxWidth = t.useAbsolutePos ? cw : cw - 4;
  const lines = wrapText(ctx, t.text, maxWidth, wrapMode);
  const totalHeight = lines.length * lineHeight;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line && lines.length > 1) continue;

    const lineWidth = ctx.measureText(line).width;

    let x: number;
    let y: number;

    if (t.useAbsolutePos) {
      const bx = t.x ?? 0;
      const by = t.y ?? 0;
      // Anchor adjusts where the text attaches to the position
      x = t.anchor === "center" ? bx - lineWidth / 2
        : t.anchor === "end" ? bx - lineWidth
        : bx;
      y = by + i * lineHeight + t.fontSize;
    } else {
      // Horizontal: get base X from alignment
      let bx: number;
      if (t.hAlign === "left") bx = 2;
      else if (t.hAlign === "right") bx = cw - 2;
      else bx = cw / 2;

      // Apply anchor to base X
      x = t.anchor === "center" ? bx - lineWidth / 2
        : t.anchor === "end" ? bx - lineWidth
        : bx;

      // Vertical: get base Y from alignment
      let by: number;
      if (t.vAlign === "top") by = 2;
      else if (t.vAlign === "bottom") by = ch - totalHeight - 2;
      else by = (ch - totalHeight) / 2;

      y = by + i * lineHeight + t.fontSize;
    }

    ctx.fillText(line, x, y);
  }
}

import { invoke } from "@tauri-apps/api/core";

const imgUrlCache: Record<string, string> = {};

async function loadImage(src: string): Promise<HTMLImageElement> {
  let url = src;
  if (src.startsWith("http://") || src.startsWith("https://")) {
    if (imgUrlCache[src]) {
      url = imgUrlCache[src];
    } else {
      try {
        const dataUrl = await invoke<string>("fetch_image_as_data_url", { url: src });
        imgUrlCache[src] = dataUrl;
        url = dataUrl;
      } catch {}
    }
  }
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = (e) => reject(e);
    img.src = url;
  });
}
