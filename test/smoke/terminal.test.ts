import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Terminal } from "../../src/terminal";
import { GhosttyError, UseAfterCloseError } from "../../src/errors";
import type { TerminalSnapshot } from "../../src/types";
import * as ffi from "../../src/ffi";

describe("Terminal lifecycle", () => {
  beforeEach(() => {
    // No need to reset ffi — load is shared across tests in the same process.
  });

  it("constructs with required options", () => {
    using term = new Terminal({ cols: 80, rows: 24 });
    expect(term).toBeDefined();
  });

  it("close() is idempotent", () => {
    const term = new Terminal({ cols: 80, rows: 24 });
    term.close();
    term.close();   // must not throw
  });

  it("is idempotent under close() → close() even with callbacks registered", () => {
    let bellCount = 0;
    const term = new Terminal({
      cols: 10, rows: 3,
      onBell: () => { bellCount++; },
    });
    term.close();
    // Second close must be a silent no-op — no throw, no double-free crash.
    expect(() => term.close()).not.toThrow();
  });

  it("Symbol.dispose closes", () => {
    let terminal: Terminal;
    {
      using term = new Terminal({ cols: 80, rows: 24 });
      terminal = term;
    }
    // After the `using` block, the handle is closed. Using it throws.
    expect(() => terminal.vtWrite(new Uint8Array([65]))).toThrow(UseAfterCloseError);
  });

  it("throws UseAfterCloseError on any method after close()", () => {
    const term = new Terminal({ cols: 80, rows: 24 });
    term.close();
    expect(() => term.vtWrite(new Uint8Array([65]))).toThrow(UseAfterCloseError);
    expect(() => term.snapshot()).toThrow(UseAfterCloseError);
    expect(() => term.resize(100, 30)).toThrow(UseAfterCloseError);
    expect(() => term.reset()).toThrow(UseAfterCloseError);
    expect(() => term.mode("bracketed_paste")).toThrow(UseAfterCloseError);
    expect(() => term.setMode("bracketed_paste", true)).toThrow(UseAfterCloseError);
  });

  it("constructor validates cols/rows > 0", () => {
    expect(() => new Terminal({ cols: 0, rows: 24 })).toThrow();
    expect(() => new Terminal({ cols: 80, rows: 0 })).toThrow();
    expect(() => new Terminal({ cols: -1, rows: 24 })).toThrow();
  });
});

// Regression tests for Codex-flagged contract bugs (Pass 1 fix-up).
// Each repro must throw at the JS boundary, naming the offending field, with
// code "invalid_value" — silent FFI coercion (u16 wrap, sign-extension into
// uint32, BigInt-encoding of negatives as huge size_t) is not acceptable.
describe("Terminal input validation (Codex bug 2)", () => {
  it("rejects cols above uint16_t max (cols: 70000 used to wrap to 4464)", () => {
    expect(() => new Terminal({ cols: 70000, rows: 24 })).toThrow(/cols/);
    try {
      new Terminal({ cols: 70000, rows: 24 });
    } catch (e) {
      expect(e).toBeInstanceOf(GhosttyError);
      expect((e as GhosttyError).code).toBe("invalid_value");
      expect((e as Error).message).toContain("cols");
      expect((e as Error).message).toContain("70000");
    }
  });

  it("rejects rows above uint16_t max", () => {
    expect(() => new Terminal({ cols: 80, rows: 70000 })).toThrow(/rows/);
  });

  it("rejects negative cellPx.width (used to yield pixelWidth: -80)", () => {
    expect(
      () => new Terminal({ cols: 80, rows: 24, cellPx: { width: -1, height: 2 } }),
    ).toThrow(/cellPx\.width/);
    try {
      new Terminal({ cols: 80, rows: 24, cellPx: { width: -1, height: 2 } });
    } catch (e) {
      expect(e).toBeInstanceOf(GhosttyError);
      expect((e as GhosttyError).code).toBe("invalid_value");
      expect((e as Error).message).toContain("cellPx.width");
    }
  });

  it("rejects negative cellPx.height", () => {
    expect(
      () => new Terminal({ cols: 80, rows: 24, cellPx: { width: 2, height: -1 } }),
    ).toThrow(/cellPx\.height/);
  });

  it("rejects non-integer cellPx values", () => {
    expect(
      () => new Terminal({ cols: 80, rows: 24, cellPx: { width: 1.5, height: 2 } }),
    ).toThrow(/cellPx\.width/);
  });

  it("rejects maxScrollback: -1 (used to be marshaled as huge size_t)", () => {
    expect(() => new Terminal({ cols: 80, rows: 24, maxScrollback: -1 })).toThrow(
      /maxScrollback/,
    );
    try {
      new Terminal({ cols: 80, rows: 24, maxScrollback: -1 });
    } catch (e) {
      expect(e).toBeInstanceOf(GhosttyError);
      expect((e as GhosttyError).code).toBe("invalid_value");
      expect((e as Error).message).toContain("maxScrollback");
    }
  });

  it("accepts cols/rows at the uint16_t boundary", () => {
    using term = new Terminal({ cols: 65535, rows: 65535 });
    // Construction should succeed; we don't snapshot because allocating a
    // 65535x65535 grid is wasteful. Just exercise construction.
    expect(term).toBeDefined();
  });

  it("resize() rejects cols above uint16_t max", () => {
    using term = new Terminal({ cols: 80, rows: 24 });
    expect(() => term.resize(70000, 24)).toThrow(/cols/);
  });

  it("resize() rejects negative cellPx.width", () => {
    using term = new Terminal({ cols: 80, rows: 24 });
    expect(() => term.resize(80, 24, { width: -1, height: 2 })).toThrow(/cellPx\.width/);
  });
});

