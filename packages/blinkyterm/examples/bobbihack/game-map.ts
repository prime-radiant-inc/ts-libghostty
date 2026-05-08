// GameMap — per-floor terrain graph + 8-connectivity A*.
// Internal infrastructure for autopilot tools and query_terrain.

import {
  classifyGlyph,
  detectBranch,
  detectPolymorph,
  detectRogueLevel,
  type StatusLine,
  type TileKind,
} from "./parsers";
import type { ClassifiedCell } from "./cell-classifier";
import { dangerWeight } from "./danger-classes";

export type FloorId = string;

export interface Tile {
  glyph: string;
  kind: TileKind;
  walkable: "yes" | "no" | "by_inference";
  lastSeenTurn: number;
}

export interface FloorMap {
  id: FloorId;
  firstSeenTurn: number;
  lastSeenTurn: number;
  tiles: Map<string, Tile>;
  isRogueLevel: boolean;
  walkabilitySuspect: boolean;
}

export interface PrecedingAction {
  tool: string;
  args: unknown;
}

export interface Step {
  x: number;
  y: number;
}

export interface Feature {
  glyph: string;
  x: number;
  y: number;
  kind: TileKind;
}

export interface UnexpectedLevelChange {
  from: FloorId;
  to: FloorId;
  reason: "trapdoor_or_hole";
  turn: number;
}

const TILE_KEY = (x: number, y: number): string => `${x},${y}`;

// Tile kinds that are passable on foot (without polymorph).
const WALKABLE_KINDS: ReadonlySet<TileKind> = new Set<TileKind>([
  "floor",
  "corridor",
  "door_open",
  "door_broken",
  "door_closed", // engine auto-opens on bump
  "stairs_up",
  "stairs_down",
  "trapdoor",
  "altar",
  "fountain",
  "sink",
  "throne",
  "grave",
]);

const NON_WALKABLE_KINDS: ReadonlySet<TileKind> = new Set<TileKind>([
  "wall",
  "boulder",
  "lava",
  "water",
  "tree",
  "trap_known",
]);

export class GameMap {
  floors: Map<FloorId, FloorMap> = new Map();
  current: FloorId | null = null;
  currentPlayerXY: { x: number; y: number } | null = null;
  lastUnexpectedLevelChange: UnexpectedLevelChange | null = null;

  // Branch state — tracked across frames; messages override.
  #activeBranch: string | null = null;

