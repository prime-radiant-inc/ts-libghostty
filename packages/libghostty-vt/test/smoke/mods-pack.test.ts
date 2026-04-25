import { describe, test, expect } from "bun:test";
import { packMods, unpackMods, type Mods } from "../../src/internal/mods-pack";

describe("packMods / unpackMods", () => {
  test("empty mods → 0", () => {
    expect(packMods({})).toBe(0);
    expect(packMods(undefined)).toBe(0);
  });

  test("each individual flag", () => {
    expect(packMods({ shift: true })).toBe(1);
    expect(packMods({ ctrl: true })).toBe(2);
    expect(packMods({ alt: true })).toBe(4);
    expect(packMods({ super: true })).toBe(8);
    expect(packMods({ capsLock: true })).toBe(16);
    expect(packMods({ numLock: true })).toBe(32);
  });

  test("side bits only meaningful when their main flag is set", () => {
    expect(packMods({ shift: true, shiftSide: "right" })).toBe(1 | 64);
    expect(packMods({ shift: true, shiftSide: "left" })).toBe(1);
    expect(packMods({ ctrl: true, ctrlSide: "right" })).toBe(2 | 128);
    expect(packMods({ alt: true, altSide: "right" })).toBe(4 | 256);
    expect(packMods({ super: true, superSide: "right" })).toBe(8 | 512);
  });

  test("Ctrl+Shift combined", () => {
    expect(packMods({ ctrl: true, shift: true })).toBe(1 | 2);
  });

  test("unpackMods round-trip", () => {
    const original: Mods = { ctrl: true, shift: true, shiftSide: "right" };
    const packed = packMods(original);
    const unpacked = unpackMods(packed);
    expect(unpacked.ctrl).toBe(true);
    expect(unpacked.shift).toBe(true);
    expect(unpacked.shiftSide).toBe("right");
  });

  test("unpackMods of 0 returns empty mods (no side fields)", () => {
    const u = unpackMods(0);
    expect(u.ctrl).toBe(false);
    expect(u.shift).toBe(false);
    expect(u.shiftSide).toBeUndefined();
  });
});
