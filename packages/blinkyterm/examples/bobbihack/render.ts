import type { Box, Layout } from "./layout";
import type {
  ChatRecord,
  ConductorStatus,
  ToolRecord,
  ViewState,
} from "./state";

const ESC = "\x1b[";
const RESET = `${ESC}0m`;
const HIDE_CURSOR = `${ESC}?25l`;
const CLEAR_SCREEN = `${ESC}2J${ESC}H`;

const goto = (row: number, col: number) => `${ESC}${row};${col}H`;

const TL = "┌", TR = "┐", BL = "└", BR = "┘", H = "─", V = "│";

// Per-pane border colors. Cyan for the NetHack pane (the "screen"),
// magenta for the agent pane, green for the tool history.
const NETHACK_BORDER = `${ESC}36m`; // cyan
const AGENT_BORDER = `${ESC}35m`;   // magenta
const TOOL_BORDER = `${ESC}32m`;    // green

// Status indicator colors (in agent-pane title).
const C_OK = `${ESC}32m`;       // green — healthy "thinking 8s"
const C_WARN = `${ESC}33m`;     // amber — slow / paused / reconnecting
const C_ERR = `${ESC}31m`;      // red — hard error
const C_TOOL = `${ESC}36m`;     // cyan — tool in flight
const C_DIM = `${ESC}90m`;      // gray — idle

// Pause threshold: after this many ms with no API progress, the
// "thinking" status display flips to "paused Xs — no API response".
// 30s is comfortably "something's off" for Sonnet (typical 5-15s/turn)
// without flickering on occasional slow turns.
const PAUSE_THRESHOLD_MS = 30_000;
const SLOW_THINKING_MS = 15_000; // earlier amber warning

/**
 * Compose the bobbihack TUI as ANSI bytes.
 *
 * `nethackContent` is the pre-positioned ANSI rendering of NetHack's pane,
 * produced by `runner.renderState.toAnsiRect({...nethack-content-rect})`
 * in main.ts. Its embedded goto sequences place each row at the right
 * host coordinates already.
 *
 * `now` is epoch ms used to compute elapsed time on the conductor
 * status (drives "thinking 12s" / "paused 4m12s" display). Defaults to
 * Date.now() so callers don't need to thread a clock through.
 */
export function render(
  state: ViewState,
  nethackContent: string,
  now: number = Date.now(),
): string {
  if (state.layout.kind === "tooSmall") return renderTooSmall(state);

  const parts: string[] = [];
  parts.push(CLEAR_SCREEN);
  parts.push(RESET);

  if (state.layout.kind === "tri") {
    drawNethackPane(parts, state.layout.nethack, state.nethack.pid, nethackContent, latestTool(state));
    drawToolsPane(parts, state.layout.tools, state.toolHistory);
    drawChatPane(parts, state.layout.chat, state, now);
  } else {
    // side / stacked: NetHack + a single combined agent pane that
    // shows chat (with tool decisions inlined when no chat text exists).
    drawNethackPane(parts, state.layout.nethack, state.nethack.pid, nethackContent, latestTool(state));
    drawAgentPane(parts, state.layout.thinking, state, now);
  }

  parts.push(HIDE_CURSOR);
  parts.push(goto(1, 1));
  return parts.join("");
}

function renderTooSmall(state: ViewState): string {
  if (state.layout.kind !== "tooSmall") return "";
  const { minSideCols, minSideRows, minStackedCols, minStackedRows } = state.layout;
  return [
    CLEAR_SCREEN,
    RESET,
    HIDE_CURSOR,
    goto(2, 2),
    `Resize terminal to at least ${minSideCols}×${minSideRows} (side-by-side) or ${minStackedCols}×${minStackedRows} (stacked).`,
    goto(3, 2),
    `Press q to quit.`,
  ].join("");
}

