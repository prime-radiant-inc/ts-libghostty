import { describe, expect, test } from "bun:test";
import { GameMap } from "../../examples/bobbihack/game-map";
import type { StatusLine } from "../../examples/bobbihack/parsers";

// Minimal status helper for tests — only the dlvl + turn matter for floor
// identity and freshness tracking.
function status(dlvl: number, turn: number, hp = 14): StatusLine {
  return {
    name: "Hero",
    title: "the Stripling",
    attrs: { st: "18", dx: 11, co: 14, in: 11, wi: 13, ch: 7 },
    alignment: "Lawful",
    ac: 7,
    hp,
    hpMax: 14,
    pw: 0,
    pwMax: 0,
    level: 1,
    xp: 0,
    dlvl,
    turn,
    gold: 0,
    hunger: "ok",
    conditions: [],
  };
}

// Minimal 80x24 frame builder — rows is the visible glyph grid.
function frame(rowSpecs: string[]): string[] {
  // Pad each row to 80 chars; pad the array to 24 rows.
  const rows = rowSpecs.map((r) => r.padEnd(80, " "));
  while (rows.length < 24) rows.push(" ".repeat(80));
  return rows.slice(0, 24);
}

describe("GameMap construction", () => {
  test("starts empty", () => {
    const m = new GameMap();
    expect(m.current).toBeNull();
    expect(m.currentPlayerXY).toBeNull();
    expect(m.visitedFloors()).toEqual([]);
    // v2: classified-grid cache starts empty.
    expect(m.latestClassified).toBeNull();
  });

  test("query methods return well-formed empty results before any frame", () => {
    const m = new GameMap();
    expect(m.renderAscii("D1")).toBe("");
    expect(m.features("D1")).toEqual([]);
    expect(m.pathfind({ x: 0, y: 0 }, { x: 5, y: 5 })).toBeNull();
  });
});