describe("TerminalSnapshot shape (Codex bug 3, narrow path)", () => {
  // Pass 1 narrowed TerminalSnapshot: `cursor.style` and `mouseTracking` are
  // removed because the C side either returns a 72-byte struct we don't
  // decode (CURSOR_STYLE) or a single bool that does not map cleanly to the
  // 5-variant MouseTracking union (MOUSE_TRACKING). See CONFIRM_WITH_MATT.md
  // "Known plan/code drift" for the rationale.
  it("snapshot does not have cursor.style or mouseTracking fields (runtime)", () => {
    using term = new Terminal({ cols: 80, rows: 24 });
    const snap = term.snapshot();
    expect("style" in (snap.cursor as object)).toBe(false);
    expect("mouseTracking" in (snap as object)).toBe(false);
  });

  it("TerminalSnapshot type does not declare cursor.style or mouseTracking (compile-time)", () => {
    // This is a structural type-level test: if either field were re-added to
    // TerminalSnapshot, these `@ts-expect-error` lines would no longer error
    // and `bun run typecheck` would fail.
    using term = new Terminal({ cols: 80, rows: 24 });
    const snap: TerminalSnapshot = term.snapshot();
    // @ts-expect-error — cursor.style is intentionally absent in Pass 1.
    void snap.cursor.style;
    // @ts-expect-error — mouseTracking is intentionally absent in Pass 1.
    void snap.mouseTracking;
  });
});

describe("Terminal.vtWrite", () => {
  it("accepts a Uint8Array and returns void", () => {
    using term = new Terminal({ cols: 80, rows: 24 });
    // "hello\r\n" — plain ASCII, should not throw
    const bytes = new TextEncoder().encode("hello\r\n");
    expect(term.vtWrite(bytes)).toBeUndefined();
  });

  it("accepts an empty Uint8Array", () => {
    using term = new Terminal({ cols: 80, rows: 24 });
    term.vtWrite(new Uint8Array(0));
  });

  it("accepts a long byte stream (1 MiB)", () => {
    using term = new Terminal({ cols: 80, rows: 24 });
    const big = new Uint8Array(1 << 20);
    big.fill(0x41);  // 'A'
    term.vtWrite(big);
  });

  it("throws UseAfterCloseError if called after close", () => {
    const term = new Terminal({ cols: 80, rows: 24 });
    term.close();
    expect(() => term.vtWrite(new Uint8Array([65]))).toThrow(UseAfterCloseError);
  });
});

describe("Terminal.resize", () => {
  it("accepts new cols/rows and returns void", () => {
    using term = new Terminal({ cols: 80, rows: 24 });
    term.resize(100, 30);
  });

  it("rejects zero or negative dimensions", () => {
    using term = new Terminal({ cols: 80, rows: 24 });
    expect(() => term.resize(0, 30)).toThrow();
    expect(() => term.resize(100, -1)).toThrow();
  });
});

describe("Terminal.reset", () => {
  it("returns void", () => {
    using term = new Terminal({ cols: 80, rows: 24 });
    term.vtWrite(new TextEncoder().encode("hello\r\n"));
    term.reset();
  });
});

describe("Terminal.snapshot", () => {
  it("returns cols/rows matching construction", () => {
    using term = new Terminal({ cols: 80, rows: 24 });
    const snap = term.snapshot();
    expect(snap.cols).toBe(80);
    expect(snap.rows).toBe(24);
  });

  it("returns cursor at (0,0) initially", () => {
    using term = new Terminal({ cols: 80, rows: 24 });
    const snap = term.snapshot();
    expect(snap.cursor.x).toBe(0);
    expect(snap.cursor.y).toBe(0);
  });

  it("cursor.x advances after writing characters", () => {
    using term = new Terminal({ cols: 80, rows: 24 });
    term.vtWrite(new TextEncoder().encode("hello"));
    const snap = term.snapshot();
    expect(snap.cursor.x).toBe(5);
    expect(snap.cursor.y).toBe(0);
  });

  it("cursor.y advances after CRLF", () => {
    using term = new Terminal({ cols: 80, rows: 24 });
    term.vtWrite(new TextEncoder().encode("hello\r\n"));
    const snap = term.snapshot();
    expect(snap.cursor.x).toBe(0);
    expect(snap.cursor.y).toBe(1);
  });

  it("activeScreen is 'primary' initially", () => {
    using term = new Terminal({ cols: 80, rows: 24 });
    expect(term.snapshot().activeScreen).toBe("primary");
  });

  it("activeScreen switches to 'alternate' on DECSET 1049", () => {
    using term = new Terminal({ cols: 80, rows: 24 });
    // ESC [ ? 1049 h
    term.vtWrite(new Uint8Array([0x1b, 0x5b, 0x3f, 0x31, 0x30, 0x34, 0x39, 0x68]));
    expect(term.snapshot().activeScreen).toBe("alternate");
  });
});

describe("Terminal.mode / setMode", () => {
  it("setMode + mode round-trip for bracketed_paste", () => {
    using term = new Terminal({ cols: 80, rows: 24 });
    // The exact ModeName string is determined by the pinned header.
    // ModeTag.GHOSTTY_MODE_BRACKETED_PASTE likely maps to name "bracketed_paste".
    term.setMode("bracketed_paste", true);
    expect(term.mode("bracketed_paste")).toBe(true);
    term.setMode("bracketed_paste", false);
    expect(term.mode("bracketed_paste")).toBe(false);
  });

  it("throws on unknown ModeName", () => {
    using term = new Terminal({ cols: 80, rows: 24 });
    expect(() => term.mode("not_a_real_mode" as never)).toThrow();
    expect(() => term.setMode("not_a_real_mode" as never, true)).toThrow();
  });
});
