import { expect, test } from "bun:test";
import { Terminal } from "../../src/terminal";
import { RenderState } from "../../src/render-state";

const writeStr = (term: Terminal, s: string): void => {
  term.vtWrite(new TextEncoder().encode(s));
};

/**
 * The motivating bug for this feature: a TUI program (e.g. NetHack)
 * writes a cursor-positioning escape after its render. If the consumer
 * splices the formatter's output into its own stream, that escape jumps
 * the host cursor and clobbers content elsewhere.
 *
 * `Terminal.renderToAnsiRect` walks the parsed cell grid and emits its
 * own cursor positioning. The program's own escapes get consumed by
 * libghostty's parser when they arrive via `vtWrite`; they MUST NOT
 * appear in the rect render's output.
 */
test("program cursor-positioning escapes do not leak into rect output", () => {
  const term = new Terminal({ cols: 8, rows: 4 });
  // Write some text, then a cursor-position escape (\x1b[3;5H = row 3 col 5)
  writeStr(term, "ABCD\r\n");
  writeStr(term, "EFGH\x1b[3;5H");

  const out = term.renderToAnsiRect({ row: 1, col: 1, cols: 8, rows: 4 }, {});
  // The program's positioning sequence MUST NOT appear in the output.
  expect(out).not.toContain("\x1b[3;5H");
  // Only our own row-start gotos are allowed (row 1-4, col 1).
  const allGotos = out.match(/\x1b\[\d+;\d+H/g) ?? [];
  for (const g of allGotos) {
    expect(g).toMatch(/^\x1b\[[1-4];1H$/);
  }
});

test("erase-in-line escapes do not leak", () => {
  const term = new Terminal({ cols: 4, rows: 1 });
  // Write text + erase-line. Whatever the visible result, the \x1b[K MUST NOT
  // appear in our rect output.
  writeStr(term, "AB\x1b[K");
  const out = term.renderToAnsiRect({ row: 1, col: 1, cols: 4, rows: 1 }, {});
  expect(out).not.toContain("\x1b[K");
});

test("alt-screen toggle escapes do not leak", () => {
  const term = new Terminal({ cols: 4, rows: 1 });
  // The DEC private modes for alt-screen (1049, 47) MUST NOT appear in output.
  writeStr(term, "\x1b[?1049hABCD");
  const out = term.renderToAnsiRect({ row: 1, col: 1, cols: 4, rows: 1 }, {});
  expect(out).not.toContain("\x1b[?1049h");
  expect(out).not.toContain("\x1b[?1049l");
});

test("OSC title sequences do not leak", () => {
  const term = new Terminal({ cols: 4, rows: 1 });
  writeStr(term, "\x1b]0;hello\x07ABCD");
  const out = term.renderToAnsiRect({ row: 1, col: 1, cols: 4, rows: 1 }, {});
  expect(out).not.toContain("\x1b]");
  expect(out).not.toContain("\x07");
});

test("convenience method matches manual RenderState path byte-for-byte", () => {
  const term = new Terminal({ cols: 8, rows: 2 });
  writeStr(term, "\x1b[1;31mAB\x1b[0mCD\r\nE\x1b[44m F\x1b[0m");

  const convenience = term.renderToAnsiRect(
    { row: 5, col: 10, cols: 8, rows: 2 },
    {},
  );

  const rs = new RenderState();
  rs.update(term);
  const manual = rs.toAnsiRect({ row: 5, col: 10, cols: 8, rows: 2 });

  expect(convenience).toBe(manual);
});
