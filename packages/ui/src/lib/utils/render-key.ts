// Key rendering, shared by the device sync (hardware) and the editor preview.
//
// Rendering is split in two steps:
//   1. resolveKeyInputs(): pure — resolves every templated field (background, image URL, conditional
//      icon + color, text + colors) and applies the runtime override. Only the variables a key uses are
//      read, so in a reactive context the key depends on exactly those variables.
//   2. renderResolvedKey(): draws the resolved inputs on a canvas and returns a JPEG data URL.
// keyFingerprint() of the resolved inputs lets callers skip re-rendering/re-sending unchanged keys.
//
// Coordinates (font size, icon size, absolute text x/y) are in "design" pixels: the canvas size the
// editor has always used, min(native, 96). Rendering at the native size scales the drawing, so a Plus
// key (120 px) looks exactly like its 96 px preview, only sharper.

import type { KeyAssignment, IconConfig, TextConfig, RuntimeOverride } from "../types/profile";
import { resolveTemplate, resolveColor, resolveTemplateDetailed, type VarLookup } from "./template";
import { drawTextLayer, drawImageFit, type ResolvedTextLayer } from "./draw-text";
import { iconToDataUrl } from "./icon-svg";
import { loadImage, isFetchableUrl } from "./image-cache";
import { ensureFontLoaded, isCustomFontFamily } from "./font";

/** Largest design canvas used by the editor; native key sizes above it are scaled up from it. */
export const MAX_DESIGN_KEY_SIZE = 96;

export function keyDesignSize(nativeSize: number): number {
  return Math.min(nativeSize > 0 ? nativeSize : 72, MAX_DESIGN_KEY_SIZE);
}

let defaultLookup: VarLookup = () => undefined;

/** The store installs its variable lookup here so callers can omit `lookup`. */
export function setDefaultVarLookup(lookup: VarLookup) {
  defaultLookup = lookup;
}

export function getDefaultVarLookup(): VarLookup {
  return defaultLookup;
}

/** Pick the icon to show: first conditional icon whose resolved variable equals its value, else the first unconditional one. */
export function resolveActiveIcon(
  assignment: { icon?: IconConfig; icons?: IconConfig[] },
  resolve: (t: string) => string
): IconConfig | undefined {
  const icons = assignment.icons?.length ? assignment.icons : (assignment.icon ? [assignment.icon] : []);
  if (icons.length === 0) return undefined;
  for (const ic of icons) {
    if (ic.variable && ic.svgBody) {
      const varVal = resolve(ic.variable);
      if (varVal === ic.value) return ic;
    }
  }
  return icons.find(ic => !ic.variable && ic.svgBody) ?? (icons[0]?.svgBody ? icons[0] : undefined);
}

export interface ResolvedKeyIcon { svgBody: string; viewBox: string; color: string; size: number; }

export interface ResolvedKeyInputs {
  background: string;
  /** Data URL or complete http(s) URL; "" for none. */
  image: string;
  imageFit: "fill" | "cover" | "contain" | "none";
  icon: ResolvedKeyIcon | null;
  texts: ResolvedTextLayer[];
  flash: "ok" | "alert" | null;
  state: number | null;
}

function defaultTitleLayer(): ResolvedTextLayer {
  return {
    text: "", fontFamily: "sans-serif", fontSize: 16, fontWeight: "bold", fontStyle: "normal",
    color: "#ffffff", hAlign: "center", vAlign: "middle", anchor: "center", useAbsolutePos: false,
    wrap: "word", stroke: { color: "#000000", width: 3 },
  };
}

