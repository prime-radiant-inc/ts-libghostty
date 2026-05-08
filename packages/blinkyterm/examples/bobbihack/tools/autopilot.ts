// Phase 6 + 7 — autopilot tools.
//
//   autopilot_to({floor, x, y, stepCap?})  — A* point-to-point.
//   autopilot_explore({stepCap?})           — frontier-policy walk.
//
// Both compress many game turns into a single LLM call. Each step:
// (1) chooses a direction, (2) sends the corresponding vi-key keystroke,
// (3) awaits the next frame, (4) updates the GameMap, (5) runs the
// interrupt list. If any interrupt fires (or step-cap is hit, or path
// arrived, or frontier is exhausted), the loop terminates and the tool
// returns a standard tool_result blob.
//
// Safety:
//   - never plans through a `trap_known` tile (already enforced by
//     GameMap.pathfind via the NON_WALKABLE_KINDS list)
//   - never sends '<' or '>' (only compass keys), so cannot accidentally
//     descend stairs
//   - refuses Sokoban / Rogue level / walkability-suspect floors
//   - re-checks `trap_known` on the next-planned tile each iteration in
//     case a trap was revealed mid-traversal

import type { GameMap, Step, FloorMap, Tile } from "../game-map";
import type { ToolContext, FrameAwaitResult } from "../tool-context";
import {
  runInterruptChecks,
  type InterruptContext,
  type InterruptFrame,
  type InterruptResult,
} from "../interrupts";
import { formatToolResult } from "../tool-result";
import type { TileKind } from "../parsers";

const DEFAULT_STEP_CAP = 50;

// (dx, dy) → vi-key.
// Append a NetHack engine message to a stop-reason code so the user
// sees both the structured reason and the human-readable cause:
//   "blocked_unreachable: \"The door is locked.\""
function withMessage(reason: string, message: string): string {
  if (message.length === 0) return reason;
  return `${reason}: ${JSON.stringify(message)}`;
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}

function deltaToViKey(dx: number, dy: number): string | null {
  if (dx === -1 && dy === -1) return "y"; // NW
  if (dx === 0 && dy === -1) return "k";  // N
  if (dx === 1 && dy === -1) return "u";  // NE
  if (dx === -1 && dy === 0) return "h";  // W
  if (dx === 1 && dy === 0) return "l";   // E
  if (dx === -1 && dy === 1) return "b";  // SW
  if (dx === 0 && dy === 1) return "j";   // S
  if (dx === 1 && dy === 1) return "n";   // SE
  return null;
}

function errJson(error: string): string {
  return JSON.stringify({ error });
}

// Build an InterruptFrame from a sendKeysAndWait result.
function frameFromResult(r: FrameAwaitResult): InterruptFrame & { frameReason: string } {
  return {
    rows: r.rows,
    glyphClass: r.glyphClass,
    status: r.status,
    message: r.message,
    frameReason: r.frameReason,
  };
}

// Format an interrupt-result hit list for a summary line.
//   primary detail              -> "monster_visible (k at (8,12))"
//   primary, no detail          -> "modal_prompt"
//   primary + also              -> "monster_visible (...). also: low_hp, hunger_transition"
function formatInterruptSummary(r: InterruptResult): string {
  if (r.primary === null) return "";
  const head =
    r.primary.detail !== undefined
      ? `${r.primary.name} (${r.primary.detail})`
      : r.primary.name;
  if (r.also.length === 0) return head;
  const alsoNames = r.also.map((h) => h.name).join(", ");
  return `${head}. also: ${alsoNames}`;
}

// Refuse-floor predicate. Returns the reason string, or null if OK.
function floorRefusalReason(floor: FloorMap): string | null {
  if (floor.id.includes("Sokoban")) return "sokoban floor — manual play required";
  if (floor.isRogueLevel) return "rogue level — manual play required";
  if (floor.walkabilitySuspect) {
    return "walkability suspect (polymorph?) — manual play required";
  }
  return null;
}

// ---------------------------------------------------------------------------
// autopilot_to

interface AutopilotToArgs {
  floor: string;
  x: number;
  y: number;
  stepCap?: number;
}