describe("GameMap.updateFromFrame", () => {
  test("records terrain glyphs and player position from a single frame", () => {
    const m = new GameMap();
    // 5-tile-wide room with player at (3, 5)
    const f = frame([
      "",
      "",
      "",
      "",
      "  -----",
      "  |...|",
      "  |.@.|",
      "  |...|",
      "  -----",
    ]);
    m.updateFromFrame(f, status(1, 1), "");
    expect(m.current).toBe("D1");
    // Row 6, "  |.@.|" — @ is at column 4 (0-indexed: 0=' ', 1=' ', 2='|', 3='.', 4='@')
    expect(m.currentPlayerXY).toEqual({ x: 4, y: 6 });
    expect(m.visitedFloors().length).toBe(1);

    const features = m.features("D1");
    // Walls + floors recorded; no stairs/altars in this room.
    expect(features.find((f) => f.kind === "altar")).toBeUndefined();
    // The tile under the player is "by_inference" walkable.
    const ascii = m.renderAscii("D1");
    expect(ascii).toContain("|"); // walls
    expect(ascii).toContain(".");  // floor
    expect(ascii).not.toContain("@"); // no player glyph in terrain render
  });

  test("lastSeenTurn updates monotonically across frames", () => {
    const m = new GameMap();
    const f1 = frame(["", "", "", "  ---", "  |.|", "  |@|", "  ---"]);
    const f2 = frame(["", "", "", "  ---", "  |.|", "  |@|", "  ---"]);
    m.updateFromFrame(f1, status(1, 5), "");
    m.updateFromFrame(f2, status(1, 17), "");
    // Internal turn tracking should reflect the latest update.
    const visited = m.visitedFloors();
    expect(visited[0]?.firstTurn).toBe(5);
    expect(visited[0]?.lastTurn).toBe(17);
  });

  test("branch transition allocates a new FloorMap", () => {
    const m = new GameMap();
    const f1 = frame(["", "", "", "  ---", "  |@|", "  ---"]);
    m.updateFromFrame(f1, status(1, 1), "");
    // Enter Mines on the next frame.
    const f2 = frame(["", "", "", "  ###", "  #@#", "  ###"]);
    m.updateFromFrame(f2, status(2, 5), "You enter the Gnomish Mines.");
    expect(m.current).toBe("Mines:2");
    expect(m.visitedFloors().length).toBe(2);
    expect(m.visitedFloors().map((v) => v.floor)).toContain("D1");
    expect(m.visitedFloors().map((v) => v.floor)).toContain("Mines:2");
  });

  test("level_changed_unexpectedly: dlvl change without move(up/down) flags trapdoor", () => {
    const m = new GameMap();
    const f1 = frame(["", "", "", "  ---", "  |@|", "  ---"]);
    m.updateFromFrame(f1, status(1, 1), "", { tool: "move", args: { direction: "east" } });
    // Player on D1 walks east; unexpected drop to D2.
    const f2 = frame(["", "", "", "  ---", "  |@|", "  ---"]);
    m.updateFromFrame(f2, status(2, 2), "You fall into a pit!", {
      tool: "move",
      args: { direction: "east" },
    });
    expect(m.lastUnexpectedLevelChange?.from).toBe("D1");
    expect(m.lastUnexpectedLevelChange?.to).toBe("D2");
    expect(m.lastUnexpectedLevelChange?.reason).toBe("trapdoor_or_hole");
  });

  test("dlvl change with move(down) is expected, not flagged", () => {
    const m = new GameMap();
    const f1 = frame(["", "", "", "  ---", "  |@|", "  ---"]);
    m.updateFromFrame(f1, status(1, 1), "", { tool: "move", args: { direction: "down" } });
    const f2 = frame(["", "", "", "  ---", "  |@|", "  ---"]);
    m.updateFromFrame(f2, status(2, 2), "", { tool: "move", args: { direction: "down" } });
    expect(m.lastUnexpectedLevelChange).toBeNull();
  });

  test("polymorph message sets walkabilitySuspect on current floor", () => {
    const m = new GameMap();
    m.updateFromFrame(
      frame(["", "", "", "  ---", "  |@|", "  ---"]),
      status(1, 1),
      "",
    );
    m.updateFromFrame(
      frame(["", "", "", "  ---", "  |@|", "  ---"]),
      status(1, 2),
      "You suddenly turn into a xorn!",
    );
    const floor = m.floors.get("D1");
    expect(floor?.walkabilitySuspect).toBe(true);
  });

  test("rogue level detection sets isRogueLevel", () => {
    const m = new GameMap();
    m.updateFromFrame(
      frame(["", "", "", "  ---", "  |@|", "  ---"]),
      status(1, 1),
      "",
    );
    m.updateFromFrame(
      frame(["", "", "", "  ---", "  |@|", "  ---"]),
      status(15, 100),
      "You enter what seems to be an older, more primitive world.",
    );
    const floor = m.floors.get("D15");
    expect(floor?.isRogueLevel).toBe(true);
  });
});