  updateFromFrame(
    rows: string[],
    status: StatusLine,
    messageLine: string,
    precedingAction?: PrecedingAction,
  ): void {
    // 1. Update branch state from message line.
    const branchHit = detectBranch(messageLine);
    if (branchHit !== null) {
      // detectBranch may return "Mines" (just the branch) or a full label
      // like "Mines:Town" or "Bigroom" (single-floor branch).
      this.#activeBranch = branchHit.includes(":") || branchHit === "Bigroom" || branchHit === "Oracle" || branchHit === "Castle"
        ? branchHit
        : branchHit;
    }

    // 2. Compute the floor ID for this frame.
    const newFloorId = this.#computeFloorId(status, branchHit);

    // 3. Detect unexpected level change (trapdoor / hole).
    const previousFloor = this.current;
    if (
      previousFloor !== null &&
      previousFloor !== newFloorId &&
      !this.#isExpectedLevelChange(precedingAction)
    ) {
      this.lastUnexpectedLevelChange = {
        from: previousFloor,
        to: newFloorId,
        reason: "trapdoor_or_hole",
        turn: status.turn,
      };
    } else {
      this.lastUnexpectedLevelChange = null;
    }

    // 4. Allocate or fetch the FloorMap.
    let floor = this.floors.get(newFloorId);
    if (floor === undefined) {
      floor = {
        id: newFloorId,
        firstSeenTurn: status.turn,
        lastSeenTurn: status.turn,
        tiles: new Map(),
        isRogueLevel: false,
        walkabilitySuspect: false,
      };
      this.floors.set(newFloorId, floor);
    }
    floor.lastSeenTurn = status.turn;

    // 5. Apply special-message side effects.
    if (detectRogueLevel(messageLine)) floor.isRogueLevel = true;
    if (detectPolymorph(messageLine)) floor.walkabilitySuspect = true;

    // 6. Walk the screen and record tiles. The map area is rows 1..21 (0-indexed)
    //    of the 80x24 screen; row 0 is the message line, rows 22-23 are status.
    //    But we don't strictly enforce this — the player's @ position determines
    //    what's the map vs status.
    let playerXY: { x: number; y: number } | null = null;
    for (let y = 0; y < rows.length; y++) {
      const row = rows[y]!;
      for (let x = 0; x < row.length; x++) {
        const ch = row[x]!;
        if (ch === "@") {
          playerXY = { x, y };
          // The tile under the player is walkable-by-inference.
          const existing = floor.tiles.get(TILE_KEY(x, y));
          if (existing === undefined) {
            floor.tiles.set(TILE_KEY(x, y), {
              glyph: ".",  // assume floor underneath
              kind: "floor",
              walkable: "by_inference",
              lastSeenTurn: status.turn,
            });
          } else {
            // Refresh freshness; don't overwrite known kind.
            existing.lastSeenTurn = status.turn;
            if (existing.walkable === "no") {
              // Player is somehow on a non-walkable tile (polymorph?).
              // Mark as by_inference and leave kind as-is.
              existing.walkable = "by_inference";
            }
          }
          continue;
        }
        const kind = classifyGlyph(ch);
        if (kind === null) {
          // Transient glyph (monster, item). Don't overwrite recorded
          // terrain; just note the tile exists. If we have no prior record,
          // mark unknown.
          const existing = floor.tiles.get(TILE_KEY(x, y));
          if (existing === undefined) {
            floor.tiles.set(TILE_KEY(x, y), {
              glyph: " ",
              kind: "unknown",
              walkable: "by_inference",
              lastSeenTurn: status.turn,
            });
          }
          continue;
        }
        if (kind === "unknown") {
          // Empty space; only record if we haven't seen this tile before.
          if (!floor.tiles.has(TILE_KEY(x, y))) {
            floor.tiles.set(TILE_KEY(x, y), {
              glyph: " ",
              kind: "unknown",
              walkable: "no",
              lastSeenTurn: status.turn,
            });
          }
          continue;
        }
        // Known terrain.
        let walkable: Tile["walkable"];
        if (WALKABLE_KINDS.has(kind)) walkable = "yes";
        else if (NON_WALKABLE_KINDS.has(kind)) walkable = "no";
        else walkable = "no";
        floor.tiles.set(TILE_KEY(x, y), {
          glyph: ch,
          kind,
          walkable,
          lastSeenTurn: status.turn,
        });
      }
    }

    // 7. Update current state.
    this.current = newFloorId;
    this.currentPlayerXY = playerXY;
  }

