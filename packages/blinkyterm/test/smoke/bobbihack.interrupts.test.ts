import { describe, expect, test } from "bun:test";
import {
  detectUnseenMonsterMarker,
  detectWarningDigit,
  INTERRUPTS,
  runInterruptChecks,
  type InterruptContext,
} from "../../examples/bobbihack/interrupts";
import type { StatusLine } from "../../examples/bobbihack/parsers";

function status(overrides: Partial<StatusLine> = {}): StatusLine {
  return {
    name: "Hero",
    title: "the Stripling",
    attrs: { st: "18", dx: 11, co: 14, in: 11, wi: 13, ch: 7 },
    alignment: "Lawful",
    ac: 7,
    hp: 14,
    hpMax: 14,
    pw: 5,
    pwMax: 5,
    level: 1,
    xp: 0,
    dlvl: 1,
    turn: 1,
    gold: 0,
    hunger: "ok",
    conditions: [],
    ...overrides,
  };
}

function ctx(overrides: Partial<InterruptContext> = {}): InterruptContext {
  return {
    cur: {
      rows: Array.from({ length: 24 }, () => " ".repeat(80)),
      status: status(),
      message: "",
      frameReason: "cellChange",
    },
    ...overrides,
  };
}

describe("INTERRUPTS array", () => {
  test("contains expected interrupt names", () => {
    const names = INTERRUPTS.map((i) => i.name);
    // Modal/combat/danger
    expect(names).toContain("modal_prompt");
    expect(names).toContain("monster_visible");
    expect(names).toContain("hp_drop");
    expect(names).toContain("low_hp");
    expect(names).toContain("engulfed");
    // Status onsets
    expect(names).toContain("paralyzed");
    expect(names).toContain("polymorphed");
    expect(names).toContain("level_changed_unexpectedly");
    expect(names).toContain("xp_levelup");
    expect(names).toContain("hunger_transition");
    // Game state
    expect(names).toContain("new_item_visible");
    expect(names).toContain("entered_trap_tile");
    expect(names).toContain("bell");
    expect(names).toContain("you_die");
  });

  test("priorities are unique", () => {
    const priorities = INTERRUPTS.map((i) => i.priority);
    const unique = new Set(priorities);
    expect(unique.size).toBe(priorities.length);
  });
});

describe("modal_prompt", () => {
  const detect = INTERRUPTS.find((i) => i.name === "modal_prompt")!.detect;

  test("fires on --More--", () => {
    expect(detect(ctx({ cur: { ...ctx().cur, message: "Some text--More--" } }))).toBeTruthy();
  });

  test("fires on [yn] prompt", () => {
    expect(detect(ctx({ cur: { ...ctx().cur, message: "Really attack? [yn]" } }))).toBeTruthy();
  });

  test("does not fire on plain message", () => {
    expect(detect(ctx({ cur: { ...ctx().cur, message: "It's a wall." } }))).toBe(false);
  });
});

describe("hp_drop and low_hp", () => {
  const hpDrop = INTERRUPTS.find((i) => i.name === "hp_drop")!.detect;
  const lowHp = INTERRUPTS.find((i) => i.name === "low_hp")!.detect;

  test("hp_drop fires when HP decreased frame-over-frame", () => {
    expect(
      hpDrop(
        ctx({
          prev: { rows: [], status: status({ hp: 14 }), message: "" },
          cur: { ...ctx().cur, status: status({ hp: 9 }) },
        }),
      ),
    ).toBeTruthy();
  });

  test("hp_drop does not fire when HP unchanged", () => {
    expect(
      hpDrop(
        ctx({
          prev: { rows: [], status: status({ hp: 14 }), message: "" },
          cur: { ...ctx().cur, status: status({ hp: 14 }) },
        }),
      ),
    ).toBe(false);
  });

  test("low_hp fires when HP < hpMax/3", () => {
    // 4 of 14 < 14/3 (~4.67)
    expect(lowHp(ctx({ cur: { ...ctx().cur, status: status({ hp: 4, hpMax: 14 }) } }))).toBeTruthy();
  });

  test("low_hp does not fire when HP >= hpMax/3", () => {
    expect(lowHp(ctx({ cur: { ...ctx().cur, status: status({ hp: 5, hpMax: 14 }) } }))).toBe(false);
  });
});