function isAutopilotToArgs(args: unknown): args is AutopilotToArgs {
  if (typeof args !== "object" || args === null) return false;
  const a = args as Record<string, unknown>;
  if (typeof a.floor !== "string") return false;
  if (typeof a.x !== "number" || !Number.isInteger(a.x)) return false;
  if (typeof a.y !== "number" || !Number.isInteger(a.y)) return false;
  if (a.stepCap !== undefined && (typeof a.stepCap !== "number" || a.stepCap < 1)) {
    return false;
  }
  return true;
}

export async function handleAutopilotTo(
  args: unknown,
  ctx: ToolContext,
): Promise<string> {
  if (!isAutopilotToArgs(args)) {
    return errJson(
      "invalid args. Expected {floor: string, x: integer, y: integer, stepCap?: integer}.",
    );
  }
  const { floor: floorId, x: goalX, y: goalY } = args;
  const stepCap = Math.max(1, Math.floor(args.stepCap ?? DEFAULT_STEP_CAP));

  const map = ctx.map;
  if (map.current === null) return errJson("no map recorded yet");

  const floor = map.floors.get(floorId);
  if (floor === undefined) return errJson(`unknown floor '${floorId}'`);

  // Autopilot can't traverse stairs/portals; if the target floor isn't the
  // current floor, the agent must navigate to a stair tile first.
  if (floorId !== map.current) {
    return errJson(
      `cannot autopilot across floors. Current floor: ${map.current}; requested: ${floorId}. Use move(up)/move(down) on stairs.`,
    );
  }

  const refusal = floorRefusalReason(floor);
  if (refusal !== null) return errJson(refusal);

  const goalKey = `${goalX},${goalY}`;
  const goalTile = floor.tiles.get(goalKey);
  if (goalTile === undefined || goalTile.kind === "unknown") {
    return errJson(`unknown tile (${goalX}, ${goalY}) on floor '${floorId}'`);
  }

  if (map.currentPlayerXY === null) return errJson("player position unknown");

  const start: Step = { x: map.currentPlayerXY.x, y: map.currentPlayerXY.y };
  const goal: Step = { x: goalX, y: goalY };

  // Initial planning: refuses goals on `trap_known` tiles or any goal not
  // reachable through walkable tiles. (GameMap.pathfind already excludes
  // trap_known tiles from the search.)
  let path = map.pathfind(start, goal);
  if (path === null) {
    return errJson("no path");
  }
  if (path.length === 0) {
    // Already on goal.
    return formatArrivedResult(ctx, 0, "");
  }

  let prevFrame: InterruptFrame | undefined;
  let lastResult: FrameAwaitResult | null = null;
  let stepsTaken = 0;
  let stopReason: string | null = null;
  // Tiles where the engine refused to let us step in this run (locked
  // doors, mimics, terrain we misclassified). pathfind doesn't know
  // about these — its walkability comes from GameMap, which only
  // reflects what the map view shows. Without tracking these locally
  // we'd replan and get the same path back, looping forever.
  const blockedTiles = new Set<string>();
  // The most recent NetHack message captured at a non-movement step.
  // Surfaced in the stop reason and live progress so the user sees WHY
  // we got stuck ("The door is locked.") rather than a bare code.
  let lastBlockMessage = "";

  while (stepsTaken < stepCap) {
    if (ctx.signal.aborted) {
      stopReason = "abort_signal";
      break;
    }

    // Re-check current player position; replan if we drifted off-plan.
    const cur = map.currentPlayerXY;
    if (cur === null) {
      stopReason = "player_position_lost";
      break;
    }
    if (cur.x === goal.x && cur.y === goal.y) break;

    // If the path is empty or its first step doesn't begin from cur, replan.
    if (path === null || path.length === 0) {
      path = map.pathfind(cur, goal, blockedTiles);
      if (path === null || path.length === 0) {
        stopReason = withMessage("no_path_after_replan", lastBlockMessage);
        break;
      }
    }

    const next = path[0]!;
    // Trap-protection: if the next planned tile is now classified
    // trap_known (revealed mid-traversal), halt without stepping.
    const nextTile = floor.tiles.get(`${next.x},${next.y}`);
    if (nextTile !== undefined && nextTile.kind === "trap_known") {
      stopReason = "entered_trap_tile";
      // The interrupt fires "before stepping in" — populate also[] empty.
      break;
    }

    const dx = next.x - cur.x;
    const dy = next.y - cur.y;
    const key = deltaToViKey(dx, dy);
    if (key === null) {
      // Path step is non-adjacent → corruption; replan.
      path = map.pathfind(cur, goal, blockedTiles);
      if (path === null || path.length === 0) {
        stopReason = withMessage("no_path_after_replan", lastBlockMessage);
        break;
      }
      continue;
    }

    const result = await ctx.sendKeysAndWait(key);
    lastResult = result;
    stepsTaken += 1;
    ctx.reportProgress?.(`${stepsTaken}/${stepCap}`);

    // Per-step trace.
    {
      const after = map.currentPlayerXY;
      const moved = after !== null && (after.x !== cur.x || after.y !== cur.y);
      ctx.logAutopilotStep?.({
        tool: "autopilot_to",
        step: stepsTaken,
        key,
        dx,
        dy,
        fromXY: { x: cur.x, y: cur.y },
        toXY: after,
        moved,
        decision: "path",
        message: truncate(result.message.trim(), 80),
      });
    }

    // Re-check abort AFTER the frame too. If the user hit Ctrl+C
    // mid-step, SIGINT propagated to NetHack via the PTY group and
    // NetHack now shows "Really quit without saving? [yn]" — which
    // would otherwise win the priority race against the next
    // top-of-loop signal check, returning `modal_prompt` to the
    // agent when the real reason is `abort_signal`.
    if (ctx.signal.aborted) {
      stopReason = "abort_signal";
      break;
    }

    if (ctx.runState.gameOver) {
      stopReason = ctx.runState.endReason ?? "runner_exited";
      break;
    }

    // Build interrupt context. enteredTrapTile fires if the player's
    // current tile is now trap_known.
    const playerNow = map.currentPlayerXY;
    let enteredTrap = false;
    if (playerNow !== null) {
      const t = floor.tiles.get(`${playerNow.x},${playerNow.y}`);
      if (t !== undefined && t.kind === "trap_known") enteredTrap = true;
    }

    const ictx: InterruptContext = {
      cur: frameFromResult(result),
      enteredTrapTile: enteredTrap,
      abortSignal: ctx.signal.aborted,
    };
    if (prevFrame !== undefined) ictx.prev = prevFrame;
    if (map.lastUnexpectedLevelChange !== null) {
      ictx.unexpectedLevelChange = map.lastUnexpectedLevelChange;
    }
    const interrupts = runInterruptChecks(ictx);
    if (interrupts.primary !== null) {
      stopReason = formatInterruptSummary(interrupts);
      break;
    }

    prevFrame = frameFromResult(result);

    // Pop the path step and verify the player actually moved.
    if (playerNow !== null && playerNow.x === next.x && playerNow.y === next.y) {
      path = path.slice(1);
    } else {
      // Engine ignored the move (closed door, locked, blocked, hostile
      // adjacent that isn't a `monster_visible` interrupt yet, etc.).
      // Capture NetHack's message so the user sees WHY (e.g. "The door
      // is locked.") rather than a bare `blocked_unreachable`.
      const msg = result.message.trim();
      if (msg.length > 0) {
        lastBlockMessage = msg;
        ctx.reportProgress?.(`${stepsTaken}/${stepCap} — ${truncate(msg, 40)}`);
      }
      blockedTiles.add(`${next.x},${next.y}`);
      // Replan excluding every tile we know the engine refused this
      // run. If a detour exists, pathfind finds it; if the only
      // viable route went through the blocked tile, pathfind returns
      // null and we surface no_path_after_replan with the engine's
      // message ("The door is locked.", etc.).
      path = map.pathfind(playerNow ?? cur, goal, blockedTiles);
      if (path === null) {
        stopReason = withMessage("blocked_unreachable", lastBlockMessage);
        break;
      }
    }
  }

  if (stopReason === null && stepsTaken >= stepCap) {
    stopReason = "step_cap";
  }

  // If we arrived at goal, return arrived; otherwise stopped reason.
  const playerFinal = map.currentPlayerXY;
  const arrived =
    playerFinal !== null && playerFinal.x === goal.x && playerFinal.y === goal.y;
  if (arrived) {
    return formatArrivedResult(ctx, stepsTaken, "", floorId, goalX, goalY, lastResult);
  }
  const head = `autopilot_to(${floorId},${goalX},${goalY}): stopped after ${stepsTaken} steps. interrupt: ${stopReason ?? "unknown"}`;
  return formatStoppedResult(ctx, head, lastResult);
}

