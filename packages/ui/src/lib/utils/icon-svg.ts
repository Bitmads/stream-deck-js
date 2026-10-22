// Render a stored IconConfig (iconify body + viewBox) to a standalone SVG.
//
// Iconify bodies carry their own fill/stroke attributes and use `currentColor`, so the color is
// applied by substituting currentColor and setting the root `color` — no stroke/fill style is
// injected, which keeps both filled sets (mdi, fa6, bi) and stroked sets (tabler, lucide) correct.

import type { IconConfig } from "../types/profile";

function escapeAttr(v: string): string {
  return v.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

/** Accept only a plain "minX minY w h" viewBox; anything else falls back to 0 0 24 24. */
function safeViewBox(vb: string | undefined): string {
  const s = (vb || "").trim();
  return /^-?[\d.]+(\s+|,)-?[\d.]+(\s+|,)[\d.]+(\s+|,)[\d.]+$/.test(s) ? s : "0 0 24 24";
}

export function iconToSvg(icon: Pick<IconConfig, "svgBody" | "viewBox">, color: string, size: number): string {
  const c = escapeAttr(color || "#ffffff");
  const body = (icon.svgBody || "").replace(/currentColor/g, c);
  const px = Math.max(1, Math.round(size));
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${safeViewBox(icon.viewBox)}" width="${px}" height="${px}" color="${c}">${body}</svg>`;
}

/** SVG markup → base64 data URL (UTF-8 safe). */
export function svgToDataUrl(svg: string): string {
  const bytes = new TextEncoder().encode(svg);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return `data:image/svg+xml;base64,${btoa(bin)}`;
}

export function iconToDataUrl(icon: Pick<IconConfig, "svgBody" | "viewBox">, color: string, size: number): string {
  return svgToDataUrl(iconToSvg(icon, color, size));
}