describe("you_die", () => {
  const detect = INTERRUPTS.find((i) => i.name === "you_die")!.detect;
  test("fires on 'You die' message", () => {
    expect(detect(ctx({ cur: { ...ctx().cur, message: "You die..." } }))).toBeTruthy();
  });
  test("fires on DYWYPI prompt", () => {
    expect(detect(ctx({ cur: { ...ctx().cur, message: "Do you want your possessions identified? [yn]" } }))).toBeTruthy();
  });
});

describe("polymorphed and paralyzed and xp_levelup", () => {
  test("polymorphed fires on 'You suddenly turn into'", () => {
    const detect = INTERRUPTS.find((i) => i.name === "polymorphed")!.detect;
    expect(detect(ctx({ cur: { ...ctx().cur, message: "You suddenly turn into a xorn!" } }))).toBeTruthy();
  });

  test("paralyzed fires on canonical message", () => {
    const detect = INTERRUPTS.find((i) => i.name === "paralyzed")!.detect;
    expect(detect(ctx({ cur: { ...ctx().cur, message: "You can't move yourself!" } }))).toBeTruthy();
  });

  test("xp_levelup fires on level-up message", () => {
    const detect = INTERRUPTS.find((i) => i.name === "xp_levelup")!.detect;
    expect(detect(ctx({ cur: { ...ctx().cur, message: "Welcome to experience level 3." } }))).toBeTruthy();
  });
});

describe("hunger_transition", () => {
  const detect = INTERRUPTS.find((i) => i.name === "hunger_transition")!.detect;

  test("fires when hunger state changes", () => {
    expect(
      detect(
        ctx({
          prev: { rows: [], status: status({ hunger: "ok" }), message: "" },
          cur: { ...ctx().cur, status: status({ hunger: "Hungry" }) },
        }),
      ),
    ).toBeTruthy();
  });

  test("does not fire when hunger stays the same", () => {
    expect(
      detect(
        ctx({
          prev: { rows: [], status: status({ hunger: "ok" }), message: "" },
          cur: { ...ctx().cur, status: status({ hunger: "ok" }) },
        }),
      ),
    ).toBe(false);
  });
});