describe("GameMap.pathfind", () => {
  test("returns null for impossible target on unmapped floor", () => {
    const m = new GameMap();
    expect(m.pathfind({ x: 0, y: 0 }, { x: 5, y: 5 })).toBeNull();
  });

  test("finds straight-line path in an open room", () => {
    const m = new GameMap();
    const f = frame([
      "",
      "",
      "",
      "  --------",
      "  |......|",
      "  |@.....|",
      "  |......|",
      "  --------",
    ]);
    m.updateFromFrame(f, status(1, 1), "");
    const path = m.pathfind({ x: 3, y: 5 }, { x: 8, y: 5 });
    expect(path).not.toBeNull();
    expect(path!.length).toBe(5); // 5 steps east
  });

  test("returns null when start and end are the same", () => {
    const m = new GameMap();
    const f = frame(["", "", "", "  ---", "  |@|", "  ---"]);
    m.updateFromFrame(f, status(1, 1), "");
    expect(m.pathfind({ x: 3, y: 4 }, { x: 3, y: 4 })).toEqual([]);
  });

  test("8-connectivity: diagonal step is one move", () => {
    const m = new GameMap();
    const f = frame([
      "",
      "",
      "",
      "  -----",
      "  |@..|",
      "  |...|",
      "  |..X|", // X marker for target tile (it's actually floor)
      "  -----",
    ]);
    // Replace X with . so it's recorded as floor; we'll pathfind to (5,6).
    f[6] = "  |...|".padEnd(80, " ");
    m.updateFromFrame(f, status(1, 1), "");
    const path = m.pathfind({ x: 3, y: 4 }, { x: 5, y: 6 });
    expect(path).not.toBeNull();
    // Two diagonal steps from (3,4) → (4,5) → (5,6) = 2 steps.
    expect(path!.length).toBe(2);
  });

  test("diagonal-doorway rule: cannot move diagonally through a closed door", () => {
    const m = new GameMap();
    const f = frame([
      "",
      "",
      "",
      "  -----",
      "  |@..|",
      "  --+--",   // closed door at the bottom
      "  |...|",
      "  -----",
    ]);
    m.updateFromFrame(f, status(1, 1), "");
    // Trying to step diagonally from (3,4) to (4,5) — but (4,5) is the door
    // position, and a diagonal hop bypassing would go through the door space.
    // Direct adjacency rule: any path that traverses the door must use a
    // cardinal step into the door tile.
    const path = m.pathfind({ x: 3, y: 4 }, { x: 5, y: 6 });
    if (path !== null) {
      // Verify no step in path moves diagonally INTO the door tile.
      let prev = { x: 3, y: 4 };
      for (const step of path) {
        const dx = step.x - prev.x;
        const dy = step.y - prev.y;
        const isDiagonal = dx !== 0 && dy !== 0;
        const intoDoor = step.x === 4 && step.y === 5;
        expect(isDiagonal && intoDoor).toBe(false);
        prev = step;
      }
    }
  });

  test("refuses to plan on walkability-suspect floor", () => {
    const m = new GameMap();
    m.updateFromFrame(
      frame(["", "", "", "  -----", "  |@..|", "  -----"]),
      status(1, 1),
      "",
    );
    m.updateFromFrame(
      frame(["", "", "", "  -----", "  |@..|", "  -----"]),
      status(1, 2),
      "You suddenly turn into a xorn!",
    );
    const path = m.pathfind({ x: 3, y: 4 }, { x: 5, y: 4 });
    expect(path).toBeNull();
  });
});

