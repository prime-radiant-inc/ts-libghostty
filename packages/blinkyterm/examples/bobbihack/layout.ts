export interface Box {
  readonly row: number;   // 1-based
  readonly col: number;   // 1-based
  readonly cols: number;
  readonly rows: number;
}

// Three panel shapes plus a tooSmall fallback. Every non-tooSmall shape
// reserves the bottom row of the host for `statusBar` (full-width). The
// pane boxes (nethack / tools / thinking / chat) are sized to leave that
// row untouched.
//
//   "tri"     — preferred. NetHack top-left (fixed 84x26), tool history
//               directly below it (84 wide x rest of column height),
//               agent chat as the right column. Best when host is wide
//               AND tall.
//   "side"    — NetHack on the left, agent pane on the right. Tool calls
//               and chat share the agent pane (renderer falls back to a
//               combined view). Used when host is wide but not tall.
//   "stacked" — NetHack on top, agent pane below. Used when host is too
//               narrow for side-by-side.
//   "tooSmall"— neither side nor stacked fits. No status bar (the resize
//               instructions render directly).
export type Layout =
  | { readonly kind: "tri"; readonly nethack: Box; readonly tools: Box; readonly chat: Box; readonly statusBar: Box }
  | { readonly kind: "side"; readonly nethack: Box; readonly thinking: Box; readonly statusBar: Box }
  | { readonly kind: "stacked"; readonly nethack: Box; readonly thinking: Box; readonly statusBar: Box }
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
const STATUS_BAR_ROWS = 1;               // reserved at the bottom
const SIDE_MIN_THINKING_COLS = 41;       // total side-by-side min: 84 + 1 + 41 = 126
const STACKED_MIN_THINKING_ROWS = 12;    // ... 26 + 1 + 12 + 1(status) = 40
const TRI_MIN_CHAT_COLS = 30;            // right column needs at least 30 wide
const TRI_MIN_TOOLS_ROWS = 8;            // tool box needs at least 8 rows

export function layout(hostCols: number, hostRows: number): Layout {
  // Effective rows available to the panes (status bar reserved).
  const paneRows = hostRows - STATUS_BAR_ROWS;

  const triMinCols = NETHACK_COLS + GAP + TRI_MIN_CHAT_COLS;          // 84 + 1 + 30 = 115
  const triMinRows = NETHACK_ROWS + GAP + TRI_MIN_TOOLS_ROWS + STATUS_BAR_ROWS; // 26+1+8+1 = 36
  const sideMinCols = NETHACK_COLS + GAP + SIDE_MIN_THINKING_COLS;    // 126
  const sideMinRows = NETHACK_ROWS + STATUS_BAR_ROWS;                 // 27
  const stackedMinCols = NETHACK_COLS;                                // 84
  const stackedMinRows = NETHACK_ROWS + GAP + STACKED_MIN_THINKING_ROWS + STATUS_BAR_ROWS; // 40

  const statusBar: Box = { row: hostRows, col: 1, cols: hostCols, rows: STATUS_BAR_ROWS };

  if (hostCols >= triMinCols && hostRows >= triMinRows) {
    const toolsRow = NETHACK_ROWS + GAP + 1;
    const toolsRows = paneRows - NETHACK_ROWS - GAP;                  // remaining above status bar
    return {
      kind: "tri",
      nethack: { row: 1, col: 1, cols: NETHACK_COLS, rows: NETHACK_ROWS },
      tools:   { row: toolsRow, col: 1, cols: NETHACK_COLS, rows: toolsRows },
      chat:    {
        row: 1,
        col: NETHACK_COLS + GAP + 1,
        cols: hostCols - NETHACK_COLS - GAP,
        rows: paneRows,
      },
      statusBar,
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
        rows: paneRows,
      },
      statusBar,
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
        rows: paneRows - NETHACK_ROWS - GAP,
      },
      statusBar,
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
