import { describe, test, expect } from "bun:test";
import { Terminal } from "../../src";

describe("Terminal.scrollViewport", () => {
  test('"top" does not throw on a fresh terminal', () => {
    using term = new Terminal({ cols: 80, rows: 24, maxScrollback: 100 });
    term.scrollViewport("top");
    expect(term.snapshot().rows).toBe(24);
  });

  test('"bottom" does not throw on a fresh terminal', () => {
    using term = new Terminal({ cols: 80, rows: 24 });
    term.scrollViewport("bottom");
    expect(term.snapshot().rows).toBe(24);
  });

  test("positive delta does not throw", () => {
    using term = new Terminal({ cols: 80, rows: 24, maxScrollback: 100 });
    term.scrollViewport(5);
    expect(term.snapshot().rows).toBe(24);
  });

  test("negative delta does not throw", () => {
    using term = new Terminal({ cols: 80, rows: 24, maxScrollback: 100 });
    term.scrollViewport(-5);
    expect(term.snapshot().rows).toBe(24);
  });

  test("huge positive delta clamps without crash", () => {
    using term = new Terminal({ cols: 80, rows: 24, maxScrollback: 100 });
    term.scrollViewport(99999);
    expect(term.snapshot().rows).toBe(24);
  });

  test("use-after-close throws", () => {
    const term = new Terminal({ cols: 80, rows: 24 });
    term.close();
    expect(() => term.scrollViewport("top")).toThrow(/closed/i);
  });

  test("invalid string argument throws", () => {
    using term = new Terminal({ cols: 80, rows: 24 });
    // @ts-expect-error — intentionally invalid
    expect(() => term.scrollViewport("middle")).toThrow(/invalid/i);
  });
});
