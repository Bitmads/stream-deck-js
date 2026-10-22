// Pure template resolution: {{$name|filter|filter:arg}}.
//
// - The `$` before the name is optional. The expression cannot contain `}` and is split on `|`.
// - A variable that is undefined or "" is "missing". Filters are skipped while there is no value;
//   `default:<text>` supplies a value (also replaces an empty filter result), and a segment that is not
//   a known filter is treated as a legacy fallback literal (`{{$x|N/A}}`). Otherwise a missing
//   variable renders as "" — filter names are never rendered as text.
// - Numeric filters on non-numeric input yield "" (never 0 or NaN).
// - Unknown segments while a value is present are ignored (they are legacy fallbacks).
//
// No Svelte or Tauri imports: usable from Node tooling and unit tests.

export type VarLookup = (name: string) => string | undefined;

export const TEMPLATE_RE = /\{\{([^}]+)\}\}/g;

function num(v: string): number {
  const t = v.trim();
  if (t === "") return NaN;
  return parseFloat(t);
}

/** Wrap a numeric transform: NaN input or output gives "". */
function numeric(fn: (n: number) => string): (v: string) => string {
  return (v) => {
    const n = num(v);
    if (!Number.isFinite(n)) return "";
    return fn(n);
  };
}

/** Trim float noise (e.g. 21.111111111111) to at most 2 decimals for f2c/c2f. */
function tidy(n: number): string {
  return String(Math.round(n * 100) / 100);
}

function hex2(n: number): string {
  return Math.round(Math.max(0, Math.min(255, n))).toString(16).padStart(2, "0");
}

export const FILTERS: Record<string, (val: string) => string> = {
  kelvin: numeric((kelvin) => {
    if (kelvin <= 0) return "";
    const k = kelvin / 100;
    let r: number, g: number, b: number;
    if (k <= 66) { r = 255; g = 99.47 * Math.log(k) - 161.12; }
    else { r = 329.7 * Math.pow(k - 60, -0.1332); g = 288.12 * Math.pow(k - 60, -0.0755); }
    if (k >= 66) b = 255;
    else if (k <= 19) b = 0;
    else b = 138.52 * Math.log(k - 10) - 305.04;
    if (![r, g, b].every(Number.isFinite)) return "";
    return `#${hex2(r)}${hex2(g)}${hex2(b)}`;
  }),
  rgb: (v) => {
    const inner = v.trim().replace(/^[[(]|[\])]$/g, "");
    const parts = inner.split(",").map(s => s.trim());
    if (parts.length >= 3) {
      const nums = parts.slice(0, 3).map(s => (s === "" ? NaN : Number(s)));
      if (nums.every(Number.isFinite)) return `#${nums.map(hex2).join("")}`;
      return "";
    }
    return v;
  },
  round: numeric((n) => String(Math.round(n))),
  floor: numeric((n) => String(Math.floor(n))),
  ceil: numeric((n) => String(Math.ceil(n))),
  abs: numeric((n) => String(Math.abs(n))),
  percent: numeric((n) => `${Math.round(n * 100)}%`),
  round1: numeric((n) => n.toFixed(1)),
  round2: numeric((n) => n.toFixed(2)),
  f2c: numeric((n) => tidy((n - 32) * 5 / 9)),
  c2f: numeric((n) => tidy(n * 9 / 5 + 32)),
  upper: (v) => v.toUpperCase(),
  lower: (v) => v.toLowerCase(),
  trim: (v) => v.trim(),
};

/** Filters that take an argument after a colon. */
const ARG_FILTERS = ["replace:", "map:", "default:"];

export function isKnownFilter(segment: string): boolean {
  const s = segment.trim();
  return s in FILTERS || ARG_FILTERS.some(p => s.startsWith(p));
}

/** Split on unescaped `sep`, then unescape `\sep` and `\\`. */
function splitEscaped(s: string, sep: string): string[] {
  const out: string[] = [];
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "\\" && i + 1 < s.length && (s[i + 1] === sep || s[i + 1] === "\\" || s[i + 1] === "=")) {
      cur += "\\" + s[i + 1];
      i++;
    } else if (c === sep) {
      out.push(cur); cur = "";
    } else {
      cur += c;
    }
  }
  out.push(cur);
  return out;
}

/** Index of the first unescaped "=" or -1. */
function indexOfUnescapedEq(s: string): number {
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\\") { i++; continue; }
    if (s[i] === "=") return i;
  }
  return -1;
}