describe("monster_visible", () => {
  const detect = INTERRUPTS.find((i) => i.name === "monster_visible")!.detect;

  // Build a glyphClass grid the same shape as `rows`, with `cls` applied
  // at (x, y). Other cells are undefined (-> "treat as hostile" fallback).
  function gridWith(
    rows: string[],
    marks: { x: number; y: number; cls: "pet" | "normal" }[],
  ): ReadonlyArray<ReadonlyArray<"pet" | "normal" | undefined>> {
    const grid: ("pet" | "normal" | undefined)[][] = rows.map((r) =>
      new Array(r.length).fill(undefined),
    );
    for (const m of marks) grid[m.y]![m.x] = m.cls;
    return grid;
  }

  test("fires when a letter glyph appears in current frame that wasn't in prev", () => {
    const prevRows = Array.from({ length: 24 }, () => " ".repeat(80));
    prevRows[5] = "  ----- ".padEnd(80, " ");
    prevRows[6] = "  |@..| ".padEnd(80, " ");
    prevRows[7] = "  ----- ".padEnd(80, " ");
    const curRows = [...prevRows];
    curRows[6] = "  |@.k| ".padEnd(80, " "); // kobold appeared
    const result = detect(
      ctx({
        prev: { rows: prevRows, status: status(), message: "" },
        cur: { ...ctx().cur, rows: curRows },
      }),
    );
    expect(result).toBeTruthy();
  });

  test("does not fire when no letter glyphs", () => {
    expect(detect(ctx())).toBe(false);
  });

  test("does NOT fire when only pet glyphs moved (pet ignored)", () => {
    // Prev: pet 'd' at (5, 6). Cur: pet 'd' at (6, 6) (one tile east).
    const blank = Array.from({ length: 24 }, () => " ".repeat(80));
    const prevRows = [...blank];
    prevRows[6] = "     d".padEnd(80, " ");
    const curRows = [...blank];
    curRows[6] = "      d".padEnd(80, " ");
    const result = detect(
      ctx({
        prev: {
          rows: prevRows,
          status: status(),
          message: "",
          glyphClass: gridWith(prevRows, [{ x: 5, y: 6, cls: "pet" }]),
        },
        cur: {
          ...ctx().cur,
          rows: curRows,
          glyphClass: gridWith(curRows, [{ x: 6, y: 6, cls: "pet" }]),
        },
      }),
    );
    expect(result).toBe(false);
  });

  test("DOES fire when a `normal` glyph appears at a new position", () => {
    const blank = Array.from({ length: 24 }, () => " ".repeat(80));
    const prevRows = [...blank];
    const curRows = [...blank];
    curRows[6] = "     k".padEnd(80, " "); // kobold appeared
    const result = detect(
      ctx({
        prev: {
          rows: prevRows,
          status: status(),
          message: "",
          glyphClass: gridWith(prevRows, []),
        },
        cur: {
          ...ctx().cur,
          rows: curRows,
          glyphClass: gridWith(curRows, [{ x: 5, y: 6, cls: "normal" }]),
        },
      }),
    );
    expect(result).toBeTruthy();
  });

  test("DOES fire on a hostile in a frame that also moved a pet (mixed scene)", () => {
    // Prev: pet at (5, 6), no hostile.
    // Cur:  pet at (6, 6), kobold at (10, 6).
    const blank = Array.from({ length: 24 }, () => " ".repeat(80));
    const prevRows = [...blank];
    prevRows[6] = "     d    ".padEnd(80, " ");
    const curRows = [...blank];
    curRows[6] = "      d   k".padEnd(80, " ");
    const result = detect(
      ctx({
        prev: {
          rows: prevRows,
          status: status(),
          message: "",
          glyphClass: gridWith(prevRows, [{ x: 5, y: 6, cls: "pet" }]),
        },
        cur: {
          ...ctx().cur,
          rows: curRows,
          glyphClass: gridWith(curRows, [
            { x: 6, y: 6, cls: "pet" },
            { x: 10, y: 6, cls: "normal" },
          ]),
        },
      }),
    );
    expect(result).toBeTruthy();
    // detail names the kobold, not the pet.
    expect(typeof result === "string" ? result : "").toContain("k at (10,6)");
  });

  test("does NOT fire on letter changes in row 0 (message line)", () => {
    // Pre-fix bug: a game message starting with an uppercase letter (e.g.
    // "You see..." / "The kobold dies." / "Yipping noises...") would land
    // a `Y`/`T`/etc. at position (0, 0), which the detector flagged as
    // `monster_visible (Y at (0,0))` and aborted the autopilot. Map cells
    // are rows 1 .. rows.length-3 only.
    const prevRows = Array.from({ length: 24 }, () => " ".repeat(80));
    prevRows[0] = "It was a quiet turn.".padEnd(80, " ");
    const curRows = [...prevRows];
    curRows[0] = "You see here a kobold corpse.".padEnd(80, " ");
    const result = detect(
      ctx({
        prev: { rows: prevRows, status: status(), message: prevRows[0]!.trim() },
        cur: { ...ctx().cur, rows: curRows, message: curRows[0]!.trim() },
      }),
    );
    expect(result).toBe(false);
  });

  test("does NOT fire on letter changes in the bottom status rows", () => {
    // Status line letters (e.g. attribute changes "St:18 -> St:19", or
    // condition flags appearing) are not monsters.
    const prevRows = Array.from({ length: 24 }, () => " ".repeat(80));
    prevRows[22] = "Agent the Stripling  St:18".padEnd(80, " ");
    prevRows[23] = "Dlvl:1  HP:14(14)".padEnd(80, " ");
    const curRows = [...prevRows];
    curRows[22] = "Agent the Stripling  St:19".padEnd(80, " "); // St letter changed
    const result = detect(
      ctx({
        prev: { rows: prevRows, status: status(), message: "" },
        cur: { ...ctx().cur, rows: curRows },
      }),
    );
    expect(result).toBe(false);
  });
});