function formatArrivedResult(
  ctx: ToolContext,
  steps: number,
  _detail: string,
  floorId?: string,
  goalX?: number,
  goalY?: number,
  lastResult?: FrameAwaitResult | null,
): string {
  const fid = floorId ?? ctx.map.current ?? "D?";
  const gx = goalX ?? ctx.map.currentPlayerXY?.x ?? 0;
  const gy = goalY ?? ctx.map.currentPlayerXY?.y ?? 0;
  const head = `autopilot_to(${fid},${gx},${gy}): arrived after ${steps} steps`;
  return formatStoppedResult(ctx, head, lastResult ?? null);
}

function formatStoppedResult(
  ctx: ToolContext,
  summary: string,
  lastResult: FrameAwaitResult | null,
): string {
  // If we never sent a key (e.g. arrived-at-goal-with-zero-steps), we have
  // no last frame. Build a degenerate result using empty status/screen.
  if (lastResult === null) {
    return formatToolResult({
      summary,
      screenAnsi: "",
      map: ctx.map,
      status: emptyStatus(),
    });
  }
  return formatToolResult({
    summary,
    screenAnsi: lastResult.screenAnsi,
    map: ctx.map,
    status: lastResult.status,
  });
}

function emptyStatus() {
  return {
    name: "",
    title: "",
    attrs: { st: "", dx: 0, co: 0, in: 0, wi: 0, ch: 0 },
    alignment: "Unaligned" as const,
    ac: 0,
    hp: 0,
    hpMax: 0,
    pw: 0,
    pwMax: 0,
    level: 0,
    xp: 0,
    dlvl: 0,
    turn: 0,
    gold: 0,
    hunger: "ok" as const,
    conditions: [] as string[],
  };
}

