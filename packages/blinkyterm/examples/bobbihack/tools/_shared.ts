// Shared validators and helpers for the verb tool handlers in this dir.
// Kept tiny and self-contained — no dependencies beyond ../tool-result and
// ../tool-context types.

import type { ToolContext } from "../tool-context";
import { formatToolResult } from "../tool-result";

// NetHack 3.6 inventory slot letters: a-zA-Z. We also accept '-' (for
// `wield -` = bare hands), and the special menu sigils '$' (gold), '#'
// (held in containers / non-inventory), '?' and '*' (some commands accept
// these as "show me a menu" wildcards).
const SLOT_RE = /^[a-zA-Z\-$#?*]$/;

export function isValidSlot(slot: unknown): slot is string {
  return typeof slot === "string" && SLOT_RE.test(slot);
}

// Compass-only direction enum (no up/down — those aren't valid for
// zap/throw/kick/force_fight; up/down are stair-traversal in `move`).
export type CompassDirection =
  | "north"
  | "south"
  | "east"
  | "west"
  | "northeast"
  | "northwest"
  | "southeast"
  | "southwest";

const COMPASS_DIR_TO_KEY: Record<CompassDirection, string> = {
  north: "k",
  south: "j",
  east: "l",
  west: "h",
  northeast: "u",
  northwest: "y",
  southeast: "n",
  southwest: "b",
};

export const COMPASS_DIRECTIONS: ReadonlyArray<CompassDirection> = Object.keys(
  COMPASS_DIR_TO_KEY,
) as CompassDirection[];

const COMPASS_DIR_SET: ReadonlySet<string> = new Set(COMPASS_DIRECTIONS);

export function isValidCompassDirection(d: unknown): d is CompassDirection {
  return typeof d === "string" && COMPASS_DIR_SET.has(d);
}

export function compassDirectionToKey(d: CompassDirection): string {
  return COMPASS_DIR_TO_KEY[d];
}

// Standard envelope: send `keys`, await frame, return a tool_result blob
// with a summary that begins with `name(...)`. Each handler builds the
// summary head itself; this just stitches in the post-keystroke message
// from NetHack and renders the screen.
export async function sendAndFormat(
  ctx: ToolContext,
  keys: string,
  summaryHead: string,
): Promise<string> {
  const result = await ctx.sendKeysAndWait(keys);
  const detail = result.message ? `: ${result.message}` : "";
  return formatToolResult({
    summary: `${summaryHead}${detail}`,
    screenAnsi: result.screenAnsi,
    map: ctx.map,
    status: result.status,
  });
}

export function errJson(msg: string): string {
  return JSON.stringify({ error: msg });
}
