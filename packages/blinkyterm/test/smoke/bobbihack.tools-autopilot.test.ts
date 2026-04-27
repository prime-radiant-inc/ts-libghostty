// Tests for Phase 6 + 7 autopilot tools — autopilot_to (point-to-point
// pathfinding) and autopilot_explore (frontier-policy exploration).

import { describe, expect, test } from "bun:test";
import {
  handleAutopilotTo,
  handleAutopilotExplore,
} from "../../examples/bobbihack/tools/autopilot";
import { GameMap } from "../../examples/bobbihack/game-map";
import { TOOL_RESULT_HEADER } from "../../examples/bobbihack/tool-result";
import type { StatusLine } from "../../examples/bobbihack/parsers";
import type { ToolContext } from "../../examples/bobbihack/tool-context";

// ---------------------------------------------------------------------------
// Test fixtures: build synthetic 80x24 frames with a controlled map.

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

const COLS = 80;
const ROWS = 24;

// Build a 24-row buffer initialised with spaces. Pass cells to overwrite
// per row. Row 0 is the message line, rows 22-23 are status lines, the
// rest are map.
function buildRows(cells: { x: number; y: number; ch: string }[]): string[] {
  const rows: string[][] = Array.from({ length: ROWS }, () =>
    Array.from({ length: COLS }, () => " "),
  );
  for (const { x, y, ch } of cells) {
    if (y >= 0 && y < ROWS && x >= 0 && x < COLS) {
      rows[y]![x] = ch;
    }
  }
  return rows.map((r) => r.join(""));
}

// ---------------------------------------------------------------------------
// Mock ToolContext.

type MockTurn =
  | { rows: string[]; status?: StatusLine; message?: string; frameReason?: string }
  | { rows: string[]; status?: StatusLine; message?: string; frameReason?: string; mutateAfter?: () => void };

interface MockOpts {
  // Initial map state — applied as a "seed" frame BEFORE any sendKeys.
  seed?: { rows: string[]; status?: StatusLine; message?: string };
  // Per-step turn descriptions returned by sendKeysAndWait.
  turns: MockTurn[];
  abortAfter?: number;
}

function mockCtx(opts: MockOpts): {
  ctx: ToolContext;
  sentKeys: string[];
  map: GameMap;
} {
  const sentKeys: string[] = [];
  const map = new GameMap();
  const ac = new AbortController();
  let stepIdx = 0;

  if (opts.seed !== undefined) {
    const s = opts.seed.status ?? status();
    map.updateFromFrame(opts.seed.rows, s, opts.seed.message ?? "");
  }

  const ctx: ToolContext = {
    map,
    runState: { gameOver: false, endReason: null },
    signal: ac.signal,
    sendKeysAndWait: async (keys: string) => {
      sentKeys.push(keys);
      const turn = opts.turns[stepIdx];
      if (turn === undefined) {
        throw new Error(
          `mockCtx: ran out of scripted turns (sent ${sentKeys.length} keys)`,
        );
      }
      stepIdx += 1;
      const s = turn.status ?? status({ turn: stepIdx + 1 });
      const message = turn.message ?? "";
      const frameReason = turn.frameReason ?? "cellChange";
      const screenAnsi = turn.rows.join("\n");
      map.updateFromFrame(turn.rows, s, message);
      if ("mutateAfter" in turn && turn.mutateAfter !== undefined) {
        turn.mutateAfter();
      }
      if (opts.abortAfter !== undefined && stepIdx >= opts.abortAfter) {
        ac.abort();
      }
      return { rows: turn.rows, status: s, message, frameReason, screenAnsi };
    },
  };
  return { ctx, sentKeys, map };
}

// Place the player at (x, y) on a horizontal floor strip from x0..x1, y.
function corridorRows(
  px: number,
  py: number,
  x0: number,
  x1: number,
  extras: { x: number; y: number; ch: string }[] = [],
): string[] {
  const cells: { x: number; y: number; ch: string }[] = [];
  for (let x = x0; x <= x1; x++) cells.push({ x, y: py, ch: "." });
  cells.push({ x: px, y: py, ch: "@" });
  cells.push(...extras);
  return buildRows(cells);
}