function unescape(s: string): string {
  return s.replace(/\\([:=\\])/g, "$1");
}

/** replace:search=replacement (literal) or replace:/regex/flags=replacement */
function applyReplace(value: string, arg: string): string {
  const re = /^\/(.+)\/([dgimsuy]*)=(.*)$/s.exec(arg);
  if (re) {
    const [, pattern, flags, replacement] = re;
    try { return value.replace(new RegExp(pattern, flags || "g"), replacement); }
    catch { return value; }
  }
  const eq = indexOfUnescapedEq(arg);
  const search = unescape(eq >= 0 ? arg.substring(0, eq) : arg);
  const replacement = eq >= 0 ? unescape(arg.substring(eq + 1)) : "";
  if (search === "") return value;
  return value.split(search).join(replacement);
}

/** map:key1=val1:key2=val2:*=default — `\:` and `\=` escape separators. No match and no `*`: unchanged. */
function applyMap(value: string, arg: string): string {
  for (const entry of splitEscaped(arg, ":")) {
    const eq = indexOfUnescapedEq(entry);
    if (eq < 0) continue;
    const key = unescape(entry.substring(0, eq));
    const val = unescape(entry.substring(eq + 1));
    if (key === "*" || key === value) return val;
  }
  return value;
}

export interface ExprResult {
  /** Final text ("" when missing). */
  value: string;
  /**
   * True when the variable was missing (or empty) and nothing (default/map/fallback) supplied a
   * value, so callers such as image URLs and numbers can fall back.
   */
  missing: boolean;
}

/** Evaluate one template expression (the text between `{{` and `}}`). */
export function evaluateExpression(expr: string, lookup: VarLookup): ExprResult {
  const parts = expr.trim().split("|");
  const name = parts[0].trim().replace(/^\$/, "").trim();
  const raw = lookup(name);
  // An empty string is a value: filters such as `map:*=...` apply to it (only `default:` treats it
  // as missing). It still reports `missing` below when the result stays empty.
  let val: string | undefined = raw === undefined || raw === null ? undefined : String(raw);

  for (let i = 1; i < parts.length; i++) {
    const seg = parts[i].trim();
    if (seg.startsWith("default:")) {
      if (val === undefined || val === "") val = seg.substring(8);
      continue;
    }
    if (val === undefined) {
      // No value yet: filters have nothing to work on; a non-filter segment is a legacy fallback literal.
      if (!isKnownFilter(seg) && seg !== "") val = seg;
      continue;
    }
    if (seg.startsWith("replace:")) { val = applyReplace(val, seg.substring(8)); continue; }
    if (seg.startsWith("map:")) { val = applyMap(val, seg.substring(4)); continue; }
    const f = FILTERS[seg];
    if (f) val = f(val);
    // Unknown segment with a value present: legacy fallback, ignored.
  }
  return { value: val ?? "", missing: val === undefined || (raw === "" && val === "") };
}

export interface ResolveOptions {
  /** Applied to each substituted expression value (e.g. shellQuote). Literal text is untouched. */
  transform?: (value: string) => string;
}

export interface ResolveResult { text: string; missing: boolean; }

/** Resolve all templates in `text`, reporting whether any referenced variable was missing. */
export function resolveTemplateDetailed(text: string, lookup: VarLookup, opts: ResolveOptions = {}): ResolveResult {
  let missing = false;
  const out = text.replace(new RegExp(TEMPLATE_RE.source, "g"), (_m, expr: string) => {
    const r = evaluateExpression(expr, lookup);
    if (r.missing) missing = true;
    return opts.transform ? opts.transform(r.value) : r.value;
  });
  return { text: out, missing };
}

export function resolveTemplate(text: string, lookup: VarLookup, opts: ResolveOptions = {}): string {
  if (typeof text !== "string") return text == null ? "" : String(text);
  if (!text.includes("{{")) return text;
  return resolveTemplateDetailed(text, lookup, opts).text;
}

export function hasTemplates(text: string | undefined | null): boolean {
  return typeof text === "string" && text.includes("{{");
}

/** Variable names referenced by templates in `text`, in order (may repeat). */
export function extractVariableNames(text: string | undefined | null): string[] {
  if (typeof text !== "string" || !text.includes("{{")) return [];
  const names: string[] = [];
  const re = new RegExp(TEMPLATE_RE.source, "g");
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    names.push(match[1].trim().split("|")[0].trim().replace(/^\$/, "").trim());
  }
  return names;
}

