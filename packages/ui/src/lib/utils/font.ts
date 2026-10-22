// CSS font shorthand for canvas `ctx.font`, with family names quoted so names such as
// "Source Sans 3" (which is not a valid unquoted identifier) actually apply.

const GENERIC_FAMILIES = new Set([
  "serif", "sans-serif", "monospace", "cursive", "fantasy", "system-ui",
  "ui-serif", "ui-sans-serif", "ui-monospace", "ui-rounded", "emoji", "math", "fangsong",
]);

/** Quote each family in a comma-separated list unless it is generic or already quoted. */
export function quoteFontFamily(family: string | undefined | null): string {
  const list = (family || "sans-serif").split(",").map(f => f.trim()).filter(Boolean);
  if (list.length === 0) return "sans-serif";
  return list.map(f => {
    if (GENERIC_FAMILIES.has(f.toLowerCase())) return f.toLowerCase();
    if (/^(".*"|'.*')$/.test(f)) return f;
    return `"${f.replace(/["\\]/g, "\\$&")}"`;
  }).join(", ");
}

/** e.g. cssFont("bold", "italic", 14, "Source Sans 3") → `italic bold 14px "Source Sans 3"` */
export function cssFont(
  weight: string | undefined | null,
  style: string | undefined | null,
  sizePx: number,
  family: string | undefined | null,
): string {
  const parts: string[] = [];
  if (style && style !== "normal") parts.push(style);
  if (weight && weight !== "normal") parts.push(weight);
  const size = Number.isFinite(sizePx) && sizePx > 0 ? sizePx : 14;
  parts.push(`${size}px`);
  parts.push(quoteFontFamily(family));
  return parts.join(" ");
}

/** True when `family` needs loading via document.fonts before drawing (i.e. not a generic family). */
export function isCustomFontFamily(family: string | undefined | null): boolean {
  const first = (family || "").split(",")[0]?.trim().replace(/^["']|["']$/g, "") ?? "";
  return first !== "" && !GENERIC_FAMILIES.has(first.toLowerCase());
}

/** Load a custom font so canvas text uses it (no-op for generic families or without a DOM). */
export async function ensureFontLoaded(family: string | undefined | null, weight = "normal", style = "normal"): Promise<void> {
  if (!isCustomFontFamily(family) || typeof document === "undefined" || !document.fonts) return;
  try { await document.fonts.load(cssFont(weight, style, 16, family)); } catch { /* font unavailable: canvas falls back */ }
}
