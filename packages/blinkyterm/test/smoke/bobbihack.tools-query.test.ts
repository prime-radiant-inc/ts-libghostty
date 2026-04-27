// Tests for handleQueryTerrain — Phase 5.
//
// query_terrain({floor}) returns {floor, ascii, features} for a recorded
// floor. query_terrain({}) (no floor arg) returns {floors: [{id,
// firstTurn, lastTurn, tileCount}]} listing visited floors. Unrecorded
// floor names return {error}.
//
// The handler reads from ctx.map (the GameMap). renderAscii / features /
// visitedFloors are existing GameMap methods (Phase 1) — this is a thin
// wiring tool.

import { describe, expect, test } from "bun:test";
import { handleQueryTerrain } from "../../examples/bobbihack/tools/query";
import { GameMap } from "../../examples/bobbihack/game-map";
import type { StatusLine } from "../../examples/bobbihack/parsers";
import type { ToolContext } from "../../examples/bobbihack/tool-context";

function status(dlvl: number, turn: number): StatusLine {
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
    dlvl,
    turn,
    gold: 0,
    hunger: "ok",
    conditions: [],
  };
}

function frame(rowSpecs: string[]): string[] {
  const rows = rowSpecs.map((r) => r.padEnd(80, " "));
  while (rows.length < 24) rows.push(" ".repeat(80));
  return rows.slice(0, 24);
}

function ctxFrom(map: GameMap): ToolContext {
  const ac = new AbortController();
  return {
    map,
    runState: { gameOver: false, endReason: null },
    signal: ac.signal,
    journalDir: "",
    sendKeysAndWait: async () => {
      throw new Error("sendKeysAndWait should not be called by query_terrain");
    },
  };
}

describe("handleQueryTerrain — single-floor query", () => {
  test("returns ascii + features for a known floor matching GameMap.renderAscii", async () => {
    const m = new GameMap();
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
    const ctx = ctxFrom(m);
    const out = await handleQueryTerrain({ floor: "D1" }, ctx);
    const parsed = JSON.parse(out) as {
      floor: string;
      ascii: string;
      features: { glyph: string; x: number; y: number; kind: string }[];
    };
    expect(parsed.floor).toBe("D1");
    expect(parsed.ascii).toBe(m.renderAscii("D1"));
    expect(parsed.features).toEqual(m.features("D1"));
  });

  test("includes recorded features (e.g. stairs_down)", async () => {
    const m = new GameMap();
    const f = frame([
      "",
      "",
      "",
      "",
      "  -----",
      "  |.@.|",
      "  |.>.|",
      "  -----",
    ]);
    m.updateFromFrame(f, status(1, 1), "");
    const ctx = ctxFrom(m);
    const out = await handleQueryTerrain({ floor: "D1" }, ctx);
    const parsed = JSON.parse(out) as {
      features: { glyph: string; x: number; y: number; kind: string }[];
    };
    expect(parsed.features.some((feat) => feat.kind === "stairs_down")).toBe(true);
  });

  test("returns error for an unvisited floor", async () => {
    const m = new GameMap();
    const f = frame([
      "",
      "",
      "  ---",
      "  |@|",
      "  ---",
    ]);
    m.updateFromFrame(f, status(1, 1), "");
    const ctx = ctxFrom(m);
    const out = await handleQueryTerrain({ floor: "D5" }, ctx);
    const parsed = JSON.parse(out) as { error: string };
    expect(parsed.error).toBeDefined();
    expect(parsed.error).toContain("D5");
  });

  test("rejects non-string floor argument with an error", async () => {
    const m = new GameMap();
    const ctx = ctxFrom(m);
    const out = await handleQueryTerrain({ floor: 5 }, ctx);
    const parsed = JSON.parse(out) as { error: string };
    expect(parsed.error).toBeDefined();
  });
});

describe("handleQueryTerrain — no-arg listing", () => {
  test("returns an empty floors list before any frames", async () => {
    const m = new GameMap();
    const ctx = ctxFrom(m);
    const out = await handleQueryTerrain({}, ctx);
    const parsed = JSON.parse(out) as {
      floors: { id: string; firstTurn: number; lastTurn: number; tileCount: number }[];
    };
    expect(parsed.floors).toEqual([]);
  });

  test("treats undefined floor as no-arg listing", async () => {
    const m = new GameMap();
    m.updateFromFrame(
      frame(["", "", "  ---", "  |@|", "  ---"]),
      status(1, 1),
      "",
    );
    const ctx = ctxFrom(m);
    // floor: undefined should behave the same as omitting floor.
    const out = await handleQueryTerrain({ floor: undefined }, ctx);
    const parsed = JSON.parse(out) as {
      floors?: { id: string }[];
      error?: string;
    };
    expect(parsed.error).toBeUndefined();
    expect(parsed.floors).toBeDefined();
    expect(parsed.floors?.length).toBe(1);
  });

  test("lists each visited floor with id, firstTurn, lastTurn, tileCount", async () => {
    const m = new GameMap();
    // Visit D1 first.
    m.updateFromFrame(
      frame([
        "",
        "",
        "  -----",
        "  |.@.|",
        "  -----",
      ]),
      status(1, 1),
      "",
    );
    // Step deeper to D2 (tracked as a separate floor).
    m.updateFromFrame(
      frame([
        "",
        "",
        "  ---",
        "  |@|",
        "  ---",
      ]),
      status(2, 5),
      "",
      { tool: "move", args: { direction: "down" } },
    );
    const ctx = ctxFrom(m);
    const out = await handleQueryTerrain({}, ctx);
    const parsed = JSON.parse(out) as {
      floors: { id: string; firstTurn: number; lastTurn: number; tileCount: number }[];
    };
    expect(parsed.floors.length).toBe(2);
    const d1 = parsed.floors.find((f) => f.id === "D1");
    const d2 = parsed.floors.find((f) => f.id === "D2");
    expect(d1).toBeDefined();
    expect(d2).toBeDefined();
    expect(d1?.firstTurn).toBe(1);
    expect(d2?.firstTurn).toBe(5);
    expect(d1?.tileCount).toBeGreaterThan(0);
    expect(d2?.tileCount).toBeGreaterThan(0);
  });

  test("floors list is sorted by firstTurn (chronological visit order)", async () => {
    const m = new GameMap();
    m.updateFromFrame(
      frame(["", "", "  ---", "  |@|", "  ---"]),
      status(1, 1),
      "",
    );
    m.updateFromFrame(
      frame(["", "", "  ---", "  |@|", "  ---"]),
      status(2, 7),
      "",
      { tool: "move", args: { direction: "down" } },
    );
    const ctx = ctxFrom(m);
    const out = await handleQueryTerrain({}, ctx);
    const parsed = JSON.parse(out) as {
      floors: { id: string; firstTurn: number }[];
    };
    expect(parsed.floors.map((f) => f.id)).toEqual(["D1", "D2"]);
  });
});