  // Optional `excluded` is a set of "x,y" tile keys to treat as
  // non-walkable for this call only — used by autopilot_to to feed
  // back tiles the engine refused at runtime (locked doors, peaceful
  // blockers, terrain we misclassified) so a replan routes around
  // rather than re-attempting the same path.
  //
  // Optional `classifiedGrid` is the per-frame `(terrain, foreground)`
  // tuple grid produced by `cell-classifier.ts:buildClassifiedGrid`.
  // When provided, neighbor step costs include the v2 danger-weight
  // multiplier (`danger-classes.ts:dangerWeight`) so the planner detours
  // around hostiles, danger-class monsters, the `I` unseen-monster
  // marker, and high-tier warning digits. When omitted, pathfind
  // falls back to the v1 cost model (door_closed = 1.5×, otherwise
  // 1×) — byte-identical to pre-v2 behavior so existing callers /
  // tests don't drift. See spec §"Layer 2".
  //
  // The danger weights are *finite* multipliers, never +∞: a single
  // danger-class monster increases the cost of stepping next to it
  // (the step cost becomes ~28 instead of ~1.4) but does not make
  // the path impassable. When there's no alternate route, the
  // planner still returns a path through; when an alternate of
  // length ≤ ~28 steps exists, the planner prefers it.
  pathfind(
    from: Step,
    to: Step,
    excluded?: ReadonlySet<string>,
    classifiedGrid?: ReadonlyArray<ReadonlyArray<ClassifiedCell>>,
  ): Step[] | null {
    if (this.current === null) return null;
    const floor = this.floors.get(this.current);
    if (floor === undefined) return null;
    if (floor.walkabilitySuspect) return null;
    if (from.x === to.x && from.y === to.y) return [];

    const goal = TILE_KEY(to.x, to.y);
    const goalTile = floor.tiles.get(goal);
    if (goalTile === undefined) return null;
    if (goalTile.walkable === "no") return null;
    if (excluded?.has(goal)) return null;

    // 8-connectivity A*. Simple priority-queue-as-sorted-array; grids are
    // small (80x24) so this is fine.
    interface Node {
      x: number;
      y: number;
      g: number;
      f: number;
      parent: string | null;
    }
    const open = new Map<string, Node>();
    const closed = new Map<string, Node>();
    const heuristic = (x: number, y: number): number =>
      Math.max(Math.abs(x - to.x), Math.abs(y - to.y));

    const startKey = TILE_KEY(from.x, from.y);
    open.set(startKey, {
      x: from.x,
      y: from.y,
      g: 0,
      f: heuristic(from.x, from.y),
      parent: null,
    });

    const dirs = [
      [-1, -1], [0, -1], [1, -1],
      [-1, 0],           [1, 0],
      [-1, 1],  [0, 1],  [1, 1],
    ];

    while (open.size > 0) {
      // Pop lowest-f.
      let bestKey = "";
      let bestNode: Node | null = null;
      for (const [k, n] of open) {
        if (bestNode === null || n.f < bestNode.f) {
          bestNode = n;
          bestKey = k;
        }
      }
      if (bestNode === null) break;
      open.delete(bestKey);
      closed.set(bestKey, bestNode);

      if (bestNode.x === to.x && bestNode.y === to.y) {
        // Reconstruct path.
        const path: Step[] = [];
        let cur: Node | null = bestNode;
        while (cur !== null && cur.parent !== null) {
          path.unshift({ x: cur.x, y: cur.y });
          cur = closed.get(cur.parent) ?? null;
        }
        return path;
      }

      for (const [dx, dy] of dirs) {
        const nx = bestNode.x + dx!;
        const ny = bestNode.y + dy!;
        const nKey = TILE_KEY(nx, ny);
        if (closed.has(nKey)) continue;
        if (excluded?.has(nKey)) continue;

        const tile = floor.tiles.get(nKey);
        if (tile === undefined) continue;
        if (tile.walkable === "no") continue;

        const isDiagonal = dx !== 0 && dy !== 0;
        if (isDiagonal && !this.#diagonalAllowed(floor, bestNode.x, bestNode.y, nx, ny)) {
          continue;
        }

        const stepCost = isDiagonal ? Math.SQRT2 : 1;
        // Prefer known-open doors over closed doors.
        const tileCost = tile.kind === "door_closed" ? 1.5 : 1;
        // v2: when a classified grid is provided, multiply by the
        // danger weight of the destination cell. When omitted, the
        // multiplier is 1.0 — byte-identical to the v1 cost model.
        // dangerWeight is defensive against out-of-bounds indices
        // (returns 1.0 for null/undefined cells) so we don't need
        // a guard here.
        const dangerMul =
          classifiedGrid !== undefined
            ? dangerWeight(classifiedGrid[ny]?.[nx])
            : 1.0;
        const tentativeG = bestNode.g + stepCost * tileCost * dangerMul;
        const existing = open.get(nKey);
        if (existing !== undefined && tentativeG >= existing.g) continue;

        open.set(nKey, {
          x: nx,
          y: ny,
          g: tentativeG,
          f: tentativeG + heuristic(nx, ny),
          parent: bestKey,
        });
      }
    }
    return null;
  }

