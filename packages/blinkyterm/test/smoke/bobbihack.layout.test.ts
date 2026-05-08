import { expect, test } from "bun:test";
import { layout } from "../../examples/bobbihack/layout";

test("tri layout when host is both wide and tall", () => {
  const out = layout(200, 60);
  expect(out.kind).toBe("tri");
  if (out.kind !== "tri") return;
  expect(out.nethack).toEqual({ row: 1, col: 1, cols: 84, rows: 26 });
  // tools box directly below NetHack with a 1-row gap; full NetHack-width
  // tall enough to take the rest of the host height (60 - 26 - 1 = 33)
  expect(out.tools).toEqual({ row: 28, col: 1, cols: 84, rows: 33 });
  // chat fills the right column (200 - 84 - 1 = 115 wide), full host height
  expect(out.chat).toEqual({ row: 1, col: 86, cols: 115, rows: 60 });
});

test("tri at exact threshold (115x35)", () => {
  const out = layout(115, 35);
  expect(out.kind).toBe("tri");
  if (out.kind !== "tri") return;
  expect(out.tools.rows).toBe(8);  // 35 - 26 - 1
  expect(out.chat.cols).toBe(30);  // 115 - 84 - 1
});

test("side-by-side when wide but not tall enough for tri", () => {
  const out = layout(200, 28);
  expect(out.kind).toBe("side");
  if (out.kind !== "side") return;
  expect(out.nethack).toEqual({ row: 1, col: 1, cols: 84, rows: 26 });
  expect(out.thinking).toEqual({ row: 1, col: 86, cols: 115, rows: 28 });
});

test("side-by-side at the exact threshold (126x26)", () => {
  const out = layout(126, 26);
  expect(out.kind).toBe("side");
  if (out.kind !== "side") return;
  expect(out.thinking.cols).toBe(41); // 126 - 84 - 1
  expect(out.thinking.rows).toBe(26);
});

test("stacked when tall but not wide enough for side-by-side", () => {
  const out = layout(100, 40);
  expect(out.kind).toBe("stacked");
  if (out.kind !== "stacked") return;
  expect(out.nethack).toEqual({ row: 1, col: 1, cols: 84, rows: 26 });
  expect(out.thinking).toEqual({ row: 28, col: 1, cols: 100, rows: 13 });
});

test("stacked at the exact threshold (84x39)", () => {
  const out = layout(84, 39);
  expect(out.kind).toBe("stacked");
});

test("tri wins when all three layouts fit", () => {
  // 200x60 satisfies tri (115+35), side (126+26), stacked (84+39).
  // Tri is preferred.
  const out = layout(200, 60);
  expect(out.kind).toBe("tri");
});

test("side-by-side wins when tri doesn't fit but side does", () => {
  // 126x28: side OK (126>=126, 28>=26); tri not OK (128 needs 35 rows);
  // stacked not OK (28 < 39).
  const out = layout(126, 28);
  expect(out.kind).toBe("side");
});

test("tooSmall when neither layout fits", () => {
  const out = layout(80, 24);
  expect(out.kind).toBe("tooSmall");
  if (out.kind !== "tooSmall") return;
  expect(out.minSideCols).toBe(126);
  expect(out.minSideRows).toBe(26);
  expect(out.minStackedCols).toBe(84);
  expect(out.minStackedRows).toBe(39);
});

test("tooSmall on degenerate input", () => {
  expect(layout(1, 1).kind).toBe("tooSmall");
  expect(layout(0, 0).kind).toBe("tooSmall");
});
