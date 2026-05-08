import { expect, test } from "bun:test";
import { layout } from "../../examples/bobbihack/layout";

test("tri layout when host is both wide and tall", () => {
  const out = layout(200, 60);
  expect(out.kind).toBe("tri");
  if (out.kind !== "tri") return;
  expect(out.nethack).toEqual({ row: 1, col: 1, cols: 84, rows: 26 });
  // Tools box sits directly below NetHack — no in-column gap. Status
  // bar reserves the bottom row, so tools fills paneRows - NetHack =
  // (60 - 1) - 26 = 33 rows.
  expect(out.tools).toEqual({ row: 27, col: 1, cols: 84, rows: 33 });
  // Chat fills the right column up to but not including the status bar:
  // 200 - 84 - 1 = 115 wide; 60 - 1 = 59 tall.
  expect(out.chat).toEqual({ row: 1, col: 86, cols: 115, rows: 59 });
  // Status bar is the bottom row, full width.
  expect(out.statusBar).toEqual({ row: 60, col: 1, cols: 200, rows: 1 });
});

test("tri at exact threshold (115x35)", () => {
  const out = layout(115, 35);
  expect(out.kind).toBe("tri");
  if (out.kind !== "tri") return;
  expect(out.tools.rows).toBe(8);   // 35 - 1(status) - 26 = 8
  expect(out.chat.cols).toBe(30);   // 115 - 84 - 1
  expect(out.statusBar.row).toBe(35);
});

test("side-by-side when wide but not tall enough for tri", () => {
  const out = layout(200, 28);
  expect(out.kind).toBe("side");
  if (out.kind !== "side") return;
  expect(out.nethack).toEqual({ row: 1, col: 1, cols: 84, rows: 26 });
  // Thinking pane occupies 28 - 1(status bar) = 27 rows.
  expect(out.thinking).toEqual({ row: 1, col: 86, cols: 115, rows: 27 });
  expect(out.statusBar).toEqual({ row: 28, col: 1, cols: 200, rows: 1 });
});

test("side-by-side at the exact threshold (126x27)", () => {
  const out = layout(126, 27);
  expect(out.kind).toBe("side");
  if (out.kind !== "side") return;
  expect(out.thinking.cols).toBe(41); // 126 - 84 - 1
  expect(out.thinking.rows).toBe(26); // 27 - 1(status)
});

test("stacked when tall but not wide enough for side-by-side", () => {
  const out = layout(100, 40);
  expect(out.kind).toBe("stacked");
  if (out.kind !== "stacked") return;
  expect(out.nethack).toEqual({ row: 1, col: 1, cols: 84, rows: 26 });
  // 40 - 1(status) - 26 - 1(gap) = 12.
  expect(out.thinking).toEqual({ row: 28, col: 1, cols: 100, rows: 12 });
  expect(out.statusBar).toEqual({ row: 40, col: 1, cols: 100, rows: 1 });
});

test("stacked at the exact threshold (84x40)", () => {
  const out = layout(84, 40);
  expect(out.kind).toBe("stacked");
});

test("tri wins when all three layouts fit", () => {
  const out = layout(200, 60);
  expect(out.kind).toBe("tri");
});

test("side-by-side wins when tri doesn't fit but side does", () => {
  // 126x28: side OK (126>=126, 28>=27); tri not OK (28 < 36 needed);
  // stacked not OK (28 < 40).
  const out = layout(126, 28);
  expect(out.kind).toBe("side");
});

test("tooSmall when neither layout fits", () => {
  const out = layout(80, 24);
  expect(out.kind).toBe("tooSmall");
  if (out.kind !== "tooSmall") return;
  expect(out.minSideCols).toBe(126);
  expect(out.minSideRows).toBe(27);
  expect(out.minStackedCols).toBe(84);
  expect(out.minStackedRows).toBe(40);
});

test("tooSmall on degenerate input", () => {
  expect(layout(1, 1).kind).toBe("tooSmall");
  expect(layout(0, 0).kind).toBe("tooSmall");
});