// v2 (Phase 2 of NetHack-aware autopilot): pathfind consumes an
// optional ClassifiedCell grid and applies danger-weight multipliers
// to step costs. When the grid is omitted, behavior must be identical
// to the v1 cost model — the existing tests above exercise that
// invariant. The tests below exercise the v2 behavior directly.
describe("GameMap.pathfind (v2 danger-aware costs)", () => {
  test("classifiedGrid is optional — omitting it does not change paths", () => {
    // Open 5x3 corridor: @ at (3,5), goal at (8,5). Without the grid
    // the path is the v1 straight-line. Calling with `undefined` for
    // both excluded and classifiedGrid must produce the same path
    // shape.
    const m = new GameMap();
    const f = frame([
      "",
      "",
      "",
      "  ----------",
      "  |........|",
      "  |@.......|",
      "  |........|",
      "  ----------",
    ]);
    m.updateFromFrame(f, status(1, 1), "");
    const baseline = m.pathfind({ x: 3, y: 5 }, { x: 8, y: 5 });
    const withUndef = m.pathfind(
      { x: 3, y: 5 },
      { x: 8, y: 5 },
      undefined,
      undefined,
    );
    expect(withUndef).toEqual(baseline);
    expect(baseline?.length).toBe(5);
  });

  test("a danger-class monster on the shortest path makes the planner detour", () => {
    // Two-row corridor: row 5 holds a 'D' (dragon, danger-class) at
    // (5,5); row 6 is open floor. Without the v2 grid pathfind takes
    // row 5 (5 steps); with the v2 grid it should detour via row 6.
    const m = new GameMap();
    const f = frame([
      "",
      "",
      "",
      "  ----------",
      "  |........|",
      "  |@.......|", // row 5
      "  |........|", // row 6
      "  ----------",
    ]);
    m.updateFromFrame(f, status(1, 1), "");

    const goal = { x: 8, y: 5 };
    const start = { x: 3, y: 5 };

    // Build a classified grid where (5,5) hosts a non-pet dragon.
    const cols = 80;
    const rows2d: ReadonlyArray<ReadonlyArray<{
      terrain: null;
      foreground:
        | { kind: "monster"; letter: string; class: "dragon"; color: number;
            pet: boolean; bold: boolean; }
        | null;
    }>> = (() => {
      const g: {
        terrain: null;
        foreground:
          | { kind: "monster"; letter: string; class: "dragon"; color: number;
              pet: boolean; bold: boolean; }
          | null;
      }[][] = [];
      for (let y = 0; y < 24; y++) {
        const line: typeof g[number] = new Array(cols);
        for (let x = 0; x < cols; x++) {
          line[x] = { terrain: null, foreground: null };
        }
        g.push(line);
      }
      g[5]![5] = {
        terrain: null,
        foreground: {
          kind: "monster",
          letter: "D",
          class: "dragon",
          color: 7,
          pet: false,
          bold: false,
        },
      };
      return g;
    })();

    const v1 = m.pathfind(start, goal);
    const v2 = m.pathfind(start, goal, undefined, rows2d as never);

    // The v1 path passes through (5,5) — the shortest line.
    expect(v1?.some((s) => s.x === 5 && s.y === 5)).toBe(true);
    // The v2 path avoids (5,5) — detouring via row 6 (or row 4).
    expect(v2).not.toBeNull();
    expect(v2!.some((s) => s.x === 5 && s.y === 5)).toBe(false);
  });

  test("a pet on the path costs nothing — does not detour", () => {
    // Same shape as above, but the 'd' at (5,5) is the pet.
    // dangerWeight returns 1.0 for pets, so the planner takes the
    // shortest line through.
    const m = new GameMap();
    const f = frame([
      "",
      "",
      "",
      "  ----------",
      "  |........|",
      "  |@.......|",
      "  |........|",
      "  ----------",
    ]);
    m.updateFromFrame(f, status(1, 1), "");

    const cols = 80;
    const grid: { terrain: null; foreground: unknown }[][] = [];
    for (let y = 0; y < 24; y++) {
      const line: { terrain: null; foreground: unknown }[] = [];
      for (let x = 0; x < cols; x++) {
        line.push({ terrain: null, foreground: null });
      }
      grid.push(line);
    }
    grid[5]![5] = {
      terrain: null,
      foreground: {
        kind: "monster",
        letter: "d",
        class: "dog",
        color: 7,
        pet: true,
        bold: false,
      },
    };

    const path = m.pathfind({ x: 3, y: 5 }, { x: 8, y: 5 }, undefined, grid as never);
    expect(path).not.toBeNull();
    expect(path!.some((s) => s.x === 5 && s.y === 5)).toBe(true);
  });

  test("a danger-class monster does NOT block a path when no detour exists", () => {
    // Single-tile-wide corridor: only one route. Even at 20× cost
    // the planner must still return the path — the multiplier is
    // finite, never +∞.
    const m = new GameMap();
    const f = frame([
      "",
      "",
      "",
      "  -----",
      "  |...|",
      "  -----",
    ]);
    m.updateFromFrame(f, status(1, 1), "");

    const cols = 80;
    const grid: { terrain: null; foreground: unknown }[][] = [];
    for (let y = 0; y < 24; y++) {
      const line: { terrain: null; foreground: unknown }[] = [];
      for (let x = 0; x < cols; x++) {
        line.push({ terrain: null, foreground: null });
      }
      grid.push(line);
    }
    grid[4]![4] = {
      terrain: null,
      foreground: {
        kind: "monster",
        letter: "D",
        class: "dragon",
        color: 7,
        pet: false,
        bold: false,
      },
    };

    const path = m.pathfind({ x: 3, y: 4 }, { x: 5, y: 4 }, undefined, grid as never);
    expect(path).not.toBeNull();
    expect(path!.length).toBe(2);
  });

  test("excluded set composes with classifiedGrid", () => {
    // (5,5) is excluded explicitly AND has a hostile in the
    // classified grid. The exclusion should make pathfind treat
    // (5,5) as non-walkable; the danger weight is irrelevant on an
    // excluded tile.
    const m = new GameMap();
    const f = frame([
      "",
      "",
      "",
      "  ----------",
      "  |........|",
      "  |@.......|",
      "  |........|",
      "  ----------",
    ]);
    m.updateFromFrame(f, status(1, 1), "");

    const cols = 80;
    const grid: { terrain: null; foreground: unknown }[][] = [];
    for (let y = 0; y < 24; y++) {
      const line: { terrain: null; foreground: unknown }[] = [];
      for (let x = 0; x < cols; x++) {
        line.push({ terrain: null, foreground: null });
      }
      grid.push(line);
    }
    grid[5]![5] = {
      terrain: null,
      foreground: {
        kind: "monster",
        letter: "o",
        class: "orc",
        color: 7,
        pet: false,
        bold: false,
      },
    };

    const excluded = new Set<string>(["5,5"]);
    const path = m.pathfind(
      { x: 3, y: 5 },
      { x: 8, y: 5 },
      excluded,
      grid as never,
    );
    expect(path).not.toBeNull();
    expect(path!.some((s) => s.x === 5 && s.y === 5)).toBe(false);
  });
});