describe("new_item_visible (row restriction)", () => {
  const detect = INTERRUPTS.find((i) => i.name === "new_item_visible")!.detect;

  test("does NOT fire on item-glyph characters in row 0 (message text)", () => {
    // Messages routinely contain item characters: "(", ")", "?", "!" etc.
    // — they're punctuation in prose, not items on the map.
    const prevRows = Array.from({ length: 24 }, () => " ".repeat(80));
    prevRows[0] = "It was a quiet turn.".padEnd(80, " ");
    const curRows = [...prevRows];
    curRows[0] = "Welcome (again)?".padEnd(80, " ");
    const result = detect(
      ctx({
        prev: { rows: prevRows, status: status(), message: prevRows[0]!.trim() },
        cur: { ...ctx().cur, rows: curRows, message: curRows[0]!.trim() },
      }),
    );
    expect(result).toBe(false);
  });

  test("DOES fire on a real new item in a map row", () => {
    const prevRows = Array.from({ length: 24 }, () => " ".repeat(80));
    const curRows = [...prevRows];
    curRows[6] = "       (".padEnd(80, " "); // weapon at (7, 6)
    const result = detect(
      ctx({
        prev: { rows: prevRows, status: status(), message: "" },
        cur: { ...ctx().cur, rows: curRows },
      }),
    );
    expect(result).toBeTruthy();
  });
});

describe("entered_trap_tile and level_changed_unexpectedly", () => {
  test("entered_trap_tile fires when context flag is set", () => {
    const detect = INTERRUPTS.find((i) => i.name === "entered_trap_tile")!.detect;
    expect(detect(ctx({ enteredTrapTile: true }))).toBeTruthy();
    expect(detect(ctx({ enteredTrapTile: false }))).toBe(false);
  });

  test("level_changed_unexpectedly fires when context flag is set", () => {
    const detect = INTERRUPTS.find((i) => i.name === "level_changed_unexpectedly")!.detect;
    expect(
      detect(ctx({ unexpectedLevelChange: { from: "D1", to: "D2" } })),
    ).toBeTruthy();
    expect(detect(ctx())).toBe(false);
  });
});

describe("bell", () => {
  const detect = INTERRUPTS.find((i) => i.name === "bell")!.detect;
  test("fires when frameReason is 'bell'", () => {
    expect(detect(ctx({ cur: { ...ctx().cur, frameReason: "bell" } }))).toBeTruthy();
  });
  test("does not fire on cellChange", () => {
    expect(detect(ctx())).toBe(false);
  });
});

describe("runInterruptChecks", () => {
  test("returns null primary when nothing fires", () => {
    const result = runInterruptChecks(ctx());
    expect(result.primary).toBeNull();
    expect(result.also).toEqual([]);
  });

  test("returns the highest-priority match as primary", () => {
    // HP dropped (low priority) AND modal prompt visible (highest priority);
    // expect modal_prompt to be primary, hp_drop in `also`.
    const result = runInterruptChecks(
      ctx({
        prev: { rows: [], status: status({ hp: 14 }), message: "" },
        cur: { ...ctx().cur, status: status({ hp: 8 }), message: "Continue? [yn]" },
      }),
    );
    expect(result.primary?.name).toBe("modal_prompt");
    expect(result.also.map((i) => i.name)).toContain("hp_drop");
  });

  test("includes detail string when detect returns string", () => {
    const result = runInterruptChecks(
      ctx({
        prev: {
          rows: Array.from({ length: 24 }, () => " ".repeat(80)),
          status: status({ hp: 14 }),
          message: "",
        },
        cur: { ...ctx().cur, status: status({ hp: 8 }) },
      }),
    );
    // hp_drop detect returns a string detail like "14 → 8".
    expect(result.primary?.detail).toBeDefined();
  });
});

