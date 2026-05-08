// Fixture-driven autopilot navigation tests.
//
// Built so we can prove navigation works on a variety of map shapes
// without burning $1-5 per attempt against a live model + NetHack
// engine. The harness:
//
//   1. parseFixture()  — ASCII map → row buffer + player start + door
//                        / goal coords. A 1-line "ASCII map" plus a
//                        few bookkeeping fields = one test case.
//
//   2. createFakeEngine() — implements just enough NetHack semantics
//                           to drive the autopilot: walls bump,
//                           floor walks, closed doors auto-open,
//                           locked doors refuse with the canonical
//                           "The door is locked." message.
//
//   3. runAutopilotTo / runAutopilotExplore — wire the engine to a
//                                              ToolContext, run the
//                                              tool, and return a
//                                              structured result the
//                                              tests assert on.
//
// What this harness IS NOT:
//   - A full NetHack simulator. Monsters don't move, items don't
//     exist, hunger/HP don't tick. We model terrain transitions only.
//   - A replacement for live runs. Engine quirks (mimics, polymorph
//     side-effects, paranoid_swap prompts, peaceful blocking) still
//     need real NetHack to surface. This harness catches the much
//     more common pathfinding / control-flow bugs.

import { describe, expect, test } from "bun:test";
import {
  handleAutopilotTo,
  handleAutopilotExplore,
} from "../../examples/bobbihack/tools/autopilot";
import { GameMap } from "../../examples/bobbihack/game-map";
import type { StatusLine } from "../../examples/bobbihack/parsers";
import type { ToolContext, FrameAwaitResult } from "../../examples/bobbihack/tool-context";

// ---------------------------------------------------------------------------
// Fixture parsing.
//
// A fixture is an ASCII map. Standard NetHack glyphs:
//   .  floor       #  corridor    |/-  walls       +  closed door
//   '  open door   <  stairs up   >    stairs down ^  trap
//   `  boulder     {  fountain    _    altar
// Plus harness-specific markers:
//   @  player start  (exactly one required)
//   *  goal marker   (used by autopilot_to tests; replaced with '.')
//
// Locked doors and "unwalkable terrain the engine reveals on bump"
// are specified out of band via the FixtureSpec.

interface FixtureSpec {
  map: string;
  /** Doors at these (x,y) refuse to open; engine emits "The door is locked." */
  lockedDoors?: Array<readonly [number, number]>;
}

interface Fixture {
  rows: string[];           // Padded 80x24 buffer.
  start: { x: number; y: number };
  goal: { x: number; y: number } | null;  // From '*' marker, if any.
  lockedDoors: Set<string>; // "x,y" coords.
}

function parseFixture(spec: FixtureSpec): Fixture {
  const lines = spec.map.split("\n");
  // Strip leading/trailing blank lines for human-friendly indentation.
  while (lines.length > 0 && lines[0]!.trim() === "") lines.shift();
  while (lines.length > 0 && lines[lines.length - 1]!.trim() === "") lines.pop();

  let start: { x: number; y: number } | null = null;
  let goal: { x: number; y: number } | null = null;

  // Build padded 80x24 buffer.
  const COLS = 80;
  const ROWS = 24;
  const buf: string[][] = Array.from({ length: ROWS }, () =>
    Array.from({ length: COLS }, () => " "),
  );
  for (let y = 0; y < lines.length && y < ROWS; y++) {
    const line = lines[y]!;
    for (let x = 0; x < line.length && x < COLS; x++) {
      const ch = line[x]!;
      if (ch === "@") {
        if (start !== null) {
          throw new Error(`fixture: multiple '@' markers (already at (${start.x},${start.y}))`);
        }
        start = { x, y };
        buf[y]![x] = "@";
      } else if (ch === "*") {
        if (goal !== null) {
          throw new Error(`fixture: multiple '*' markers`);
        }
        goal = { x, y };
        buf[y]![x] = ".";
      } else {
        buf[y]![x] = ch;
      }
    }
  }
  if (start === null) throw new Error(`fixture: missing '@' player marker`);

  const lockedDoors = new Set<string>();
  for (const [x, y] of spec.lockedDoors ?? []) {
    lockedDoors.add(`${x},${y}`);
  }

  return {
    rows: buf.map((r) => r.join("")),
    start,
    goal,
    lockedDoors,
  };
}

