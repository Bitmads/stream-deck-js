// Plain-text reports for the CLI: per-scene key / encoder / strip tables and validation issues.

import type { ActionDef, IconConfig, KeyAssignment, Scene, StripItem, TextConfig } from "../../ui/src/lib/types/profile.ts";
import type { BuiltDeck, BuiltDevice } from "./build.ts";
import type { DeviceMergeSummary } from "./apply.ts";
import type { Issue } from "./validate.ts";

function clip(s: string, n: number): string {
  const one = s.replace(/\s*\n\s*/g, "⏎");
  return one.length > n ? one.slice(0, n - 1) + "…" : one;
}

function table(rows: string[][], indent: string): string {
  if (rows.length === 0) return "";
  const widths = rows[0].map((_, c) => Math.max(...rows.map(r => (r[c] ?? "").length)));
  return rows.map(r => indent + r.map((cell, c) => (c === r.length - 1 ? cell : cell.padEnd(widths[c]))).join("  ").trimEnd()).join("\n");
}

/** Short description of an action and its settings. */
export function describeAction(action: ActionDef | undefined, settings: Record<string, string> | undefined, sceneNames: Record<string, string>): string {
  if (!action || action.id === "none") return "-";
  const s = settings ?? {};
  switch (action.id) {
    case "ha-service": {
      const svc = `${s.ha_domain ?? "?"}.${s.ha_service ?? "?"}`;
      const attr = s.ha_attr ? ` ${s.ha_attr}${s.value ? `=${s.value}` : ""}` : "";
      const data = s.ha_service_data ? ` ${s.ha_service_data}` : "";
      return `HA ${svc} ${s.ha_entity ?? ""}${attr}${data}`.trim();
    }
    case "ha-custom": return `HA custom ${s.ha_custom_json ?? ""}`;
    case "switch-scene": return `→ ${sceneNames[s.sceneId] ?? s.sceneId} (${s.mode || "push"})`;
    case "back": return "← back";
    case "hotkey": return `hotkey ${[s.modifiers, s.key].filter(Boolean).join(" + ")}`;
    case "command": return `$ ${s.command ?? ""}`;
    case "launch": return `launch ${s.target ?? ""}`;
    case "open-url": return `open ${s.url ?? ""}`;
    case "http-request": return `${s.method || "POST"} ${s.url ?? ""}`;
    case "timer": return `timer ${s.duration ?? ""}s`;
    case "counter": return `counter from ${s.value ?? "0"}`;
    case "multi-action": {
      try {
        const steps = JSON.parse(s.steps ?? "[]") as Array<{ actionId?: string; settings?: Record<string, string>; delayMs?: number }>;
        return `multi[${steps.map(st => describeAction({ id: st.actionId ?? "?", label: "", icon: "", color: "" }, st.settings, sceneNames) + (st.delayMs ? ` +${st.delayMs}ms` : "")).join("; ")}]`;
      } catch {
        return "multi[invalid]";
      }
    }
    default: return action.id;
  }
}

function describeTexts(texts: TextConfig[] | undefined): string {
  return (texts ?? []).filter(t => !t.hidden).map(t => `"${t.text}" ${t.fontFamily} ${t.fontSize}px`).join(" | ");
}

function describeIcons(icons: IconConfig[] | undefined): string {
  return (icons ?? []).map(i => `${i.setId}:${i.iconName}${i.variable ? ` if ${i.variable}==${i.value}` : ""}`).join(", ");
}

function keyVisual(k: KeyAssignment): string {
  const texts = k.texts?.length ? k.texts : k.text ? [k.text] : [];
  const icons = k.icons?.length ? k.icons : k.icon ? [k.icon] : [];
  const parts = [`bg ${k.backgroundColor}`];
  if (icons.length) parts.push(describeIcons(icons));
  if (texts.length) parts.push(describeTexts(texts));
  if (k.imageUrl) parts.push(`img ${k.imageUrl}`);
  if (k.pinned) parts.push("pinned");
  return parts.join("; ");
}

