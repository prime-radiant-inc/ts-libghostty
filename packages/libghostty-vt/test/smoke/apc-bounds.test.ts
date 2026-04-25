import { describe, test, expect } from "bun:test";
import { Terminal, GhosttyError } from "../../src";

describe("APC bounds wiring", () => {
  test("default-path constructor succeeds (no options passed)", () => {
    using term = new Terminal({ cols: 80, rows: 24 });
    // No crash on construction; subsequent vtWrite works.
    term.vtWrite(new Uint8Array([0x61])); // "a"
    expect(term.snapshot().cols).toBe(80);
  });

  test("custom apcMaxBytes (2 MiB) constructor succeeds", () => {
    using term = new Terminal({
      cols: 80,
      rows: 24,
      apcMaxBytes: 2 * 1024 * 1024,
    });
    term.vtWrite(new Uint8Array([0x61]));
    expect(term.snapshot().cols).toBe(80);
  });

  test("custom apcMaxBytesKitty (1 MiB) constructor succeeds", () => {
    using term = new Terminal({
      cols: 80,
      rows: 24,
      apcMaxBytesKitty: 1024 * 1024,
    });
    expect(term.snapshot().cols).toBe(80);
  });

  test("constructing with both options set succeeds", () => {
    using term = new Terminal({
      cols: 80,
      rows: 24,
      apcMaxBytes: 512 * 1024,
      apcMaxBytesKitty: 256 * 1024,
    });
    expect(term.snapshot().cols).toBe(80);
  });

  test("negative apcMaxBytes throws invalid_value at construction", () => {
    try {
      new Terminal({ cols: 80, rows: 24, apcMaxBytes: -1 });
      throw new Error("expected constructor to throw");
    } catch (e) {
      expect(e).toBeInstanceOf(GhosttyError);
      expect((e as GhosttyError).code).toBe("invalid_value");
      expect(String(e)).toMatch(/apcMaxBytes/);
      expect(String(e)).toMatch(/-1/);
    }
  });

  test("negative apcMaxBytesKitty throws invalid_value at construction", () => {
    try {
      new Terminal({ cols: 80, rows: 24, apcMaxBytesKitty: -42 });
      throw new Error("expected constructor to throw");
    } catch (e) {
      expect(e).toBeInstanceOf(GhosttyError);
      expect((e as GhosttyError).code).toBe("invalid_value");
      expect(String(e)).toMatch(/apcMaxBytesKitty/);
    }
  });

  test("oversized apcMaxBytes throws invalid_value", () => {
    try {
      new Terminal({ cols: 80, rows: 24, apcMaxBytes: Number.MAX_SAFE_INTEGER + 1 });
      throw new Error("expected constructor to throw");
    } catch (e) {
      expect(e).toBeInstanceOf(GhosttyError);
      expect((e as GhosttyError).code).toBe("invalid_value");
    }
  });

  test("APC bound NaN throws invalid_value", () => {
    try {
      new Terminal({ cols: 80, rows: 24, apcMaxBytes: Number.NaN });
      throw new Error("expected constructor to throw");
    } catch (e) {
      expect(e).toBeInstanceOf(GhosttyError);
      expect((e as GhosttyError).code).toBe("invalid_value");
    }
  });
});