// ---------------------------------------------------------------------------
// autopilot_to

describe("handleAutopilotTo", () => {
  test("walks a known straight corridor east and reports arrival", async () => {
    // Map seeded with player at (10, 5), corridor east through (15, 5).
    const seedRows = corridorRows(10, 5, 10, 15);
    // Five eastward steps; player at (11..15, 5) per step.
    const turns: MockTurn[] = [];
    for (let i = 1; i <= 5; i++) {
      turns.push({ rows: corridorRows(10 + i, 5, 10, 15) });
    }
    const { ctx, sentKeys } = mockCtx({ seed: { rows: seedRows }, turns });
    const out = await handleAutopilotTo({ floor: "D1", x: 15, y: 5 }, ctx);
    expect(sentKeys).toEqual(["l", "l", "l", "l", "l"]);
    expect(out).toContain(TOOL_RESULT_HEADER);
    expect(out).toContain("autopilot_to(D1,15,5): arrived after 5 steps");
  });

  test("rejects malformed args", async () => {
    const seedRows = corridorRows(10, 5, 10, 15);
    const { ctx, sentKeys } = mockCtx({ seed: { rows: seedRows }, turns: [] });
    const out1 = await handleAutopilotTo({ floor: "D1", x: 15 } as any, ctx);
    expect(out1).toContain("error");
    const out2 = await handleAutopilotTo({} as any, ctx);
    expect(out2).toContain("error");
    expect(sentKeys).toEqual([]);
  });

  test("returns error 'unknown floor' when target floor not visited", async () => {
    const seedRows = corridorRows(10, 5, 10, 15);
    const { ctx, sentKeys } = mockCtx({ seed: { rows: seedRows }, turns: [] });
    const out = await handleAutopilotTo({ floor: "D5", x: 5, y: 5 }, ctx);
    expect(out).toContain("unknown floor");
    expect(sentKeys).toEqual([]);
  });

  test("returns error 'unknown tile' when target not on map", async () => {
    const seedRows = corridorRows(10, 5, 10, 15);
    const { ctx, sentKeys } = mockCtx({ seed: { rows: seedRows }, turns: [] });
    const out = await handleAutopilotTo({ floor: "D1", x: 50, y: 12 }, ctx);
    expect(out).toContain("unknown tile");
    expect(sentKeys).toEqual([]);
  });

  test("returns error 'no path' when goal unreachable", async () => {
    // Player at (10,5); goal at (12,5) but a wall sits between.
    const seedRows = buildRows([
      { x: 10, y: 5, ch: "@" },
      { x: 11, y: 5, ch: "|" }, // wall blocks
      { x: 12, y: 5, ch: "." },
    ]);
    const { ctx, sentKeys } = mockCtx({ seed: { rows: seedRows }, turns: [] });
    const out = await handleAutopilotTo({ floor: "D1", x: 12, y: 5 }, ctx);
    expect(out).toContain("no path");
    expect(sentKeys).toEqual([]);
  });

  test("refuses Sokoban floors", async () => {
    // Force floor id to include "Sokoban" via the branch detector.
    const seedRows = corridorRows(10, 5, 10, 15);
    const { ctx, sentKeys, map } = mockCtx({
      seed: {
        rows: seedRows,
        message: "Welcome to Sokoban!",
      },
      turns: [],
    });
    expect(map.current).toContain("Sokoban");
    const out = await handleAutopilotTo({ floor: map.current!, x: 15, y: 5 }, ctx);
    expect(out.toLowerCase()).toContain("sokoban");
    expect(sentKeys).toEqual([]);
  });

  test("refuses Rogue level floors", async () => {
    const seedRows = corridorRows(10, 5, 10, 15);
    const { ctx, sentKeys, map } = mockCtx({
      seed: {
        rows: seedRows,
        message: "You enter what seems to be an older, more primitive world.",
      },
      turns: [],
    });
    const floor = map.floors.get(map.current!)!;
    expect(floor.isRogueLevel).toBe(true);
    const out = await handleAutopilotTo({ floor: map.current!, x: 15, y: 5 }, ctx);
    expect(out.toLowerCase()).toContain("rogue");
    expect(sentKeys).toEqual([]);
  });

  test("refuses walkability-suspect floors", async () => {
    const seedRows = corridorRows(10, 5, 10, 15);
    const { ctx, sentKeys, map } = mockCtx({
      seed: {
        rows: seedRows,
        message: "You suddenly turn into a frog.",
      },
      turns: [],
    });
    const floor = map.floors.get(map.current!)!;
    expect(floor.walkabilitySuspect).toBe(true);
    const out = await handleAutopilotTo({ floor: map.current!, x: 15, y: 5 }, ctx);
    expect(out.toLowerCase()).toMatch(/suspect|polymorph/);
    expect(sentKeys).toEqual([]);
  });

  test("trap-protection: refuses to plan through known trap", async () => {
    // Player at (10,5), goal at (15,5), but (12,5) is a known trap.
    const seedRows = buildRows([
      ...Array.from({ length: 6 }, (_, i) => ({
        x: 10 + i,
        y: 5,
        ch: i === 2 ? "^" : ".",
      })),
      { x: 10, y: 5, ch: "@" },
    ]);
    const { ctx, sentKeys } = mockCtx({ seed: { rows: seedRows }, turns: [] });
    const out = await handleAutopilotTo({ floor: "D1", x: 15, y: 5 }, ctx);
    expect(out).toContain("no path");
    expect(sentKeys).toEqual([]);
  });

  test("entered_trap_tile interrupt fires when next step reveals a trap mid-traversal", async () => {
    // Player at (10,5); corridor east to (15,5). Step 1 succeeds; step 2's
    // frame reveals a trap on the now-current tile.
    const seedRows = corridorRows(10, 5, 10, 15);
    // Step 1: player moved to (11,5). Step 2's resulting frame: player at
    // (12,5) and the message reveals a trap (the autopilot detects this
    // post-step via `enteredTrapTile`).
    const turns: MockTurn[] = [
      { rows: corridorRows(11, 5, 10, 15) },
      // Now (12,5) is a trap underneath the player. Mark it via glyph.
      // After the player @ overwrites, the GameMap records the underlying
      // tile via inference; we expose trap_known by including a ^ glyph
      // visible elsewhere prior. Instead test the "next planned tile is
      // now classified trap_known" case: pre-mark (13,5) as a trap by
      // sending a frame where it shows.
      {
        rows: buildRows([
          { x: 10, y: 5, ch: "." },
          { x: 11, y: 5, ch: "." },
          { x: 12, y: 5, ch: "@" }, // player here
          { x: 13, y: 5, ch: "^" }, // trap revealed!
          { x: 14, y: 5, ch: "." },
          { x: 15, y: 5, ch: "." },
        ]),
      },
    ];
    const { ctx, sentKeys } = mockCtx({ seed: { rows: seedRows }, turns });
    const out = await handleAutopilotTo({ floor: "D1", x: 15, y: 5 }, ctx);
    expect(sentKeys.length).toBeGreaterThanOrEqual(1);
    expect(sentKeys.length).toBeLessThan(5);
    expect(out).toContain("entered_trap_tile");
  });

  test("step cap default 50 — stops at cap if path is longer", async () => {
    // Build a long corridor of length 60. Cap should fire at 50.
    const startRows = buildRows([
      ...Array.from({ length: 60 }, (_, i) => ({ x: 5 + i, y: 5, ch: "." })),
      { x: 5, y: 5, ch: "@" },
    ]);
    const turns: MockTurn[] = [];
    for (let i = 1; i <= 60; i++) {
      turns.push({
        rows: buildRows([
          ...Array.from({ length: 60 }, (_, j) => ({
            x: 5 + j,
            y: 5,
            ch: ".",
          })),
          { x: 5 + i, y: 5, ch: "@" },
        ]),
      });
    }
    const { ctx, sentKeys } = mockCtx({ seed: { rows: startRows }, turns });
    const out = await handleAutopilotTo({ floor: "D1", x: 64, y: 5 }, ctx);
    expect(sentKeys.length).toBe(50);
    expect(out).toContain("step_cap");
  });

  test("custom step cap honored", async () => {
    const seedRows = corridorRows(10, 5, 10, 30);
    const turns: MockTurn[] = [];
    for (let i = 1; i <= 20; i++) {
      turns.push({ rows: corridorRows(10 + i, 5, 10, 30) });
    }
    const { ctx, sentKeys } = mockCtx({ seed: { rows: seedRows }, turns });
    const out = await handleAutopilotTo(
      { floor: "D1", x: 30, y: 5, stepCap: 5 },
      ctx,
    );
    expect(sentKeys.length).toBe(5);
    expect(out).toContain("step_cap");
  });

  test("monster_visible interrupt halts traversal", async () => {
    const seedRows = corridorRows(10, 5, 10, 15);
    const turns: MockTurn[] = [
      { rows: corridorRows(11, 5, 10, 15) },
      // A monster 'k' (kobold) appears at (14, 5).
      {
        rows: buildRows([
          ...Array.from({ length: 6 }, (_, i) => ({ x: 10 + i, y: 5, ch: "." })),
          { x: 12, y: 5, ch: "@" },
          { x: 14, y: 5, ch: "k" },
        ]),
      },
    ];
    const { ctx, sentKeys } = mockCtx({ seed: { rows: seedRows }, turns });
    const out = await handleAutopilotTo({ floor: "D1", x: 15, y: 5 }, ctx);
    expect(sentKeys.length).toBe(2);
    expect(out).toContain("monster_visible");
  });

  test("modal_prompt interrupt halts traversal", async () => {
    const seedRows = corridorRows(10, 5, 10, 15);
    const turns: MockTurn[] = [
      {
        rows: corridorRows(11, 5, 10, 15),
        message: "Continue? [yn]",
      },
    ];
    const { ctx, sentKeys } = mockCtx({ seed: { rows: seedRows }, turns });
    const out = await handleAutopilotTo({ floor: "D1", x: 15, y: 5 }, ctx);
    expect(sentKeys.length).toBe(1);
    expect(out).toContain("modal_prompt");
  });

  test("hp_drop interrupt halts traversal", async () => {
    const seedRows = corridorRows(10, 5, 10, 15);
    // hp_drop needs a previous frame inside the autopilot loop, so the
    // first step is the "warmup" (full HP) and the second step's frame
    // shows the HP drop.
    const turns: MockTurn[] = [
      { rows: corridorRows(11, 5, 10, 15), status: status({ turn: 2, hp: 14 }) },
      {
        rows: corridorRows(12, 5, 10, 15),
        status: status({ hp: 10, turn: 3 }), // dropped 14 → 10
      },
    ];
    const { ctx, sentKeys } = mockCtx({ seed: { rows: seedRows }, turns });
    const out = await handleAutopilotTo({ floor: "D1", x: 15, y: 5 }, ctx);
    expect(sentKeys.length).toBe(2);
    expect(out).toContain("hp_drop");
  });

  test("abort_signal interrupt halts traversal", async () => {
    const seedRows = corridorRows(10, 5, 10, 15);
    const turns: MockTurn[] = [];
    for (let i = 1; i <= 5; i++) {
      turns.push({ rows: corridorRows(10 + i, 5, 10, 15) });
    }
    const { ctx, sentKeys } = mockCtx({
      seed: { rows: seedRows },
      turns,
      abortAfter: 2,
    });
    const out = await handleAutopilotTo({ floor: "D1", x: 15, y: 5 }, ctx);
    expect(sentKeys.length).toBe(2);
    expect(out).toContain("abort_signal");
  });

  test("can land on stairs but does not descend (only sends compass keys)", async () => {
    // Player at (10,5); stairs at (12,5). Walk to stairs.
    const seedRows = buildRows([
      { x: 10, y: 5, ch: "@" },
      { x: 11, y: 5, ch: "." },
      { x: 12, y: 5, ch: ">" },
    ]);
    const turns: MockTurn[] = [
      {
        rows: buildRows([
          { x: 10, y: 5, ch: "." },
          { x: 11, y: 5, ch: "@" },
          { x: 12, y: 5, ch: ">" },
        ]),
      },
      {
        rows: buildRows([
          { x: 10, y: 5, ch: "." },
          { x: 11, y: 5, ch: "." },
          { x: 12, y: 5, ch: "@" },
        ]),
      },
    ];
    const { ctx, sentKeys } = mockCtx({ seed: { rows: seedRows }, turns });
    const out = await handleAutopilotTo({ floor: "D1", x: 12, y: 5 }, ctx);
    expect(sentKeys).toEqual(["l", "l"]);
    // Verify no '>' or '<' was ever sent.
    expect(sentKeys.every((k) => k !== ">" && k !== "<")).toBe(true);
    expect(out).toContain("arrived after 2 steps");
  });

  test("path-step deltas map to correct vi-keys (8-connectivity)", async () => {
    // Diagonal southeast move.
    const seedRows = buildRows([
      { x: 5, y: 5, ch: "@" },
      { x: 6, y: 6, ch: "." },
    ]);
    const turns: MockTurn[] = [
      {
        rows: buildRows([
          { x: 5, y: 5, ch: "." },
          { x: 6, y: 6, ch: "@" },
        ]),
      },
    ];
    const { ctx, sentKeys } = mockCtx({ seed: { rows: seedRows }, turns });
    await handleAutopilotTo({ floor: "D1", x: 6, y: 6 }, ctx);
    expect(sentKeys).toEqual(["n"]); // SE
  });

  test("noop when goal equals start position", async () => {
    const seedRows = corridorRows(10, 5, 10, 15);
    const { ctx, sentKeys } = mockCtx({ seed: { rows: seedRows }, turns: [] });
    const out = await handleAutopilotTo({ floor: "D1", x: 10, y: 5 }, ctx);
    expect(sentKeys).toEqual([]);
    expect(out).toContain("arrived after 0 steps");
  });
});

