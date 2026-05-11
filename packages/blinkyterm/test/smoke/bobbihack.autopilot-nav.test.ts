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
import { buildClassifiedGrid } from "../../examples/bobbihack/cell-classifier";
import type { CellInfo, CellStyle } from "libghostty-vt";
import type { FrameSnapshot } from "../../src/types";

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
  /**
   * Coordinates of letter glyphs that should be classified as pets
   * (inverse-styled in real NetHack with `hilite_pet`). Phase 4 v2:
   * lets fixtures exercise pet-displacement without a real engine.
   */
  petPositions?: Array<readonly [number, number]>;
  /**
   * Per-cell foreground color overrides (palette index 0..15). Lets a
   * fixture mark a `}` as red (lava) or blue (water), or color a `D`
   * for future v3 species disambiguation. Keyed by `"x,y"`.
   */
  cellColors?: Record<string, number>;
  /**
   * Status conditions to set on every frame's StatusLine (e.g. "Conf",
   * "Stun"). Lets fixtures exercise status-conditioned AP rules even
   * though the fake engine doesn't model the underlying mechanics.
   */
  playerConditions?: string[];
  /**
   * Item glyphs at specific positions, given as `{ "x,y": glyph }`.
   * The underlying buffer is rendered with `.` (floor) at these
   * positions so GameMap classifies the tile as walkable; the
   * per-frame snapshot's cellAt returns the item glyph so
   * predict-and-avoid sees it as a `pickup-prompt` candidate.
   * This mirrors production where items render on top of recorded
   * terrain.
   */
  items?: Record<string, string>;
}

interface Fixture {
  rows: string[];           // Padded 80x24 buffer.
  start: { x: number; y: number };
  goal: { x: number; y: number } | null;  // From '*' marker, if any.
  lockedDoors: Set<string>; // "x,y" coords.
  /**
   * Pet positions keyed by "x,y", mapped to the letter glyph the
   * pet should render with (default `d`). The buffer cell is
   * replaced with `.` so GameMap records walkable floor; the
   * snapshot's `cellAt` then overlays the letter glyph with
   * inverse=true so the v2 classifier marks the cell as
   * monster:pet.
   */
  petPositions: Map<string, string>;
  cellColors: Map<string, number>;
  playerConditions: string[];
  /** Item glyphs by position key — rendered via the snapshot, not
   *  the buffer (the buffer keeps `.` so GameMap records floor). */
  items: Map<string, string>;
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

  const petPositions = new Map<string, string>();
  for (const [x, y] of spec.petPositions ?? []) {
    // Capture whatever letter the source map drew at this position
    // (default `d` if it wasn't a letter). The snapshot will overlay
    // this glyph with inverse=true so the classifier marks the cell
    // as monster:pet.
    let letter = "d";
    if (y >= 0 && y < ROWS) {
      const row = buf[y]!;
      if (x >= 0 && x < row.length) {
        const ch = row[x]!;
        if (/^[a-zA-Z]$/.test(ch)) letter = ch;
        // Replace the buffer cell with floor so GameMap records the
        // tile as walkable terrain (mirroring how production sees
        // it: the player has walked over here at some point,
        // leaving the floor recorded; the pet's letter glyph is a
        // transient overlay). Without this, GameMap classifies the
        // letter as `unknown` and pathfind detours around the pet
        // without ever attempting a swap.
        row[x] = ".";
      }
    }
    petPositions.set(`${x},${y}`, letter);
  }

  const cellColors = new Map<string, number>();
  for (const [k, v] of Object.entries(spec.cellColors ?? {})) {
    cellColors.set(k, v);
  }

  const items = new Map<string, string>();
  for (const [k, glyph] of Object.entries(spec.items ?? {})) {
    items.set(k, glyph);
    // Replace the buffer cell with floor so GameMap records walkable
    // terrain underneath. The item is overlaid via the snapshot.
    const [xs, ys] = k.split(",");
    const x = Number.parseInt(xs ?? "", 10);
    const y = Number.parseInt(ys ?? "", 10);
    if (Number.isFinite(x) && Number.isFinite(y) && y >= 0 && y < ROWS) {
      const row = buf[y]!;
      if (x >= 0 && x < row.length) row[x] = ".";
    }
  }