// Test-only: re-export the per-step event shape so tests can spread
// it into assertions without re-writing the type.
type StepEvent = Parameters<NonNullable<ToolContext["logAutopilotStep"]>>[0];

// ---------------------------------------------------------------------------
// Fake engine.

const VI_KEY_TO_DELTA: Record<string, readonly [number, number]> = {
  y: [-1, -1], k: [0, -1], u: [1, -1],
  h: [-1, 0],              l: [1, 0],
  b: [-1, 1], j: [0, 1], n: [1, 1],
};

function defaultStatus(turn = 1): StatusLine {
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
    turn,
    gold: 0,
    hunger: "ok",
    conditions: [],
  };
}

interface EngineState {
  rows: string[];                  // Mutable row buffer (per-cell strings rejoined each step).
  player: { x: number; y: number };
  // What's underneath the player (so when they move, the original tile
  // is restored). Initially the start glyph is `.` (a fresh fixture
  // never starts the player on a non-walkable; we record floor).
  underPlayer: string;
  fixture: Fixture;
}

// Look up the cell glyph at (x,y) in the engine state.
function cellAt(state: EngineState, x: number, y: number): string {
  if (y < 0 || y >= state.rows.length) return " ";
  const row = state.rows[y]!;
  if (x < 0 || x >= row.length) return " ";
  return row[x]!;
}

function setCell(state: EngineState, x: number, y: number, ch: string): void {
  const row = state.rows[y]!;
  state.rows[y] = row.substring(0, x) + ch + row.substring(x + 1);
}

// Apply a single vi-key. Mutates state in place; returns the message
// the engine would print on the message line. Empty string = silent.
function step(state: EngineState, key: string): string {
  const delta = VI_KEY_TO_DELTA[key];
  if (delta === undefined) return ""; // Unknown key, no-op.
  const [dx, dy] = delta;
  const { x: px, y: py } = state.player;
  const nx = px + dx;
  const ny = py + dy;
  const target = cellAt(state, nx, ny);
  const isDiag = dx !== 0 && dy !== 0;

  // Engine-side diagonal-doorway rule. Real NetHack disallows
  // diagonal entry/exit through doors. We mirror that so autopilot
  // tests catch any pathfind/handler mismatch.
  if (isDiag) {
    const fromGlyph = cellAt(state, px, py); // Player position; check what's *under*.
    const fromTile = fromGlyph === "@" ? state.underPlayer : fromGlyph;
    if (fromTile === "+" || fromTile === "'") return "You can't move diagonally out of an intact doorway.";
    if (target === "+" || target === "'") return "You can't move diagonally into an intact doorway.";
    // Walls at both intermediates → corner squeeze refused.
    const inter1 = cellAt(state, px, ny);
    const inter2 = cellAt(state, nx, py);
    if ((inter1 === "|" || inter1 === "-") && (inter2 === "|" || inter2 === "-")) {
      return "It's hard to squeeze through that gap.";
    }
  }

  // Locked door check.
  if (target === "+" && state.fixture.lockedDoors.has(`${nx},${ny}`)) {
    return "The door is locked.";
  }

  // Closed door auto-open. Real NetHack 3.6 actually does open-only,
  // not open-and-step; we model open-and-step here. If the autopilot
  // ever needs to handle two-bump-door semantics, write an opt-in
  // realistic-engine variant — don't change the default and break
  // every test using doors.
  if (target === "+") {
    setCell(state, nx, ny, "'"); // Door is now open.
    // Fallthrough to "move into target" with target updated.
    movePlayer(state, nx, ny, "'");
    return "";
  }

  // Walls and out-of-bounds are bumps.
  if (target === "|" || target === "-" || target === " ") {
    return "Ouch! You bump into a wall.";
  }

  // Boulder: you cannot push diagonally; cardinal pushes deferred.
  if (target === "`") {
    return "You can't push the boulder diagonally.";
  }

  // Trap_known: refuse — autopilot should never aim for one, but if
  // someone manually tested this we want a clear message.
  if (target === "^") {
    return "You see a trap.";
  }

  // Walkable terrain.
  movePlayer(state, nx, ny, target);
  return "";
}

