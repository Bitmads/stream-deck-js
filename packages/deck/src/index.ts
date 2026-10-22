// Public API for deck files: import { defineDeck, device, scene, key, ... } from ".../packages/deck/src/index.ts".

export {
  // actions
  none, haService, haToggle, haScript, haAttrControl, haCustom, nav, hotkey, command, launch, openUrl,
  httpRequest, timer, counter, multi,
  // keys
  text, icon, ha, key,
  // encoders
  encoder, haDial,
  // strip
  bar, stripItem, panel, haSlider, strip, PANEL_WIDTH,
  // scenes / deck
  windowTrigger, manual, scene, device, defineDeck, SCENE_REF_PREFIX,
} from "./builders.ts";
export type {
  ActionSpec, SceneRef, HttpRequestOptions, MultiStep, KeyOptions, EncoderOptions, HaDialOptions, BarOptions,
  StripItemOptions, HaSliderOptions, WindowTriggerOptions, SceneOptions, SceneSpec, DeviceSpec, DeckSpec,
} from "./builders.ts";
export type { IconOptions } from "./icons.ts";
export { DEVICE_MODELS, deviceModel, keyIndex, keyCount, buttonCount, keyDesignSize } from "./devices.ts";
export type { DeviceModel } from "./devices.ts";
export { ACTIONS, HA_CONTROLS, UI_FONTS } from "./catalog.ts";
export { sceneIdFromSlug } from "./uuid.ts";
export { buildDeck } from "./build.ts";
export type { BuiltDeck, BuiltDevice } from "./build.ts";
export { validateDeck, hasErrors } from "./validate.ts";
export type { Issue, HaStateLite, ValidateOptions } from "./validate.ts";
export { mergeProfile, applyDeck, defaultConfigDir } from "./apply.ts";
export type { ApplyOptions, ApplyResult, MergeOptions, DeviceMergeSummary } from "./apply.ts";
