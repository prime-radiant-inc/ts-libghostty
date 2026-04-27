// query_terrain — Phase 5.
//
// Surfaces the bobbihack-owned GameMap as a tool. Two shapes:
//
//   query_terrain({})                 → {floors: [{id, firstTurn, lastTurn, tileCount}]}
//   query_terrain({floor: "D2"})      → {floor, ascii, features}
//
// Unrecorded floor names return {error}. Plain ASCII only — terrain
// glyphs are unambiguous (closed/open is in the glyph; altar alignment
// is recorded in the Dungeon journal section, not here).

import type { ToolContext } from "../tool-context";

export async function handleQueryTerrain(
  args: unknown,
  ctx: ToolContext,
): Promise<string> {
  const a = (args ?? {}) as { floor?: unknown };

  // No-arg listing: enumerate every visited floor with its bookkeeping.
  if (a.floor === undefined) {
    const floors = ctx.map.visitedFloors().map((f) => ({
      id: f.floor,
      firstTurn: f.firstTurn,
      lastTurn: f.lastTurn,
      tileCount: ctx.map.floors.get(f.floor)?.tiles.size ?? 0,
    }));
    return JSON.stringify({ floors });
  }

  if (typeof a.floor !== "string") {
    return JSON.stringify({
      error: `floor must be a string (e.g. "D1", "Mines:3"); got ${typeof a.floor}`,
    });
  }

  const floor = ctx.map.floors.get(a.floor);
  if (floor === undefined) {
    return JSON.stringify({
      error: `no map recorded for floor '${a.floor}'`,
    });
  }

  return JSON.stringify({
    floor: a.floor,
    ascii: ctx.map.renderAscii(a.floor),
    features: ctx.map.features(a.floor),
  });
}