  renderAscii(floorId: FloorId): string {
    const floor = this.floors.get(floorId);
    if (floor === undefined) return "";
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const tile of floor.tiles.values()) {
      // Bound by recorded tiles.
      void tile;
    }
    for (const key of floor.tiles.keys()) {
      const [xs, ys] = key.split(",");
      const x = parseInt(xs!, 10);
      const y = parseInt(ys!, 10);
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    if (minX === Infinity) return "";
    const lines: string[] = [];
    for (let y = minY; y <= maxY; y++) {
      let line = "";
      for (let x = minX; x <= maxX; x++) {
        const tile = floor.tiles.get(TILE_KEY(x, y));
        line += tile === undefined ? " " : tile.glyph;
      }
      lines.push(line.trimEnd());
    }
    return lines.join("\n");
  }

  features(floorId: FloorId): Feature[] {
    const floor = this.floors.get(floorId);
    if (floor === undefined) return [];
    const out: Feature[] = [];
    const FEATURE_KINDS: ReadonlySet<TileKind> = new Set<TileKind>([
      "stairs_up",
      "stairs_down",
      "altar",
      "fountain",
      "sink",
      "throne",
      "grave",
      "trap_known",
    ]);
    for (const [key, tile] of floor.tiles) {
      if (FEATURE_KINDS.has(tile.kind)) {
        const [xs, ys] = key.split(",");
        out.push({
          glyph: tile.glyph,
          x: parseInt(xs!, 10),
          y: parseInt(ys!, 10),
          kind: tile.kind,
        });
      }
    }
    return out;
  }

  visitedFloors(): { floor: FloorId; firstTurn: number; lastTurn: number }[] {
    const out: { floor: FloorId; firstTurn: number; lastTurn: number }[] = [];
    for (const f of this.floors.values()) {
      out.push({ floor: f.id, firstTurn: f.firstSeenTurn, lastTurn: f.lastSeenTurn });
    }
    out.sort((a, b) => a.firstTurn - b.firstTurn);
    return out;
  }

  // Internals --------------------------------------------------------------

  #computeFloorId(status: StatusLine, branchHit: string | null): FloorId {
    // If branch hit had a sublabel like "Mines:Town" or a single-floor branch
    // like "Bigroom" / "Oracle" / "Castle", use that directly.
    if (branchHit !== null) {
      if (branchHit.includes(":")) return branchHit;
      if (branchHit === "Bigroom" || branchHit === "Oracle" || branchHit === "Castle") {
        return branchHit;
      }
      // Otherwise it's just a branch label (e.g. "Mines", "Sokoban", "Quest");
      // combine with dlvl below.
      this.#activeBranch = branchHit;
    }
    if (this.#activeBranch !== null) {
      return `${this.#activeBranch}:${status.dlvl}`;
    }
    return `D${status.dlvl}`;
  }

  #isExpectedLevelChange(precedingAction?: PrecedingAction): boolean {
    if (precedingAction === undefined) return false;
    if (precedingAction.tool !== "move") return false;
    const args = precedingAction.args as { direction?: string };
    return args.direction === "up" || args.direction === "down";
  }

  #diagonalAllowed(
    floor: FloorMap,
    fromX: number,
    fromY: number,
    toX: number,
    toY: number,
  ): boolean {
    const fromTile = floor.tiles.get(TILE_KEY(fromX, fromY));
    const toTile = floor.tiles.get(TILE_KEY(toX, toY));
    // No diagonal through a door tile (either side).
    if (fromTile !== undefined && (fromTile.kind === "door_open" || fromTile.kind === "door_closed")) return false;
    if (toTile !== undefined && (toTile.kind === "door_open" || toTile.kind === "door_closed")) return false;
    // No diagonal squeeze past a boulder at either of the two cardinal
    // intermediates.
    const inter1 = floor.tiles.get(TILE_KEY(fromX, toY));
    const inter2 = floor.tiles.get(TILE_KEY(toX, fromY));
    if (inter1?.kind === "boulder" || inter2?.kind === "boulder") return false;
    // No squeezing through the corner where both intermediate tiles are walls.
    if (inter1?.kind === "wall" && inter2?.kind === "wall") return false;
    return true;
  }
}