function movePlayer(state: EngineState, nx: number, ny: number, targetTile: string): void {
  const { x: px, y: py } = state.player;
  setCell(state, px, py, state.underPlayer); // Restore old.
  state.underPlayer = targetTile;             // Remember new under.
  setCell(state, nx, ny, "@");
  state.player = { x: nx, y: ny };
}

// ---------------------------------------------------------------------------
// Harness.

interface HarnessResult {
  /** Tool result string (TOOL_RESULT_HEADER prefixed JSON-ish blob). */
  toolResult: string;
  /** Keys the autopilot sent, in order. */
  sentKeys: string[];
  /** Final player position. */
  finalPos: { x: number; y: number };
  /** True if last frame's status matches start (no engine progress). */
  steps: number;
  /** Stop-reason text extracted from the tool result, if any. */
  stopReason: string | null;
  /** Per-step trace events emitted by the autopilot. */
  stepEvents: StepEvent[];
}

interface RunOpts {
  /** Step cap to pass to autopilot. Defaults to 200 (enough for any test map). */
  stepCap?: number;
  /** If set, abort the AbortController after this many steps. */
  abortAfter?: number;
}

function makeContext(fixture: Fixture): {
  ctx: ToolContext;
  sentKeys: string[];
  state: EngineState;
  ac: AbortController;
  steps: Parameters<NonNullable<ToolContext["logAutopilotStep"]>>[0][];
} {
  const sentKeys: string[] = [];
  const map = new GameMap();
  const ac = new AbortController();
  const steps: Parameters<NonNullable<ToolContext["logAutopilotStep"]>>[0][] = [];
  const state: EngineState = {
    rows: [...fixture.rows],
    player: { ...fixture.start },
    underPlayer: ".",
    fixture,
  };
  // Seed the GameMap with the initial frame so pathfind sees terrain.
  map.updateFromFrame(state.rows, defaultStatus(1), "");

  let turnCount = 1;
  const ctx: ToolContext = {
    map,
    runState: { gameOver: false, endReason: null },
    signal: ac.signal,
    journalDir: "",
    logAutopilotStep: (ev) => steps.push(ev),
    sendKeysAndWait: async (keys: string): Promise<FrameAwaitResult> => {
      sentKeys.push(keys);
      // Real autopilot only sends single vi-keys, but be defensive.
      let lastMessage = "";
      for (const key of keys) lastMessage = step(state, key);
      turnCount += 1;
      const status = defaultStatus(turnCount);
      // GameMap re-parses the new rows.
      map.updateFromFrame(state.rows, status, lastMessage);
      const screenAnsi = state.rows.join("\n");
      const glyphClass = state.rows.map(() => [] as undefined[]);
      return {
        rows: state.rows,
        glyphClass,
        status,
        message: lastMessage,
        frameReason: "cellChange",
        screenAnsi,
      };
    },
  };
  return { ctx, sentKeys, state, ac, steps };
}

// Pull the stop reason out of the tool result. The handler emits one of:
//   "autopilot_to(D1,X,Y): arrived after N steps"
//   "autopilot_to(D1,X,Y): stopped after N steps. interrupt: <reason>"
//   "autopilot_explore: N steps. stopped: <reason>"
function extractStopReason(toolResult: string): string | null {
  const arrived = toolResult.match(/arrived after \d+ steps/);
  if (arrived !== null) return "arrived";
  const m1 = toolResult.match(/interrupt: (.+?)(?:\\n|$|\n)/);
  if (m1 !== null) return m1[1]!.trim();
  const m2 = toolResult.match(/stopped: (.+?)(?:\\n|$|\n)/);
  if (m2 !== null) return m2[1]!.trim();
  return null;
}

