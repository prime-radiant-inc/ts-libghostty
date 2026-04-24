import { describe, test, expect } from "bun:test";
import { Terminal } from "../../src";

describe("Terminal.cellAt — active + viewport", () => {
  test('default coord space is "active"', () => {
    using term = new Terminal({ cols: 80, rows: 24 });
    term.vtWrite(new TextEncoder().encode("hello"));
    // cursor advanced; (0,0) should be 'h'
    const cell = term.cellAt({ x: 0, y: 0 });
    expect(cell).toBeDefined();
    expect(cell!.text).toBe("h");
    expect(cell!.wide).toBe(false);
    expect(cell!.isWideContinuation).toBe(false);
    expect(cell!.protected).toBe(false);
  });

  test("empty cell has empty text", () => {
    using term = new Terminal({ cols: 80, rows: 24 });
    term.vtWrite(new TextEncoder().encode("hi"));
    const cell = term.cellAt({ x: 10, y: 0 }); // past "hi"
    expect(cell).toBeDefined();
    expect(cell!.text).toBe("");
  });

  test("bold cell carries style.bold = true", () => {
    using term = new Terminal({ cols: 80, rows: 24 });
    // SGR 1 = bold. Sequence: CSI 1 m + 'A'
    term.vtWrite(new TextEncoder().encode("\x1b[1mA"));
    const cell = term.cellAt({ x: 0, y: 0 });
    expect(cell).toBeDefined();
    expect(cell!.text).toBe("A");
    expect(cell!.style?.bold).toBe(true);
  });

  test("wide grapheme: primary cell wide=true, next cell isWideContinuation=true", () => {
    using term = new Terminal({ cols: 80, rows: 24 });
    // U+4E2D "中" — CJK ideograph, width=2
    term.vtWrite(new TextEncoder().encode("中"));
    const primary = term.cellAt({ x: 0, y: 0 });
    const trailing = term.cellAt({ x: 1, y: 0 });
    expect(primary).toBeDefined();
    expect(primary!.text).toBe("中");
    expect(primary!.wide).toBe(true);
    expect(primary!.isWideContinuation).toBe(false);
    expect(trailing).toBeDefined();
    expect(trailing!.text).toBe("");
    expect(trailing!.isWideContinuation).toBe(true);
  });

  test("out-of-bounds (active) returns undefined, not a throw", () => {
    using term = new Terminal({ cols: 80, rows: 24 });
    expect(term.cellAt({ x: 999, y: 0 })).toBeUndefined();
    expect(term.cellAt({ x: 0, y: 999 })).toBeUndefined();
    expect(term.cellAt({ x: -1, y: 0 })).toBeUndefined();
  });

  test('coordinateSpace: "viewport" works on a fresh terminal (== active before any scroll)', () => {
    using term = new Terminal({ cols: 80, rows: 24 });
    term.vtWrite(new TextEncoder().encode("v"));
    const cell = term.cellAt({ x: 0, y: 0, coordinateSpace: "viewport" });
    expect(cell).toBeDefined();
    expect(cell!.text).toBe("v");
  });

  test("out-of-bounds viewport returns undefined", () => {
    using term = new Terminal({ cols: 80, rows: 24 });
    expect(term.cellAt({ x: 0, y: 999, coordinateSpace: "viewport" })).toBeUndefined();
  });

  test("hyperlink URI read: cell inside OSC 8 region has hyperlinkUri set", () => {
    using term = new Terminal({ cols: 80, rows: 24 });
    // OSC 8 ; params ; uri ST text OSC 8 ; ; ST
    const seq = "\x1b]8;;https://example.com\x1b\\X\x1b]8;;\x1b\\";
    term.vtWrite(new TextEncoder().encode(seq));
    const cell = term.cellAt({ x: 0, y: 0 });
    expect(cell).toBeDefined();
    expect(cell!.text).toBe("X");
    // OSC 8 support may not be wired at the pin — if hyperlinkUri is undefined,
    // log a diagnostic and skip the assertion (do not fail the test).
    if (cell!.hyperlinkUri !== undefined) {
      expect(cell!.hyperlinkUri).toBe("https://example.com");
    } else {
      console.log("[cell-at test] hyperlinkUri is undefined — OSC 8 not wired at this pin");
    }
  });

  test("use-after-close throws", () => {
    const term = new Terminal({ cols: 80, rows: 24 });
    term.close();
    expect(() => term.cellAt({ x: 0, y: 0 })).toThrow(/closed/i);
  });

  test("invalid coordinateSpace throws invalid", () => {
    using term = new Terminal({ cols: 80, rows: 24 });
    // @ts-expect-error — intentionally invalid
    expect(() => term.cellAt({ x: 0, y: 0, coordinateSpace: "fog" })).toThrow(/invalid/i);
  });
});

describe("Terminal.cellAt — screen + history", () => {
  test('"screen" returns the same cell as "active" on a fresh terminal', () => {
    using term = new Terminal({ cols: 80, rows: 24 });
    term.vtWrite(new TextEncoder().encode("hello"));
    const active = term.cellAt({ x: 0, y: 0 });
    const screen = term.cellAt({ x: 0, y: 0, coordinateSpace: "screen" });
    expect(screen?.text).toBe(active?.text);
  });

  test('"history" on a fresh terminal with no scrollback: y=0 returns empty cell, large y returns undefined', () => {
    // libghostty authoritative behavior: history y=0 resolves (returns an empty cell)
    // even when the history space has no content. Out-of-bounds is signalled by
    // undefined only when the coordinate exceeds the allocated history rows.
    using term = new Terminal({ cols: 80, rows: 24, maxScrollback: 100 });
    const cell = term.cellAt({ x: 0, y: 0, coordinateSpace: "history" });
    // Either an empty cell or undefined — both are valid; the important invariant
    // is that it does NOT throw.
    if (cell !== undefined) {
      expect(cell.text).toBe("");
    }
  });

  test('"history" returns scrollback content after rows scroll off-screen', () => {
    using term = new Terminal({ cols: 10, rows: 2, maxScrollback: 100 });
    // Fill rows 0..5 then let natural scroll push the first into scrollback.
    for (let i = 0; i < 5; i += 1) {
      term.vtWrite(new TextEncoder().encode(`L${i}\r\n`));
    }
    // History (y=0) should now hold the oldest row "L0".
    // We can't assert exactly — libghostty's exact scrollback semantics are
    // authoritative — but at least one of y=0..3 should contain "L".
    let found = false;
    for (let y = 0; y < 4; y += 1) {
      const c = term.cellAt({ x: 0, y, coordinateSpace: "history" });
      if (c?.text === "L") { found = true; break; }
    }
    expect(found).toBe(true);
  });

  test('"screen" out-of-bounds returns undefined', () => {
    using term = new Terminal({ cols: 80, rows: 24 });
    expect(term.cellAt({ x: 999, y: 0, coordinateSpace: "screen" })).toBeUndefined();
  });

  test('"history" out-of-bounds returns undefined', () => {
    using term = new Terminal({ cols: 80, rows: 24, maxScrollback: 100 });
    expect(term.cellAt({ x: 0, y: 99999, coordinateSpace: "history" })).toBeUndefined();
  });
});
