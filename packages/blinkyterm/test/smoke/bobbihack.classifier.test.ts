// Unit tests for the v2 cell classifier
// (`packages/blinkyterm/examples/bobbihack/cell-classifier.ts`).
//
// Phase 1 of the NetHack-aware autopilot v2 — see
// docs/superpowers/specs/2026-05-09-nethack-aware-autopilot.md.

import { describe, expect, test } from "bun:test";
import {
  buildClassifiedGrid,
  classifyCell,
  colorFromStyle,
  LETTER_TO_CLASS,
  type ClassifiedCell,
  type MonsterClass,
} from "../../examples/bobbihack/cell-classifier";
import {
  DANGER_CLASS_FLAGS,
  DANGER_CLASS_LETTERS,
} from "../../examples/bobbihack/danger-classes";
import type { CellInfo, CellStyle } from "libghostty-vt";
import type { FrameSnapshot } from "../../src/types";

// Build a minimal stub `FrameSnapshot` from a cell map. Only `cellAt` is
// exercised by `buildClassifiedGrid`.
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

function cellInfo(text: string, style?: CellStyle): CellInfo {
  const out: CellInfo = {
    text,
    wide: false,
    isWideContinuation: false,
    protected: false,
    ...(style !== undefined ? { style } : {}),
  };
  return out;
}

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

describe("classifyCell", () => {
  test("plain floor returns terrain only", () => {
    const cell = classifyCell(".", undefined);
    expect(cell.terrain).toBe("floor");
    expect(cell.foreground).toBeNull();
  });

  test("a wall returns terrain only", () => {
    const cell = classifyCell("|", undefined);
    expect(cell.terrain).toBe("wall");
    expect(cell.foreground).toBeNull();
  });

  test("a closed door returns terrain only", () => {
    const cell = classifyCell("+", undefined);
    expect(cell.terrain).toBe("door_closed");
    expect(cell.foreground).toBeNull();
  });

  test("'@' without playerXY classifies as a human monster", () => {
    const cell = classifyCell("@", undefined);
    expect(cell.foreground?.kind).toBe("monster");
    if (cell.foreground?.kind === "monster") {
      expect(cell.foreground.class).toBe("human");
    }
  });

  test("'@' AT the player's xy classifies as player", () => {
    const cell = classifyCell(
      "@",
      undefined,
      { x: 5, y: 10 },
      { x: 5, y: 10 },
    );
    expect(cell.foreground?.kind).toBe("player");
  });

  test("'@' at a different xy still classifies as a human monster", () => {
    const cell = classifyCell(
      "@",
      undefined,
      { x: 7, y: 10 },
      { x: 5, y: 10 },
    );
    expect(cell.foreground?.kind).toBe("monster");
  });

  test("'I' classifies as unseen-monster regardless of style", () => {
    const cell = classifyCell("I", undefined);
    expect(cell.foreground?.kind).toBe("unseen-monster");
    const cellInv = classifyCell("I", defaultStyle({ inverse: true }));
    expect(cellInv.foreground?.kind).toBe("unseen-monster");
  });

  test("digits 1..5 classify as warning with the correct tier", () => {
    for (const [ch, tier] of [
      ["1", 1],
      ["2", 2],
      ["3", 3],
      ["4", 4],
      ["5", 5],
    ] as const) {
      const cell = classifyCell(ch, undefined);
      expect(cell.foreground?.kind).toBe("warning");
      if (cell.foreground?.kind === "warning") {
        expect(cell.foreground.tier).toBe(tier);
      }
    }
  });

  test("digit 6 is NOT classified as warning (out of 1..5 range)", () => {
    const cell = classifyCell("6", undefined);
    expect(cell.foreground).toBeNull();
  });

  test("'d' inverse-styled classifies as a pet dog", () => {
    const cell = classifyCell("d", defaultStyle({ inverse: true }));
    expect(cell.foreground?.kind).toBe("monster");
    if (cell.foreground?.kind === "monster") {
      expect(cell.foreground.class).toBe("dog");
      expect(cell.foreground.pet).toBe(true);
      expect(cell.foreground.letter).toBe("d");
    }
  });

  test("'d' non-inverse classifies as a non-pet dog (jackal etc.)", () => {
    const cell = classifyCell("d", defaultStyle());
    expect(cell.foreground?.kind).toBe("monster");
    if (cell.foreground?.kind === "monster") {
      expect(cell.foreground.class).toBe("dog");
      expect(cell.foreground.pet).toBe(false);
    }
  });

  test("'D' classifies as dragon, capturing the bold flag and color", () => {
    const cell = classifyCell(
      "D",
      defaultStyle({ bold: true, fg: { palette: 1 } }),
    );
    expect(cell.foreground?.kind).toBe("monster");
    if (cell.foreground?.kind === "monster") {
      expect(cell.foreground.class).toBe("dragon");
      expect(cell.foreground.bold).toBe(true);
      expect(cell.foreground.color).toBe(1);
    }
  });

  test("'?' classifies as item (scroll)", () => {
    const cell = classifyCell("?", undefined);
    expect(cell.foreground?.kind).toBe("item");
    if (cell.foreground?.kind === "item") {
      expect(cell.foreground.letter).toBe("?");
    }
  });

  test("'!' classifies as item (potion)", () => {
    const cell = classifyCell("!", undefined);
    expect(cell.foreground?.kind).toBe("item");
  });

  test("'[' classifies as item (armor)", () => {
    const cell = classifyCell("[", undefined);
    expect(cell.foreground?.kind).toBe("item");
  });

  test("']' classifies as monster (mimic-def), NOT item", () => {
    const cell = classifyCell("]", undefined);
    expect(cell.foreground?.kind).toBe("monster");
    if (cell.foreground?.kind === "monster") {
      expect(cell.foreground.class).toBe("mimic-def");
    }
  });

  test("color-disambiguated '}' — red is lava (terrain set), no foreground", () => {
    const cell = classifyCell("}", defaultStyle({ fg: { palette: 1 } }));
    expect(cell.terrain).toBe("lava");
    expect(cell.foreground).toBeNull();
  });

  test("color-disambiguated '}' — blue is water", () => {
    const cell = classifyCell("}", defaultStyle({ fg: { palette: 4 } }));
    expect(cell.terrain).toBe("water");
    expect(cell.foreground).toBeNull();
  });

  test("multi-character text returns the empty cell", () => {
    const cell = classifyCell("ab", undefined);
    expect(cell.terrain).toBeNull();
    expect(cell.foreground).toBeNull();
  });
});

