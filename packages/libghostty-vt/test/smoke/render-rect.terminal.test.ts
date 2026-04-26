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

test("Terminal.renderToAnsiRect picks up many sequential writes", () => {
  // Regression: an earlier implementation cached one RenderState and reused
  // it across calls; under a real pty-driven Terminal, ghostty_render_state_update
  // returned success but the cell grid stayed frozen on the first frame.
  // Now the convenience method allocates fresh per call. This test proves the
  // sequence is genuinely fresh by hashing successive rect renders after each
  // write and asserting they all differ.
  const term = new Terminal({ cols: 4, rows: 2 });
  const seen = new Set<string>();
  for (const ch of ["A", "B", "C", "D", "E", "F", "G", "H"]) {
    writeStr(term, ch);
    seen.add(term.renderToAnsiRect({ row: 1, col: 1, cols: 4, rows: 2 }));
  }
  // Eight writes → eight distinct rendered strings (cell content differs each time).
  expect(seen.size).toBe(8);
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