// ---------------------------------------------------------------------------
// autopilot_explore

interface AutopilotExploreArgs {
  stepCap?: number;
}

function isAutopilotExploreArgs(args: unknown): args is AutopilotExploreArgs {
  if (typeof args !== "object" || args === null) return false;
  const a = args as Record<string, unknown>;
  if (a.stepCap !== undefined && (typeof a.stepCap !== "number" || a.stepCap < 1)) {
    return false;
  }
  return true;
}

// Tile kinds the exploration policy refuses to step onto, beyond the
// general non-walkable kinds. Boulders and water/lava are repeated for
// clarity; they're already non-walkable in GameMap. trap_known is the
// safety-critical one.
const EXPLORE_FORBIDDEN_KINDS: ReadonlySet<TileKind> = new Set<TileKind>([
  "trap_known",
  "boulder",
  "lava",
  "water",
]);

const DIAG_DIRS: ReadonlyArray<readonly [number, number]> = [
  [-1, -1], [0, -1], [1, -1],
  [-1, 0],           [1, 0],
  [-1, 1],  [0, 1],  [1, 1],
];

function isPlayerWalkable(tile: Tile): boolean {
  if (tile.walkable === "no") return false;
  if (EXPLORE_FORBIDDEN_KINDS.has(tile.kind)) return false;
  return true;
}