function resolveTextLayer(t: TextConfig, lookup: VarLookup): ResolvedTextLayer {
  return {
    text: resolveTemplate(t.text, lookup),
    fontFamily: t.fontFamily || "sans-serif",
    fontSize: Number(t.fontSize) > 0 ? Number(t.fontSize) : 14,
    fontWeight: t.fontWeight, fontStyle: t.fontStyle,
    color: resolveColor(t.color || "#ffffff", lookup, "#ffffff"),
    hAlign: t.hAlign, vAlign: t.vAlign, anchor: t.anchor,
    useAbsolutePos: !!t.useAbsolutePos, x: t.x, y: t.y,
    wrap: t.wrap,
    shadow: t.shadow ? { ...t.shadow, color: resolveColor(t.shadow.color, lookup, "#000000") } : undefined,
    stroke: t.stroke ? { ...t.stroke, color: resolveColor(t.stroke.color, lookup, "#000000") } : undefined,
  };
}

/** Resolve a templated image URL; "" when a variable is missing or the URL is incomplete. */
export function resolveImageUrl(url: string | undefined, lookup: VarLookup): string {
  if (!url) return "";
  const r = resolveTemplateDetailed(url, lookup);
  if (r.missing) return "";
  const u = r.text.trim();
  if (!u) return "";
  if (u.startsWith("data:")) return u;
  return isFetchableUrl(u) ? u : "";
}

export function keyTextLayers(assignment: KeyAssignment): TextConfig[] {
  return assignment.texts?.length ? assignment.texts : (assignment.text ? [assignment.text] : []);
}

/** Resolve everything that affects a key's pixels. Pure; reads only the variables the key uses. */
export function resolveKeyInputs(
  assignment: KeyAssignment,
  lookup: VarLookup = defaultLookup,
  override?: RuntimeOverride | null,
): ResolvedKeyInputs {
  const resolve = (t: string) => resolveTemplate(t, lookup);

  const background = resolveColor(assignment.backgroundColor || "#000000", lookup, "#000000");

  let image = assignment.imageDataUrl || resolveImageUrl(assignment.imageUrl, lookup);
  if (override?.image) image = override.image;

  const active = resolveActiveIcon(assignment, resolve);
  const icon: ResolvedKeyIcon | null = active ? {
    svgBody: active.svgBody, viewBox: active.viewBox,
    color: resolveColor(active.color || "#ffffff", lookup, "#ffffff"),
    size: Number(active.size) > 0 ? Number(active.size) : 48,
  } : null;

  const layers = keyTextLayers(assignment).filter(t => t && !t.hidden);
  let texts = layers.map(t => resolveTextLayer(t, lookup));
  if (override?.title !== undefined) {
    if (texts.length > 0) texts = [{ ...texts[0], text: override.title }, ...texts.slice(1)];
    else texts = [{ ...defaultTitleLayer(), text: override.title }];
  }
  texts = texts.filter(t => t.text !== "");

  return {
    background,
    image,
    imageFit: assignment.imageFit || "fill",
    icon,
    texts,
    flash: override?.flash ?? null,
    state: override?.state ?? null,
  };
}

/** Compact, stable fingerprint of any JSON-serializable value (two FNV-1a style 32-bit hashes + length). */
export function fingerprintOf(value: unknown): string {
  const s = JSON.stringify(value);
  let h1 = 0x811c9dc5, h2 = 0x01000193 ^ 0x5bd1e995;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = Math.imul(h2 ^ c, 0x5bd1e995);
  }
  return (h1 >>> 0).toString(36) + "." + (h2 >>> 0).toString(36) + "." + s.length.toString(36);
}

/** Stable fingerprint of a key's resolved render inputs at a given output size. */
export function keyFingerprint(inputs: ResolvedKeyInputs, size: number): string {
  return fingerprintOf([size, inputs]);
}

export interface RenderResult {
  dataUrl: string;
  /** True when an image or icon could not be loaded (callers may retry later). */
  incomplete: boolean;
}

