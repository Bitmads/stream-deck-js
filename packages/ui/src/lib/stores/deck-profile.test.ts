// Drives a generated deck profile through the real store, template engine, renderers' resolve step,
// HA client and plugin executors, using a Home Assistant state snapshot instead of a live connection.
// Skipped unless OSD_DECK_PROFILE points at a profile_<name>.json, so no user data is committed:
//
//   OSD_DECK_PROFILE=/path/profile.json \
//   OSD_DECK_STATES=/path/ha_states.json      (GET /api/states output: [{entity_id, state, attributes}])
//   OSD_DECK_SERVICES=/path/ha_services.json  (optional; [{domain, services}] as from get_services)
//   OSD_DECK_WATCHED=light.a,sensor.b         (optional; default: every ha.* entity the profile references)
//   OSD_DECK_REPORT=/path/report.json         (optional; full resolved/dispatched report)
//   pnpm --filter @open-stream-deck/ui test deck-profile
//
// Every key, encoder and strip item of every scene is resolved under several HA states (snapshot,
// snapshot + stock quotes, an "active" variant, everything unavailable) and checked for unresolved
// templates, NaN/undefined, leaked filter names and colours that would silently fall back. Then every
// press, rotation and strip gesture is dispatched and the resulting HA calls, host actions and scene
// changes are checked against the HA service schema.
import { describe, it, expect, vi } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";

const h = vi.hoisted(() => {
  const g = globalThis as any;
  g.window = g;
  g.addEventListener = () => {};
  g.document = { addEventListener: () => {}, visibilityState: "visible" };
  const files: Record<string, string> = {};
  const calls: { cmd: string; args: any }[] = [];
  const devices: any[] = [];
  return { files, calls, devices };
});

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args: any) => {
    h.calls.push({ cmd, args });
    switch (cmd) {
      case "load_json_file": return h.files[args.filename] ?? null;
      case "load_json_file_stamped": {
        const content = h.files[args.filename];
        return content === undefined ? null : { content, stamp: `s:${content}` };
      }
      case "save_json_file": {
        const current = h.files[args.filename];
        if (args.expectedStamp != null && (current === undefined || `s:${current}` !== args.expectedStamp)) {
          throw `changed on disk: ${args.filename}.json was replaced by another writer`;
        }
        h.files[args.filename] = args.content;
        return `s:${args.content}`;
      }
      case "list_json_files": return Object.keys(h.files);
      case "list_devices": return h.devices;
      default: return null;
    }
  }),
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
// The settings panel is UI only; the plugin's executors are what is under test.
vi.mock("../plugins/homeassistant/HASettings.svelte", () => ({ default: {} }));

import { store, registerActionType } from "./store.svelte";
import type { KeyAssignment, StripItem, EncoderConfig, Scene } from "../types/profile";
import { resolveKeyInputs, keyFingerprint, resolveActiveIcon } from "../utils/render-key";
import { resolveStripInputs, stripFingerprint } from "../utils/render-strip";
import {
  resolveTemplate, resolveTemplateDetailed, extractVariableNames, isUsableColor, resolveNumber, hasTemplates,
} from "../utils/template";
import { isFetchableUrl } from "../utils/image-cache";
import { quantize, ratioToValue } from "../plugins/homeassistant/mapping";
import { haPluginDef, ha } from "../plugins/homeassistant/index";
import { multiActionPluginDef } from "../plugins/multi-action/index";
import { navigationPluginDef } from "../plugins/navigation/index";
import { systemActionsPluginDef } from "../plugins/system/index";
import { parseSteps } from "../plugins/multi-action/steps";

const profilePath = process.env.OSD_DECK_PROFILE;
const statesPath = process.env.OSD_DECK_STATES;

type Severity = "FAIL" | "WARN";
interface Finding { severity: Severity; scenario: string; where: string; problem: string; detail?: string }
interface HaCall { domain: string; service: string; data?: Record<string, any>; target?: Record<string, any> }