// Diagonal-doorway / boulder rule, mirroring GameMap.pathfind. Used by
// the exploration policy when picking adjacent steps and during BFS.
function diagonalAllowed(
  floor: FloorMap,
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
): boolean {
  const fromTile = floor.tiles.get(`${fromX},${fromY}`);
  const toTile = floor.tiles.get(`${toX},${toY}`);
  if (
    fromTile !== undefined &&
    (fromTile.kind === "door_open" || fromTile.kind === "door_closed")
  ) {
    return false;
  }
  if (
    toTile !== undefined &&
    (toTile.kind === "door_open" || toTile.kind === "door_closed")
  ) {
    return false;
  }
  const inter1 = floor.tiles.get(`${fromX},${toY}`);
  const inter2 = floor.tiles.get(`${toX},${fromY}`);
  if (inter1?.kind === "boulder" || inter2?.kind === "boulder") return false;
  if (inter1?.kind === "wall" && inter2?.kind === "wall") return false;
  return true;
}

// Is a tile a "frontier" — known walkable adjacent to an unknown tile?
function isFrontier(floor: FloorMap, x: number, y: number): boolean {
  const t = floor.tiles.get(`${x},${y}`);
  if (t === undefined) return false;
  if (!isPlayerWalkable(t)) return false;
  for (const [dx, dy] of DIAG_DIRS) {
    const nx = x + dx;
    const ny = y + dy;
    const neighbor = floor.tiles.get(`${nx},${ny}`);
    if (neighbor === undefined) return true;
    if (neighbor.kind === "unknown") return true;
  }
  return false;
}

// BFS from (sx, sy) to the nearest frontier tile. Returns the (dx, dy)
// of the first step or null if no frontier is reachable.
//
// `blocked` is the set of "x,y" tile keys the engine has refused at
// runtime this autopilot call (locked doors, peaceful blockers,
// terrain we misclassified). BFS must NOT expand through them — and
// MUST also reject them as frontier targets — otherwise it routes
// through the same blocked tile every iteration, returning the same
// first-step over and over. Production run bbh-20260508-203614 hit
// this on a locked door at (66,16): 148+ consecutive `k` keystrokes
// returning "This door is locked." because BFS kept finding a
// frontier beyond the door and the locked-door tile in the
// expansion path was never excluded.
function bfsToFrontier(
  floor: FloorMap,
  sx: number,
  sy: number,
  visited: Set<string>,
  blocked: Set<string>,
): readonly [number, number] | null {
  // BFS through walkable tiles. Expand 8-connectivity.
  type Node = { x: number; y: number; firstStep: readonly [number, number] | null };
  const start: Node = { x: sx, y: sy, firstStep: null };
  const queue: Node[] = [start];
  const seen = new Set<string>();
  seen.add(`${sx},${sy}`);

  while (queue.length > 0) {
    const node = queue.shift()!;
    // Treat the start tile as not a stop condition (we want to make
    // progress). Otherwise, if this tile is a frontier and is
    // unvisited and not engine-blocked, we have our target.
    const isStart = node.x === sx && node.y === sy;
    if (
      !isStart &&
      isFrontier(floor, node.x, node.y) &&
      !visited.has(`${node.x},${node.y}`) &&
      !blocked.has(`${node.x},${node.y}`)
    ) {
      return node.firstStep;
    }

    for (const [dx, dy] of DIAG_DIRS) {
      const nx = node.x + dx;
      const ny = node.y + dy;
      const key = `${nx},${ny}`;
      if (seen.has(key)) continue;
      if (blocked.has(key)) continue;
      const t = floor.tiles.get(key);
      if (t === undefined) continue;
      if (!isPlayerWalkable(t)) continue;
      const isDiag = dx !== 0 && dy !== 0;
      if (isDiag && !diagonalAllowed(floor, node.x, node.y, nx, ny)) continue;
      seen.add(key);
      queue.push({
        x: nx,
        y: ny,
        firstStep: node.firstStep ?? ([dx, dy] as const),
      });
    }
  }
  return null;
}

// Score for "prefer corridor over room". Lower is better.
function tileTypeScore(t: Tile): number {
  // Stairs heavily de-preferred — we never want to "exit" the floor on
  // autopilot. Even just stepping onto stairs is OK; pick others first
  // when available.
  if (t.kind === "stairs_up" || t.kind === "stairs_down") return 100;
  if (t.kind === "corridor") return 0;
  if (t.kind === "floor") return 1;
  return 2;
}