describe("buildClassifiedGrid", () => {
  // Helper: 24-row map with row 0 = message, rows 1..21 = map, rows 22-23 = status.
  function makeRows(mapRows: string[]): string[] {
    const blank80 = " ".repeat(80);
    const rows: string[] = new Array(24);
    rows[0] = blank80; // message
    for (let i = 0; i < 21; i++) {
      rows[i + 1] = (mapRows[i] ?? blank80).padEnd(80, " ");
    }
    rows[22] = blank80; // status row 1
    rows[23] = blank80; // status row 2
    return rows;
  }

  test("returns a row-shaped grid with empty placeholders for non-map rows", () => {
    const rows = makeRows([]);
    const snapshot = stubSnapshot(new Map());
    const grid = buildClassifiedGrid(snapshot, rows, null);
    expect(grid.length).toBe(24);
    // Row 0 (message line) is all empties.
    expect(grid[0]?.length).toBe(80);
    expect(grid[0]?.[0]).toEqual({ terrain: null, foreground: null });
    // Rows 22 and 23 (status) likewise.
    expect(grid[22]?.[5]).toEqual({ terrain: null, foreground: null });
    expect(grid[23]?.[5]).toEqual({ terrain: null, foreground: null });
  });

  test("classifies map rows from cellAt style data", () => {
    const rows = makeRows(["@.d#"]);
    const cells = new Map<string, CellInfo>();
    cells.set("0,1", cellInfo("@"));
    cells.set("1,1", cellInfo("."));
    cells.set("2,1", cellInfo("d", defaultStyle({ inverse: true })));
    cells.set("3,1", cellInfo("#"));
    const snapshot = stubSnapshot(cells);
    const grid = buildClassifiedGrid(snapshot, rows, { x: 0, y: 1 });
    // Player's @ at (0, 1).
    expect(grid[1]?.[0]?.foreground?.kind).toBe("player");
    // Floor at (1, 1).
    expect(grid[1]?.[1]?.terrain).toBe("floor");
    // Pet dog at (2, 1).
    const dogFg = grid[1]?.[2]?.foreground;
    expect(dogFg?.kind).toBe("monster");
    if (dogFg?.kind === "monster") {
      expect(dogFg.class).toBe("dog");
      expect(dogFg.pet).toBe(true);
    }
    // Corridor at (3, 1).
    expect(grid[1]?.[3]?.terrain).toBe("corridor");
  });

  test("falls back to row text when cellAt returns null", () => {
    const rows = makeRows([".d"]);
    const snapshot = stubSnapshot(new Map());
    const grid = buildClassifiedGrid(snapshot, rows, null);
    expect(grid[1]?.[0]?.terrain).toBe("floor");
    const fg = grid[1]?.[1]?.foreground;
    expect(fg?.kind).toBe("monster");
    if (fg?.kind === "monster") {
      expect(fg.class).toBe("dog");
      expect(fg.pet).toBe(false);
    }
  });

  test("classifies '}' as lava when style has red palette index", () => {
    const rows = makeRows(["}"]);
    const cells = new Map<string, CellInfo>();
    cells.set("0,1", cellInfo("}", defaultStyle({ fg: { palette: 1 } })));
    const snapshot = stubSnapshot(cells);
    const grid = buildClassifiedGrid(snapshot, rows, null);
    expect(grid[1]?.[0]?.terrain).toBe("lava");
  });

  test("does not throw on a snapshot whose cellAt throws", () => {
    const rows = makeRows([".d"]);
    const snapshot = stubSnapshot(new Map());
    // Replace cellAt to throw.
    const badSnapshot: FrameSnapshot = {
      ...snapshot,
      cellAt: () => {
        throw new Error("boom");
      },
    };
    expect(() => buildClassifiedGrid(badSnapshot, rows, null)).not.toThrow();
  });

  test("classifies an 'I' marker", () => {
    const rows = makeRows(["I"]);
    const snapshot = stubSnapshot(new Map());
    const grid = buildClassifiedGrid(snapshot, rows, null);
    expect(grid[1]?.[0]?.foreground?.kind).toBe("unseen-monster");
  });

  test("classifies a warning digit '4'", () => {
    const rows = makeRows(["4"]);
    const snapshot = stubSnapshot(new Map());
    const grid = buildClassifiedGrid(snapshot, rows, null);
    const fg = grid[1]?.[0]?.foreground;
    expect(fg?.kind).toBe("warning");
    if (fg?.kind === "warning") {
      expect(fg.tier).toBe(4);
    }
  });
});

