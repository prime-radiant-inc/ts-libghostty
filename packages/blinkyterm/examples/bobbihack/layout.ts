export interface Box {
  readonly row: number;   // 1-based
  readonly col: number;   // 1-based
  readonly cols: number;
  readonly rows: number;
}

// Three layout shapes, in order of preference (largest host first):
//
//   "tri"     — preferred. NetHack top-left (fixed 84x26), tool history
//               directly below it (84 wide, rest of column height), agent
//               chat as the full-height right column. Best when host is
//               wider AND taller than NetHack.
//   "side"    — NetHack on the left, agent pane on the right. Tool calls
//               and chat share the agent pane (renderer falls back to a
//               combined view). Used when host is wide but not tall.
//   "stacked" — NetHack on top, agent pane below. Used when host is too
//               narrow for side-by-side.
//   "tooSmall"— neither side nor stacked fits.
//
// "side" and "stacked" don't have a separate tools box; in those modes
// the renderer puts tool history under chat history in the agent pane.
export type Layout =
  | { readonly kind: "tri"; readonly nethack: Box; readonly tools: Box; readonly chat: Box }
  | { readonly kind: "side"; readonly nethack: Box; readonly thinking: Box }
  | { readonly kind: "stacked"; readonly nethack: Box; readonly thinking: Box }
  | {
      readonly kind: "tooSmall";
      readonly minSideCols: number;
      readonly minSideRows: number;
      readonly minStackedCols: number;
      readonly minStackedRows: number;
    };

// Outer NetHack pane geometry. NetHack itself emits 80x24 (NetHack 3.6
// uses only 24 of a 25-row pty). We pad horizontally by 1 cell on each
// side so the box border doesn't visually merge with NetHack's own wall
// characters at column 0, but rows are sized tight to the actual output.
const NETHACK_INNER_COLS = 80;
const NETHACK_INNER_ROWS = 24;
const NETHACK_HPAD = 1;     // cells of horizontal padding inside the box
const NETHACK_COLS = NETHACK_INNER_COLS + 2 * NETHACK_HPAD + 2; // 84
const NETHACK_ROWS = NETHACK_INNER_ROWS + 2;                    // 26
const GAP = 1;
const SIDE_MIN_THINKING_COLS = 41;       // total side-by-side min: 84 + 1 + 41 = 126
const STACKED_MIN_THINKING_ROWS = 12;    // total stacked min rows: 26 + 1 + 12 = 39
const TRI_MIN_CHAT_COLS = 30;            // right column needs at least 30 wide
const TRI_MIN_TOOLS_ROWS = 8;            // tool box needs at least 8 rows

export function layout(hostCols: number, hostRows: number): Layout {
  const triMinCols = NETHACK_COLS + GAP + TRI_MIN_CHAT_COLS;        // 84 + 1 + 30 = 115
  const triMinRows = NETHACK_ROWS + GAP + TRI_MIN_TOOLS_ROWS;       // 26 + 1 + 8 = 35
  const sideMinCols = NETHACK_COLS + GAP + SIDE_MIN_THINKING_COLS;  // 126
  const sideMinRows = NETHACK_ROWS;                                 // 26
  const stackedMinCols = NETHACK_COLS;                              // 84
  const stackedMinRows = NETHACK_ROWS + GAP + STACKED_MIN_THINKING_ROWS; // 39

  // Prefer tri when the host is both wide enough for a chat column and
  // tall enough to give the tool box meaningful room.
  if (hostCols >= triMinCols && hostRows >= triMinRows) {
    const toolsRow = NETHACK_ROWS + GAP + 1;                        // row after gap
    const toolsRows = hostRows - NETHACK_ROWS - GAP;                // remaining
    return {
      kind: "tri",
      nethack: { row: 1, col: 1, cols: NETHACK_COLS, rows: NETHACK_ROWS },
      tools:   { row: toolsRow, col: 1, cols: NETHACK_COLS, rows: toolsRows },
      chat:    {
        row: 1,
        col: NETHACK_COLS + GAP + 1,
        cols: hostCols - NETHACK_COLS - GAP,
        rows: hostRows,
      },
    };
  }

  if (hostCols >= sideMinCols && hostRows >= sideMinRows) {
    return {
      kind: "side",
      nethack: { row: 1, col: 1, cols: NETHACK_COLS, rows: NETHACK_ROWS },
      thinking: {
        row: 1,
        col: NETHACK_COLS + GAP + 1,
        cols: hostCols - NETHACK_COLS - GAP,
        rows: hostRows,
      },
    };
  }

  if (hostCols >= stackedMinCols && hostRows >= stackedMinRows) {
    return {
      kind: "stacked",
      nethack: { row: 1, col: 1, cols: NETHACK_COLS, rows: NETHACK_ROWS },
      thinking: {
        row: NETHACK_ROWS + GAP + 1,
        col: 1,
        cols: hostCols,
        rows: hostRows - NETHACK_ROWS - GAP,
      },
    };
  }

  return {
    kind: "tooSmall",
    minSideCols: sideMinCols,
    minSideRows: sideMinRows,
    minStackedCols: stackedMinCols,
    minStackedRows: stackedMinRows,
  };
}