function drawFlash(ctx: CanvasRenderingContext2D, kind: "ok" | "alert", d: number) {
  ctx.save();
  ctx.fillStyle = "rgba(0,0,0,0.55)";
  ctx.fillRect(0, 0, d, d);
  const cx = d / 2, cy = d / 2, r = d * 0.28;
  ctx.lineWidth = Math.max(3, d * 0.06);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  if (kind === "ok") {
    ctx.fillStyle = "#2ecc71";
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = "#ffffff";
    ctx.beginPath();
    ctx.moveTo(cx - r * 0.45, cy + r * 0.02);
    ctx.lineTo(cx - r * 0.1, cy + r * 0.38);
    ctx.lineTo(cx + r * 0.5, cy - r * 0.35);
    ctx.stroke();
  } else {
    ctx.fillStyle = "#f1c40f";
    ctx.beginPath();
    ctx.moveTo(cx, cy - r);
    ctx.lineTo(cx + r * 1.1, cy + r * 0.85);
    ctx.lineTo(cx - r * 1.1, cy + r * 0.85);
    ctx.closePath(); ctx.fill();
    ctx.strokeStyle = "#000000";
    ctx.beginPath(); ctx.moveTo(cx, cy - r * 0.45); ctx.lineTo(cx, cy + r * 0.25); ctx.stroke();
    ctx.fillStyle = "#000000";
    ctx.beginPath(); ctx.arc(cx, cy + r * 0.55, ctx.lineWidth * 0.55, 0, Math.PI * 2); ctx.fill();
  }
  ctx.restore();
}

/** Draw resolved inputs; `size` is the output pixel size (native key size for hardware). */
export async function renderResolvedKey(inputs: ResolvedKeyInputs, size: number, designSize = keyDesignSize(size)): Promise<RenderResult> {
  let incomplete = false;

  // Load everything first, then draw synchronously so the drawing is atomic.
  let bgImg: HTMLImageElement | null = null;
  if (inputs.image) {
    try { bgImg = await loadImage(inputs.image); } catch { incomplete = true; }
  }
  let iconImg: HTMLImageElement | null = null;
  if (inputs.icon) {
    try { iconImg = await loadImage(iconToDataUrl(inputs.icon, inputs.icon.color, inputs.icon.size * (size / designSize))); }
    catch (e) { incomplete = true; console.error("Failed to render SVG icon:", e); }
  }
  for (const t of inputs.texts) {
    if (isCustomFontFamily(t.fontFamily)) await ensureFontLoaded(t.fontFamily, t.fontWeight, t.fontStyle);
  }

  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const scale = size / designSize;
  ctx.scale(scale, scale);
  const d = designSize;

  ctx.fillStyle = inputs.background;
  ctx.fillRect(0, 0, d, d);

  if (bgImg) drawImageFit(ctx, bgImg, { x: 0, y: 0, w: d, h: d }, inputs.imageFit);

  if (iconImg && inputs.icon) {
    const s = inputs.icon.size;
    ctx.drawImage(iconImg, (d - s) / 2, (d - s) / 2, s, s);
  }

  for (const t of inputs.texts) drawTextLayer(ctx, t, { x: 0, y: 0, w: d, h: d }, { padding: 2 });

  if (inputs.flash) drawFlash(ctx, inputs.flash, d);

  // Images are always drawn from data URLs (see image-cache), so the canvas is never tainted.
  const dataUrl = canvas.toDataURL("image/jpeg", 0.92);
  return { dataUrl, incomplete };
}

export interface RenderKeyOptions {
  lookup?: VarLookup;
  override?: RuntimeOverride | null;
  /** Design canvas size (defaults to min(size, 96)). */
  designSize?: number;
}

/** Render a key assignment to a JPEG data URL at `size` px. */
export async function renderKey(assignment: KeyAssignment, size: number, opts: RenderKeyOptions = {}): Promise<string> {
  const inputs = resolveKeyInputs(assignment, opts.lookup ?? defaultLookup, opts.override);
  return (await renderResolvedKey(inputs, size, opts.designSize ?? keyDesignSize(size))).dataUrl;
}

/** Back-compat wrapper used by the editor preview: render at `width` px using the store's variables. */
export async function renderKeyToDataUrl(assignment: KeyAssignment, width: number = 72, _height?: number): Promise<string> {
  return renderKey(assignment, width);
}

