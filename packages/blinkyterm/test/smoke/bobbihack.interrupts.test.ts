import { describe, expect, test } from "bun:test";
import {
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