describe("modal_prompt", () => {
  const detect = INTERRUPTS.find((i) => i.name === "modal_prompt")!.detect;

  test("returns the message text as detail (not a bare true)", () => {
    // Production run bbh-20260508-201818-5c1ab1 returned a bare
    // "modal_prompt" stop reason; the user had to look at the
    // screen to know what was being prompted. Detail-as-text fixes
    // that.
    const c = ctx({
      cur: { ...ctx().cur, message: "Really quit without saving? [yn] (n)" },
    });
    expect(detect(c)).toBe("Really quit without saving? [yn] (n)");
  });

  test("--More-- pages return their message as detail too", () => {
    const c = ctx({ cur: { ...ctx().cur, message: "You hit the kobold.--More--" } });
    expect(detect(c)).toBe("You hit the kobold.--More--");
  });

  test("returns false when no modal pattern matches", () => {
    const c = ctx({ cur: { ...ctx().cur, message: "You walk east." } });
    expect(detect(c)).toBe(false);
  });
});

describe("engulfed", () => {
  // Build a 24-row buffer with a 3x3 glyph block painted at (cx, cy).
  // The block is given as a 3-line string ("/-\\\n|@|\n\\-/").
  function rowsWithBlock(cx: number, cy: number, block: string): string[] {
    const lines = block.split("\n");
    const rows = Array.from({ length: 24 }, () =>
      Array.from({ length: 80 }, () => " "),
    );
    for (let dy = 0; dy < lines.length; dy++) {
      const line = lines[dy]!;
      for (let dx = 0; dx < line.length; dx++) {
        rows[cy - 1 + dy]![cx - 1 + dx] = line[dx]!;
      }
    }
    return rows.map((r) => r.join(""));
  }

  const detect = INTERRUPTS.find((i) => i.name === "engulfed")!.detect;

  test("fires on the canonical /-\\ | @ | \\-/ swallower rendering", () => {
    const rows = rowsWithBlock(10, 10, "/-\\\n|@|\n\\-/");
    expect(detect(ctx({ cur: { ...ctx().cur, rows } }))).toBe(true);
  });

  test("does NOT fire on plain dungeon walls (regression for false-fire)", () => {
    // The shape that bit production runs on 2026-05-08: @ in a
    // small room with `-` walls top/bottom, `|` walls left/right.
    // Old heuristic matched corner '-' glyphs as engulfer corners.
    const rows = rowsWithBlock(10, 10, "---\n|@|\n---");
    expect(detect(ctx({ cur: { ...ctx().cur, rows } }))).toBe(false);
  });

  test("does NOT fire when @ is adjacent to a wall but not boxed", () => {
    // Very common: player walking along a corridor edge.
    const rows = rowsWithBlock(10, 10, "---\n.@.\n...");
    expect(detect(ctx({ cur: { ...ctx().cur, rows } }))).toBe(false);
  });

  test("does NOT fire on partial slash patterns (3 of 4 corners)", () => {
    // If only some slashes are present (e.g. mixed terrain), the
    // tightened heuristic must reject — the rendering is all-or-
    // nothing in real NetHack.
    const rows = rowsWithBlock(10, 10, "/-\\\n|@|\n---"); // bottom corners are dashes
    expect(detect(ctx({ cur: { ...ctx().cur, rows } }))).toBe(false);
  });

  test("does NOT fire when @ is in the first or last row (no above/below)", () => {
    // Edge case: @ at y=0 or y=23 has no above/below row — must
    // safely return false rather than read undefined.
    const rows = Array.from({ length: 24 }, () => " ".repeat(80));
    rows[0] = "         @          ".padEnd(80, " ");
    expect(detect(ctx({ cur: { ...ctx().cur, rows } }))).toBe(false);
  });
});

