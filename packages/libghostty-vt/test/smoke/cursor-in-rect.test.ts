import { expect, test } from "bun:test";
import { Terminal } from "../../src/terminal";
import { RenderState } from "../../src/render-state";
import { RectSizeMismatch } from "../../src/errors";

const writeStr = (term: Terminal, s: string): void => {
  term.vtWrite(new TextEncoder().encode(s));
};

test("never-updated RenderState returns null", () => {
  const rs = new RenderState();
  // 0×0 source; passing a 0×0 dest succeeds and returns null since cursor is unset
  expect(rs.cursorInRect({ row: 1, col: 1, cols: 0, rows: 0 })).toBeNull();
});

test("cursor at (0,0) of source maps to dest origin", () => {
  const term = new Terminal({ cols: 4, rows: 2 });
  // Terminal's initial cursor is at (0,0); we don't write anything so it stays.
  const rs = new RenderState();
  rs.update(term);

  const c = rs.cursorInRect({ row: 1, col: 1, cols: 4, rows: 2 });
  expect(c).not.toBeNull();
  expect(c?.row).toBe(1);
  expect(c?.col).toBe(1);
  expect(c?.wideTail).toBe(false);
});

test("cursor at (0,0) maps to non-1,1 dest origin", () => {
  const term = new Terminal({ cols: 4, rows: 2 });
  const rs = new RenderState();
  rs.update(term);

  const c = rs.cursorInRect({ row: 5, col: 10, cols: 4, rows: 2 });
  expect(c?.row).toBe(5);
  expect(c?.col).toBe(10);
});

test("cursor advances after writes", () => {
  const term = new Terminal({ cols: 4, rows: 2 });
  writeStr(term, "AB");
  const rs = new RenderState();
  rs.update(term);

  const c = rs.cursorInRect({ row: 1, col: 1, cols: 4, rows: 2 });
  expect(c).not.toBeNull();
  expect(c?.col).toBe(3); // dest.col(1) + cursor.x(2) = 3
  expect(c?.row).toBe(1); // dest.row(1) + cursor.y(0) = 1
});

test("size mismatch throws RectSizeMismatch", () => {
  const term = new Terminal({ cols: 4, rows: 2 });
  const rs = new RenderState();
  rs.update(term);
  expect(() =>
    rs.cursorInRect({ row: 1, col: 1, cols: 5, rows: 2 }),
  ).toThrow(RectSizeMismatch);
});

test("UseAfterCloseError after close", () => {
  const rs = new RenderState();
  rs.close();
  expect(() =>
    rs.cursorInRect({ row: 1, col: 1, cols: 0, rows: 0 }),
  ).toThrow(/has been closed/);
});