async function runAutopilotTo(
  fixture: Fixture,
  goal: { x: number; y: number } | null,
  opts: RunOpts = {},
): Promise<HarnessResult> {
  const target = goal ?? fixture.goal;
  if (target === null) throw new Error("runAutopilotTo: fixture has no goal '*' and none given");
  const { ctx, sentKeys, state, ac, steps } = makeContext(fixture);
  if (opts.abortAfter !== undefined) {
    // Wrap sendKeysAndWait to abort after N calls.
    const orig = ctx.sendKeysAndWait;
    let n = 0;
    ctx.sendKeysAndWait = async (k) => {
      const r = await orig(k);
      n += 1;
      if (n >= opts.abortAfter!) ac.abort();
      return r;
    };
  }
  const args: { floor: string; x: number; y: number; stepCap?: number } = {
    floor: "D1",
    x: target.x,
    y: target.y,
  };
  if (opts.stepCap !== undefined) args.stepCap = opts.stepCap;
  else args.stepCap = 200;
  const toolResult = await handleAutopilotTo(args, ctx);
  return {
    toolResult,
    sentKeys,
    finalPos: state.player,
    steps: sentKeys.length,
    stopReason: extractStopReason(toolResult),
    stepEvents: steps,
  };
}

async function runAutopilotExplore(
  fixture: Fixture,
  opts: RunOpts = {},
): Promise<HarnessResult> {
  const { ctx, sentKeys, state, ac, steps } = makeContext(fixture);
  if (opts.abortAfter !== undefined) {
    const orig = ctx.sendKeysAndWait;
    let n = 0;
    ctx.sendKeysAndWait = async (k) => {
      const r = await orig(k);
      n += 1;
      if (n >= opts.abortAfter!) ac.abort();
      return r;
    };
  }
  const args: { stepCap?: number } = {};
  if (opts.stepCap !== undefined) args.stepCap = opts.stepCap;
  else args.stepCap = 200;
  const toolResult = await handleAutopilotExplore(args, ctx);
  return {
    toolResult,
    sentKeys,
    finalPos: state.player,
    steps: sentKeys.length,
    stopReason: extractStopReason(toolResult),
    stepEvents: steps,
  };
}

// ===========================================================================
// Tests
// ===========================================================================