// Helper: build a full 24-row screen with `mapRowText` placed at row `y`
// inside the map area. Row 0 (message), rows 22-23 (status) blank.
function makeRowsWithMapLine(y: number, mapRowText: string): string[] {
  const blank80 = " ".repeat(80);
  const rows = Array.from({ length: 24 }, () => blank80);
  rows[y] = mapRowText.padEnd(80, " ");
  return rows;
}

describe("detectUnseenMonsterMarker", () => {
  test("returns false when no I is present in map rows", () => {
    const rows = makeRowsWithMapLine(5, "....@.....");
    expect(detectUnseenMonsterMarker(rows)).toBe(false);
  });

  test("returns the position of the first map I", () => {
    const rows = makeRowsWithMapLine(7, "....I....");
    expect(detectUnseenMonsterMarker(rows)).toEqual({ x: 4, y: 7 });
  });

  test("ignores I in row 0 (message line)", () => {
    const rows = makeRowsWithMapLine(0, "I see something here.");
    expect(detectUnseenMonsterMarker(rows)).toBe(false);
  });

  test("ignores I in status row", () => {
    const rows = Array.from({ length: 24 }, () => " ".repeat(80));
    // Last two rows are status.
    rows[22] = "Some I in status".padEnd(80, " ");
    rows[23] = "Another I row".padEnd(80, " ");
    expect(detectUnseenMonsterMarker(rows)).toBe(false);
  });

  test("rejects I sandwiched between letters (word context)", () => {
    const rows = makeRowsWithMapLine(5, "..aIb..");
    expect(detectUnseenMonsterMarker(rows)).toBe(false);
  });
});

describe("detectWarningDigit", () => {
  test("returns false when no warning digit is present", () => {
    const rows = makeRowsWithMapLine(5, "....@.....");
    expect(detectWarningDigit(rows)).toBe(false);
  });

  test("returns tier 4 for a single '4' on the map", () => {
    const rows = makeRowsWithMapLine(7, ".....4....");
    expect(detectWarningDigit(rows)).toEqual({ tier: 4, x: 5, y: 7 });
  });

  test("returns highest tier when multiple digits present", () => {
    // Multi-row map: tier 2 at row 5, tier 5 at row 7. Should pick the 5.
    const blank = " ".repeat(80);
    const rows = Array.from({ length: 24 }, () => blank);
    rows[5] = "..2.....".padEnd(80, " ");
    rows[7] = "....5...".padEnd(80, " ");
    const out = detectWarningDigit(rows);
    expect(out).not.toBe(false);
    if (out !== false) {
      expect(out.tier).toBe(5);
    }
  });

  test("ignores digits in message line", () => {
    const rows = makeRowsWithMapLine(0, "T:1234 turns elapsed");
    expect(detectWarningDigit(rows)).toBe(false);
  });

  test("rejects digit sandwiched between digits, returns highest non-sandwiched", () => {
    // Pattern "..234.." — the middle '3' is sandwiched (left=2, right=4)
    // and gets rejected. The '2' (left=., right=3) and '4' (left=3,
    // right=.) qualify. Detector returns the highest tier — '4'.
    const rows = makeRowsWithMapLine(5, "..234..");
    const out = detectWarningDigit(rows);
    expect(out).toEqual({ tier: 4, x: 4, y: 5 });
  });

  test("digit '0' is not a warning (out of 1..5 range)", () => {
    const rows = makeRowsWithMapLine(5, ".0.");
    expect(detectWarningDigit(rows)).toBe(false);
  });

  test("digit '6' or higher is not a warning", () => {
    const rows = makeRowsWithMapLine(5, ".7.");
    expect(detectWarningDigit(rows)).toBe(false);
  });
});