describe("GameMap.renderAscii", () => {
  test("returns terrain glyphs only (no @, monsters, items)", () => {
    const m = new GameMap();
    const f = frame([
      "",
      "",
      "",
      "  -----",
      "  |.@.|",
      "  |.d.|",  // dog (monster)
      "  |.$.|",  // gold (item)
      "  -----",
    ]);
    m.updateFromFrame(f, status(1, 1), "");
    const ascii = m.renderAscii("D1");
    expect(ascii).not.toContain("@");
    expect(ascii).not.toContain("d");
    expect(ascii).not.toContain("$");
    expect(ascii).toContain("|");
    expect(ascii).toContain(".");
  });

  test("returns empty string for unknown floor", () => {
    const m = new GameMap();
    expect(m.renderAscii("D99")).toBe("");
  });
});

describe("GameMap.features", () => {
  test("lists stairs, altars, fountains", () => {
    const m = new GameMap();
    const f = frame([
      "",
      "",
      "",
      "  -------",
      "  |.<.>.|",
      "  |.@._.|",
      "  |.{...|",
      "  -------",
    ]);
    m.updateFromFrame(f, status(1, 1), "");
    const features = m.features("D1");
    expect(features.find((f) => f.kind === "stairs_up")).toBeDefined();
    expect(features.find((f) => f.kind === "stairs_down")).toBeDefined();
    expect(features.find((f) => f.kind === "altar")).toBeDefined();
    expect(features.find((f) => f.kind === "fountain")).toBeDefined();
  });
});

describe("GameMap.visitedFloors", () => {
  test("returns ordered list with turn ranges", () => {
    const m = new GameMap();
    m.updateFromFrame(frame(["", "", "", "  ---", "  |@|", "  ---"]), status(1, 1), "");
    m.updateFromFrame(frame(["", "", "", "  ---", "  |@|", "  ---"]), status(1, 5), "");
    m.updateFromFrame(
      frame(["", "", "", "  ---", "  |@|", "  ---"]),
      status(2, 6),
      "",
      { tool: "move", args: { direction: "down" } },
    );
    const v = m.visitedFloors();
    expect(v.length).toBe(2);
    expect(v[0]).toEqual({ floor: "D1", firstTurn: 1, lastTurn: 5 });
    expect(v[1]?.floor).toBe("D2");
    expect(v[1]?.firstTurn).toBe(6);
  });
});