describe("autopilot_to navigation", () => {
  test("walks straight east through an open corridor", async () => {
    // Use '-' / '|' walls (corridor '#' is *walkable* in NetHack;
    // wrong choice for sealed-room tests).
    //
    // Note: detectEngulfed false-fires if @ sits directly under a
    // '-' wall (matches the NetHack engulfer-rendering heuristic).
    // Pad with at least one floor row above the player.
    const fx = parseFixture({
      map: `
--------
|......|
|@....*|
--------`,
    });
    const r = await runAutopilotTo(fx, null);
    expect(r.stopReason).toBe("arrived");
    expect(r.finalPos).toEqual(fx.goal!);
    // Path may go straight east OR diagonal-then-east; either is a
    // valid optimal path. Just check the result.
    expect(r.steps).toBeGreaterThan(0);
  });

  test("walks diagonally through an open room (NE)", async () => {
    // Player bottom-left, goal upper-right. A* prefers diagonals
    // (cost SQRT2 < 2 cardinals) so we expect 'u' (NE) keys.
    const fx = parseFixture({
      map: `
--------
|.....*|
|......|
|......|
|@.....|
--------`,
    });
    const r = await runAutopilotTo(fx, null);
    expect(r.stopReason).toBe("arrived");
    expect(r.finalPos).toEqual(fx.goal!);
    const ne = r.sentKeys.filter((k) => k === "u").length;
    expect(ne).toBeGreaterThan(0);
    expect(r.toolResult).not.toContain("bump");
  });

  test("navigates around a wall — corner detour", async () => {
    // L-shaped corridor: east blocked early, must go south first.
    const fx = parseFixture({
      map: `
--------
|@.|----
|..|----
|..|----
|....*||
--------`,
    });
    const r = await runAutopilotTo(fx, null);
    expect(r.stopReason).toBe("arrived");
    expect(r.finalPos).toEqual(fx.goal!);
    // Must have moved both south and east at least once.
    const south = r.sentKeys.filter((k) => "jbn".includes(k)).length;
    const east = r.sentKeys.filter((k) => "lun".includes(k)).length;
    expect(south).toBeGreaterThan(0);
    expect(east).toBeGreaterThan(0);
  });

  test("opens a closed door on the path (auto-open + step)", async () => {
    const fx = parseFixture({
      map: `
--------
|......|
|@..+.*|
--------`,
    });
    const r = await runAutopilotTo(fx, null);
    expect(r.stopReason).toBe("arrived");
    expect(r.finalPos).toEqual(fx.goal!);
  });

  test("autopilot_to emits per-step trace events with decision='path'", async () => {
    const fx = parseFixture({
      map: `
--------
|......|
|@....*|
--------`,
    });
    const r = await runAutopilotTo(fx, null);
    expect(r.stepEvents.length).toBe(r.steps);
    for (const ev of r.stepEvents) {
      expect(ev.tool).toBe("autopilot_to");
      expect(ev.decision).toBe("path");
    }
    // moved=true on every step for an unobstructed corridor.
    expect(r.stepEvents.every((e) => e.moved)).toBe(true);
  });

  test("locked door step is logged with moved=false and engine message", async () => {
    const fx = parseFixture({
      map: `
--------
|...|..|
|...|..|
|@..+.*|
|...|..|
--------`,
      lockedDoors: [[4, 3]],
    });
    const r = await runAutopilotTo(fx, null, { stepCap: 30 });
    // At least one step should be moved=false with the locked-door message.
    const refusals = r.stepEvents.filter((e) => !e.moved);
    expect(refusals.length).toBeGreaterThan(0);
    expect(refusals.some((e) => e.message.includes("door is locked"))).toBe(true);
  });

  test("REGRESSION: locked-door-only-route bails with blocked_unreachable + engine message", async () => {
    // The "autopilot_to wall-bumping" bug from 2026-05-08. Wall
    // separates @ from goal; the locked door is the only opening.
    // Without per-call exclusion, autopilot would replan and get
    // the same path back forever; with it, replan returns null and
    // we surface blocked_unreachable with the engine's message.
    const fx = parseFixture({
      map: `
--------
|...|..|
|...|..|
|@..+.*|
|...|..|
--------`,
      lockedDoors: [[4, 3]],
    });
    const r = await runAutopilotTo(fx, null, { stepCap: 50 });
    expect(r.stopReason).toContain("blocked_unreachable");
    expect(r.stopReason).toContain("The door is locked.");
    // Bails FAST — a few approach steps + one bump, not the cap.
    expect(r.steps).toBeLessThan(15);
    expect(r.finalPos.x).toBeLessThan(fx.goal!.x);
  });

  test("locked door with a detour — autopilot replans around and arrives", async () => {
    // Two corridors converging on the goal. East path through a
    // locked door is shorter (3 tiles); the row-1 detour is longer.
    // After the first bump, autopilot excludes the door from
    // pathfind and routes via the alternate path. End: arrives.
    const fx = parseFixture({
      map: `
----------
|........|
|@.+....*|
|........|
----------`,
      lockedDoors: [[3, 2]],
    });
    const r = await runAutopilotTo(fx, null, { stepCap: 50 });
    expect(r.stopReason).toBe("arrived");
    expect(r.finalPos).toEqual(fx.goal!);
    // The agent should have bumped the door at most once and then
    // detoured. Total steps is bounded by detour length + bump.
    expect(r.steps).toBeLessThan(15);
  });

  test("returns 'no path' when goal is fully walled off", async () => {
    // Vertical wall '|' must reach both top and bottom borders to
    // truly seal — otherwise A* routes around it.
    const fx = parseFixture({
      map: `
----------
|...|....|
|...|....|
|@..|...*|
|...|....|
----------`,
    });
    const r = await runAutopilotTo(fx, fx.goal);
    expect(r.toolResult).toContain("no path");
    expect(r.steps).toBe(0);
  });

  test("honors stepCap — never sends more keys than the cap", async () => {
    const fx = parseFixture({
      map: `
--------------
|............|
|@..........*|
--------------`,
    });
    const r = await runAutopilotTo(fx, fx.goal, { stepCap: 3 });
    expect(r.steps).toBe(3);
    expect(r.toolResult).toContain("step_cap");
  });

  test("respects abort signal — stops promptly", async () => {
    const fx = parseFixture({
      map: `
--------------
|............|
|@..........*|
--------------`,
    });
    const r = await runAutopilotTo(fx, fx.goal, { abortAfter: 2 });
    expect(r.steps).toBeLessThanOrEqual(3);
    expect(r.toolResult).toContain("abort_signal");
  });

  test("REGRESSION: abort_signal wins over modal_prompt set by SIGINT", async () => {
    // Production run bbh-20260508-201818-5c1ab1: user Ctrl+C'd
    // mid-autopilot, SIGINT propagated to NetHack via the PTY,
    // NetHack showed "Really quit without saving? [yn]", and the
    // autopilot reported `stopped: modal_prompt` — confusing,
    // because the real cause was the user. With abort-after-frame,
    // abort_signal wins.
    //
    // Simulated by having abortAfter=1 and a fake engine that
    // injects a quit-modal on the next frame (the message field).
    const fx = parseFixture({
      map: `
--------
|......|
|@....*|
--------`,
    });
    const { ctx, sentKeys, ac } = makeContext(fx);
    // Patch sendKeysAndWait: after the first call, abort + return
    // a frame whose message would otherwise trigger modal_prompt.
    const orig = ctx.sendKeysAndWait;
    let n = 0;
    ctx.sendKeysAndWait = async (k) => {
      const r = await orig(k);
      n += 1;
      if (n === 1) {
        ac.abort();
        return { ...r, message: "Really quit without saving? [yn] (n)" };
      }
      return r;
    };
    const out = await handleAutopilotTo({ floor: "D1", x: fx.goal!.x, y: fx.goal!.y, stepCap: 50 }, ctx);
    expect(out).toContain("abort_signal");
    expect(out).not.toContain("modal_prompt");
    expect(sentKeys.length).toBe(1);
  });

  test("zero-distance goal returns 'arrived after 0 steps'", async () => {
    const fx = parseFixture({
      map: `
----
|..|
|@.|
----`,
    });
    const r = await runAutopilotTo(fx, fx.start);
    expect(r.stopReason).toBe("arrived");
    expect(r.steps).toBe(0);
  });

  test("multi-room layout — through a doorway", async () => {
    // Two rooms separated by a vertical wall with a door. Note that
    // the engine forbids diagonal entry/exit through doorways
    // (matching real NetHack); pathfind already accounts for this.
    const fx = parseFixture({
      map: `
--------------
|............|
|@....+.....*|
|............|
--------------`,
    });
    const r = await runAutopilotTo(fx, null);
    expect(r.stopReason).toBe("arrived");
    expect(r.finalPos).toEqual(fx.goal!);
    // No diagonal-doorway violations.
    expect(r.toolResult).not.toContain("intact doorway");
  });
});

