import type { Box, Layout } from "./layout";
import type { TurnRecord, TurnState, ViewState } from "./state";

const ESC = "\x1b[";
const RESET = `${ESC}0m`;
const HIDE_CURSOR = `${ESC}?25l`;
const CLEAR_SCREEN = `${ESC}2J${ESC}H`;

const goto = (row: number, col: number) => `${ESC}${row};${col}H`;

const TL = "┌", TR = "┐", BL = "└", BR = "┘", H = "─", V = "│";

/**
 * Compose the bobbihack TUI as ANSI bytes.
 *
 * `nethackContent` is the pre-positioned ANSI rendering of NetHack's pane,
 * produced by `runner.terminal.renderToAnsiRect({...nethack-content-rect})`
 * in main.ts. Its embedded goto sequences place each row at the right
 * host coordinates already; render() just splices it in after drawing
 * the pane border and clearing the 1-cell horizontal padding columns.
 *
 * Pass an empty string when there's no Runner yet or during teardown.
 */
export function render(state: ViewState, nethackContent: string): string {
  if (state.layout.kind === "tooSmall") return renderTooSmall(state);

  const parts: string[] = [];
  parts.push(CLEAR_SCREEN);
  parts.push(RESET);

  // NetHack pane
  drawNethackPane(parts, state.layout.nethack, state.nethack.pid, nethackContent);

  // Agent pane
  const agentTitle = currentTurnTitle(state);
  drawBox(parts, state.layout.thinking, agentTitle);
  drawAgentContent(parts, state.layout.thinking, state);

  if (state.errorBanner !== null) {
    drawErrorBanner(parts, state.layout.thinking, state.errorBanner);
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

function drawBox(parts: string[], box: Box, title: string): void {
  parts.push(goto(box.row, box.col));
  const topInner = H.repeat(Math.max(0, box.cols - 2));
  const t = ` ${title.trim()} `;
  const fitted = t.length <= topInner.length ? t : t.slice(0, topInner.length);
  const top = TL + fitted + topInner.slice(fitted.length) + TR;
  parts.push(top);

  for (let r = 1; r < box.rows - 1; r++) {
    parts.push(goto(box.row + r, box.col));
    parts.push(V);
    parts.push(goto(box.row + r, box.col + box.cols - 1));
    parts.push(V);
  }

  parts.push(goto(box.row + box.rows - 1, box.col));
  parts.push(BL + H.repeat(Math.max(0, box.cols - 2)) + BR);
}

/**
 * Draw the NetHack pane: border + title, blank the 1-cell horizontal padding
 * columns, then splice in the pre-positioned nethackContent.
 *
 * The padding-column blanks are defensive — `renderToAnsiRect` only writes
 * the 80×24 content area at the inner content cols, so if anything ever
 * wrote into the padding cells, the next paint would still leave them dirty.
 * A single space per row keeps them clean.
 */
function drawNethackPane(
  parts: string[],
  box: Box,
  pid: number,
  nethackContent: string,
): void {
  drawBox(parts, box, ` NetHack — pid=${pid} `);

  const innerRows = box.rows - 2;
  for (let i = 0; i < innerRows; i++) {
    parts.push(goto(box.row + 1 + i, box.col + 1));
    parts.push(" ");                                  // left padding cell
    parts.push(goto(box.row + 1 + i, box.col + box.cols - 2));
    parts.push(" ");                                  // right padding cell
  }

  parts.push(nethackContent);
}

function currentTurnTitle(state: ViewState): string {
  const t = state.currentTurn;
  if (t === null) return ` Agent (${state.agentLabel}) `;
  return ` Agent (${state.agentLabel}) — turn ${t.number}, frame: ${t.frameReason} `;
}

function drawAgentContent(parts: string[], box: Box, state: ViewState): void {
  const innerCols = box.cols - 2;
  const innerRows = box.rows - 2;
  const liveRows = Math.max(1, Math.min(8, Math.floor(innerRows / 3)));
  const dividerRow = box.row + 1 + liveRows;
  const historyStartRow = dividerRow + 1;
  const historyRows = Math.max(0, innerRows - liveRows - 1);

  const liveLines = wrapText(state.currentTurn?.streamingText ?? "", innerCols - 2);
  for (let i = 0; i < liveRows; i++) {
    parts.push(goto(box.row + 1 + i, box.col + 1));
    const prefix = i === 0 ? "▶ " : "  ";
    const text = liveLines[i] ?? "";
    parts.push(prefix + text);
    parts.push(RESET);
    const used = prefix.length + text.length;
    if (used < innerCols) parts.push(" ".repeat(innerCols - used));
  }

  parts.push(goto(dividerRow, box.col + 1));
  parts.push(H.repeat(innerCols));

  for (let i = 0; i < historyRows; i++) {
    const rec = state.history[i];
    parts.push(goto(historyStartRow + i, box.col + 1));
    if (!rec) {
      parts.push(" ".repeat(innerCols));
      continue;
    }
    const line = formatHistoryLine(rec, innerCols);
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

function formatHistoryLine(rec: TurnRecord, innerCols: number): string {
  const head = `#${rec.number} ${rec.frameReason} → ${rec.decision}`;
  const summary = rec.summary ? `  "${rec.summary}"` : "";
  const full = head + summary;
  return full.length > innerCols ? full.slice(0, innerCols) : full;
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
