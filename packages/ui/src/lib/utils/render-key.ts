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

  // Layer 2: Background image
  if (assignment.imageDataUrl) {
    try {
      const img = await loadImage(assignment.imageDataUrl);
      ctx.drawImage(img, 0, 0, w, h);
    } catch (e) {
      console.error("Failed to load background image:", e);
    }
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
  for (const t of texts) {
    if (t?.text && !t.hidden) {
      const resolved = { ...t, text: resolveTemplate(t.text) };
      drawText(ctx, resolved, w, h);
    }
  }

  return canvas.toDataURL("image/jpeg", 0.92);
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
  },
  canvasW: number,
  canvasH?: number
) {
  const size = canvasW; // backward compat for callers that pass one size
  const cw = canvasW;
  const ch = canvasH ?? canvasW;
  const lines = t.text.split("\n");
  const lineHeight = t.fontSize * 1.2;
  const totalHeight = lines.length * lineHeight;

  const fontStyle = t.fontStyle === "italic" ? "italic " : "";
  const fontWeight = t.fontWeight === "bold" ? "bold " : "";
  const fontFamily = t.fontFamily || "sans-serif";
  ctx.font = `${fontStyle}${fontWeight}${t.fontSize}px ${fontFamily}`;
  ctx.fillStyle = t.color;

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

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = (e) => reject(e);
    img.src = src;
  });
}
