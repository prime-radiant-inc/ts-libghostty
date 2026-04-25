export interface Box {
  readonly row: number;   // 1-based
  readonly col: number;   // 1-based
  readonly cols: number;
  readonly rows: number;
}

export type Layout =
  | { readonly kind: "side"; readonly nethack: Box; readonly thinking: Box }
  | { readonly kind: "stacked"; readonly nethack: Box; readonly thinking: Box }
  | {
      readonly kind: "tooSmall";
      readonly minSideCols: number;
      readonly minSideRows: number;
      readonly minStackedCols: number;
      readonly minStackedRows: number;
    };

const NETHACK_COLS = 82;   // 80 inner + 2 border
const NETHACK_ROWS = 27;   // 25 inner + 1 title bar + 2 border (row 27 incl title)
const GAP = 1;
const SIDE_MIN_THINKING_COLS = 41;
const STACKED_MIN_THINKING_ROWS = 11;

export function layout(hostCols: number, hostRows: number): Layout {
  const sideMinCols = NETHACK_COLS + GAP + SIDE_MIN_THINKING_COLS; // 82 + 1 + 41 = 124
  const sideMinRows = NETHACK_ROWS;                                 // 27
  const stackedMinCols = NETHACK_COLS;                              // 82
  const stackedMinRows = NETHACK_ROWS + GAP + STACKED_MIN_THINKING_ROWS; // 39

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
