import { expect, test } from "bun:test";
import { Terminal } from "../../src/terminal";
import { RenderState } from "../../src/render-state";

const writeStr = (term: Terminal, s: string): void => {
  term.vtWrite(new TextEncoder().encode(s));
};

test("Terminal.renderToAnsiRect returns same content as a manual RenderState", () => {
  const term = new Terminal({ cols: 4, rows: 2 });
  writeStr(term, "ABCD");

  const manual = new RenderState();
  manual.update(term);
  const expected = manual.toAnsiRect({ row: 1, col: 1, cols: 4, rows: 2 });

  const actual = term.renderToAnsiRect({ row: 1, col: 1, cols: 4, rows: 2 });
  expect(actual).toBe(expected);
});

test("Terminal.renderToAnsiRect picks up writes between calls", () => {
  const term = new Terminal({ cols: 4, rows: 2 });
  writeStr(term, "AB");
  const first = term.renderToAnsiRect({ row: 1, col: 1, cols: 4, rows: 2 });
  expect(first).toContain("AB");

  writeStr(term, "CD");
  const second = term.renderToAnsiRect({ row: 1, col: 1, cols: 4, rows: 2 });
  expect(second).toContain("ABCD");
});

test("Terminal.renderToAnsiRect picks up resize", () => {
  const term = new Terminal({ cols: 4, rows: 2 });
  writeStr(term, "ABCD");
  // First call at 4×2 succeeds
  expect(() =>
    term.renderToAnsiRect({ row: 1, col: 1, cols: 4, rows: 2 }),
  ).not.toThrow();

  term.resize(8, 2);
  // After resize, dest must match new size
  expect(() =>
    term.renderToAnsiRect({ row: 1, col: 1, cols: 4, rows: 2 }),
  ).toThrow(/RectSizeMismatch/);
  expect(() =>
    term.renderToAnsiRect({ row: 1, col: 1, cols: 8, rows: 2 }),
  ).not.toThrow();
});

test("Terminal.close disposes cached RenderState", () => {
  const term = new Terminal({ cols: 4, rows: 2 });
  // Trigger cache allocation
  term.renderToAnsiRect({ row: 1, col: 1, cols: 4, rows: 2 });
  // Close the terminal
  term.close();
  // Subsequent calls throw
  expect(() =>
    term.renderToAnsiRect({ row: 1, col: 1, cols: 4, rows: 2 }),
  ).toThrow(/closed/);
});

test("Terminal.renderToAnsiRect throws UseAfterCloseError after close", () => {
  const term = new Terminal({ cols: 4, rows: 2 });
  term.close();
  expect(() =>
    term.renderToAnsiRect({ row: 1, col: 1, cols: 4, rows: 2 }),
  ).toThrow(/closed/);
});

test("public exports include the new render-rect surface", async () => {
  const mod = await import("../../src/index");
  expect(typeof mod.RectSizeMismatch).toBe("function");
  // Type-only exports don't appear at runtime; this test guards the
  // value-shaped exports only. Types are checked at compile time.
});
