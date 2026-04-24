import { describe, test, expect } from "bun:test";
import { Terminal } from "../../src";

describe("Terminal.colors", () => {
  test("returns effective + defaults + palette[256] on fresh terminal", () => {
    using term = new Terminal({ cols: 80, rows: 24 });
    const c = term.colors();
    expect(c.palette.length).toBe(256);
    expect(c.effective).toBeDefined();
    expect(c.defaults).toBeDefined();
    // Palette entries are tuples of [r, g, b], each 0-255.
    for (const [r, g, b] of c.palette) {
      expect(r).toBeGreaterThanOrEqual(0);
      expect(r).toBeLessThanOrEqual(255);
      expect(g).toBeGreaterThanOrEqual(0);
      expect(g).toBeLessThanOrEqual(255);
      expect(b).toBeGreaterThanOrEqual(0);
      expect(b).toBeLessThanOrEqual(255);
    }
  });

  test("palette[0] and palette[1] differ (semantic index order preserved)", () => {
    using term = new Terminal({ cols: 80, rows: 24 });
    const p = term.colors().palette;
    // xterm defaults: palette[0] is black (0,0,0), palette[1] is red (typically non-zero).
    // We only assert they differ; exact values depend on libghostty's default palette.
    expect(p[0]).not.toEqual(p[1]);
  });

  test("setColors(defaults.fg) updates defaults fg", () => {
    using term = new Terminal({ cols: 80, rows: 24 });
    term.setColors({ defaults: { fg: [42, 43, 44] } });
    const c = term.colors();
    expect(c.defaults.fg).toEqual([42, 43, 44]);
  });

  test("OSC 10 sets effective.fg", () => {
    using term = new Terminal({ cols: 80, rows: 24 });
    // OSC 10 ; rgb:ff/00/00 ST
    const bytes = new TextEncoder().encode("\x1b]10;rgb:ff/00/00\x1b\\");
    term.vtWrite(bytes);
    expect(term.colors().effective.fg).toEqual([255, 0, 0]);
  });

  test("OSC 10 override survival after setColors — records observed behavior", () => {
    using term = new Terminal({ cols: 80, rows: 24 });
    term.setColors({ defaults: { fg: [10, 20, 30] } });
    term.vtWrite(new TextEncoder().encode("\x1b]10;rgb:ff/00/00\x1b\\"));
    expect(term.colors().effective.fg).toEqual([255, 0, 0]);

    term.setColors({ defaults: { fg: [40, 50, 60] } });
    const afterSecondSet = term.colors().effective.fg;

    // This test RECORDS libghostty's observed behavior rather than asserting it.
    // Two outcomes are valid:
    //   (a) OSC override survives setColors → effective.fg stays [255, 0, 0]
    //   (b) setColors clears OSC override   → effective.fg becomes [40, 50, 60]
    // Both are documented in the README after Pass 3 lands.
    const survived = afterSecondSet?.[0] === 255 && afterSecondSet?.[1] === 0 && afterSecondSet?.[2] === 0;
    const cleared = afterSecondSet?.[0] === 40 && afterSecondSet?.[1] === 50 && afterSecondSet?.[2] === 60;
    expect(survived || cleared).toBe(true);
    // Log the observed outcome so the implementer can capture it in the README.
    console.log(`[Pass 3 §4.3 probe] OSC-override-survives-setColors: ${survived ? "YES" : "NO"}`);
  });

  test("empty setColors patch is a no-op", () => {
    using term = new Terminal({ cols: 80, rows: 24 });
    const before = term.colors();
    term.setColors({});
    const after = term.colors();
    expect(after.defaults).toEqual(before.defaults);
  });

  test("use-after-close throws on colors()", () => {
    const term = new Terminal({ cols: 80, rows: 24 });
    term.close();
    expect(() => term.colors()).toThrow(/closed/i);
  });

  test("setColors is rejected from inside a callback (re-entry guard)", () => {
    let caught: unknown;
    using term = new Terminal({
      cols: 80,
      rows: 24,
      onTitleChanged: () => {
        try { term.setColors({ defaults: { fg: [1, 2, 3] } }); }
        catch (e) { caught = e; }
      },
    });
    term.vtWrite(new TextEncoder().encode("\x1b]0;x\x1b\\"));
    expect(caught).toBeDefined();
  });

  test("Codex P2: setColors({ palette }) writes all 256 entries", () => {
    using term = new Terminal({ cols: 10, rows: 4 });
    const before = term.colors().palette;
    const next = before.map(([r, g, b]) => [(r + 1) & 0xff, (g + 2) & 0xff, (b + 3) & 0xff] as const);
    term.setColors({ palette: next });
    const after = term.colors().palette;
    for (let i = 0; i < 256; i += 1) {
      expect(after[i]).toEqual(next[i]!);
    }
  });

  test("Codex P2: setColors({ palette }) with wrong length throws invalid_value", () => {
    using term = new Terminal({ cols: 10, rows: 4 });
    expect(() => term.setColors({ palette: [[0, 0, 0]] })).toThrow(/invalid/i);
  });
});
