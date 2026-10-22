import { describe, it, expect } from "vitest";
import {
  FILTERS, resolveTemplate, resolveTemplateDetailed, evaluateExpression, extractVariableNames, extractVarName,
  shellQuote, isKnownFilter, resolveColor, resolveNumber, isUsableColor, type VarLookup,
} from "./template";

const vars = (o: Record<string, string>): VarLookup => (n) => o[n];
const r = (t: string, o: Record<string, string> = {}) => resolveTemplate(t, vars(o));

describe("numeric filters", () => {
  it.each([
    ["round", "2.5", "3"], ["round", "-2.4", "-2"],
    ["floor", "2.9", "2"], ["ceil", "2.1", "3"],
    ["abs", "-4.5", "4.5"],
    ["percent", "0.256", "26%"],
    ["round1", "21.149", "21.1"], ["round2", "3.14159", "3.14"],
    ["f2c", "212", "100"], ["f2c", "70", "21.11"],
    ["c2f", "100", "212"], ["c2f", "21.5", "70.7"],
  ])("%s(%s) = %s", (f, input, out) => {
    expect(FILTERS[f](input)).toBe(out);
  });

  it.each(["round", "floor", "ceil", "abs", "percent", "round1", "round2", "f2c", "c2f", "kelvin"])(
    "%s on a non-number yields empty (never 0 or NaN)", (f) => {
      expect(FILTERS[f]("unavailable")).toBe("");
      expect(FILTERS[f]("")).toBe("");
      expect(FILTERS[f]("  ")).toBe("");
    });

  it("chains through empty: unavailable|f2c|round1 is empty", () => {
    expect(r("{{$t|f2c|round1}}", { t: "unavailable" })).toBe("");
    expect(r("{{$t|f2c|round1}}°C", { t: "70" })).toBe("21.1°C");
  });
});

