// Device geometry per model, mirrored from crates/sd-core/src/device/profile.rs (DEVICE_PROFILES).
//
// Only the fields a deck layout needs are kept. test/devices.test.ts parses profile.rs and fails
// when this table drifts from it, so a model added or changed there must be mirrored here.

export interface DeviceModel {
  /** DeviceProfile.id (e.g. "plus", "xl", "mk2"). */
  id: string;
  displayName: string;
  usbPid: number;
  columns: number;
  rows: number;
  /** Native key image size in px; 0 = keys have no display (Pedal). */
  keyPixelSize: number;
  /** Extra non-display touch buttons reported after the key grid (Neo). */
  touchButtonCount: number;
  hasLcdStrip: boolean;
  hasDials: boolean;
  encoderCount: number;
  lcdStripWidth: number;
  lcdStripHeight: number;
  infoLcdWidth: number;
  infoLcdHeight: number;
}

function gen2Grid(id: string, displayName: string, usbPid: number, columns: number, rows: number, keyPixelSize: number): DeviceModel {
  return {
    id, displayName, usbPid, columns, rows, keyPixelSize,
    touchButtonCount: 0, hasLcdStrip: false, hasDials: false, encoderCount: 0,
    lcdStripWidth: 0, lcdStripHeight: 0, infoLcdWidth: 0, infoLcdHeight: 0,
  };
}

function gen1SixKey(id: string, displayName: string, usbPid: number): DeviceModel {
  return {
    id, displayName, usbPid, columns: 3, rows: 2, keyPixelSize: 80,
    touchButtonCount: 0, hasLcdStrip: false, hasDials: false, encoderCount: 0,
    lcdStripWidth: 0, lcdStripHeight: 0, infoLcdWidth: 0, infoLcdHeight: 0,
  };
}

export const DEVICE_MODELS: readonly DeviceModel[] = [
  {
    id: "original", displayName: "Stream Deck Original", usbPid: 0x0060, columns: 5, rows: 3, keyPixelSize: 72,
    touchButtonCount: 0, hasLcdStrip: false, hasDials: false, encoderCount: 0,
    lcdStripWidth: 0, lcdStripHeight: 0, infoLcdWidth: 0, infoLcdHeight: 0,
  },
  gen2Grid("original_v2", "Stream Deck Original V2", 0x006d, 5, 3, 72),
  gen1SixKey("mini", "Stream Deck Mini", 0x0063),
  gen1SixKey("mini_v2", "Stream Deck Mini V2", 0x0090),
  gen1SixKey("mini_v2_b3", "Stream Deck Mini", 0x00b3),
  gen1SixKey("module_6", "Stream Deck 6 Module", 0x00b8),
  gen2Grid("xl", "Stream Deck XL", 0x006c, 8, 4, 96),
  gen2Grid("xl_v2", "Stream Deck XL V2", 0x008f, 8, 4, 96),
  gen2Grid("mk2", "Stream Deck MK.2", 0x0080, 5, 3, 72),
  gen2Grid("mk2_scissor", "Stream Deck MK.2 (Scissor)", 0x00a5, 5, 3, 72),
  gen2Grid("module_15", "Stream Deck 15 Module", 0x00b9, 5, 3, 72),
  gen2Grid("module_15_scissor", "Stream Deck 15 Module (Scissor)", 0x00e4, 5, 3, 72),
  gen2Grid("module_32", "Stream Deck 32 Module", 0x00ba, 8, 4, 96),
  {
    id: "pedal", displayName: "Stream Deck Pedal", usbPid: 0x0086, columns: 3, rows: 1, keyPixelSize: 0,
    touchButtonCount: 0, hasLcdStrip: false, hasDials: false, encoderCount: 0,
    lcdStripWidth: 0, lcdStripHeight: 0, infoLcdWidth: 0, infoLcdHeight: 0,
  },
  {
    id: "plus", displayName: "Stream Deck +", usbPid: 0x0084, columns: 4, rows: 2, keyPixelSize: 120,
    touchButtonCount: 0, hasLcdStrip: true, hasDials: true, encoderCount: 4,
    lcdStripWidth: 800, lcdStripHeight: 100, infoLcdWidth: 0, infoLcdHeight: 0,
  },
  {
    id: "neo", displayName: "Stream Deck Neo", usbPid: 0x009a, columns: 4, rows: 2, keyPixelSize: 96,
    touchButtonCount: 2, hasLcdStrip: false, hasDials: false, encoderCount: 0,
    lcdStripWidth: 0, lcdStripHeight: 0, infoLcdWidth: 248, infoLcdHeight: 58,
  },
];

/** Strip item coordinates are always in this design space (render-strip.ts STRIP_DESIGN_*). */
export const STRIP_DESIGN_WIDTH = 800;
export const STRIP_DESIGN_HEIGHT = 100;

/** Largest key design canvas (render-key.ts MAX_DESIGN_KEY_SIZE); font/icon px are relative to it. */
export const MAX_DESIGN_KEY_SIZE = 96;

export function findDeviceModel(id: string): DeviceModel | undefined {
  return DEVICE_MODELS.find(m => m.id === id);
}

/** Model by id; throws with the list of known ids. */
export function deviceModel(id: string): DeviceModel {
  const m = findDeviceModel(id);
  if (!m) throw new Error(`Unknown device model "${id}" (known: ${DEVICE_MODELS.map(d => d.id).join(", ")})`);
  return m;
}

/** Number of display keys (columns * rows). */
export function keyCount(m: DeviceModel): number {
  return m.columns * m.rows;
}

/** Display keys plus touch buttons: every valid key index is below this. */
export function buttonCount(m: DeviceModel): number {
  return keyCount(m) + m.touchButtonCount;
}

/** Key design canvas size in px, same as render-key.ts keyDesignSize(native). */
export function keyDesignSize(m: DeviceModel): number {
  return Math.min(m.keyPixelSize > 0 ? m.keyPixelSize : 72, MAX_DESIGN_KEY_SIZE);
}

/** Key index of a grid position (row-major, left to right). */
export function keyIndex(m: DeviceModel, row: number, col: number): number {
  if (row < 0 || row >= m.rows || col < 0 || col >= m.columns) {
    throw new Error(`Key position row ${row}, col ${col} is outside the ${m.columns}x${m.rows} grid of ${m.id}`);
  }
  return row * m.columns + col;
}
