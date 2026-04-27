// Tool-result formatter — assembles the standard string layout returned by
// game-advancing tools. Stable header line lets the model disambiguate
// live results from compacted stubs and from JSON-shaped non-screen
// tool results.

import type { GameMap } from "./game-map";
import type { StatusLine } from "./parsers";

export const TOOL_RESULT_HEADER = "== bobbihack tool_result v1 ==";

export interface FormatArgs {
  summary: string;
  screenAnsi: string;
  map: GameMap;
  status: StatusLine;
}

export interface GameOverArgs {
  reason: string;
  finalTurn: number;
  finalHp: number;
  finalHpMax: number;
  screenAnsi: string;
}

export function formatToolResult(args: FormatArgs): string {
  const { summary, screenAnsi, map, status } = args;
  const visited = map.visitedFloors().map((v) => v.floor).join(", ");
  const standing = `Floor: ${map.current ?? "D?"}. Visited: ${visited || "(none)"}. Turn: ${status.turn}.`;
  const conditions =
    status.conditions.length > 0 ? status.conditions.join(" ") : "-";
  const statusBlock =
    `HP ${status.hp}/${status.hpMax}   ` +
    `Pw ${status.pw}/${status.pwMax}   ` +
    `AC ${status.ac}   ` +
    `Hunger: ${status.hunger}   ` +
    `Cond: ${conditions}`;

  const lines = [
    TOOL_RESULT_HEADER,
    summary,
    standing,
    statusBlock,
    "",
    screenAnsi,
  ];
  return lines.join("\n");
}

export function formatGameOverResult(args: GameOverArgs): string {
  const { reason, finalTurn, finalHp, finalHpMax, screenAnsi } = args;
  const summary = `GAME OVER: ${reason}. Final turn: ${finalTurn}. Final HP: ${finalHp}/${finalHpMax}.`;
  return [TOOL_RESULT_HEADER, summary, "", screenAnsi].join("\n");
}