// Pick best adjacent unvisited walkable. Returns (dx, dy) or null.
function pickAdjacentUnvisited(
  floor: FloorMap,
  px: number,
  py: number,
  visited: Set<string>,
  prevDir: readonly [number, number] | null,
): readonly [number, number] | null {
  type Cand = {
    dx: number;
    dy: number;
    typeScore: number;
    dirScore: number; // 0 if matches prevDir, 1 otherwise
  };
  const cands: Cand[] = [];
  for (const [dx, dy] of DIAG_DIRS) {
    const nx = px + dx;
    const ny = py + dy;
    const t = floor.tiles.get(`${nx},${ny}`);
    if (t === undefined) continue;
    if (!isPlayerWalkable(t)) continue;
    const isDiag = dx !== 0 && dy !== 0;
    if (isDiag && !diagonalAllowed(floor, px, py, nx, ny)) continue;
    if (visited.has(`${nx},${ny}`)) continue;
    const dirScore = prevDir !== null && prevDir[0] === dx && prevDir[1] === dy ? 0 : 1;
    cands.push({ dx, dy, typeScore: tileTypeScore(t), dirScore });
  }
  if (cands.length === 0) return null;
  // Sort: typeScore asc (corridors first), then dirScore asc (continue first).
  cands.sort((a, b) => {
    if (a.typeScore !== b.typeScore) return a.typeScore - b.typeScore;
    return a.dirScore - b.dirScore;
  });
  return [cands[0]!.dx, cands[0]!.dy] as const;
}