describe("warning_high interrupt", () => {
  const detect = INTERRUPTS.find((i) => i.name === "warning_high")!.detect;

  test("fires when a tier-4 digit appears that wasn't present in prev frame", () => {
    const prevRows = makeRowsWithMapLine(5, "....@.....");
    const curRows = makeRowsWithMapLine(5, "....@4....");
    const result = detect(
      ctx({
        prev: { rows: prevRows, status: status(), message: "" },
        cur: { ...ctx().cur, rows: curRows },
      }),
    );
    expect(result).toBeTruthy();
  });

  test("fires on tier-5 digit", () => {
    const curRows = makeRowsWithMapLine(7, ".5.");
    const result = detect(
      ctx({
        cur: { ...ctx().cur, rows: curRows },
      }),
    );
    expect(result).toBeTruthy();
  });

  test("does NOT fire on tier-3 digit (gating threshold is 4)", () => {
    const curRows = makeRowsWithMapLine(7, ".3.");
    const result = detect(
      ctx({
        cur: { ...ctx().cur, rows: curRows },
      }),
    );
    expect(result).toBe(false);
  });

  test("does NOT fire when same tier-4 digit was at the same position last frame", () => {
    const rows = makeRowsWithMapLine(7, ".4.");
    const result = detect(
      ctx({
        prev: { rows, status: status(), message: "" },
        cur: { ...ctx().cur, rows },
      }),
    );
    expect(result).toBe(false);
  });
});

describe("unseen_monster_visible interrupt", () => {
  const detect = INTERRUPTS.find((i) => i.name === "unseen_monster_visible")!.detect;

  test("fires when an I appears that wasn't present in prev frame", () => {
    const prevRows = makeRowsWithMapLine(5, "....@.....");
    const curRows = makeRowsWithMapLine(5, "....@.I...");
    const result = detect(
      ctx({
        prev: { rows: prevRows, status: status(), message: "" },
        cur: { ...ctx().cur, rows: curRows },
      }),
    );
    expect(result).toBeTruthy();
  });

  test("does NOT fire when same I was at same position last frame", () => {
    const rows = makeRowsWithMapLine(7, ".I.");
    const result = detect(
      ctx({
        prev: { rows, status: status(), message: "" },
        cur: { ...ctx().cur, rows },
      }),
    );
    expect(result).toBe(false);
  });
});

describe("MODAL_PATTERNS extensions for v2", () => {
  const detect = INTERRUPTS.find((i) => i.name === "modal_prompt")!.detect;

  test("fires on `[yes]` paranoid-Confirm prompt", () => {
    expect(
      detect(
        ctx({
          cur: { ...ctx().cur, message: "Really attack? [yes/no] (no)" },
        }),
      ),
    ).toBeTruthy();
  });

  test("fires on `[no]` (lowercase no in confirmation)", () => {
    expect(
      detect(
        ctx({
          cur: { ...ctx().cur, message: "Sure? [no/yes]" },
        }),
      ),
    ).toBeTruthy();
  });

  test("fires on full What-do-you-want-to-eat? prompt", () => {
    expect(
      detect(
        ctx({
          cur: { ...ctx().cur, message: "What do you want to eat?" },
        }),
      ),
    ).toBeTruthy();
  });

  test("fires on What-do-you-want-to-name? prompt", () => {
    expect(
      detect(
        ctx({
          cur: { ...ctx().cur, message: "What do you want to name?" },
        }),
      ),
    ).toBeTruthy();
  });

  test("fires on What-do-you-want-to-sacrifice? prompt", () => {
    expect(
      detect(
        ctx({
          cur: { ...ctx().cur, message: "What do you want to sacrifice?" },
        }),
      ),
    ).toBeTruthy();
  });
});