// ---------------------------------------------------------------------------
// autopilot_explore

describe("handleAutopilotExplore", () => {
  test("walks an unexplored corridor east, then halts on no-frontier", async () => {
    // Seed: player at (10,5); only this tile and the immediate neighbors
    // visible to the right (11..14 are walkable, 15 is not visible/unknown).
    // After stepping east, more frontier appears.
    // We'll script a simple unfolding corridor.
    const initial = buildRows([
      { x: 10, y: 5, ch: "@" },
      { x: 11, y: 5, ch: "." }, // visible adjacent
    ]);
    // Each step reveals one more tile to the east (typical NetHack visibility
    // expansion).
    const turns: MockTurn[] = [
      // After step 1 (east): now at (11,5); can see (12,5).
      {
        rows: buildRows([
          { x: 10, y: 5, ch: "." },
          { x: 11, y: 5, ch: "@" },
          { x: 12, y: 5, ch: "." },
        ]),
      },
      // After step 2: now at (12,5); can see (13,5).
      {
        rows: buildRows([
          { x: 10, y: 5, ch: "." },
          { x: 11, y: 5, ch: "." },
          { x: 12, y: 5, ch: "@" },
          { x: 13, y: 5, ch: "." },
        ]),
      },
      // After step 3: now at (13,5); no new tiles visible — frontier exhausted.
      {
        rows: buildRows([
          { x: 10, y: 5, ch: "." },
          { x: 11, y: 5, ch: "." },
          { x: 12, y: 5, ch: "." },
          { x: 13, y: 5, ch: "@" },
        ]),
      },
    ];
    const { ctx, sentKeys } = mockCtx({ seed: { rows: initial }, turns });
    const out = await handleAutopilotExplore({}, ctx);
    expect(sentKeys.length).toBeGreaterThanOrEqual(2);
    // The trailing summary should report some kind of stop reason.
    expect(out).toContain(TOOL_RESULT_HEADER);
    expect(out).toMatch(/autopilot_explore: \d+ steps/);
  });

  test("refuses Sokoban floors", async () => {
    const seedRows = corridorRows(10, 5, 10, 15);
    const { ctx, sentKeys, map } = mockCtx({
      seed: { rows: seedRows, message: "Welcome to Sokoban!" },
      turns: [],
    });
    expect(map.current).toContain("Sokoban");
    const out = await handleAutopilotExplore({}, ctx);
    expect(out.toLowerCase()).toContain("sokoban");
    expect(sentKeys).toEqual([]);
  });

  test("refuses Rogue level floors", async () => {
    const seedRows = corridorRows(10, 5, 10, 15);
    const { ctx, sentKeys } = mockCtx({
      seed: {
        rows: seedRows,
        message: "You enter what seems to be an older, more primitive world.",
      },
      turns: [],
    });
    const out = await handleAutopilotExplore({}, ctx);
    expect(out.toLowerCase()).toContain("rogue");
    expect(sentKeys).toEqual([]);
  });

  test("refuses walkability-suspect floors", async () => {
    const seedRows = corridorRows(10, 5, 10, 15);
    const { ctx, sentKeys } = mockCtx({
      seed: { rows: seedRows, message: "You suddenly turn into a frog." },
      turns: [],
    });
    const out = await handleAutopilotExplore({}, ctx);
    expect(out.toLowerCase()).toMatch(/suspect|polymorph/);
    expect(sentKeys).toEqual([]);
  });

  test("returns 'explored entire known map' when no frontier exists", async () => {
    // Tiny enclosed room: walls all around.
    const seedRows = buildRows([
      { x: 10, y: 5, ch: "-" },
      { x: 11, y: 5, ch: "-" },
      { x: 12, y: 5, ch: "-" },
      { x: 10, y: 6, ch: "|" },
      { x: 11, y: 6, ch: "@" },
      { x: 12, y: 6, ch: "|" },
      { x: 10, y: 7, ch: "-" },
      { x: 11, y: 7, ch: "-" },
      { x: 12, y: 7, ch: "-" },
    ]);
    const { ctx, sentKeys } = mockCtx({ seed: { rows: seedRows }, turns: [] });
    const out = await handleAutopilotExplore({}, ctx);
    expect(sentKeys.length).toBe(0);
    expect(out).toMatch(/explored entire known map|fully_explored/);
  });

  test("step cap default 50 honored", async () => {
    // Long corridor: 60 tiles east.
    const seedCells: { x: number; y: number; ch: string }[] = [];
    for (let i = 0; i < 60; i++) seedCells.push({ x: 5 + i, y: 5, ch: "." });
    seedCells.push({ x: 5, y: 5, ch: "@" });
    const seedRows = buildRows(seedCells);
    // Each step: player moves east, no new frontier — the 60-long corridor
    // is fully visible from the start, so the policy should... actually,
    // since all is visible, there's no "unvisited" frontier. But adjacent
    // tiles are still marked as having `walkable: yes` and the player
    // hasn't been to them. The exploration policy considers a tile
    // "unvisited" if the player hasn't stood on it.
    //
    // We need to test the cap, so set up a scenario where the policy
    // keeps stepping. Simplest: each step's frame is a brand-new "fresh"
    // corridor segment (so frontier always exists).
    const turns: MockTurn[] = [];
    for (let i = 1; i <= 60; i++) {
      const cells: { x: number; y: number; ch: string }[] = [];
      for (let j = 0; j < 60 + i; j++) cells.push({ x: 5 + j, y: 5, ch: "." });
      cells.push({ x: 5 + i, y: 5, ch: "@" });
      turns.push({ rows: buildRows(cells) });
    }
    const { ctx, sentKeys } = mockCtx({
      seed: { rows: seedRows },
      turns,
    });
    const out = await handleAutopilotExplore({}, ctx);
    expect(sentKeys.length).toBe(50);
    expect(out).toContain("step_cap");
  });

  test("custom step cap honored", async () => {
    const seedCells: { x: number; y: number; ch: string }[] = [];
    for (let i = 0; i < 30; i++) seedCells.push({ x: 5 + i, y: 5, ch: "." });
    seedCells.push({ x: 5, y: 5, ch: "@" });
    const seedRows = buildRows(seedCells);
    const turns: MockTurn[] = [];
    for (let i = 1; i <= 10; i++) {
      const cells: { x: number; y: number; ch: string }[] = [];
      for (let j = 0; j < 30 + i; j++) cells.push({ x: 5 + j, y: 5, ch: "." });
      cells.push({ x: 5 + i, y: 5, ch: "@" });
      turns.push({ rows: buildRows(cells) });
    }
    const { ctx, sentKeys } = mockCtx({ seed: { rows: seedRows }, turns });
    const out = await handleAutopilotExplore({ stepCap: 3 }, ctx);
    expect(sentKeys.length).toBe(3);
    expect(out).toContain("step_cap");
  });

  test("never steps onto known trap tile", async () => {
    // Player at (10,5); to the east at (11,5) is a known trap. To the south
    // is a normal floor. The policy should pick south, not east.
    const seedRows = buildRows([
      { x: 10, y: 5, ch: "@" },
      { x: 11, y: 5, ch: "^" }, // trap
      { x: 10, y: 6, ch: "." }, // floor
    ]);
    const turns: MockTurn[] = [
      {
        rows: buildRows([
          { x: 10, y: 5, ch: "." },
          { x: 11, y: 5, ch: "^" },
          { x: 10, y: 6, ch: "@" },
        ]),
      },
    ];
    const { ctx, sentKeys } = mockCtx({ seed: { rows: seedRows }, turns });
    await handleAutopilotExplore({ stepCap: 1 }, ctx);
    // First key should be 'j' (south), not 'l' (east into trap).
    expect(sentKeys[0]).toBe("j");
  });

  test("monster_visible interrupt halts exploration", async () => {
    // monster_visible needs a prev frame in the loop; first step is
    // "warmup" (no prev), second step's frame introduces the monster.
    const seedRows = buildRows([
      { x: 10, y: 5, ch: "@" },
      { x: 11, y: 5, ch: "." },
      { x: 12, y: 5, ch: "." },
      { x: 13, y: 5, ch: "." },
      { x: 14, y: 5, ch: "." },
    ]);
    const turns: MockTurn[] = [
      {
        rows: buildRows([
          { x: 10, y: 5, ch: "." },
          { x: 11, y: 5, ch: "@" },
          { x: 12, y: 5, ch: "." },
          { x: 13, y: 5, ch: "." },
          { x: 14, y: 5, ch: "." },
        ]),
      },
      {
        rows: buildRows([
          { x: 10, y: 5, ch: "." },
          { x: 11, y: 5, ch: "." },
          { x: 12, y: 5, ch: "@" },
          { x: 13, y: 5, ch: "." },
          { x: 14, y: 5, ch: "k" },
        ]),
      },
    ];
    const { ctx, sentKeys } = mockCtx({ seed: { rows: seedRows }, turns });
    const out = await handleAutopilotExplore({}, ctx);
    expect(sentKeys.length).toBe(2);
    expect(out).toContain("monster_visible");
  });
});