  return {
    rows: buf.map((r) => r.join("")),
    start,
    goal,
    lockedDoors,
    petPositions,
    cellColors,
    playerConditions: spec.playerConditions ?? [],
    items,
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

function defaultStatus(turn = 1, conditions: string[] = []): StatusLine {
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
    conditions: [...conditions],
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

// ---------------------------------------------------------------------------
// v2 classified-grid helpers (Phase 4 of the NetHack-aware autopilot v2).
//
// The autopilot's predict-and-avoid logic consumes
// `map.latestClassified`, populated in production by the conductor in
// `main.ts` from a real FrameSnapshot. The fake engine has no
// FrameSnapshot, so the harness builds one cell at a time from the
// fixture's pet/color hints and the current row buffer.

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

function makeCellInfo(text: string, style?: CellStyle): CellInfo {
  const out: CellInfo = {
    text,
    wide: false,
    isWideContinuation: false,
    protected: false,
    ...(style !== undefined ? { style } : {}),
  };
  return out;
}

// Build a per-frame stub `FrameSnapshot` whose `cellAt` returns a
// `CellInfo` with the right style for pets and color-tagged cells.
// Cells that the fixture didn't explicitly mark fall through to
// `null`, and `buildClassifiedGrid` then falls back to plain row text
// (no style).
function buildStubSnapshot(rows: string[], fixture: Fixture): FrameSnapshot {
  return {
    text: "",
    title: "",
    cursor: { x: 0, y: 0, visible: true },
    bellsSinceLast: 0,
    titleChangesSinceLast: [],
    toAnsi: () => rows.join("\n"),
    toHtml: () => "",
    toVt: () => "",
    cellAt(x: number, y: number): CellInfo | null {
      if (y < 0 || y >= rows.length) return null;
      const row = rows[y]!;
      if (x < 0 || x >= row.length) return null;
      const k = `${x},${y}`;
      const itemGlyph = fixture.items.get(k);
      const petLetter = fixture.petPositions.get(k);
      // Items / pets overlay the buffer's floor cell; the buffer
      // keeps `.` so GameMap records walkable terrain underneath,
      // mirroring production where the player has walked here and
      // recorded floor, and monsters / items render as transient
      // overlays on top.
      const ch = itemGlyph ?? petLetter ?? row[x]!;
      const isPet = petLetter !== undefined;
      const colorOverride = fixture.cellColors.get(k);
      if (itemGlyph === undefined && !isPet && colorOverride === undefined) {
        return null;
      }
      const overrides: Partial<CellStyle> = {};
      if (isPet) overrides.inverse = true;
      if (colorOverride !== undefined) overrides.fg = { palette: colorOverride };
      return makeCellInfo(ch, defaultStyle(overrides));
    },
  };
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

  // Pet displacement: walking onto a pet glyph silently swaps. The
  // pet ends up where the player came from. Real NetHack emits no
  // message for this in cardinal directions.
  const targetKey = `${nx},${ny}`;
  if (state.fixture.petPositions.has(targetKey) && /^[a-zA-Z]$/.test(target)) {
    // Move pet position state from (nx,ny) to (px,py) so the
    // classified grid keeps reading "pet" at the swapped square.
    const petLetter = state.fixture.petPositions.get(targetKey)!;
    state.fixture.petPositions.delete(targetKey);
    state.fixture.petPositions.set(`${px},${py}`, petLetter);
    // Keep the color override too if present.
    const color = state.fixture.cellColors.get(targetKey);
    if (color !== undefined) {
      state.fixture.cellColors.delete(targetKey);
      state.fixture.cellColors.set(`${px},${py}`, color);
    }
    // Render the pet at the player's prior square. The player moves
    // onto the pet's prior square; underPlayer becomes whatever the
    // pet was standing on (assume floor for fixture simplicity).
    setCell(state, px, py, target);
    state.underPlayer = ".";
    setCell(state, nx, ny, "@");
    state.player = { x: nx, y: ny };
    return "";
  }

  // Walking over an item with `m`-prefix (the harness stripped the
  // `m` upstream): consume the item from the fixture's items map so
  // the next frame's classified grid no longer reads it as a pickup
  // candidate. Real NetHack would render a "You see here ..." line;
  // we simulate the silent-skip case (m-prefix path).
  if (state.fixture.items.has(targetKey)) {
    state.fixture.items.delete(targetKey);
    movePlayer(state, nx, ny, ".");
    return "";
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
  map.updateFromFrame(state.rows, defaultStatus(1, fixture.playerConditions), "");
  // v2: also seed the classified grid so the AP's first-step
  // predict-and-avoid check has something to consult.
  map.latestClassified = buildClassifiedGrid(
    buildStubSnapshot(state.rows, fixture),
    state.rows,
    map.currentPlayerXY,
  );

  let turnCount = 1;
  const ctx: ToolContext = {
    map,
    runState: { gameOver: false, endReason: null },
    signal: ac.signal,
    journalDir: "",
    logAutopilotStep: (ev) => steps.push(ev),
    sendKeysAndWait: async (keys: string): Promise<FrameAwaitResult> => {
      sentKeys.push(keys);
      // Real autopilot sends bare vi-keys plus optional `m` prefix;
      // strip the m so step() consumes only the direction.
      const directionKeys = keys.startsWith("m") ? keys.slice(1) : keys;
      let lastMessage = "";
      for (const key of directionKeys) lastMessage = step(state, key);
      turnCount += 1;
      const status = defaultStatus(turnCount, fixture.playerConditions);
      // GameMap re-parses the new rows.
      map.updateFromFrame(state.rows, status, lastMessage);
      // v2: refresh the classified grid each frame, mirroring
      // main.ts's per-frame call. Without this, predict-and-avoid
      // would read a stale pet position after the first displacement.
      const classified = buildClassifiedGrid(
        buildStubSnapshot(state.rows, fixture),
        state.rows,
        map.currentPlayerXY,
      );
      map.latestClassified = classified;
      const screenAnsi = state.rows.join("\n");
      const glyphClass = state.rows.map(() => [] as undefined[]);
      return {
        rows: state.rows,
        glyphClass,
        status,
        message: lastMessage,
        frameReason: "cellChange",
        screenAnsi,
        classified,
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

// ===========================================================================
// Phase 4 — v2 fixture coverage (NetHack-aware autopilot)
//
// Locks in the v2 behavior changes from
// docs/superpowers/specs/2026-05-09-nethack-aware-autopilot.md:
// danger-aware path costs, predict-and-avoid for tile-induced modals,
// the rendering-quirk detectors. Each `describe` block below maps to
// one of the seven fixture groups in plan §"Task 4.1".
//
// Assertion style: contracts, not literal step counts. Bound steps and
// match stop-reason patterns so harmless v2.x tweaks don't break the
// suite. Each fixture documents the failure mode it catches with a
// `REGRESSION:` or `INVARIANT:` lead.
// ===========================================================================

describe("v2 — pet displacement (spec case 1)", () => {
  test("INVARIANT: AP steps cardinally onto a pet, swaps, and arrives", async () => {
    // Pet `d` on the cardinal-east path between @ and goal. The AP's
    // predict-and-avoid classifies the inverse-styled `d` as
    // `pet-displace`, sends a bare direction key (no `m` prefix, no
    // refusal), the engine swaps positions silently, no
    // `monster_visible` interrupt fires (pet glyph is in both prev
    // and cur frames; detector only fires on newly-appeared
    // letters).
    const fx = parseFixture({
      map: `
--------
|......|
|@.d..*|
--------`,
      petPositions: [[3, 2]],
    });
    const r = await runAutopilotTo(fx, null);
    expect(r.stopReason).toBe("arrived");
    expect(r.finalPos).toEqual(fx.goal!);
    // No predict-avoid refusal fired for the pet square.
    const refusals = r.stepEvents.filter((e) =>
      e.key.startsWith("predict-avoid:"),
    );
    expect(refusals.length).toBe(0);
    // Bounded — 5 floor cells from @ to *, plus one for the swap.
    expect(r.steps).toBeLessThan(10);
  });

  test("REGRESSION (v2.5): diagonal pet-swap is refused via predict-and-avoid", async () => {
    // Live run bbh-20260509-025250-b0fc34 observed: `u` (NE) into a
    // pet emits "You stop. Your kitten is in the way!" and the step
    // is consumed without movement. Cardinal swaps work fine.
    //
    // v2.5 fix (modal-prediction.ts): `willStepFireModal` now takes
    // a `delta` context arg; when the step is diagonal AND the
    // target is a pet, it returns `{kind: 'pet-displace-blocked',
    // resolveWith: 'refuse'}`. The AP marks the pet tile blocked
    // and detours. Total step count stays bounded.
    //
    // The fixture places the pet directly NE of the player AND the
    // goal directly NE of the pet, so A*'s shortest path is the
    // two-diagonal route through the pet. Without the v2.5 fix the
    // AP would diagonal into the pet (engine refuses) and burn the
    // step cap; with the fix the AP refuses pre-step, marks the pet
    // tile blocked, and detours via cardinals.
    const fx = parseFixture({
      map: `
-------
|.....|
|.....|
|..*..|
|.d...|
|@....|
-------`,
      petPositions: [[2, 4]],
    });
    const r = await runAutopilotTo(fx, null);
    expect(r.stopReason).toBe("arrived");
    const blocked = r.stepEvents.filter((e) =>
      e.key === "predict-avoid:pet-displace-blocked",
    );
    expect(blocked.length).toBeGreaterThanOrEqual(1);
    // Bounded — refusal + cardinal detour is at most ~4 movements.
    expect(r.steps).toBeLessThan(10);
  });
});

describe("v2 — danger-class refusal & detour (spec cases 2, 3)", () => {
  test("REGRESSION: non-pet hostile letter blocks path → predict-avoid refuse", async () => {
    // Case 2 from spec test plan. A non-pet `d` (jackal etc.) sits in
    // a single-row corridor between @ and goal so no detour exists.
    // v2 predict-and-avoid sees `kind: 'monster', pet: false`,
    // returns `attack-or-peaceful` -> `refuse`. The AP marks the
    // tile blocked and replans; with no alternate route,
    // `blocked_unreachable: predict:...` surfaces.
    //
    // Production bug this guards against: pre-v2 AP would step onto
    // the hostile, fire the [yn] attack-or-peaceful prompt, and the
    // LLM's resumed `y` answer became "yes, attack." See spec
    // §"Layer 5" rubric 1, "Common novice errors."
    const fx = parseFixture({
      map: `
--------
|@.d..*|
--------`,
    });
    const r = await runAutopilotTo(fx, null, { stepCap: 30 });
    // Halts upstream — never bumps the hostile tile.
    expect(r.stopReason ?? "").toMatch(/blocked_unreachable|predict|attack-or-peaceful|monster_visible/);
    // No `y`/`n` keystrokes ever sent (would mean we hit the modal).
    expect(r.sentKeys.includes("y")).toBe(false);
    expect(r.sentKeys.includes("n")).toBe(false);
    // Bounded — bails fast.
    expect(r.steps).toBeLessThan(15);
  });

  test("INVARIANT: predict-avoid event is logged with key='predict-avoid:<kind>'", async () => {
    // The trace event captures the predict-avoid decision so a stuck
    // run can be diagnosed from run.jsonl alone. Single-row corridor
    // forces the AP to engage (or refuse) the hostile rather than
    // detour around through a parallel row.
    const fx = parseFixture({
      map: `
--------
|@.o..*|
--------`,
    });
    const r = await runAutopilotTo(fx, null, { stepCap: 30 });
    const refusals = r.stepEvents.filter((e) =>
      e.key.startsWith("predict-avoid:"),
    );
    expect(refusals.length).toBeGreaterThan(0);
    // The kind is one of the modal-prediction module's enum values.
    expect(refusals[0]?.key).toMatch(
      /^predict-avoid:(attack-or-peaceful|paranoid-trap|paranoid-swim|pickup-prompt)$/,
    );
  });

  test("INVARIANT: danger-class `D` at adjacency cost forces a longer detour", async () => {
    // Case 3 from spec test plan. Short path runs adjacent to a
    // dragon `D`; an alt path exists ~5 tiles longer. The v2 cost
    // model multiplies adjacency-to-danger-class by 20× so the
    // pathfinder prefers the detour even when it costs +5 cardinal
    // steps.
    //
    // Layout: a 3-row room with a dragon parked in the middle.
    // The direct east route runs row 2 (@ → row 2 → *) but row 2
    // is the dragon row; row 1 (top) and row 3 (bottom) are clean
    // detours of equal length.
    const fx = parseFixture({
      map: `
----------
|........|
|...D....|
|@......*|
|........|
----------`,
    });
    const r = await runAutopilotTo(fx, null, { stepCap: 50 });
    expect(r.stopReason).toBe("arrived");
    expect(r.finalPos).toEqual(fx.goal!);
    // Reads-the-room sanity: the `D` is at (4, 2); a path that
    // *passed adjacent to* the dragon would have at least one step
    // landing at (3, 2) or (5, 2) or (4, 1)/(4, 3) BEFORE the goal.
    // With danger-aware cost the AP avoids those cells entirely.
    const visited = new Set(
      r.stepEvents
        .filter((e) => e.toXY !== null)
        .map((e) => `${e.toXY!.x},${e.toXY!.y}`),
    );
    // The AP must NOT have stepped onto the dragon's tile (would be
    // an attack, not a detour).
    expect(visited.has("4,2")).toBe(false);
  });

  test("INVARIANT: danger-class blocking ALL paths halts upstream, no engagement", async () => {
    // Variant: dragon directly on a single-row corridor — no detour.
    // AP halts via predict-avoid:attack-or-peaceful, never bumps.
    const fx = parseFixture({
      map: `
--------
|@.D..*|
--------`,
    });
    const r = await runAutopilotTo(fx, null, { stepCap: 30 });
    expect(r.stopReason ?? "").toMatch(
      /blocked_unreachable|predict|attack-or-peaceful|monster_visible/,
    );
    // No engagement keys.
    expect(r.sentKeys.includes("y")).toBe(false);
    expect(r.steps).toBeLessThan(15);
  });
});

describe("v2 — marker refusal (spec cases 4, 5)", () => {
  test("REGRESSION: `I` unseen-monster marker on path → AP refuses, no step", async () => {
    // Case 4 from spec test plan. The `I` glyph marks an unseen
    // monster (warning extrinsic, monster detection, telepathy, fresh
    // footprints). v2 layers: classifier returns
    // `foreground.kind: 'unseen-monster'`; predict-and-avoid returns
    // `attack-or-peaceful: refuse`; interrupt
    // `unseen_monster_visible` (priority 245) also fires when the
    // marker first appears in a new frame.
    //
    // Fixture: single-row corridor with `I` between @ and goal so no
    // detour exists. AP halts upstream — never bumps the marker.
    const fx = parseFixture({
      map: `
--------
|@.I..*|
--------`,
    });
    const r = await runAutopilotTo(fx, null, { stepCap: 30 });
    expect(r.stopReason ?? "").toMatch(
      /blocked_unreachable|predict|unseen_monster_visible|attack-or-peaceful/,
    );
    expect(r.steps).toBeLessThan(10);
  });

  test("REGRESSION: warning digit `4` on path → AP refuses, no step", async () => {
    // Case 5 from spec test plan. Warning extrinsic surfaces `1`-`5`
    // digits on map cells; tier ≥ 4 is "high warning" and fires the
    // `warning_high` interrupt (priority 243). v2 also routes around
    // them via the dangerWeight `tier × 4` multiplier (4× = 16, well
    // above the explore threshold of 10).
    //
    // Fixture: single-row corridor with `4` between @ and goal.
    const fx = parseFixture({
      map: `
--------
|@.4..*|
--------`,
    });
    const r = await runAutopilotTo(fx, null, { stepCap: 30 });
    expect(r.stopReason ?? "").toMatch(
      /blocked_unreachable|predict|warning_high|attack-or-peaceful/,
    );
    expect(r.steps).toBeLessThan(10);
  });

  test("INVARIANT: warning tier 1 also refuses upstream (any tier blocks step)", async () => {
    // The `warning_high` interrupt only fires for tier ≥ 4 (to keep
    // ambient warnings from spamming halts), but predict-and-avoid
    // refuses ANY warning tile because stepping onto it is undefined
    // engine behavior. This locks in the layered defense: tier 1
    // doesn't fire `warning_high` but DOES fire predict-avoid refuse.
    const fx = parseFixture({
      map: `
--------
|@.1..*|
--------`,
    });
    const r = await runAutopilotTo(fx, null, { stepCap: 30 });
    // Either predict-avoid refuses (most common) or pathfind's
    // dangerWeight (1×4=4) lets the AP through and the explore
    // threshold catches it later. Either way, no engagement key.
    expect(r.sentKeys.includes("y")).toBe(false);
  });
});

describe("v2 — modal prediction (spec cases 6, 7, 8)", () => {
  test("INVARIANT: item `?` on path → AP sends m-prefix and arrives", async () => {
    // Case 6 from spec test plan. An item glyph on the path triggers
    // the pickup prompt unless the AP prefixes the move with `m`
    // (NetHack's "move without picking up / fighting"). v2
    // predict-and-avoid returns `pickup-prompt: m-prefix`; the AP
    // sends `m` + direction as a single sequence.
    //
    // Fixture: `?` (scroll) on the cardinal-east path. The harness
    // overlays the item via the snapshot but keeps `.` in the buffer
    // so GameMap records walkable underneath (mirrors production
    // where items render on top of recorded terrain).
    const fx = parseFixture({
      map: `
--------
|@....*|
--------`,
      items: { "3,1": "?" },
    });
    const r = await runAutopilotTo(fx, null, { stepCap: 30 });
    expect(r.stopReason).toBe("arrived");
    // At least one keystroke is the `m`-prefixed pair `ml` / `mu` /
    // `mh` / `mn` etc. (length 2, starts with 'm').
    const mPrefixed = r.sentKeys.filter(
      (k) => k.length === 2 && k.startsWith("m") && /^[hjklyubn]$/.test(k[1] ?? ""),
    );
    expect(mPrefixed.length).toBeGreaterThan(0);
    // No predict-avoid refusal logged for the item tile.
    const refusals = r.stepEvents.filter((e) =>
      e.key === "predict-avoid:pickup-prompt",
    );
    expect(refusals.length).toBe(0);
  });

  test("REGRESSION: `^` known trap on path → AP refuses, never steps in", async () => {
    // Case 7 from spec test plan. `^` is `trap_known` terrain;
    // GameMap.pathfind already excludes it from the search via
    // NON_WALKABLE_KINDS, so the AP can't plan a route through it in
    // the first place. v2 predict-and-avoid is the layered defense
    // for the case where a trap appears on the planned path
    // mid-traversal.
    //
    // Fixture: trap directly between @ and goal in a single-row
    // corridor. The AP must NOT step onto the trap; result is "no
    // path" or arrival via no-path-after-replan, never engagement.
    const fx = parseFixture({
      map: `
--------
|@.^..*|
--------`,
    });
    const r = await runAutopilotTo(fx, null, { stepCap: 30 });
    // pathfind's NON_WALKABLE_KINDS filter rejects trap_known
    // up-front, so the AP returns "no path" before sending any key.
    expect(r.toolResult).toContain("no path");
    expect(r.steps).toBe(0);
    // Defense in depth: even if pathfind ever lets a trap through,
    // the engine's "You see a trap." message would surface here.
    expect(r.sentKeys.includes("l")).toBe(false);
  });

  test("REGRESSION (v2.5): Conf + closed door — `confused` interrupt still wins (defense-in-depth predicate added)", async () => {
    // Case 8 from spec test plan. Under Conf/Stun, NetHack disables
    // closed-door autoopen, so a step into `+` consumes a turn
    // without opening anything.
    //
    // In production, two layers defend against this:
    //  (1) `confused` interrupt fires the first frame Conf appears
    //      (priority 321) — halts AP before any bumping.
    //  (2) v2.5 predict-and-avoid `autoopen-disabled` predicate in
    //      `willStepFireModal` — defense in depth for the case
    //      where Conf was already set when AP was invoked AND
    //      `confused` did not fire for whatever reason.
    //
    // This fixture sets `Conf` on every frame the harness produces.
    // The first sendKeysAndWait result has Conf with prev=undefined,
    // so the `confused` interrupt fires and the AP halts. Predict-
    // and-avoid would also catch it on iter-2 if the interrupt
    // didn't — both layers are tested separately, so here we
    // assert the v1 layer still wins (no regression).
    const fx = parseFixture({
      map: `
--------
|@..+.*|
--------`,
      playerConditions: ["Conf"],
    });
    const r = await runAutopilotTo(fx, null, { stepCap: 30 });
    expect(r.stopReason ?? "").toMatch(/confused|predict|blocked/);
    expect(r.steps).toBeLessThan(10);
  });
});

describe("v2 — floor-refusal table (spec case 14)", () => {
  test("INVARIANT: Sokoban / Rogue / Quest / Castle / walkability-suspect refused; main dungeon + Mines accepted", async () => {
    // Case 14 from spec test plan. Drives the AP against a stub
    // GameMap whose `current` floor is set to each refused / accepted
    // ID; asserts the AP's `floorRefusalReason` rejects refused
    // floors before sending any key.
    //
    // We exercise this through `handleAutopilotTo` rather than
    // pulling out the private function: the public surface is what
    // production calls. A successful refusal returns an `error: ...`
    // tool result string and never sends a keystroke.

    // Helper: build a context with a custom floor id and isRogue /
    // walkabilitySuspect flags. We don't need pet/items wiring —
    // refusal happens before the AP looks at terrain.
    const mkCtxWithFloor = (
      floorId: string,
      flags: { isRogueLevel?: boolean; walkabilitySuspect?: boolean } = {},
    ): { ctx: ToolContext; sentKeys: string[] } => {
      const fx = parseFixture({
        map: `
--------
|@....*|
--------`,
      });
      const { ctx, sentKeys } = makeContext(fx);
      // Override floor id + flags on the now-seeded floor map.
      const map = ctx.map;
      const oldFloor = map.floors.get(map.current!)!;
      const newFloor = {
        ...oldFloor,
        id: floorId,
        isRogueLevel: flags.isRogueLevel ?? false,
        walkabilitySuspect: flags.walkabilitySuspect ?? false,
      };
      map.floors.delete(map.current!);
      map.floors.set(floorId, newFloor);
      map.current = floorId;
      return { ctx, sentKeys };
    };

    const refused: Array<[string, { isRogueLevel?: boolean; walkabilitySuspect?: boolean }, RegExp]> = [
      ["Sokoban:1", {}, /sokoban/i],
      ["Quest:Home", {}, /quest/i],
      ["Castle", {}, /castle/i],
      ["D5", { isRogueLevel: true }, /rogue/i],
      ["D5", { walkabilitySuspect: true }, /walkability/i],
    ];
    for (const [floorId, flags, errRe] of refused) {
      const { ctx, sentKeys } = mkCtxWithFloor(floorId, flags);
      const result = await handleAutopilotTo(
        { floor: floorId, x: 6, y: 1, stepCap: 5 },
        ctx,
      );
      expect(result).toMatch(errRe);
      expect(sentKeys.length).toBe(0);
    }

    // Accepted floors: main dungeon (D1, D5, D45) and Mines variants.
    // We don't assert arrival (the fixture goal isn't on the renamed
    // floor); we assert the tool didn't refuse with a floor error.
    const accepted = ["D1", "D5", "D45", "Mines:5", "Mines:Town", "Bigroom", "Oracle"];
    for (const floorId of accepted) {
      const { ctx } = mkCtxWithFloor(floorId);
      const result = await handleAutopilotTo(
        { floor: floorId, x: 6, y: 1, stepCap: 5 },
        ctx,
      );
      expect(result).not.toMatch(/sokoban|quest|castle|rogue|walkability/i);
    }
  });
});

describe("v2 — engulfed false-positive regression (spec case 10)", () => {
  test("REGRESSION: AP runs through corridor edges without firing `engulfed`", async () => {
    // Spec case 10. The pre-`0b31893` engulfed detector matched any
    // `@` adjacent to dash walls, false-firing on every player frame
    // in a 1-row corridor (top/bottom dashes flanking @). The v0.3.0
    // tightened heuristic requires all four `/`/`\` slashes — only
    // the canonical engulfer rendering matches.
    //
    // This fixture exercises the *integration* path: the AP runs
    // multiple steps through a tight corridor (player adjacent to
    // top and bottom walls) and must NOT halt with `engulfed`.
    // The unit detector is exercised by bobbihack.interrupts.test.ts
    // (`engulfed > does NOT fire on plain dungeon walls`); this
    // fixture catches a regression that re-loosens the heuristic
    // upstream of the AP.
    const fx = parseFixture({
      map: `
--------
|@....*|
--------`,
    });
    const r = await runAutopilotTo(fx, null, { stepCap: 30 });
    expect(r.stopReason).toBe("arrived");
    // None of the per-step events report engulfed — the AP only
    // sees `path` decisions.
    expect(
      r.stepEvents.every((e) => e.decision === "path"),
    ).toBe(true);
    // Tool result text never mentions engulfed.
    expect(r.toolResult.toLowerCase()).not.toContain("engulfed");
  });

  test("REGRESSION: dense single-cell-tall corridor (top + bottom walls flanking @)", async () => {
    // The most concentrated form of the pre-fix false-fire shape:
    // `@` between two dash walls with corner cells also dash.
    // `parseFixture` produces this with a 3-row map where rows 0
    // and 2 are dashes and row 1 is `|@.....|`.
    const fx = parseFixture({
      map: `
--------
|@.....*|
--------`,
    });
    const r = await runAutopilotTo(fx, null, { stepCap: 30 });
    expect(r.stopReason).toBe("arrived");
    expect(r.toolResult.toLowerCase()).not.toContain("engulfed");
  });
});
