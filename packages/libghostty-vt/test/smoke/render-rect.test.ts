import { expect, test } from "bun:test";
import { Terminal } from "../../src/terminal";
import { RenderState } from "../../src/render-state";
import { renderRect } from "../../src/render-rect";
import { RectSizeMismatch } from "../../src/errors";

const writeStr = (term: Terminal, s: string): void => {
  term.vtWrite(new TextEncoder().encode(s));
};

const stateOf = (cols: number, rows: number, write?: (t: Terminal) => void) => {
  const term = new Terminal({ cols, rows });
  if (write) write(term);
  const rs = new RenderState();
  rs.update(term);
  return { term, rs };
};

test("empty terminal renders all-spaces with row-start resets", () => {
  const { rs } = stateOf(4, 2);
  const out = renderRect(rs, { row: 1, col: 1, cols: 4, rows: 2 }, {});
  expect(out).toContain("\x1b[1;1H\x1b[0m");
  expect(out).toContain("\x1b[2;1H\x1b[0m");
  const spaceRuns = out.match(/    /g);
  expect(spaceRuns?.length).toBeGreaterThanOrEqual(2);
  const allGotos = out.match(/\x1b\[\d+;\d+H/g) ?? [];
  expect(allGotos).toEqual(["\x1b[1;1H", "\x1b[2;1H"]);
});

test("plain text content appears in the output", () => {
  const { rs } = stateOf(4, 1, (t) => writeStr(t, "ABCD"));
  const out = renderRect(rs, { row: 1, col: 1, cols: 4, rows: 1 }, {});
  expect(out).toContain("ABCD");
});

test("dest origin is honored — non-1,1 coordinates", () => {
  const { rs } = stateOf(4, 2, (t) => writeStr(t, "ABCD"));
  const out = renderRect(rs, { row: 5, col: 10, cols: 4, rows: 2 }, {});
  expect(out).toContain("\x1b[5;10H");
  expect(out).toContain("\x1b[6;10H");
});

test("styled cell emits reset-prefixed SGR", () => {
  const { rs } = stateOf(4, 1, (t) => writeStr(t, "\x1b[1;31mX"));
  const out = renderRect(rs, { row: 1, col: 1, cols: 4, rows: 1 }, {});
  expect(out).toContain("\x1b[0;1;31m");
  expect(out).toContain("X");
});

test("transition back to default emits reset", () => {
  const { rs } = stateOf(4, 1, (t) => writeStr(t, "\x1b[1;31mX\x1b[0mY"));
  const out = renderRect(rs, { row: 1, col: 1, cols: 4, rows: 1 }, {});
  expect(out).toContain("\x1b[0;1;31m");
  expect(out).toContain("X");
  const resetIndex = out.lastIndexOf("\x1b[0m");
  const yIndex = out.indexOf("Y");
  expect(resetIndex).toBeLessThan(yIndex);
});

test("colorDepth 'none' suppresses all SGR", () => {
  const { rs } = stateOf(4, 1, (t) => writeStr(t, "\x1b[1;31mABCD"));
  const out = renderRect(
    rs,
    { row: 1, col: 1, cols: 4, rows: 1 },
    { colorDepth: "none" },
  );
  expect(out).toContain("ABCD");
  // Permitted: row-start \x1b[0m. Forbidden: any *other* SGR.
  const allSgr = out.match(/\x1b\[\d+(;\d+)*m/g) ?? [];
  for (const s of allSgr) expect(s).toBe("\x1b[0m");
});

test("size mismatch throws RectSizeMismatch", () => {
  const { rs } = stateOf(4, 2);
  expect(() =>
    renderRect(rs, { row: 1, col: 1, cols: 5, rows: 2 }, {}),
  ).toThrow(RectSizeMismatch);
  expect(() =>
    renderRect(rs, { row: 1, col: 1, cols: 4, rows: 3 }, {}),
  ).toThrow(RectSizeMismatch);
});

test("size mismatch error carries source and dest dims", () => {
  const { rs } = stateOf(4, 2);
  try {
    renderRect(rs, { row: 1, col: 1, cols: 5, rows: 2 }, {});
    throw new Error("expected throw");
  } catch (e) {
    expect(e).toBeInstanceOf(RectSizeMismatch);
    if (e instanceof RectSizeMismatch) {
      expect(e.source).toEqual({ cols: 4, rows: 2 });
      expect(e.dest).toEqual({ cols: 5, rows: 2 });
      expect(e.code).toBe("rect_size_mismatch");
    }
  }
});

test("never-updated RenderState has 0×0 source and throws on any non-zero dest", () => {
  const rs = new RenderState();
  expect(() =>
    renderRect(rs, { row: 1, col: 1, cols: 4, rows: 2 }, {}),
  ).toThrow(RectSizeMismatch);
});