const RAW_SETTINGS: Record<string, string[]> = { "multi-action": ["steps"], "ha-service": ["ha_service_data"], "ha-custom": ["ha_custom_json"] };
const FILTER_LEAK = /\b(round[12]?|floor|ceil|abs|percent|upper|lower|rgb|kelvin|f2c|c2f|trim|default:|map:|replace:)/;
const BAD_TEXT = /NaN|undefined|\bnull\b|\[object|\{\{|\}\}/;

describe.skipIf(!profilePath || !statesPath)("generated deck profile", () => {
  // The describe body runs even when skipped: read nothing then.
  const enabled = !!profilePath && !!statesPath;
  const text = enabled ? readFileSync(profilePath!, "utf8") : "{}";
  const raw = JSON.parse(text);
  const baseStates: any[] = enabled ? JSON.parse(readFileSync(statesPath!, "utf8")) : [];
  const servicesRaw = enabled && process.env.OSD_DECK_SERVICES ? JSON.parse(readFileSync(process.env.OSD_DECK_SERVICES, "utf8")) : null;
  const services: Record<string, Record<string, any>> | null = servicesRaw
    ? (Array.isArray(servicesRaw) ? Object.fromEntries(servicesRaw.map((s: any) => [s.domain, s.services])) : servicesRaw)
    : null;
  const serials = Object.keys(raw.devices ?? {});
  const findings: Finding[] = [];
  const report: Record<string, any> = { renders: {}, actions: [] };
  let scenario = "";
  const add = (severity: Severity, where: string, problem: string, detail?: string) =>
    findings.push({ severity, scenario, where, problem, detail });

  // ── Fixture helpers ──────────────────────────────────────────

  function allTemplateStrings(): string[] {
    const out: string[] = [];
    const walk = (v: unknown) => {
      if (typeof v === "string") { if (v.includes("{{")) out.push(v); return; }
      if (Array.isArray(v)) { v.forEach(walk); return; }
      if (v && typeof v === "object") {
        for (const [k, x] of Object.entries(v)) {
          if (k === "steps" && typeof x === "string") { try { walk(JSON.parse(x)); } catch { /* reported elsewhere */ } }
          else if (k === "ha_service_data" && typeof x === "string") { try { walk(JSON.parse(x)); } catch { /* reported elsewhere */ } }
          else walk(x);
        }
      }
    };
    walk(raw.devices);
    return out;
  }
  const referencedVars = [...new Set(allTemplateStrings().flatMap(t => extractVariableNames(t)))];
  const referencedEntities = [...new Set(referencedVars.filter(v => v.startsWith("ha.")).map(v => v.split(".").slice(1, 3).join(".")))];
  const watched = process.env.OSD_DECK_WATCHED
    ? process.env.OSD_DECK_WATCHED.split(",").map(s => s.trim()).filter(Boolean)
    : referencedEntities;

  const stateById = (states: any[]) => new Map(states.map(s => [s.entity_id, s]));

  /** Publish entity states through the HA client's own state-changed path (attr → variable mapping). */
  function applyStates(states: any[]) {
    for (const s of states) {
      (ha as any).handleStateChange({ new_state: { entity_id: s.entity_id, state: s.state, attributes: s.attributes ?? {} } });
    }
  }

  function serviceFields(domain: string, service: string): Record<string, any> | null {
    const svc = services?.[domain]?.[service];
    if (!svc) return null;
    const flat: Record<string, any> = {};
    for (const [k, f] of Object.entries<any>(svc.fields ?? {})) {
      if (f && typeof f === "object" && f.fields && typeof f.fields === "object") Object.assign(flat, f.fields); // sections
      else flat[k] = f;
    }
    return flat;
  }

  /** Validate one HA call against the snapshot's service schema and entity list. */
  function checkHaCall(where: string, call: HaCall, states: Map<string, any>) {
    if (!services) return;
    const svc = services[call.domain]?.[call.service];
    if (!svc) { add("FAIL", where, `service ${call.domain}.${call.service} does not exist in HA`); return; }
    const entityId = call.target?.entity_id as string | undefined;
    if (entityId) {
      const ent = states.get(entityId);
      if (!ent) add("FAIL", where, `target ${entityId} does not exist in HA`);
      const targets: any[] = svc.target?.entity ?? [];
      if (targets.length > 0 && ent) {
        const dom = entityId.split(".")[0];
        const ok = targets.some(t => (!t.domain || t.domain.includes(dom)) &&
          (!t.supported_features || t.supported_features.some((f: number) => ((ent.attributes?.supported_features ?? 0) & f) === f)));
        if (!ok) add("FAIL", where, `${entityId} is not a valid target of ${call.domain}.${call.service} (domain/supported_features)`);
      }
    }
    const fields = serviceFields(call.domain, call.service) ?? {};
    for (const [k, v] of Object.entries(call.data ?? {})) {
      const f = fields[k];
      if (!f) { add("FAIL", where, `${call.domain}.${call.service} has no field "${k}"`); continue; }
      const sel = f.selector ?? {};
      if (sel.number) {
        if (typeof v !== "number" || !Number.isFinite(v)) add("FAIL", where, `field ${k} must be a number, got ${JSON.stringify(v)}`);
        else {
          const { min, max } = sel.number;
          if ((min !== undefined && v < min) || (max !== undefined && v > max)) add("FAIL", where, `field ${k}=${v} outside selector range [${min}, ${max}]`);
        }
      }
      if (sel.boolean !== undefined && typeof v !== "boolean") {
        add("WARN", where, `field ${k} has a boolean selector but is sent as ${typeof v} ${JSON.stringify(v)} (accepted only through HA's cv.boolean coercion)`);
      }
    }
    for (const [k, f] of Object.entries<any>(fields)) {
      if (f?.required && !(call.data && k in call.data)) add("FAIL", where, `${call.domain}.${call.service} requires field "${k}" which is not sent`);
    }
  }

  // ── Template checks ──────────────────────────────────────────

  type Kind = "text" | "color" | "url" | "number" | "cond" | "setting";
  function checkField(where: string, kind: Kind, value: unknown, fallback?: string) {
    if (value === undefined || value === null || value === "") return;
    if (typeof value !== "string") {
      if (kind === "number" && typeof value === "number") return;
      add("FAIL", where, `field is ${typeof value}, expected a string`); return;
    }
    const r = resolveTemplateDetailed(value, store.lookupVar);
    const out = r.text;
    const names = extractVariableNames(value);
    const undef = names.filter(n => store.lookupVar(n) === undefined);
    if (BAD_TEXT.test(out)) add("FAIL", where, `renders "${out}"`, value.slice(0, 160));
    if (hasTemplates(value) && kind === "text" && FILTER_LEAK.test(out)) add("FAIL", where, `filter name leaks into "${out}"`);
    if (kind === "color") {
      if (!isUsableColor(out.trim())) add("FAIL", where, `colour "${out}" does not resolve; falls back to ${fallback ?? "default"}`, value.slice(0, 160));
    }
    if (kind === "url" && out.trim() && !r.missing && !out.startsWith("data:") && !isFetchableUrl(out.trim())) {
      add("FAIL", where, `image URL "${out.slice(0, 60)}" is not fetchable`);
    }
    if (kind === "number" && hasTemplates(value)) {
      const n = parseFloat(out);
      if (r.missing) add("WARN", where, `number template has no value; fallback used`, value);
      else if (!Number.isFinite(n)) add("WARN", where, `number resolves to "${out}"; fallback used`, value);
    }
    if (kind === "text" && hasTemplates(value) && out.trim() === "" && names.length > 0 &&
        names.every(n => (store.lookupVar(n) ?? "") !== "")) {
      add("WARN", where, `renders empty although every variable has a value`, names.map(n => `${n}=${store.lookupVar(n)}`).join(", "));
    }
    if (undef.length > 0 && kind !== "url") add("WARN", where, `variable(s) not published: ${undef.join(", ")}`);
  }

  function checkTexts(where: string, texts: any[] | undefined) {
    (texts ?? []).forEach((t, i) => {
      checkField(`${where}.texts[${i}].text`, "text", t.text);
      checkField(`${where}.texts[${i}].color`, "color", t.color || "#ffffff", "#ffffff");
      if (t.stroke) checkField(`${where}.texts[${i}].stroke.color`, "color", t.stroke.color, "#000000");
      if (t.shadow) checkField(`${where}.texts[${i}].shadow.color`, "color", t.shadow.color, "#000000");
    });
  }

  function checkSettings(where: string, actionId: string, settings: Record<string, string> | undefined) {
    for (const [k, v] of Object.entries(settings ?? {})) {
      if ((RAW_SETTINGS[actionId] ?? []).includes(k)) {
        if (k === "ha_service_data") {
          let obj: any;
          try { obj = JSON.parse(v); } catch (e) { add("FAIL", `${where}.${k}`, `invalid JSON: ${String(e)}`); continue; }
          for (const [dk, dv] of Object.entries<any>(obj)) if (typeof dv === "string") checkField(`${where}.${k}.${dk}`, "setting", dv);
        }
        if (k === "steps") {
          try {
            parseSteps(v).forEach((s, i) => checkSettings(`${where}.steps[${i}](${s.actionId})`, s.actionId, s.settings));
          } catch (e) { add("FAIL", `${where}.steps`, String(e)); }
        }
        continue;
      }
      checkField(`${where}.${k}`, "setting", v);
    }
  }

  function checkKey(where: string, key: KeyAssignment) {
    checkField(`${where}.backgroundColor`, "color", key.backgroundColor || "#000000", "#000000");
    checkField(`${where}.imageUrl`, "url", key.imageUrl);
    checkTexts(where, key.texts?.length ? key.texts : key.text ? [key.text] : []);
    (key.icons ?? []).forEach((ic, i) => {
      checkField(`${where}.icons[${i}].color`, "color", ic.color || "#ffffff", "#ffffff");
      if (ic.variable) checkField(`${where}.icons[${i}].variable`, "cond", ic.variable);
      if (!ic.svgBody) add("FAIL", `${where}.icons[${i}]`, "icon has no svgBody (draws nothing)");
    });
    checkSettings(`${where}.settings`, key.action.id, key.settings);
    const inputs = resolveKeyInputs(key, store.lookupVar);
    expect(typeof keyFingerprint(inputs, 120)).toBe("string");
    const active = resolveActiveIcon(key, t => resolveTemplate(t, store.lookupVar));
    return {
      bg: inputs.background, image: inputs.image ? (inputs.image.startsWith("data:") ? "data:" : "url") : "",
      icon: active ? `${active.iconName}@${inputs.icon?.color}` : null,
      texts: inputs.texts.map(t => `${t.text}@${t.color}`),
    };
  }

  function checkEncoder(where: string, enc: EncoderConfig) {
    checkField(`${where}.value`, "number", enc.value);
    checkField(`${where}.min`, "number", enc.min);
    checkField(`${where}.max`, "number", enc.max);
    checkSettings(`${where}.pressSettings`, enc.pressAction.id, enc.pressSettings);
    checkSettings(`${where}.rotateSettings`, enc.rotateAction.id, enc.rotateSettings);
    const v = resolveNumber(enc.value, store.lookupVar, 0), mn = resolveNumber(enc.min, store.lookupVar, 0), mx = resolveNumber(enc.max, store.lookupVar, 100);
    if (v < mn || v > mx) add("WARN", where, `current value ${v} is outside the dial range [${mn}, ${mx}]; the first turn jumps to the edge`);
    return { label: enc.label, value: v, min: mn, max: mx };
  }

  function checkStripItem(where: string, item: StripItem) {
    if (item.backgroundColor) checkField(`${where}.backgroundColor`, "color", item.backgroundColor, "#333333");
    checkField(`${where}.imageUrl`, "url", item.imageUrl);
    checkTexts(where, item.texts);
    if (item.icon) checkField(`${where}.icon.color`, "color", item.icon.color || "#ffffff", "#ffffff");
    if (item.bar) {
      checkField(`${where}.bar.value`, "number", item.bar.value);
      checkField(`${where}.bar.min`, "number", item.bar.min);
      checkField(`${where}.bar.max`, "number", item.bar.max);
      checkField(`${where}.bar.color`, "color", item.bar.color || "#03a9f4", "#03a9f4");
    }
    for (const g of ["tap", "longPress", "swipe"] as const) {
      const a = (item as any)[`${g}Action`];
      if (a && a.id !== "none") checkSettings(`${where}.${g}Settings`, a.id, (item as any)[`${g}Settings`]);
    }
  }

  function renderAll(label: string) {
    scenario = label;
    const out: Record<string, any> = {};
    for (const serial of serials) {
      for (const [sceneId, scene] of Object.entries<Scene>(store.profileDevices[serial].scenes)) {
        const dev = h.devices.find(d => d.serial === serial);
        const count = dev.columns * dev.rows;
        for (let i = 0; i < count; i++) {
          const key = store.getEffectiveKey(serial, sceneId, i);
          if (!key) continue;
          out[`${scene.name}.key${i}`] = checkKey(`${scene.name}.key${i}`, key);
        }
        for (const [i, enc] of Object.entries(scene.encoders ?? {})) out[`${scene.name}.enc${i}`] = checkEncoder(`${scene.name}.enc${i}`, enc);
        if (scene.strip) {
          checkField(`${scene.name}.strip.backgroundColor`, "color", scene.strip.backgroundColor, "#0a0a1a");
          scene.strip.items.forEach(it => checkStripItem(`${scene.name}.strip.${it.id}`, it));
          const rs = resolveStripInputs(scene.strip, store.lookupVar);
          expect(typeof stripFingerprint(rs, 800, 100)).toBe("string");
          for (const it of rs.items) {
            out[`${scene.name}.strip.${it.id}`] = {
              bg: it.background, bar: it.bar ? `${Math.round(it.bar.ratio * 100)}%@${it.bar.color}` : null,
              image: it.image ? "url" : "", texts: it.texts.map(t => `${t.text}@${t.color}`),
            };
          }
        }
      }
    }
    report.renders[label] = out;
  }

  // ── Dispatch capture ─────────────────────────────────────────

  const haCalls: HaCall[] = [];
  vi.spyOn(ha, "callService").mockImplementation(async (domain: string, service: string, data?: any, target?: any) => {
    haCalls.push({ domain, service, data, target });
    return { type: "result", success: true };
  });
  const hostCalls = () => h.calls.filter(c => c.cmd === "execute_action");

  async function settle() { await vi.advanceTimersByTimeAsync(60); }

  /** Run `fn`, collecting HA calls, host actions, scene changes and errors it causes. */
  async function capture(serial: string, fn: () => unknown) {
    const ha0 = haCalls.length, host0 = hostCalls().length;
    const sceneBefore = store.getActiveSceneId(serial);
    store.lastError = null;
    let error: string | null = null;
    try { await fn(); } catch (e) { error = e instanceof Error ? e.message : String(e); }
    await settle();
    return {
      ha: haCalls.slice(ha0),
      host: hostCalls().slice(host0).map(c => ({ actionType: c.args.actionType, settings: JSON.parse(c.args.settings) })),
      sceneBefore, sceneAfter: store.getActiveSceneId(serial),
      error: error ?? store.lastError,
    };
  }

  const sceneName = (serial: string, id: string | null) => (id && store.profileDevices[serial].scenes[id]?.name) || String(id);

  /** Bring a device to `sceneId` the way a user would: from the first scene via a key that pushes it, else a switch. */
  async function goTo(serial: string, sceneId: string) {
    const ids = Object.keys(store.profileDevices[serial].scenes);
    const home = ids[0];
    store.switchScene(home, false, serial);
    store.sceneStacks[serial] = [home];
    if (sceneId === home) return;
    const homeKeys = store.profileDevices[serial].scenes[home].keys;
    const via = Object.entries(homeKeys).find(([, k]) => k.action.id === "switch-scene" && k.settings.sceneId === sceneId);
    if (via) await store.executeKeyAction(serial, Number(via[0]));
    else store.switchScene(sceneId, false, serial);
    expect(store.getActiveSceneId(serial)).toBe(sceneId);
  }

  function expectHaFromSettings(where: string, settings: Record<string, string>, res: Awaited<ReturnType<typeof capture>>, states: Map<string, any>) {
    const resolved = store.resolveActionSettings("ha-service", settings);
    if (res.error) { add("FAIL", where, `dispatch error: ${res.error}`); return; }
    if (res.ha.length !== 1) { add("FAIL", where, `expected 1 HA call, got ${res.ha.length}`); return; }
    const c = res.ha[0];
    if (c.domain !== resolved.ha_domain || c.service !== resolved.ha_service) add("FAIL", where, `called ${c.domain}.${c.service}, expected ${resolved.ha_domain}.${resolved.ha_service}`);
    if ((c.target?.entity_id ?? "") !== (resolved.ha_entity ?? "")) add("FAIL", where, `target ${c.target?.entity_id} != ${resolved.ha_entity}`);
    if (settings.ha_service_data) {
      const expected: Record<string, any> = {};
      for (const [k, v] of Object.entries<any>(JSON.parse(settings.ha_service_data))) expected[k] = typeof v === "string" ? resolveTemplate(v, store.lookupVar) : v;
      expect(c.data, where).toEqual(expected);
    }
    checkHaCall(where, c, states);
  }

  /** Check an attribute control call (encoder/strip): the number sent for ha_attr. */
  function expectAttrValue(where: string, res: Awaited<ReturnType<typeof capture>>, attr: string, expected: number) {
    const sent = res.ha[0]?.data?.[attr];
    report.actions.push({ scenario, where, sent, expected });
    if (typeof sent !== "number") { add("FAIL", where, `${attr} sent as ${JSON.stringify(sent)}`); return; }
    if (Math.abs(sent - expected) > 1e-9) add("FAIL", where, `${attr} sent ${sent}, expected ${expected}`);
  }

  async function dispatchAll(label: string, states: Map<string, any>) {
    scenario = label;
    for (const serial of serials) {
      const cfg = store.profileDevices[serial];
      const dev = h.devices.find(d => d.serial === serial);
      for (const [sceneId, scene] of Object.entries<Scene>(cfg.scenes)) {
        // ── keys ──
        for (let i = 0; i < dev.columns * dev.rows; i++) {
          await goTo(serial, sceneId);
          const key = store.getEffectiveKey(serial, sceneId, i);
          if (!key) continue;
          const where = `${scene.name}.key${i}(${key.action.id})`;
          const stackBefore = [...store.getSceneStack(serial)];
          const res = await capture(serial, () => store.executeKeyAction(serial, i));
          report.actions.push({ scenario, where, ha: res.ha, host: res.host, scene: `${sceneName(serial, res.sceneBefore)}→${sceneName(serial, res.sceneAfter)}`, error: res.error });
          switch (key.action.id) {
            case "ha-service": expectHaFromSettings(where, key.settings, res, states); break;
            case "switch-scene":
              if (res.sceneAfter !== key.settings.sceneId) add("FAIL", where, `scene is ${sceneName(serial, res.sceneAfter)}, expected ${sceneName(serial, key.settings.sceneId)}`);
              break;
            case "back": {
              const expected = stackBefore.length > 1 ? stackBefore[stackBefore.length - 2] : res.sceneBefore;
              if (res.sceneAfter !== expected) add("FAIL", where, `back went to ${sceneName(serial, res.sceneAfter)}, expected ${sceneName(serial, expected)}`);
              if (stackBefore.length <= 1) add("WARN", where, `BACK does nothing here: the scene stack is [${stackBefore.map(s => sceneName(serial, s)).join(", ")}]`);
              break;
            }
            case "multi-action": {
              if (res.error) add("FAIL", where, `dispatch error: ${res.error}`);
              const steps = parseSteps(key.settings.steps);
              const haSteps = steps.filter(s => s.actionId === "ha-service");
              if (res.ha.length !== haSteps.length) add("FAIL", where, `expected ${haSteps.length} HA call(s), got ${res.ha.length}`);
              haSteps.forEach((s, n) => {
                const c = res.ha[n];
                if (!c) return;
                const r = store.resolveActionSettings("ha-service", s.settings);
                if (c.domain !== r.ha_domain || c.service !== r.ha_service || c.target?.entity_id !== r.ha_entity) {
                  add("FAIL", `${where}.step${n}`, `called ${c.domain}.${c.service} ${c.target?.entity_id}`);
                }
                checkHaCall(`${where}.step${n}`, c, states);
              });
              if (steps.some(s => s.actionId === "back")) {
                const expected = stackBefore.length > 1 ? stackBefore[stackBefore.length - 2] : res.sceneBefore;
                if (res.sceneAfter !== expected) add("FAIL", where, `ended on ${sceneName(serial, res.sceneAfter)}, expected ${sceneName(serial, expected)}`);
              }
              break;
            }
            case "hotkey": case "command": case "launch": case "open-url": {
              if (res.error) add("FAIL", where, `dispatch error: ${res.error}`);
              const expected = store.resolveActionSettings(key.action.id, key.settings);
              if (res.host.length !== 1) add("FAIL", where, `expected 1 execute_action, got ${res.host.length}`);
              else {
                expect(res.host[0].actionType, where).toBe(key.action.id);
                expect(res.host[0].settings, where).toEqual(expected);
              }
              break;
            }
            case "none":
              if (res.ha.length || res.host.length || res.sceneAfter !== res.sceneBefore) add("FAIL", where, "a key without action dispatched something");
              break;
            default:
              if (res.error) add("FAIL", where, `dispatch error: ${res.error}`);
          }
        }

        // ── encoders ──
        for (const [idx, enc] of Object.entries(scene.encoders ?? {})) {
          const i = Number(idx);
          const where = `${scene.name}.enc${i}`;
          await goTo(serial, sceneId);
          const stackBefore = [...store.getSceneStack(serial)];
          const press = await capture(serial, () => store.handleEncoderPressForDevice(serial, i));
          report.actions.push({ scenario, where: `${where}.press`, ha: press.ha, scene: `${sceneName(serial, press.sceneBefore)}→${sceneName(serial, press.sceneAfter)}`, error: press.error });
          if (enc.pressAction.id === "ha-service") expectHaFromSettings(`${where}.press`, enc.pressSettings, press, states);
          if (enc.pressAction.id === "back") {
            const expected = stackBefore.length > 1 ? stackBefore[stackBefore.length - 2] : press.sceneBefore;
            if (press.sceneAfter !== expected) add("FAIL", `${where}.press`, `back went to ${sceneName(serial, press.sceneAfter)}`);
          }

          for (const delta of [1, -1, 3]) {
            await goTo(serial, sceneId);
            await vi.advanceTimersByTimeAsync(600); // past echo suppression of the previous turn
            applyStates([...states.values()].filter(s => watched.includes(s.entity_id))); // reset to the scenario state
            const saves0 = h.calls.filter(c => c.cmd === "save_json_file" && c.args.filename === "profile_default").length;
            const valueBefore = enc.value;
            const r0 = resolveNumber(enc.value, store.lookupVar, 0);
            const mn = resolveNumber(enc.min, store.lookupVar, 0), mx = resolveNumber(enc.max, store.lookupVar, 100);
            const step = Number(enc.step) || 1;
            const newVal = Math.max(mn, Math.min(mx, r0 + delta * step));
            const rot = await capture(serial, async () => {
              for (let n = 0; n < Math.abs(delta); n++) store.handleEncoderRotateForDevice(serial, i, Math.sign(delta));
            });
            const w = `${where}.rotate${delta > 0 ? "+" : ""}${delta}`;
            if (enc.rotateAction.id === "none") {
              if (rot.ha.length || rot.host.length) add("FAIL", w, "rotate without action dispatched something");
              await vi.advanceTimersByTimeAsync(600);
              const saves1 = h.calls.filter(c => c.cmd === "save_json_file" && c.args.filename === "profile_default").length;
              if (!hasTemplates(valueBefore) && (enc.value !== valueBefore || saves1 !== saves0)) add("WARN", w, `turning changed the stored value ${valueBefore} → ${enc.value} (profile saved)`);
              continue;
            }
            if (enc.rotateAction.id !== "ha-service") continue;
            expectHaFromSettings(w, enc.rotateSettings, rot, states);
            const attr = enc.rotateSettings.ha_attr;
            if (attr && !enc.rotateSettings.ha_service_data) {
              const ctrl = ha.getEntityControls(enc.rotateSettings.ha_entity).find(c => c.attr === attr);
              expectAttrValue(w, rot, attr, ctrl ? quantize(newVal, ctrl) : newVal);
              const shown = resolveNumber(enc.value, store.lookupVar, NaN);
              const sent = rot.ha[0]?.data?.[attr];
              if (typeof sent === "number" && Math.abs(shown - sent) > 1e-9) {
                add("WARN", w, `dial shows ${shown} but ${sent} is sent (snapped to the HA control step ${ctrl?.step})`);
              }
            }
          }
        }

        // ── strip gestures ──
        for (const item of scene.strip?.items ?? []) {
          const where = `${scene.name}.strip.${item.id}`;
          const cx = item.x + item.w / 2, cy = item.y + item.h / 2;
          const gestures: { g: "tap" | "longPress" | "swipe"; run: () => void; ratio?: number }[] = [
            { g: "tap", run: () => store.handleStripTapForDevice(serial, cx, cy), ratio: 0.5 },
            { g: "tap", run: () => store.handleStripTapForDevice(serial, item.x + item.w * 0.9, cy), ratio: 0.9 },
            // Swipes stay 1px inside the item: hitTestSwipe picks the last item whose x range the swipe
            // touches, so a swipe ending exactly on the shared edge belongs to the neighbour.
            { g: "swipe", run: () => store.handleStripSwipeForDevice(serial, item.x + 1, cy, item.x + item.w - 1, cy), ratio: (item.w - 1) / item.w },
            { g: "swipe", run: () => store.handleStripSwipeForDevice(serial, item.x + item.w - 1, cy, item.x + item.w * 0.2, cy), ratio: 0.2 },
            { g: "longPress", run: () => store.handleStripLongPressForDevice(serial, cx, cy) },
          ];
          for (const gest of gestures) {
            await goTo(serial, sceneId);
            const action = (item as any)[`${gest.g}Action`];
            const settings = (item as any)[`${gest.g}Settings`] ?? {};
            const res = await capture(serial, gest.run);
            const w = `${where}.${gest.g}${gest.ratio !== undefined ? `@${gest.ratio}` : ""}`;
            report.actions.push({ scenario, where: w, ha: res.ha, host: res.host, error: res.error });
            if (!action || action.id === "none") {
              if (res.ha.length || res.host.length) add("FAIL", w, "gesture without action dispatched something");
              continue;
            }
            if (action.id !== "ha-service") continue;
            expectHaFromSettings(w, settings, res, states);
            const attr = settings.ha_attr;
            if (attr && !settings.ha_service_data && gest.ratio !== undefined) {
              const ctrl = ha.getEntityControls(settings.ha_entity).find(c => c.attr === attr);
              if (!ctrl) add("FAIL", w, `no HA control for ${settings.ha_entity}.${attr}: strip position cannot be mapped`);
              else expectAttrValue(w, res, attr, ratioToValue(gest.ratio, ctrl));
            }
          }
        }
      }
    }
  }

  // ── Scenarios ────────────────────────────────────────────────

  function variant(patch: Record<string, { state?: string; attributes?: Record<string, any> }>): any[] {
    return baseStates.map(s => {
      const p = patch[s.entity_id];
      return p ? { ...s, state: p.state ?? s.state, attributes: { ...s.attributes, ...(p.attributes ?? {}) } } : s;
    });
  }

  /** An "active" variant built from what the profile references: lights on, players playing, things on. */
  function activeVariant(): any[] {
    const patch: Record<string, any> = {};
    for (const id of referencedEntities) {
      const dom = id.split(".")[0];
      if (dom === "light") patch[id] = { state: "on", attributes: { brightness: 128, rgb_color: [255, 180, 90], color_mode: "xy" } };
      else if (dom === "switch" || dom === "binary_sensor") patch[id] = { state: "on" };
      else if (dom === "humidifier") patch[id] = { state: "off" };
      else if (dom === "media_player") patch[id] = { state: "playing", attributes: { volume_level: 0.35, is_volume_muted: true, entity_picture: "/api/media_player_proxy/x?token=T&cache=1" } };
      else if (dom === "vacuum") patch[id] = { state: "cleaning", attributes: { status: "Cleaning", cleaning_progress: 42 } };
      else if (/error$/.test(id)) patch[id] = { state: "main_brush_tangled", attributes: { description: "Main brush tangled" } };
      else if (/water_warning$/.test(id)) patch[id] = { state: "low_water" };
      else if (/now_playing/.test(id)) patch[id] = { state: "Some Movie (2024)" };
      else if (/current_room$/.test(id)) patch[id] = { state: "Kitchen" };
    }
    return variant(patch);
  }

  function unavailableVariant(): any[] {
    return baseStates.map(s => referencedEntities.includes(s.entity_id)
      ? { entity_id: s.entity_id, state: "unavailable", attributes: { friendly_name: s.attributes?.friendly_name, restored: true } }
      : s);
  }

  function setStocks(on: boolean) {
    const syms = [...new Set(referencedVars.filter(v => v.startsWith("stock.")).map(v => v.split(".")[1]))];
    const rows: Record<string, [number, number]> = {};
    syms.forEach((s, i) => { rows[s] = [i === 0 ? 67432.18 : 245.3 + i, i === 0 ? 1.234 : i === 1 ? -2.5 : 0]; });
    for (const [sym, [price, pct]] of Object.entries(rows)) {
      const p = `stock.${sym}`;
      const dir = pct > 0 ? "up" : pct < 0 ? "down" : "flat";
      // Same formatting as plugins/stock-quotes (crypto for the first symbol, Finnhub for the rest).
      const vals: Record<string, string> = {
        price: String(price), change_pct: sym === syms[0] ? pct.toFixed(2) : String(pct), direction: dir,
        arrow: dir === "up" ? "↑" : dir === "down" ? "↓" : "→", color: dir === "up" ? "#00c853" : dir === "down" ? "#ff1744" : "#888888",
        price_usd: sym === syms[0] ? `$${price.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : `$${price.toFixed(2)}`,
      };
      for (const [k, v] of Object.entries(vals)) on ? store.setVariableLocal(`${p}.${k}`, v) : store.deleteVariableLocal(`${p}.${k}`);
    }
  }

  it("loads, resolves every control under each state and dispatches every gesture correctly", async () => {
    vi.useFakeTimers();
    h.files.profile_default = text;
    serials.forEach(serial => {
      const scenes = Object.values<any>(raw.devices[serial].scenes);
      const plus = scenes.some(s => s.strip || s.encoders);
      h.devices.push(plus
        ? { serial, model: "Stream Deck +", model_id: "plus", columns: 4, rows: 2, key_size: 120, key_pixel_size: 120, has_lcd_strip: true, has_dials: true, encoder_count: 4, lcd_width: 800, lcd_height: 100 }
        : { serial, model: "Stream Deck Original V2", model_id: "original_v2", columns: 5, rows: 3, key_size: 72, key_pixel_size: 72, has_lcd_strip: false, has_dials: false, encoder_count: 0, lcd_width: 0, lcd_height: 0 });
    });
    for (const def of [haPluginDef, multiActionPluginDef, navigationPluginDef, systemActionsPluginDef]) {
      for (const a of def.actions ?? []) registerActionType(a, def.actionExecutors?.[a.id]);
    }
    await store.initStore();
    await store.refreshDevices();
    expect(store.loadError).toBeNull();

    // HA client in its connected state, fed from the snapshot (no socket).
    ha.setVariableSetter((name, value) => store.setVariableLocal(name, value));
    (ha as any).watchedEntities = new Set(watched);
    (ha as any).entities = [];
    applyStates(baseStates);
    scenario = "setup";
    for (const id of referencedEntities) if (!watched.includes(id)) add("FAIL", id, "referenced by the profile but not in the watched list: its variables are never published");
    for (const id of watched) if (!baseStates.some(s => s.entity_id === id)) add("FAIL", id, "watched entity does not exist in HA");

    renderAll("snapshot");
    setStocks(true);
    renderAll("snapshot+stocks");
    await dispatchAll("snapshot", stateById(baseStates));

    await vi.advanceTimersByTimeAsync(600);
    const active = activeVariant();
    applyStates(active);
    renderAll("active");
    await dispatchAll("active", stateById(active));

    await vi.advanceTimersByTimeAsync(600);
    setStocks(false);
    const unav = unavailableVariant();
    applyStates(unav);
    renderAll("unavailable");

    // Restart/reload while a pushed scene is on screen: is there a way back?
    scenario = "restart-on-subscene";
    applyStates(baseStates);
    for (const serial of serials) {
      const ids = Object.keys(raw.devices[serial].scenes);
      for (const sub of ids.slice(1)) {
        const copy = JSON.parse(text);
        copy.devices[serial].activeSceneId = sub;
        h.files.profile_default = JSON.stringify(copy);
        expect(await store.reloadProfileFromDisk("default")).toBe(true);
        const scene = store.profileDevices[serial].scenes[sub];
        const dev = h.devices.find(d => d.serial === serial);
        const exits: string[] = [];
        for (let i = 0; i < dev.columns * dev.rows; i++) {
          const k = store.getEffectiveKey(serial, sub, i);
          if (!k || !["back", "switch-scene", "multi-action"].includes(k.action.id)) continue;
          if (k.action.id === "multi-action") continue; // also runs an HA script; only pure navigation counts
          store.switchScene(sub, false, serial);
          store.sceneStacks[serial] = [sub];
          await store.executeKeyAction(serial, i).catch(() => {});
          if (store.getActiveSceneId(serial) !== sub) exits.push(`key${i}`);
        }
        for (const [i, enc] of Object.entries(scene.encoders ?? {})) {
          if (enc.pressAction.id !== "back" && enc.pressAction.id !== "switch-scene") continue;
          store.switchScene(sub, false, serial);
          store.sceneStacks[serial] = [sub];
          store.handleEncoderPressForDevice(serial, Number(i));
          await settle();
          if (store.getActiveSceneId(serial) !== sub) exits.push(`enc${i}`);
        }
        const hasTrigger = scene.triggers.some(t => t.type === "window");
        if (exits.length === 0 && !hasTrigger) {
          add("FAIL", scene.name, `after an app restart or profile reload with "${scene.name}" active, no key or dial leads out of it (BACK has an empty stack and there is no switch-scene key)`);
        }
      }
    }
    h.files.profile_default = text;
    await store.reloadProfileFromDisk("default");

    if (process.env.OSD_DECK_REPORT) writeFileSync(process.env.OSD_DECK_REPORT, JSON.stringify({ findings, ...report }, null, 1));
    const fails = findings.filter(f => f.severity === "FAIL");
    for (const f of findings) console.log(`${f.severity} [${f.scenario}] ${f.where}: ${f.problem}${f.detail ? `  (${f.detail})` : ""}`);
    vi.useRealTimers();
    expect(fails, fails.map(f => `[${f.scenario}] ${f.where}: ${f.problem}`).join("\n")).toHaveLength(0);
  }, 120_000);
});
