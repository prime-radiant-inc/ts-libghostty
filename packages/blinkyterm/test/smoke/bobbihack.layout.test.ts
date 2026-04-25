import { expect, test } from "bun:test";
import { layout } from "../../examples/bobbihack/layout";

test("side-by-side when wide enough", () => {
  const out = layout(200, 60);
  expect(out.kind).toBe("side");
  if (out.kind !== "side") return;
  expect(out.nethack).toEqual({ row: 1, col: 1, cols: 82, rows: 27 });
  // thinking pane occupies remaining width (200 - 82 - 1 = 117), full host height
  expect(out.thinking).toEqual({ row: 1, col: 84, cols: 117, rows: 60 });
});

test("side-by-side at the exact threshold (124x27)", () => {
  const out = layout(124, 27);
  expect(out.kind).toBe("side");
  if (out.kind !== "side") return;
  expect(out.thinking.cols).toBe(41); // 124 - 82 - 1
  expect(out.thinking.rows).toBe(27);
});

test("stacked when tall but not wide enough for side-by-side", () => {
  const out = layout(100, 40);
  expect(out.kind).toBe("stacked");
  if (out.kind !== "stacked") return;
  expect(out.nethack).toEqual({ row: 1, col: 1, cols: 82, rows: 27 });
  // thinking pane below NetHack, full width, remaining height (40 - 27 - 1 = 12)
  expect(out.thinking).toEqual({ row: 29, col: 1, cols: 100, rows: 12 });
});

test("stacked at the exact threshold (82x39)", () => {
  const out = layout(82, 39);
  expect(out.kind).toBe("stacked");
});

test("side-by-side wins when both fit", () => {
  // 124x39 satisfies both: side-by-side preferred
  const out = layout(124, 39);
  expect(out.kind).toBe("side");
});

test("tooSmall when neither layout fits", () => {
  const out = layout(80, 24);
  expect(out.kind).toBe("tooSmall");
  if (out.kind !== "tooSmall") return;
  expect(out.minSideCols).toBe(124);
  expect(out.minSideRows).toBe(27);
  expect(out.minStackedCols).toBe(82);
  expect(out.minStackedRows).toBe(39);
});

test("tooSmall on degenerate input", () => {
  expect(layout(1, 1).kind).toBe("tooSmall");
  expect(layout(0, 0).kind).toBe("tooSmall");
});
