// Unit tests for the glyph classifier and grid builder used by the
// autopilot interrupt detector. See
// docs/superpowers/specs/2026-05-07-bobbihack-attribute-aware-interrupts-design.md.

import { describe, expect, test } from "bun:test";
import {
  classifyCell,
  buildGlyphClass,
  type GlyphClass,
} from "../../examples/bobbihack/glyph-class";
import type { CellInfo, CellStyle } from "libghostty-vt";
import type { FrameSnapshot } from "../../src/types";

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

// Build a minimal stub `FrameSnapshot` from a 2D map of cells. Only
// `cellAt` is exercised by `buildGlyphClass`; the rest can throw if
// touched (which would surface a regression).
function stubSnapshot(cells: Map<string, CellInfo>): FrameSnapshot {
  return {
    text: "",
    title: "",
    cursor: { x: 0, y: 0, visible: true },
    bellsSinceLast: 0,
    titleChangesSinceLast: [],
    toAnsi: () => "",
    toHtml: () => "",
    toVt: () => "",
    cellAt(x: number, y: number) {
      return cells.get(`${x},${y}`) ?? null;
    },
  };
}

function cell(text: string, style?: CellStyle): CellInfo {
  const out: CellInfo = {
    text,
    wide: false,
    isWideContinuation: false,
    protected: false,
    ...(style !== undefined ? { style } : {}),
  };
  return out;
}

describe("classifyCell", () => {
  test("letter + inverse -> pet", () => {
    expect(classifyCell("d", defaultStyle({ inverse: true }))).toBe("pet");
    expect(classifyCell("F", defaultStyle({ inverse: true }))).toBe("pet");
  });

  test("letter without style -> normal", () => {
    expect(classifyCell("k", undefined)).toBe("normal");
  });

  test("letter + style without inverse -> normal", () => {
    expect(classifyCell("d", defaultStyle({ inverse: false }))).toBe("normal");
    expect(classifyCell("d", defaultStyle({ bold: true }))).toBe("normal");
  });

  test("@ + inverse -> pet (we trust the attribute)", () => {
    // The probe confirmed the player's @ never gets inverse. Other @
    // glyphs (humans) could in principle, though the spec says the
    // upstream position filter strips the player's @ before classification.
    expect(classifyCell("@", defaultStyle({ inverse: true }))).toBe("pet");
  });

  test("@ without inverse -> normal", () => {
    expect(classifyCell("@", undefined)).toBe("normal");
    expect(classifyCell("@", defaultStyle())).toBe("normal");
  });

  test("non-letter glyph -> undefined", () => {
    for (const ch of [".", "#", "|", "-", "+", ">", "<", "$", "?", "!", " "]) {
      expect(classifyCell(ch, undefined)).toBeUndefined();
      expect(classifyCell(ch, defaultStyle({ inverse: true }))).toBeUndefined();
    }
  });

  test("multi-char text -> undefined", () => {
    expect(classifyCell("", undefined)).toBeUndefined();
    expect(classifyCell("ab", undefined)).toBeUndefined();
    // Wide CJK glyphs land here — we don't classify them as monsters.
    expect(classifyCell("猫", defaultStyle({ inverse: true }))).toBeUndefined();
  });
});

describe("buildGlyphClass", () => {
  test("returns a row-by-row grid the same length as rows", () => {
    const rows = ["abc", "def", ""];
    const snap = stubSnapshot(new Map());
    const grid = buildGlyphClass(snap, rows, null);
    expect(grid.length).toBe(3);
    expect(grid[0]!.length).toBe(3);
    expect(grid[1]!.length).toBe(3);
    expect(grid[2]!.length).toBe(0);
  });

  test("classifies a pet at one cell, normals elsewhere", () => {
    // Row 0:  @.k.   (player at (0,0); kobold at (2,0); a dot at 1 and 3)
    // Row 1:  ..d.   (pet 'd' at (2,1) with inverse)
    const cells = new Map<string, CellInfo>([
      ["0,0", cell("@", defaultStyle())],
      ["2,0", cell("k", defaultStyle())],
      ["2,1", cell("d", defaultStyle({ inverse: true }))],
    ]);
    const rows = ["@.k.", "..d."];
    const grid = buildGlyphClass(stubSnapshot(cells), rows, { x: 0, y: 0 });
    // Player position filtered.
    expect(grid[0]![0]).toBeUndefined();
    // Dots are non-letters.
    expect(grid[0]![1]).toBeUndefined();
    // Kobold without inverse -> normal.
    expect(grid[0]![2]).toBe("normal");
    expect(grid[0]![3]).toBeUndefined();
    // Pet -> pet.
    expect(grid[1]![2]).toBe("pet");
  });

  test("filters the player's `@` even if cellAt would return inverse", () => {
    // Defensive: even if the engine ever emitted inverse on the player's
    // @, the position filter ensures we don't mark the player as a pet.
    const cells = new Map<string, CellInfo>([
      ["5,3", cell("@", defaultStyle({ inverse: true }))],
    ]);
    const rows = Array.from({ length: 6 }, () => "      ");
    rows[3] = "     @";
    // pad row 3 to length 6 with @ at index 5
    rows[3] = "     @";
    const grid = buildGlyphClass(stubSnapshot(cells), rows, { x: 5, y: 3 });
    expect(grid[3]![5]).toBeUndefined();
  });

  test("accepts a null player position (probe-style usage) and classifies all @s", () => {
    const cells = new Map<string, CellInfo>([
      ["0,0", cell("@", defaultStyle())],
    ]);
    const grid = buildGlyphClass(stubSnapshot(cells), ["@"], null);
    expect(grid[0]![0]).toBe("normal");
  });

  test("does not call cellAt for cells that are obviously not glyphs", () => {
    let calls = 0;
    const snap: FrameSnapshot = {
      ...stubSnapshot(new Map()),
      cellAt(_x: number, _y: number) {
        calls++;
        return null;
      },
    };
    const grid = buildGlyphClass(snap, ["....####    ----"], null);
    expect(calls).toBe(0);
    // Every cell is undefined.
    expect(grid[0]!.every((c: GlyphClass | undefined) => c === undefined)).toBe(true);
  });
});
