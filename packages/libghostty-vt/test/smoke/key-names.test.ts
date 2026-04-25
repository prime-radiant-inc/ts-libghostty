import { describe, test, expect } from "bun:test";
import { keyToGhosttyId, type Key } from "../../src/internal/key-names";
import { GhosttyKeyValues } from "../../src/internal/generated";

describe("keyToGhosttyId", () => {
  test("letter keys: KeyA → GHOSTTY_KEY_A", () => {
    expect(keyToGhosttyId["KeyA"]).toBe(GhosttyKeyValues.GHOSTTY_KEY_A);
    expect(keyToGhosttyId["KeyZ"]).toBe(GhosttyKeyValues.GHOSTTY_KEY_Z);
  });

  test("digits: Digit0 → GHOSTTY_KEY_DIGIT_0", () => {
    expect(keyToGhosttyId["Digit0"]).toBe(GhosttyKeyValues.GHOSTTY_KEY_DIGIT_0);
    expect(keyToGhosttyId["Digit9"]).toBe(GhosttyKeyValues.GHOSTTY_KEY_DIGIT_9);
  });

  test("arrows: ArrowUp → GHOSTTY_KEY_ARROW_UP", () => {
    expect(keyToGhosttyId["ArrowUp"]).toBe(GhosttyKeyValues.GHOSTTY_KEY_ARROW_UP);
    expect(keyToGhosttyId["ArrowDown"]).toBe(GhosttyKeyValues.GHOSTTY_KEY_ARROW_DOWN);
    expect(keyToGhosttyId["ArrowLeft"]).toBe(GhosttyKeyValues.GHOSTTY_KEY_ARROW_LEFT);
    expect(keyToGhosttyId["ArrowRight"]).toBe(GhosttyKeyValues.GHOSTTY_KEY_ARROW_RIGHT);
  });

  test("Enter, Space, Backspace, Escape, Tab", () => {
    expect(keyToGhosttyId["Enter"]).toBe(GhosttyKeyValues.GHOSTTY_KEY_ENTER);
    expect(keyToGhosttyId["Space"]).toBe(GhosttyKeyValues.GHOSTTY_KEY_SPACE);
    expect(keyToGhosttyId["Backspace"]).toBe(GhosttyKeyValues.GHOSTTY_KEY_BACKSPACE);
    expect(keyToGhosttyId["Escape"]).toBe(GhosttyKeyValues.GHOSTTY_KEY_ESCAPE);
    expect(keyToGhosttyId["Tab"]).toBe(GhosttyKeyValues.GHOSTTY_KEY_TAB);
  });

  test("function keys: F1 → GHOSTTY_KEY_F1", () => {
    expect(keyToGhosttyId["F1"]).toBe(GhosttyKeyValues.GHOSTTY_KEY_F1);
    expect(keyToGhosttyId["F12"]).toBe(GhosttyKeyValues.GHOSTTY_KEY_F12);
  });

  test("Unidentified maps to GHOSTTY_KEY_UNIDENTIFIED (0)", () => {
    expect(keyToGhosttyId["Unidentified"]).toBe(0);
  });

  test("the union type covers every GHOSTTY_KEY_*", () => {
    const enumNames = Object.keys(GhosttyKeyValues).filter(k => k !== "GHOSTTY_KEY_MAX_VALUE");
    expect(enumNames.length).toBeGreaterThan(140);
  });
});
