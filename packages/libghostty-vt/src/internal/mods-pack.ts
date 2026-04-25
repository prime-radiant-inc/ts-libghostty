/**
 * Mods <-> uint16 bitmask. Bit layout per ghostty/vt/key/event.h.
 */
export interface Mods {
  shift?: boolean;
  ctrl?: boolean;
  alt?: boolean;
  super?: boolean;
  capsLock?: boolean;
  numLock?: boolean;
  shiftSide?: "left" | "right";
  ctrlSide?: "left" | "right";
  altSide?: "left" | "right";
  superSide?: "left" | "right";
}

const BIT_SHIFT       = 1 << 0;
const BIT_CTRL        = 1 << 1;
const BIT_ALT         = 1 << 2;
const BIT_SUPER       = 1 << 3;
const BIT_CAPS_LOCK   = 1 << 4;
const BIT_NUM_LOCK    = 1 << 5;
const BIT_SHIFT_SIDE  = 1 << 6;
const BIT_CTRL_SIDE   = 1 << 7;
const BIT_ALT_SIDE    = 1 << 8;
const BIT_SUPER_SIDE  = 1 << 9;

export function packMods(mods: Mods | undefined): number {
  if (!mods) return 0;
  let m = 0;
  if (mods.shift)     m |= BIT_SHIFT;
  if (mods.ctrl)      m |= BIT_CTRL;
  if (mods.alt)       m |= BIT_ALT;
  if (mods.super)     m |= BIT_SUPER;
  if (mods.capsLock)  m |= BIT_CAPS_LOCK;
  if (mods.numLock)   m |= BIT_NUM_LOCK;
  if (mods.shiftSide === "right") m |= BIT_SHIFT_SIDE;
  if (mods.ctrlSide  === "right") m |= BIT_CTRL_SIDE;
  if (mods.altSide   === "right") m |= BIT_ALT_SIDE;
  if (mods.superSide === "right") m |= BIT_SUPER_SIDE;
  return m;
}

export function unpackMods(m: number): Mods {
  const out: Mods = {
    shift:    (m & BIT_SHIFT)     !== 0,
    ctrl:     (m & BIT_CTRL)      !== 0,
    alt:      (m & BIT_ALT)       !== 0,
    super:    (m & BIT_SUPER)     !== 0,
    capsLock: (m & BIT_CAPS_LOCK) !== 0,
    numLock:  (m & BIT_NUM_LOCK)  !== 0,
  };
  // Side bits are only meaningful when the corresponding main bit is set.
  if (out.shift && (m & BIT_SHIFT_SIDE)) out.shiftSide = "right";
  if (out.ctrl  && (m & BIT_CTRL_SIDE))  out.ctrlSide  = "right";
  if (out.alt   && (m & BIT_ALT_SIDE))   out.altSide   = "right";
  if (out.super && (m & BIT_SUPER_SIDE)) out.superSide = "right";
  return out;
}