function drawBox(parts: string[], box: Box, title: string, color: string): void {
  parts.push(goto(box.row, box.col));
  parts.push(color);
  const topInner = H.repeat(Math.max(0, box.cols - 2));
  const t = ` ${title.trim()} `;
  const fitted = t.length <= topInner.length ? t : t.slice(0, topInner.length);
  const top = TL + fitted + topInner.slice(fitted.length) + TR;
  parts.push(top);
  parts.push(RESET);

  for (let r = 1; r < box.rows - 1; r++) {
    parts.push(goto(box.row + r, box.col));
    parts.push(color + V + RESET);
    parts.push(goto(box.row + r, box.col + box.cols - 1));
    parts.push(color + V + RESET);
  }

  parts.push(goto(box.row + box.rows - 1, box.col));
  parts.push(color);
  parts.push(BL + H.repeat(Math.max(0, box.cols - 2)) + BR);
  parts.push(RESET);
}

/**
 * Draw a box with a colored span inside its title. Title structure:
 *   `<labelLeft><colorOpen><colorText><colorClose><labelRight>`
 *   (e.g. "Agent (sonnet-4-6) — " + greenish + "thinking 12s" + reset)
 * Lengths must add up to the visible-char width that fits in the top.
 */
function drawBoxWithStatusTitle(
  parts: string[],
  box: Box,
  borderColor: string,
  labelLeft: string,
  statusText: string,
  statusColor: string,
  labelRight: string,
): void {
  parts.push(goto(box.row, box.col));
  parts.push(borderColor);
  const topInnerWidth = Math.max(0, box.cols - 2);
  // Visible text we want to render in the top: "<labelLeft><statusText><labelRight>"
  const visible = ` ${labelLeft}${statusText}${labelRight} `;
  const fitted = visible.length <= topInnerWidth ? visible : visible.slice(0, topInnerWidth);
  const remainder = topInnerWidth - fitted.length;

  // Reconstruct fitted with colors inserted around the status span. We
  // re-derive the offset of statusText inside fitted; if status got
  // truncated, fall back to plain rendering.
  const leftPart = ` ${labelLeft}`;
  const statusEnd = leftPart.length + statusText.length;
  if (fitted.length >= statusEnd) {
    parts.push(TL);
    parts.push(fitted.slice(0, leftPart.length));      // " Agent (...) — "
    parts.push(borderColor);                            // close-then-reopen border, then status
    parts.push(statusColor);
    parts.push(fitted.slice(leftPart.length, statusEnd));
    parts.push(RESET);
    parts.push(borderColor);
    parts.push(fitted.slice(statusEnd));               // " "
    parts.push(H.repeat(remainder));
    parts.push(TR);
  } else {
    // Truncated through the status span — render plain.
    parts.push(TL);
    parts.push(fitted);
    parts.push(H.repeat(remainder));
    parts.push(TR);
  }
  parts.push(RESET);

  for (let r = 1; r < box.rows - 1; r++) {
    parts.push(goto(box.row + r, box.col));
    parts.push(borderColor + V + RESET);
    parts.push(goto(box.row + r, box.col + box.cols - 1));
    parts.push(borderColor + V + RESET);
  }
  parts.push(goto(box.row + box.rows - 1, box.col));
  parts.push(borderColor);
  parts.push(BL + H.repeat(Math.max(0, box.cols - 2)) + BR);
  parts.push(RESET);
}

function drawNethackPane(
  parts: string[],
  box: Box,
  pid: number,
  nethackContent: string,
  lastTool: ToolRecord | undefined,
): void {
  // Surface the most recent committed action in the title so movement
  // is visible at a glance even when @ bounces inside a small room.
  const recent = lastTool !== undefined
    ? ` — turn ${lastTool.number} → ${lastTool.decision}`
    : "";
  drawBox(parts, box, ` NetHack — pid=${pid}${recent} `, NETHACK_BORDER);

  const innerRows = box.rows - 2;
  for (let i = 0; i < innerRows; i++) {
    parts.push(goto(box.row + 1 + i, box.col + 1));
    parts.push(" ");
    parts.push(goto(box.row + 1 + i, box.col + box.cols - 2));
    parts.push(" ");
  }

  parts.push(nethackContent);
}