describe("autopilot_explore navigation", () => {
  test("explores a small open room and exits cleanly", async () => {
    // 4×3 interior = 12 walkable tiles. Visit all, then exit.
    const fx = parseFixture({
      map: `
------
|....|
|.@..|
|....|
------`,
    });
    const r = await runAutopilotExplore(fx, { stepCap: 50 });
    expect(r.stopReason).toContain("explored entire known map");
    // 12 walkables, but BFS-to-frontier may reroute; 20 is a
    // generous upper bound that catches "spinning" without being
    // brittle to step-by-step visit order.
    expect(r.steps).toBeLessThan(20);
  });

  test("REGRESSION: BFS does not loop through a locked door to a far frontier", async () => {
    // Production run bbh-20260508-203614: player at (66,17), locked
    // door directly north at (66,16). Beyond the door, the map
    // continues into unexplored territory (frontier tiles). BFS
    // routed through the door 148+ times, returning first-step=k
    // each iteration. Engine refused every single one.
    //
    // Fixture: a sealed room whose only opening is a locked door.
    // Past the door is a short corridor that opens onto unknown
    // (the unrendered cells past col 10 → "unknown" terrain → a
    // genuine frontier the BFS will WANT to reach). Without the
    // blocked-tiles-in-BFS fix, the autopilot routes through the
    // door every iteration and burns the whole stepCap.
    const fx = parseFixture({
      map: `
------
|....|
|....|
|....+....
|....|
|@...|
------`,
      lockedDoors: [[5, 3]],
    });
    const r = await runAutopilotExplore(fx, { stepCap: 200 });
    // Critical: must NOT spend the whole stepCap. With the fix,
    // explore visits the room interior, bumps the door once, marks
    // it blocked, and exits because no frontier remains reachable.
    expect(r.steps).toBeLessThan(40);
    expect(r.toolResult.toLowerCase()).toContain("door is locked");
    // BFS must not repeat the same key more than a handful of times.
    // Production bug was 148 consecutive 'k'.
    let longestRun = 0;
    let curRun = 0;
    let prevKey = "";
    for (const ev of r.stepEvents) {
      if (ev.key === prevKey) curRun += 1;
      else curRun = 1;
      if (curRun > longestRun) longestRun = curRun;
      prevKey = ev.key;
    }
    expect(longestRun).toBeLessThan(10);
  });

  test("REGRESSION: sealed room with locked door — does NOT spin", async () => {
    // The "autopilot_explore wall-bumping" bug from 2026-05-08.
    // Player sealed in; only "exit" is a locked door, which engine
    // refuses. Without visited.add(target) on no-move, this would
    // burn the entire stepCap walking into the door.
    const fx = parseFixture({
      map: `
--------
|......|
|..@...|
|.....+|
--------`,
      lockedDoors: [[6, 3]],
    });
    const r = await runAutopilotExplore(fx, { stepCap: 100 });
    // Critical: must NOT consume the full stepCap. Room interior
    // is 6×3=18 cells; an extra ~5-10 for the door bumps before
    // visited-mark kicks in is acceptable.
    expect(r.steps).toBeLessThan(30);
    // The exit reason should be "explored entire known map" —
    // explore ran out of unvisited tiles after marking the door
    // visited. (NOT step_cap; if we hit step_cap, the regression
    // is back.)
    expect(r.stopReason).toContain("explored entire known map");
  });

  test("explore exits cleanly — never spins on a fully-known sealed room", async () => {
    // Tiny sealed room; player + 2 floor cells. Must not spin.
    const fx = parseFixture({
      map: `
----
|@.|
|..|
----`,
    });
    const r = await runAutopilotExplore(fx, { stepCap: 50 });
    expect(r.stopReason).toContain("explored entire known map");
    // 3 walkables; should finish in <= 5 steps.
    expect(r.steps).toBeLessThan(8);
  });

  test("explore visits all walkable tiles in a small room", async () => {
    const fx = parseFixture({
      map: `
-----
|@..|
|...|
-----`,
    });
    const r = await runAutopilotExplore(fx, { stepCap: 50 });
    expect(r.stopReason).toContain("explored entire known map");
    expect(r.finalPos.y).toBeGreaterThanOrEqual(1);
    expect(r.finalPos.y).toBeLessThanOrEqual(2);
  });

  test("emits per-step trace events with key, decision, moved, message", async () => {
    const fx = parseFixture({
      map: `
------
|....|
|.@..|
|....|
------`,
    });
    const r = await runAutopilotExplore(fx, { stepCap: 5 });
    expect(r.stepEvents.length).toBe(r.steps);
    // Every event has the expected shape.
    for (const ev of r.stepEvents) {
      expect(ev.tool).toBe("autopilot_explore");
      expect(typeof ev.step).toBe("number");
      expect("hjklyubn".includes(ev.key)).toBe(true);
      expect(["adjacent", "bfs"].includes(ev.decision)).toBe(true);
      expect(typeof ev.moved).toBe("boolean");
    }
    // Step numbers are 1-indexed and contiguous.
    expect(r.stepEvents.map((e) => e.step)).toEqual(
      Array.from({ length: r.stepEvents.length }, (_, i) => i + 1),
    );
  });

  test("explore makes progress when unknown tiles exist beyond a corridor", async () => {
    // Right edge open → tiles (5,1), (5,2)... are unknown ' '.
    // Explore's BFS-to-frontier should pick a step toward unknown
    // rather than declaring done immediately.
    const fx = parseFixture({
      map: `
------
|@....
|.....`,
    });
    const r = await runAutopilotExplore(fx, { stepCap: 10 });
    expect(r.steps).toBeGreaterThan(0);
    // Player should have moved east at least once.
    expect(r.finalPos.x).toBeGreaterThan(fx.start.x);
  });
});