/** Variable name of a value that STARTS with a template: "{{$name|...}}" → "name". */
export function extractVarName(template: string | undefined | null): string | null {
  if (typeof template !== "string") return null;
  const m = template.match(/^\{\{\s*\$?([^}|]+)/);
  return m ? m[1].trim() : null;
}

/** POSIX shell single-quoting: the result is always one literal word. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** CSS named colors (CSS Color Module Level 4), lower case. */
const CSS_NAMED_COLORS = new Set([
  "aliceblue", "antiquewhite", "aqua", "aquamarine", "azure", "beige", "bisque", "black", "blanchedalmond",
  "blue", "blueviolet", "brown", "burlywood", "cadetblue", "chartreuse", "chocolate", "coral",
  "cornflowerblue", "cornsilk", "crimson", "cyan", "darkblue", "darkcyan", "darkgoldenrod", "darkgray",
  "darkgreen", "darkgrey", "darkkhaki", "darkmagenta", "darkolivegreen", "darkorange", "darkorchid",
  "darkred", "darksalmon", "darkseagreen", "darkslateblue", "darkslategray", "darkslategrey", "darkturquoise",
  "darkviolet", "deeppink", "deepskyblue", "dimgray", "dimgrey", "dodgerblue", "firebrick", "floralwhite",
  "forestgreen", "fuchsia", "gainsboro", "ghostwhite", "gold", "goldenrod", "gray", "green", "greenyellow",
  "grey", "honeydew", "hotpink", "indianred", "indigo", "ivory", "khaki", "lavender", "lavenderblush",
  "lawngreen", "lemonchiffon", "lightblue", "lightcoral", "lightcyan", "lightgoldenrodyellow", "lightgray",
  "lightgreen", "lightgrey", "lightpink", "lightsalmon", "lightseagreen", "lightskyblue", "lightslategray",
  "lightslategrey", "lightsteelblue", "lightyellow", "lime", "limegreen", "linen", "magenta", "maroon",
  "mediumaquamarine", "mediumblue", "mediumorchid", "mediumpurple", "mediumseagreen", "mediumslateblue",
  "mediumspringgreen", "mediumturquoise", "mediumvioletred", "midnightblue", "mintcream", "mistyrose",
  "moccasin", "navajowhite", "navy", "oldlace", "olive", "olivedrab", "orange", "orangered", "orchid",
  "palegoldenrod", "palegreen", "paleturquoise", "palevioletred", "papayawhip", "peachpuff", "peru", "pink",
  "plum", "powderblue", "purple", "rebeccapurple", "red", "rosybrown", "royalblue", "saddlebrown", "salmon",
  "sandybrown", "seagreen", "seashell", "sienna", "silver", "skyblue", "slateblue", "slategray", "slategrey",
  "snow", "springgreen", "steelblue", "tan", "teal", "thistle", "tomato", "transparent", "turquoise",
  "violet", "wheat", "white", "whitesmoke", "yellow", "yellowgreen",
]);

/**
 * Colors the canvas accepts from user templates: #hex, rgb()/rgba(), hsl()/hsla() and CSS named
 * colors ("red", "RebeccaPurple"). Anything else (an unresolved template, CSS text such as `;` or
 * `}`) falls back, so it never reaches a canvas style or an SVG <style>.
 */
export function isUsableColor(c: string | undefined | null): c is string {
  if (typeof c !== "string") return false;
  const s = c.trim();
  return /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(s) || /^(rgb|rgba|hsl|hsla)\(/i.test(s)
    || CSS_NAMED_COLORS.has(s.toLowerCase());
}

/** Resolve a templated color; fall back when it does not resolve to a usable color. */
export function resolveColor(text: string | undefined | null, lookup: VarLookup, fallback: string): string {
  if (!text) return fallback;
  const c = resolveTemplate(text, lookup).trim();
  return isUsableColor(c) ? c : fallback;
}

/** Resolve a templated number; fall back when missing or not numeric. */
export function resolveNumber(input: string | number | undefined | null, lookup: VarLookup, fallback: number): number {
  if (input === undefined || input === null || input === "") return fallback;
  if (typeof input === "number") return Number.isFinite(input) ? input : fallback;
  const r = resolveTemplateDetailed(String(input), lookup);
  if (r.missing) return fallback;
  const parsed = parseFloat(r.text);
  return Number.isFinite(parsed) ? parsed : fallback;
}