/**
 * Tool history pane (left-bottom in tri). Renders newest-at-bottom; if
 * there are more entries than rows, only the most-recent fit. Each line:
 *   "#NNN reason → decision  summary"
 */
function drawToolsPane(parts: string[], box: Box, history: readonly ToolRecord[]): void {
  drawBox(parts, box, ` Tool history `, TOOL_BORDER);

  const innerCols = box.cols - 2;
  const innerRows = box.rows - 2;
  if (innerRows <= 0) return;

  // Format every entry into a single line, then take the last innerRows.
  const lines = history.map((rec) => formatToolLine(rec, innerCols));
  const startIdx = Math.max(0, lines.length - innerRows);
  const visible = lines.slice(startIdx);

  for (let i = 0; i < innerRows; i++) {
    parts.push(goto(box.row + 1 + i, box.col + 1));
    const line = visible[i] ?? "";
    parts.push(line);
    if (line.length < innerCols) parts.push(" ".repeat(innerCols - line.length));
  }
}

/**
 * Chat pane (right column in tri). Word-wraps each chat entry across
 * however many rows it needs; renders newest-at-bottom. Title shows the
 * conductor status with color (e.g. " Agent (...) — thinking 12s ").
 */
function drawChatPane(
  parts: string[],
  box: Box,
  state: ViewState,
  now: number,
): void {
  drawChatLikeBox(parts, box, state, now, state.chatHistory);
  if (state.errorBanner !== null) drawErrorBanner(parts, box, state.errorBanner);
}

/**
 * Agent pane for side/stacked fallback. Combines chat + tool history:
 * for each turn, show the chat text if present, otherwise a compact
 * tool line. Newest-at-bottom.
 */
function drawAgentPane(parts: string[], box: Box, state: ViewState, now: number): void {
  // Build a unified per-turn feed (oldest first). For each tool record,
  // if a matching chat record exists for that turn, prefer the chat
  // text; else render a compact tool line.
  const chatByTurn = new Map<number, string>();
  for (const c of state.chatHistory) chatByTurn.set(c.number, c.text);
  const merged: ChatRecord[] = state.toolHistory.map((t) => {
    const text = chatByTurn.get(t.number);
    if (text !== undefined && text.length > 0) {
      return { number: t.number, text };
    }
    return { number: t.number, text: `${t.frameReason} → ${t.decision}` };
  });
  drawChatLikeBox(parts, box, state, now, merged);
  if (state.errorBanner !== null) drawErrorBanner(parts, box, state.errorBanner);
}

function drawChatLikeBox(
  parts: string[],
  box: Box,
  state: ViewState,
  now: number,
  records: readonly ChatRecord[],
): void {
  const status = renderStatus(state.conductorStatus, now);
  const labelLeft = `Agent (${state.agentLabel}) — `;
  drawBoxWithStatusTitle(parts, box, AGENT_BORDER, labelLeft, status.text, status.color, "");

  const innerCols = box.cols - 2;
  const innerRows = box.rows - 2;
  if (innerRows <= 0) return;

  // Build all wrapped lines (oldest → newest). Each chat record begins
  // with "#N " on its first wrapped line, then continuation lines indent.
  const indent = "  ";
  const allLines: string[] = [];
  for (const rec of records) {
    const head = `#${rec.number} `;
    const wrapped = wrapText(rec.text, Math.max(1, innerCols - head.length));
    if (wrapped.length === 0) {
      allLines.push(head);
    } else {
      allLines.push(head + wrapped[0]);
      for (let i = 1; i < wrapped.length; i++) {
        allLines.push(indent + wrapped[i]);
      }
    }
    // Blank separator line between turns (skip after last).
    allLines.push("");
  }
  if (allLines.length > 0 && allLines[allLines.length - 1] === "") {
    allLines.pop();
  }

  // Take the last innerRows lines so newest stays at the bottom.
  const startIdx = Math.max(0, allLines.length - innerRows);
  const visible = allLines.slice(startIdx);
  // Top-fill blanks if we have fewer lines than rows.
  const blankRows = innerRows - visible.length;

  for (let i = 0; i < blankRows; i++) {
    parts.push(goto(box.row + 1 + i, box.col + 1));
    parts.push(" ".repeat(innerCols));
  }
  for (let i = 0; i < visible.length; i++) {
    const line = visible[i] ?? "";
    parts.push(goto(box.row + 1 + blankRows + i, box.col + 1));
    parts.push(line);
    if (line.length < innerCols) parts.push(" ".repeat(innerCols - line.length));
  }
}