function stripRow(it: StripItem, names: Record<string, string>): string[] {
  const gestures = [
    it.tapAction ? `tap ${describeAction(it.tapAction, it.tapSettings, names)}` : "",
    it.swipeAction ? `swipe ${describeAction(it.swipeAction, it.swipeSettings, names)}` : "",
    it.longPressAction ? `hold ${describeAction(it.longPressAction, it.longPressSettings, names)}` : "",
  ].filter(Boolean).join("; ");
  const vis = [
    it.backgroundColor ? `bg ${it.backgroundColor}` : "",
    it.icon ? describeIcons([it.icon]) : "",
    describeTexts(it.texts),
    it.bar ? `bar ${it.bar.value} ${it.bar.min}..${it.bar.max} ${it.bar.position}` : "",
  ].filter(Boolean).join("; ");
  return [it.id, `${it.x},${it.y} ${it.w}x${it.h}`, clip(gestures || "-", 70), clip(vis, 90)];
}

function sceneTable(scene: Scene, dev: BuiltDevice, names: Record<string, string>): string {
  const lines: string[] = [];
  const triggers = scene.triggers.map(t => t.type === "window" ? `window(${[t.app_name && `app~${t.app_name}`, t.window_title && `title~${t.window_title}`, t.priority !== undefined && `prio ${t.priority}`].filter(Boolean).join(", ")})` : t.type).join(", ");
  lines.push(`  Scene "${scene.name}" ${scene.id}  [${triggers || "no triggers"}]`);
  const keyRows: string[][] = [["key", "pos", "action", "look"]];
  const cols = dev.model?.columns ?? 0;
  for (const [k, key] of Object.entries(scene.keys).sort((a, b) => Number(a[0]) - Number(b[0]))) {
    const i = Number(k);
    const pos = cols ? `r${Math.floor(i / cols)}c${i % cols}` : "";
    keyRows.push([k, pos, clip(describeAction(key.action, key.settings, names), 60), clip(keyVisual(key), 100)]);
  }
  lines.push(keyRows.length > 1 ? table(keyRows, "    ") : "    (no keys)");
  if (scene.encoders && Object.keys(scene.encoders).length) {
    const rows: string[][] = [["enc", "rotate", "press", "value"]];
    for (const [e, enc] of Object.entries(scene.encoders).sort((a, b) => Number(a[0]) - Number(b[0]))) {
      rows.push([
        `E${e}${enc.label ? ` ${enc.label}` : ""}`,
        clip(describeAction(enc.rotateAction, enc.rotateSettings, names), 55),
        clip(describeAction(enc.pressAction, enc.pressSettings, names), 45),
        `${enc.value} [${enc.min}..${enc.max}] step ${enc.step}`,
      ]);
    }
    lines.push(table(rows, "    "));
  }
  if (scene.strip) {
    lines.push(`    strip bg ${scene.strip.backgroundColor}`);
    const rows: string[][] = [["item", "rect", "gestures", "look"], ...scene.strip.items.map(it => stripRow(it, names))];
    lines.push(rows.length > 1 ? table(rows, "    ") : "    (no strip items)");
  }
  return lines.join("\n");
}

export function deckReport(built: BuiltDeck, summary?: DeviceMergeSummary[]): string {
  const out: string[] = [];
  for (const dev of built.devices) {
    const m = dev.model;
    const geo = m ? `${m.displayName}, ${m.columns}x${m.rows} keys${m.encoderCount ? `, ${m.encoderCount} encoders` : ""}${m.hasLcdStrip ? `, ${m.lcdStripWidth}x${m.lcdStripHeight} strip` : ""}` : `unknown model "${dev.modelId}"`;
    out.push(`Device ${dev.serial} (${geo})`);
    const names: Record<string, string> = {};
    for (const sc of dev.scenes) names[sc.id] = sc.name;
    for (const sc of dev.scenes) out.push(sceneTable(sc, dev, names));
    const s = summary?.find(x => x.serial === dev.serial);
    if (s) {
      out.push(`  Merge: ${s.newDevice ? "new device; " : ""}${s.added.length} added, ${s.replaced.length} replaced in place, ${s.kept.length} kept, ${s.removed.length} removed`);
    }
    out.push("");
  }
  out.push(`Watched HA entities (${built.watched.length}): ${built.watched.join(", ") || "-"}`);
  out.push(`Required plugins: ${built.requiredPlugins.join(", ") || "-"}`);
  return out.join("\n");
}

export function issuesReport(issues: Issue[]): string {
  const errors = issues.filter(i => i.level === "error");
  const warnings = issues.filter(i => i.level === "warning");
  const lines = [`Validation: ${errors.length} error(s), ${warnings.length} warning(s)`];
  for (const i of [...errors, ...warnings]) lines.push(`  ${i.level === "error" ? "ERROR" : "warn "} ${i.path}: ${i.message}`);
  return lines.join("\n");
}