describe("color filters", () => {
  it("kelvin gives a hex color", () => {
    expect(FILTERS.kelvin("6600")).toMatch(/^#[0-9a-f]{6}$/);
    expect(FILTERS.kelvin("2700")).toBe("#ffa757");
    expect(FILTERS.kelvin("0")).toBe("");
    expect(FILTERS.kelvin("-5")).toBe("");
  });
  it("rgb converts r,g,b lists and clamps", () => {
    expect(FILTERS.rgb("255, 128, 0")).toBe("#ff8000");
    expect(FILTERS.rgb("[255, 128, 0]")).toBe("#ff8000");
    expect(FILTERS.rgb("(300, -5, 16)")).toBe("#ff0010");
    expect(FILTERS.rgb("1,2,3,4")).toBe("#010203");
  });
  it("rgb with non-numeric components yields empty; other input passes through", () => {
    expect(FILTERS.rgb("a, b, c")).toBe("");
    expect(FILTERS.rgb("#123456")).toBe("#123456");
    expect(FILTERS.rgb("None")).toBe("None");
  });
});

describe("string filters", () => {
  it("upper/lower/trim", () => {
    expect(r("{{$x|upper}}", { x: "On" })).toBe("ON");
    expect(r("{{$x|lower}}", { x: "On" })).toBe("on");
    expect(r("[{{$x|trim}}]", { x: "  a  " })).toBe("[a]");
  });
});

describe("replace filter", () => {
  it("literal replace of every occurrence", () => {
    expect(r("{{$x|replace:-=}}", { x: "a-b-c" })).toBe("abc");
    expect(r("{{$x|replace:a=b}}", { x: "banana" })).toBe("bbnbnb");
  });
  it("replacement may contain '='", () => {
    expect(r("{{$x|replace:a=b=c}}", { x: "a" })).toBe("b=c");
  });
  it("without '=' removes the search text", () => {
    expect(r("{{$x|replace:o}}", { x: "foo" })).toBe("f");
  });
  it("empty search is a no-op", () => {
    expect(r("{{$x|replace:=z}}", { x: "abc" })).toBe("abc");
  });
  it("escaped '=' in the search text", () => {
    expect(r("{{$x|replace:a\\=b=c}}", { x: "a=b!" })).toBe("c!");
  });
  it("regex with default g flag and groups", () => {
    expect(r("{{$x|replace:/[0-9]+/=#}}", { x: "a1b22c" })).toBe("a#b#c");
    expect(r("{{$x|replace:/(\\w+) (\\w+)/=$2 $1}}", { x: "hello world" })).toBe("world hello");
  });
  it("regex with explicit flags", () => {
    expect(r("{{$x|replace:/A/i=x}}", { x: "aAa" })).toBe("xAa");
  });
  it("regex containing '='", () => {
    expect(r("{{$x|replace:/a=b/=c}}", { x: "a=b" })).toBe("c");
  });
  it("invalid regex is a no-op", () => {
    expect(r("{{$x|replace:/(/=y}}", { x: "(a" })).toBe("(a");
  });
});

describe("map filter", () => {
  it("maps exact matches, then the * default", () => {
    expect(r("{{$x|map:on=#0f0:off=#f00}}", { x: "on" })).toBe("#0f0");
    expect(r("{{$x|map:on=#0f0:off=#f00}}", { x: "off" })).toBe("#f00");
    expect(r("{{$x|map:on=#0f0:*=#000}}", { x: "unknown" })).toBe("#000");
  });
  it("no match and no * leaves the value unchanged", () => {
    expect(r("{{$x|map:on=1}}", { x: "idle" })).toBe("idle");
  });
  it("first matching entry wins, entries without '=' are ignored", () => {
    expect(r("{{$x|map:junk:a=1:a=2}}", { x: "a" })).toBe("1");
  });
  it("is case-sensitive", () => {
    expect(r("{{$x|map:on=1:*=0}}", { x: "On" })).toBe("0");
  });
  it("supports escaped ':' and '=' in keys and values", () => {
    expect(r("{{$x|map:12\\:00=noon:*=other}}", { x: "12:00" })).toBe("noon");
    expect(r("{{$x|map:a=http\\://h:*=x}}", { x: "a" })).toBe("http://h");
    expect(r("{{$x|map:a\\=b=yes}}", { x: "a=b" })).toBe("yes");
  });
  it("an empty key only matches an empty value", () => {
    expect(r("{{$x|map:=empty}}", { x: "z" })).toBe("z");
  });
  it("combines with other filters", () => {
    expect(r("{{$x|lower|map:on=ON!}}", { x: "ON" })).toBe("ON!");
  });
});

describe("missing variables", () => {
  it("render empty, never filter names", () => {
    expect(r("{{$missing}}")).toBe("");
    expect(r("{{$missing|f2c|round1}}")).toBe("");
    expect(r("{{$missing|rgb}}")).toBe("");
    expect(r("{{$missing|map:on=#f90:*=#000}}")).toBe("");
    expect(r("{{$missing|replace:a=b}}")).toBe("");
    expect(r("T: {{$missing|round}}°")).toBe("T: °");
  });
  it("empty string counts as missing for default:, but other filters still apply to it", () => {
    expect(r("{{$x|default:n/a}}", { x: "" })).toBe("n/a");
    expect(r("{{$x|map:*=Nothing playing}}", { x: "" })).toBe("Nothing playing");
    expect(r("{{$x|map:=none}}", { x: "" })).toBe("none");
    expect(r("[{{$x}}]", { x: "" })).toBe("[]");
    expect(resolveTemplateDetailed("{{$x}}", vars({ x: "" })).missing).toBe(true);
    expect(resolveTemplateDetailed("{{$x|map:*=n}}", vars({ x: "" })).missing).toBe(false);
  });
  it("explicit default: supplies a value and later filters apply", () => {
    expect(r("{{$missing|default:0|round1}}")).toBe("0.0");
    expect(r("{{$missing|round|default:--}}")).toBe("--");
    expect(r("{{$x|default:--}}", { x: "5" })).toBe("5");
  });
  it("default: also replaces an empty filter result", () => {
    expect(r("{{$t|f2c|round1|default:--}}", { t: "unavailable" })).toBe("--");
  });
  it("legacy fallback literal (a non-filter segment)", () => {
    expect(r("{{$missing|N/A}}")).toBe("N/A");
    expect(r("{{$x|N/A}}", { x: "ok" })).toBe("ok");
    expect(r("{{$x|50}}", { x: "7" })).toBe("7");
  });
  it("reports missing in detailed resolution", () => {
    expect(resolveTemplateDetailed("{{$a}}-{{$b}}", vars({ a: "1" }))).toEqual({ text: "1-", missing: true });
    expect(resolveTemplateDetailed("{{$a|default:x}}", vars({}))).toEqual({ text: "x", missing: false });
    expect(evaluateExpression("$a|round", vars({}))).toEqual({ value: "", missing: true });
  });
});

describe("syntax", () => {
  it("$ is optional and whitespace is trimmed", () => {
    expect(r("{{ x }}", { x: "1" })).toBe("1");
    expect(r("{{ $x | upper }}", { x: "a" })).toBe("A");
  });
  it("text without templates is returned unchanged", () => {
    expect(r("plain {text}")).toBe("plain {text}");
  });
  it("unknown filter with a value is ignored, chain continues", () => {
    expect(r("{{$x|nosuch|upper}}", { x: "a" })).toBe("A");
  });
  it("isKnownFilter", () => {
    expect(isKnownFilter("round1")).toBe(true);
    expect(isKnownFilter("map:a=b")).toBe(true);
    expect(isKnownFilter("default:x")).toBe(true);
    expect(isKnownFilter("N/A")).toBe(false);
  });
  it("extractVariableNames / extractVarName", () => {
    expect(extractVariableNames("{{$a.b|round}} and {{ c }} {{$d|map:x=y}}")).toEqual(["a.b", "c", "d"]);
    expect(extractVariableNames("none")).toEqual([]);
    expect(extractVarName("{{$ha.light.x.brightness}}")).toBe("ha.light.x.brightness");
    expect(extractVarName("{{ $v|round }}")).toBe("v");
    expect(extractVarName("50")).toBeNull();
  });
});

describe("color/number helpers", () => {
  it("resolveColor validates and falls back", () => {
    expect(resolveColor("{{$c|rgb}}", vars({ c: "255,0,0" }), "#000")).toBe("#ff0000");
    expect(resolveColor("{{$c|rgb}}", vars({}), "#000")).toBe("#000");
    expect(resolveColor("red", vars({}), "#000")).toBe("red");
    expect(resolveColor("{{$c}}", vars({ c: "RebeccaPurple" }), "#000")).toBe("RebeccaPurple");
    expect(resolveColor("red;}", vars({}), "#000")).toBe("#000");
    expect(resolveColor("nonsense", vars({}), "#000")).toBe("#000");
    expect(resolveColor("{{$c}}", vars({}), "#000")).toBe("#000");
    expect(resolveColor("{{c}}", vars({}), "#000")).toBe("#000");
    expect(resolveColor("rgba(1,2,3,0.5)", vars({}), "#000")).toBe("rgba(1,2,3,0.5)");
    expect(isUsableColor("#12345")).toBe(false);
  });
  it("resolveNumber falls back when missing or not numeric", () => {
    expect(resolveNumber("{{$b}}", vars({ b: "128" }), 0)).toBe(128);
    expect(resolveNumber("{{$b}}", vars({}), 7)).toBe(7);
    expect(resolveNumber("{{$b}}", vars({ b: "off" }), 7)).toBe(7);
    expect(resolveNumber("12.5", vars({}), 0)).toBe(12.5);
    expect(resolveNumber("", vars({}), 3)).toBe(3);
    expect(resolveNumber(4, vars({}), 3)).toBe(4);
  });
});

describe("shell quoting", () => {
  it("quotes values as one literal word", () => {
    expect(shellQuote("abc")).toBe("'abc'");
    expect(shellQuote("")).toBe("''");
    expect(shellQuote("it's")).toBe("'it'\\''s'");
    expect(shellQuote("$(rm -rf ~); `x` \"y\" \\z")).toBe("'$(rm -rf ~); `x` \"y\" \\z'");
  });
  it("transform quotes only substituted values", () => {
    const out = resolveTemplate("notify-send {{$title}} done", vars({ title: "a'; rm -rf / #" }), { transform: shellQuote });
    expect(out).toBe("notify-send 'a'\\''; rm -rf / #' done");
    expect(resolveTemplate("echo {{$missing}}", vars({}), { transform: shellQuote })).toBe("echo ''");
  });
});

describe("nested templates", () => {
  const stocks = {
    "deck.pos": "1",
    "stock.BTC.price": "67000", "stock.NVDA.price": "181.5",
  };

  it("builds a variable name from another variable", () => {
    expect(r("{{$stock.{{$deck.pos|map:0=BTC:1=NVDA}}.price}}", stocks)).toBe("181.5");
    expect(r("{{$stock.{{$deck.pos|map:0=BTC:1=NVDA}}.price}}", { ...stocks, "deck.pos": "0" })).toBe("67000");
  });

  it("uses defaults at both levels", () => {
    expect(r("{{$stock.{{$deck.pos|default:0|map:0=BTC:1=NVDA}}.price|default:--}}", { "stock.BTC.price": "1" })).toBe("1");
    expect(r("{{$stock.{{$deck.pos|map:0=BTC}}.price|default:--}}", { "deck.pos": "9" })).toBe("--");
  });

  it("never re-scans substituted values", () => {
    expect(r("{{$a}}", { a: "{{$secret}}", secret: "x" })).toBe("{{$secret}}");
    expect(r("{{$p.{{$a}}}}", { a: "{{$secret}}", secret: "x" })).toBe("");
  });

  it("keeps unclosed templates literal and still resolves the rest", () => {
    expect(r("{{$a}} {{$b", { a: "1", b: "2" })).toBe("1 {{$b");
  });

  it("applies the transform only to outermost values", () => {
    const out = resolveTemplate("echo {{$stock.{{$s}}.p}}", vars({ s: "X", "stock.X.p": "a b" }), { transform: shellQuote });
    expect(out).toBe("echo 'a b'");
  });

  it("extractVariableNames lists only statically known names", () => {
    expect(extractVariableNames("{{$stock.{{$deck.pos|map:0=BTC}}.price}} {{$x}}")).toEqual(["deck.pos", "x"]);
  });
});