describe("DANGER_CLASS_FLAGS", () => {
  test("contains the v0 set: dragon, lich, vampire, wraith, demon", () => {
    expect(DANGER_CLASS_FLAGS.size).toBe(5);
    expect(DANGER_CLASS_FLAGS.has("dragon")).toBe(true);
    expect(DANGER_CLASS_FLAGS.has("lich")).toBe(true);
    expect(DANGER_CLASS_FLAGS.has("vampire")).toBe(true);
    expect(DANGER_CLASS_FLAGS.has("wraith")).toBe(true);
    expect(DANGER_CLASS_FLAGS.has("demon")).toBe(true);
  });

  test("does NOT include classes that are merely hostile (orc, kobold)", () => {
    expect(DANGER_CLASS_FLAGS.has("orc")).toBe(false);
    expect(DANGER_CLASS_FLAGS.has("kobold")).toBe(false);
    expect(DANGER_CLASS_FLAGS.has("dog")).toBe(false);
  });
});

describe("DANGER_CLASS_LETTERS", () => {
  test("matches the DANGER_CLASS_FLAGS one-to-one", () => {
    expect(DANGER_CLASS_LETTERS.size).toBe(DANGER_CLASS_FLAGS.size);
    for (const letter of DANGER_CLASS_LETTERS) {
      const klass = LETTER_TO_CLASS[letter];
      expect(klass).toBeDefined();
      if (klass !== undefined) {
        expect(DANGER_CLASS_FLAGS.has(klass)).toBe(true);
      }
    }
  });
});
