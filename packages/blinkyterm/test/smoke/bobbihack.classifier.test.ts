// Unit tests for the v2 cell classifier
// (`packages/blinkyterm/examples/bobbihack/cell-classifier.ts`).
//
// Phase 1 of the NetHack-aware autopilot v2 — see
// docs/superpowers/specs/2026-05-09-nethack-aware-autopilot.md.

import { describe, expect, test } from "bun:test";
import {
  colorFromStyle,
  LETTER_TO_CLASS,
  type ClassifiedCell,
  type MonsterClass,
} from "../../examples/bobbihack/cell-classifier";
import type { CellStyle } from "libghostty-vt";

function defaultStyle(overrides: Partial<CellStyle> = {}): CellStyle {
  return {
    bold: false,
    faint: false,
    italic: false,
    underline: "none",
    overline: false,
    strikethrough: false,
    blink: false,
    inverse: false,
    invisible: false,
    ...overrides,
  };
}

describe("LETTER_TO_CLASS", () => {
  test("contains 58 entries (26 lowercase + 25 uppercase skip I + 7 specials)", () => {
    expect(Object.keys(LETTER_TO_CLASS).length).toBe(58);
  });

  test("includes all 26 lowercase letters", () => {
    for (let c = "a".charCodeAt(0); c <= "z".charCodeAt(0); c++) {
      const ch = String.fromCharCode(c);
      expect(LETTER_TO_CLASS[ch]).toBeDefined();
    }
  });

  test("includes all uppercase letters except I", () => {
    for (let c = "A".charCodeAt(0); c <= "Z".charCodeAt(0); c++) {
      const ch = String.fromCharCode(c);
      if (ch === "I") {
        expect(LETTER_TO_CLASS[ch]).toBeUndefined();
        continue;
      }
      expect(LETTER_TO_CLASS[ch]).toBeDefined();
    }
  });

  test("includes the seven special chars", () => {
    for (const ch of ["@", "'", "&", ";", ":", "~", "]"]) {
      expect(LETTER_TO_CLASS[ch]).toBeDefined();
    }
  });

  test("has unique class names per char (no two chars map to the same class)", () => {
    const seen = new Map<MonsterClass, string>();
    for (const [ch, klass] of Object.entries(LETTER_TO_CLASS)) {
      const prior = seen.get(klass);
      if (prior !== undefined) {
        throw new Error(
          `MonsterClass "${klass}" mapped from both '${prior}' and '${ch}'`,
        );
      }
      seen.set(klass, ch);
    }
    expect(seen.size).toBe(Object.keys(LETTER_TO_CLASS).length);
  });

  test("specific landmark mappings from MONSYM", () => {
    expect(LETTER_TO_CLASS.d).toBe("dog");
    expect(LETTER_TO_CLASS.f).toBe("feline");
    expect(LETTER_TO_CLASS.D).toBe("dragon");
    expect(LETTER_TO_CLASS.L).toBe("lich");
    expect(LETTER_TO_CLASS.V).toBe("vampire");
    expect(LETTER_TO_CLASS.W).toBe("wraith");
    expect(LETTER_TO_CLASS["@"]).toBe("human");
    expect(LETTER_TO_CLASS["&"]).toBe("demon");
    expect(LETTER_TO_CLASS["]"]).toBe("mimic-def");
  });

  test("does NOT include 'I' (unseen-monster is its own foreground kind)", () => {
    expect(LETTER_TO_CLASS.I).toBeUndefined();
  });
});

describe("colorFromStyle", () => {
  test("returns -1 for undefined style", () => {
    expect(colorFromStyle(undefined)).toBe(-1);
  });

  test("returns -1 for default style with no fg", () => {
    expect(colorFromStyle(defaultStyle())).toBe(-1);
  });

  test("returns palette index for fg in 0..15", () => {
    for (let i = 0; i <= 15; i++) {
      expect(colorFromStyle(defaultStyle({ fg: { palette: i } }))).toBe(i);
    }
  });

  test("returns -1 for palette index outside 0..15", () => {
    expect(colorFromStyle(defaultStyle({ fg: { palette: 16 } }))).toBe(-1);
    expect(colorFromStyle(defaultStyle({ fg: { palette: 255 } }))).toBe(-1);
  });

  test("returns -1 for RGB triplet", () => {
    expect(colorFromStyle(defaultStyle({ fg: [255, 0, 0] }))).toBe(-1);
  });
});

describe("ClassifiedCell type shape", () => {
  test("an empty cell can be constructed", () => {
    const cell: ClassifiedCell = { terrain: null, foreground: null };
    expect(cell.terrain).toBeNull();
    expect(cell.foreground).toBeNull();
  });
});
