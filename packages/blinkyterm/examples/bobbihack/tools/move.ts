// Movement & exploration tool handlers: move, search, pickup.

import type { ToolContext } from "../tool-context";
import { formatToolResult } from "../tool-result";

export type Direction =
  | "north"
  | "south"
  | "east"
  | "west"
  | "northeast"
  | "northwest"
  | "southeast"
  | "southwest"
  | "up"
  | "down";

const DIR_TO_KEY: Record<Direction, string> = {
  north: "k",
  south: "j",
  east: "l",
  west: "h",
  northeast: "u",
  northwest: "y",
  southeast: "n",
  southwest: "b",
  up: "<",
  down: ">",
};

const VALID_DIRS: ReadonlySet<string> = new Set(Object.keys(DIR_TO_KEY));

export function directionToKeystroke(dir: Direction): string {
  return DIR_TO_KEY[dir];
}

export async function handleMove(
  args: { direction: Direction; count?: number },
  ctx: ToolContext,
): Promise<string> {
  if (typeof args.direction !== "string" || !VALID_DIRS.has(args.direction)) {
    return JSON.stringify({
      error: `invalid direction: ${String(args.direction)}. Valid: ${Object.keys(DIR_TO_KEY).join(", ")}`,
    });
  }
  const cap = 50;
  const count = Math.max(1, Math.min(cap, args.count ?? 1));
  const key = DIR_TO_KEY[args.direction];
  const keys = count === 1 ? key : `${count}${key}`;
  const result = await ctx.sendKeysAndWait(keys);
  const summary = formatMoveSummary(args.direction, count, result);
  return formatToolResult({
    summary,
    screenAnsi: result.screenAnsi,
    map: ctx.map,
    status: result.status,
  });
}

function formatMoveSummary(
  dir: Direction,
  count: number,
  result: { message: string; status: { hp: number; hpMax: number } },
): string {
  const head = count === 1 ? `move(${dir})` : `move(${dir} ×${count})`;
  const detail = result.message ? `: ${result.message}` : "";
  return `${head}${detail}`;
}

export async function handleSearch(_args: object, ctx: ToolContext): Promise<string> {
  const result = await ctx.sendKeysAndWait("s");
  const detail = result.message ? `: ${result.message}` : "";
  return formatToolResult({
    summary: `search${detail}`,
    screenAnsi: result.screenAnsi,
    map: ctx.map,
    status: result.status,
  });
}

export async function handlePickup(_args: object, ctx: ToolContext): Promise<string> {
  const result = await ctx.sendKeysAndWait(",");
  const detail = result.message ? `: ${result.message}` : "";
  return formatToolResult({
    summary: `pickup${detail}`,
    screenAnsi: result.screenAnsi,
    map: ctx.map,
    status: result.status,
  });
}