function drawErrorBanner(parts: string[], box: Box, banner: string): void {
  const innerCols = box.cols - 2;
  const lastRow = box.row + box.rows - 2;
  parts.push(goto(lastRow, box.col + 1));
  const trimmed = banner.length > innerCols ? banner.slice(0, innerCols) : banner;
  parts.push(`${ESC}33m${trimmed}${RESET}`);
  if (trimmed.length < innerCols) parts.push(" ".repeat(innerCols - trimmed.length));
}

function formatToolLine(rec: ToolRecord, innerCols: number): string {
  const head = `#${rec.number} ${rec.frameReason} → ${rec.decision}`;
  const summary = rec.summary ? `  "${rec.summary}"` : "";
  const full = head + summary;
  return full.length > innerCols ? full.slice(0, innerCols) : full;
}

function latestTool(state: ViewState): ToolRecord | undefined {
  return state.toolHistory[state.toolHistory.length - 1];
}

interface RenderedStatus {
  text: string;
  color: string;
}

/**
 * Translate a ConductorStatus into the title display string + color.
 * "Paused" is derived here from elapsed time on the "thinking" kind —
 * the conductor doesn't emit a pause event explicitly.
 */
function renderStatus(status: ConductorStatus, now: number): RenderedStatus {
  const elapsed = Math.max(0, now - status.since);
  switch (status.kind) {
    case "idle":
      return { text: "idle", color: C_DIM };
    case "thinking": {
      const t = formatElapsed(elapsed);
      if (elapsed >= PAUSE_THRESHOLD_MS) {
        return { text: `paused ${t} — no API response`, color: C_WARN };
      }
      if (elapsed >= SLOW_THINKING_MS) {
        return { text: `thinking ${t}`, color: C_WARN };
      }
      return { text: `thinking ${t}`, color: C_OK };
    }
    case "tool_running": {
      const detail = status.detail.length > 0 ? status.detail : "(unnamed)";
      return { text: `tool: ${detail}`, color: C_TOOL };
    }
    case "reconnecting": {
      const detail = status.detail.length > 0 ? ` (${status.detail})` : "";
      return { text: `reconnecting${detail}`, color: C_WARN };
    }
    case "error":
      return { text: status.detail.length > 0 ? status.detail : "error", color: C_ERR };
    case "exited":
      return { text: "exited", color: C_DIM };
  }
}

function formatElapsed(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  const mins = Math.floor(ms / 60_000);
  const secs = Math.round((ms % 60_000) / 1000);
  return secs === 0 ? `${mins}m` : `${mins}m${secs}s`;
}

function wrapText(text: string, width: number): string[] {
  if (width <= 0 || text === "") return [];
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let current = "";
  for (const w of words) {
    if (w.length === 0) continue;
    if (current === "") {
      current = w;
    } else if (current.length + 1 + w.length <= width) {
      current += " " + w;
    } else {
      lines.push(current);
      current = w.length > width ? w.slice(0, width) : w;
    }
  }
  if (current !== "") lines.push(current);
  return lines;
}