export async function handleAutopilotExplore(
  args: unknown,
  ctx: ToolContext,
): Promise<string> {
  if (!isAutopilotExploreArgs(args)) {
    return errJson("invalid args. Expected {stepCap?: integer}.");
  }
  const stepCap = Math.max(1, Math.floor(args.stepCap ?? DEFAULT_STEP_CAP));

  const map = ctx.map;
  if (map.current === null) return errJson("no map recorded yet");
  const floor = map.floors.get(map.current);
  if (floor === undefined) return errJson(`floor '${map.current}' not in map`);

  const refusal = floorRefusalReason(floor);
  if (refusal !== null) return errJson(refusal);

  if (map.currentPlayerXY === null) return errJson("player position unknown");

  // Track tiles visited *during this autopilot call* (not across game).
  const visited = new Set<string>();
  visited.add(`${map.currentPlayerXY.x},${map.currentPlayerXY.y}`);
  // Tiles where the engine refused movement this run (locked doors,
  // peaceful blockers, misclassified terrain). Distinct from
  // `visited`: BFS-to-frontier MUST NOT expand through these, or it
  // returns a same-direction first-step every iteration and burns
  // the entire stepCap. See bfsToFrontier comment for the
  // production trace that motivated this.
  const blockedTiles = new Set<string>();

  let prevFrame: InterruptFrame | undefined;
  let lastResult: FrameAwaitResult | null = null;
  let stepsTaken = 0;
  let stopReason: string | null = null;
  let prevDir: readonly [number, number] | null = null;
  // Most recent NetHack message captured on a non-movement step. Used
  // as additional context if explore exits via "explored entire known
  // map" — the message often reveals what stopped progress.
  let lastExploreBlockMessage = "";

  while (stepsTaken < stepCap) {
    if (ctx.signal.aborted) {
      stopReason = "abort_signal";
      break;
    }
    const cur = map.currentPlayerXY;
    if (cur === null) {
      stopReason = "player_position_lost";
      break;
    }

    // Step 1: prefer adjacent unvisited walkable.
    let stepDir: readonly [number, number] | null = pickAdjacentUnvisited(
      floor,
      cur.x,
      cur.y,
      visited,
      prevDir,
    );
    let decision: "adjacent" | "bfs" = "adjacent";

    // Step 2 (BFS to nearest frontier) when no adjacent unvisited.
    if (stepDir === null) {
      stepDir = bfsToFrontier(floor, cur.x, cur.y, visited, blockedTiles);
      decision = "bfs";
    }

    if (stepDir === null) {
      stopReason = withMessage("explored entire known map", lastExploreBlockMessage);
      break;
    }

    const [dx, dy] = stepDir;
    const key = deltaToViKey(dx, dy);
    if (key === null) {
      stopReason = "internal_bad_direction";
      break;
    }

    // Trap-protection: never step into a trap_known. (pickAdjacent and
    // bfsToFrontier already filter, but defense in depth.)
    const nextTile = floor.tiles.get(`${cur.x + dx},${cur.y + dy}`);
    if (nextTile !== undefined && nextTile.kind === "trap_known") {
      stopReason = "entered_trap_tile";
      break;
    }

    const result = await ctx.sendKeysAndWait(key);
    lastResult = result;
    stepsTaken += 1;
    ctx.reportProgress?.(`${stepsTaken}/${stepCap}`);

    // Per-step trace.
    {
      const after = map.currentPlayerXY;
      const moved = after !== null && (after.x !== cur.x || after.y !== cur.y);
      ctx.logAutopilotStep?.({
        tool: "autopilot_explore",
        step: stepsTaken,
        key,
        dx,
        dy,
        fromXY: { x: cur.x, y: cur.y },
        toXY: after,
        moved,
        decision,
        message: truncate(result.message.trim(), 80),
      });
    }

    // Re-check abort AFTER the frame; see handleAutopilotTo for why.
    if (ctx.signal.aborted) {
      stopReason = "abort_signal";
      break;
    }

    if (ctx.runState.gameOver) {
      stopReason = ctx.runState.endReason ?? "runner_exited";
      break;
    }

    const playerNow = map.currentPlayerXY;
    let enteredTrap = false;
    if (playerNow !== null) {
      const t = floor.tiles.get(`${playerNow.x},${playerNow.y}`);
      if (t !== undefined && t.kind === "trap_known") enteredTrap = true;
      visited.add(`${playerNow.x},${playerNow.y}`);
    }

    // If the keystroke produced no movement, the engine refused the
    // step (locked door, boulder, terrain we misclassified as walkable,
    // diagonal blocked by walls, etc.). Mark the intended target tile
    // as both visited (so pickAdjacentUnvisited skips it) AND blocked
    // (so bfsToFrontier won't route THROUGH it on subsequent iters).
    // The visited-only marking was insufficient: BFS-to-frontier
    // happily routed through visited-but-blocked tiles, returning the
    // same first-step every iteration. Production run
    // bbh-20260508-203614 burned 148+ steps on `k` against a single
    // locked door at (66,16) before this distinction was added.
    // Capture NetHack's message so the user sees WHY ("This door is
    // locked.") in the final stop reason and live progress.
    const movedThisStep =
      playerNow !== null && (playerNow.x !== cur.x || playerNow.y !== cur.y);
    if (!movedThisStep) {
      const targetKey = `${cur.x + dx},${cur.y + dy}`;
      visited.add(targetKey);
      blockedTiles.add(targetKey);
      const msg = result.message.trim();
      if (msg.length > 0) {
        lastExploreBlockMessage = msg;
        ctx.reportProgress?.(`${stepsTaken}/${stepCap} — ${truncate(msg, 40)}`);
      }
    }

    const ictx: InterruptContext = {
      cur: frameFromResult(result),
      enteredTrapTile: enteredTrap,
      abortSignal: ctx.signal.aborted,
    };
    if (prevFrame !== undefined) ictx.prev = prevFrame;
    if (map.lastUnexpectedLevelChange !== null) {
      ictx.unexpectedLevelChange = map.lastUnexpectedLevelChange;
    }
    const interrupts = runInterruptChecks(ictx);
    if (interrupts.primary !== null) {
      stopReason = formatInterruptSummary(interrupts);
      break;
    }

    prevFrame = frameFromResult(result);
    prevDir = stepDir;
  }

  if (stopReason === null && stepsTaken >= stepCap) {
    stopReason = "step_cap";
  }

  const summary = `autopilot_explore: ${stepsTaken} steps. stopped: ${stopReason ?? "unknown"}`;
  return formatStoppedResult(ctx, summary, lastResult);
}
