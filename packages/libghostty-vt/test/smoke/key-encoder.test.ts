import { describe, test, expect } from "bun:test";
import { KeyEncoder } from "../../src/key-encoder";

describe("KeyEncoder — basic lifecycle and plain-printable encode", () => {
  test("constructs in standalone mode with empty options", () => {
    using enc = new KeyEncoder({ options: {} });
    expect(enc).toBeInstanceOf(KeyEncoder);
  });

  test("encode plain 'c' press returns single byte 0x63", () => {
    using enc = new KeyEncoder({ options: {} });
    const bytes = enc.encode({
      key: "KeyC",
      utf8: "c",
      unshiftedCodepoint: 0x63,
    });
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.length).toBe(1);
    expect(bytes[0]).toBe(0x63);
  });

  test("encode plain 'A' shift+a press returns single byte 0x41", () => {
    using enc = new KeyEncoder({ options: {} });
    const bytes = enc.encode({
      key: "KeyA",
      mods: { shift: true },
      utf8: "A",
      unshiftedCodepoint: 0x61,
    });
    expect(bytes.length).toBe(1);
    expect(bytes[0]).toBe(0x41);
  });

  test("encode returns a fresh Uint8Array each call (no buffer reuse)", () => {
    using enc = new KeyEncoder({ options: {} });
    const a = enc.encode({ key: "KeyC", utf8: "c", unshiftedCodepoint: 0x63 });
    const b = enc.encode({ key: "KeyC", utf8: "c", unshiftedCodepoint: 0x63 });
    expect(a).not.toBe(b);
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  test("[Symbol.dispose] is idempotent", () => {
    const enc = new KeyEncoder({ options: {} });
    enc[Symbol.dispose]();
    expect(() => enc[Symbol.dispose]()).not.toThrow();
  });

  test("encode after dispose throws", () => {
    const enc = new KeyEncoder({ options: {} });
    enc[Symbol.dispose]();
    expect(() => enc.encode({ key: "KeyC", utf8: "c", unshiftedCodepoint: 0x63 }))
      .toThrow(/closed/i);
  });
});

describe("KeyEncoder — modified keys (golden table)", () => {
  // Each row: [name, KeyEvent, expected bytes (hex array)]
  const cases: Array<[string, import("../../src/key-encoder").KeyEvent, number[]]> = [
    // Ctrl+C → ETX (0x03)
    ["Ctrl+C", { key: "KeyC", mods: { ctrl: true }, utf8: "c", unshiftedCodepoint: 0x63 }, [0x03]],
    // Ctrl+D → EOT (0x04)
    ["Ctrl+D", { key: "KeyD", mods: { ctrl: true }, utf8: "d", unshiftedCodepoint: 0x64 }, [0x04]],
    // Ctrl+A → SOH (0x01)
    ["Ctrl+A", { key: "KeyA", mods: { ctrl: true }, utf8: "a", unshiftedCodepoint: 0x61 }, [0x01]],
    // Ctrl+Z → SUB (0x1a)
    ["Ctrl+Z", { key: "KeyZ", mods: { ctrl: true }, utf8: "z", unshiftedCodepoint: 0x7a }, [0x1a]],
    // Ctrl+[ → ESC sequence (CSI modifier encoding)
    ["Ctrl+BracketLeft", { key: "BracketLeft", mods: { ctrl: true }, utf8: "[", unshiftedCodepoint: 0x5b }, [0x1b, 91, 57, 49, 59, 53, 117]],
  ];

  // Each test owns its encoder. A `using` declaration in the describe
  // callback would dispose the encoder when describe finishes registering
  // tests (before any test callback runs); per-test construction avoids
  // that footgun.
  for (const [name, event, expected] of cases) {
    test(name, () => {
      using enc = new KeyEncoder({ options: {} });
      const bytes = enc.encode(event);
      expect(Array.from(bytes)).toEqual(expected);
    });
  }
});

describe("KeyEncoder — standalone mode options", () => {
  test("cursorKeyMode: 'application' makes ArrowUp emit ESC O A", () => {
    using enc = new KeyEncoder({ options: { cursorKeyMode: "application" } });
    const bytes = enc.encode({ key: "ArrowUp" });
    expect(Array.from(bytes)).toEqual([0x1b, 0x4f, 0x41]);
  });

  test("cursorKeyMode: 'normal' makes ArrowUp emit ESC [ A (default)", () => {
    using enc = new KeyEncoder({ options: { cursorKeyMode: "normal" } });
    const bytes = enc.encode({ key: "ArrowUp" });
    expect(Array.from(bytes)).toEqual([0x1b, 0x5b, 0x41]);
  });

  test("kittyFlags accepts a u8 bitmask", () => {
    using enc = new KeyEncoder({ options: { kittyFlags: 0b11111 } });
    // Just verify it constructs and encodes without throwing — exact bytes
    // depend on Kitty protocol details we don't fully spec here.
    const bytes = enc.encode({ key: "KeyA", utf8: "a", unshiftedCodepoint: 0x61 });
    expect(bytes.length).toBeGreaterThan(0);
  });

  test("backarrowKeyMode: false (default) → Backspace emits 0x7f", () => {
    using enc = new KeyEncoder({ options: { backarrowKeyMode: false } });
    const bytes = enc.encode({ key: "Backspace" });
    expect(Array.from(bytes)).toEqual([0x7f]);
  });

  test("backarrowKeyMode: true → Backspace emits 0x08", () => {
    using enc = new KeyEncoder({ options: { backarrowKeyMode: true } });
    const bytes = enc.encode({ key: "Backspace" });
    expect(Array.from(bytes)).toEqual([0x08]);
  });
});

import { Terminal } from "../../src";

describe("KeyEncoder — bound mode (terminal sync)", () => {
  test("ArrowUp encodes ESC[A in normal mode (DECCKM off)", () => {
    using term = new Terminal({ cols: 80, rows: 24 });
    using enc = new KeyEncoder({ terminal: term });
    const bytes = enc.encode({ key: "ArrowUp" });
    expect(Array.from(bytes)).toEqual([0x1b, 0x5b, 0x41]);   // ESC [ A
  });

  test("ArrowUp encodes ESC O A in application mode (DECCKM on)", () => {
    using term = new Terminal({ cols: 80, rows: 24 });
    using enc = new KeyEncoder({ terminal: term });
    // Flip DECCKM on
    term.vtWrite(new TextEncoder().encode("\x1b[?1h"));
    const bytes = enc.encode({ key: "ArrowUp" });
    expect(Array.from(bytes)).toEqual([0x1b, 0x4f, 0x41]);   // ESC O A
  });

  test("encoder picks up mode changes between encodes", () => {
    using term = new Terminal({ cols: 80, rows: 24 });
    using enc = new KeyEncoder({ terminal: term });
    // First encode — normal mode
    const a = enc.encode({ key: "ArrowUp" });
    expect(Array.from(a)).toEqual([0x1b, 0x5b, 0x41]);
    // Flip DECCKM on
    term.vtWrite(new TextEncoder().encode("\x1b[?1h"));
    // Second encode — same key, application mode now
    const b = enc.encode({ key: "ArrowUp" });
    expect(Array.from(b)).toEqual([0x1b, 0x4f, 0x41]);
  });
});

import { EncodeError } from "../../src/errors";

describe("KeyEncoder — utf8 contract enforcement", () => {
  test("utf8 with C0 control throws EncodeError(invalid_utf8)", () => {
    using enc = new KeyEncoder({ options: {} });
    expect(() => enc.encode({ key: "Enter", utf8: "\r" }))
      .toThrow(EncodeError);
    try {
      enc.encode({ key: "KeyC", utf8: "\x03" });
    } catch (e) {
      expect(e).toBeInstanceOf(EncodeError);
      expect((e as EncodeError).code).toBe("invalid_utf8");
    }
  });

  test("utf8 with macOS PUA codepoint throws EncodeError(invalid_utf8)", () => {
    using enc = new KeyEncoder({ options: {} });
    expect(() => enc.encode({ key: "F1", utf8: "\u{F704}" }))
      .toThrow(/PUA/);
  });

  test("utf8 with valid printable does NOT throw", () => {
    using enc = new KeyEncoder({ options: {} });
    expect(() => enc.encode({ key: "KeyA", utf8: "a", unshiftedCodepoint: 0x61 }))
      .not.toThrow();
  });

  test("utf8 omitted entirely does NOT throw (encoder uses logical key)", () => {
    using enc = new KeyEncoder({ options: {} });
    expect(() => enc.encode({ key: "Enter" })).not.toThrow();
  });
});

describe("KeyEncoder — input validation (Codex post-merge review)", () => {
  test("unknown key string throws EncodeError(invalid_value)", () => {
    using enc = new KeyEncoder({ options: {} });
    try {
      enc.encode({ key: "Nope" as unknown as Parameters<typeof enc.encode>[0]["key"] });
      throw new Error("expected encode to throw");
    } catch (e) {
      expect(e).toBeInstanceOf(EncodeError);
      expect((e as EncodeError).code).toBe("invalid_value");
      expect((e as EncodeError).message).toMatch(/Nope/);
    }
  });

  test("unknown action throws EncodeError(invalid_value)", () => {
    using enc = new KeyEncoder({ options: {} });
    try {
      enc.encode({
        key: "KeyA",
        action: "smash" as unknown as Parameters<typeof enc.encode>[0]["action"],
      });
      throw new Error("expected encode to throw");
    } catch (e) {
      expect(e).toBeInstanceOf(EncodeError);
      expect((e as EncodeError).code).toBe("invalid_value");
      expect((e as EncodeError).message).toMatch(/smash/);
    }
  });

  test("typed key + action pass through cleanly", () => {
    using enc = new KeyEncoder({ options: {} });
    const bytes = enc.encode({ key: "KeyC", utf8: "c", unshiftedCodepoint: 0x63, action: "press" });
    expect(Array.from(bytes)).toEqual([0x63]);
  });
});

describe("KeyEncoder — utf8 buffer lifetime (Codex post-merge review)", () => {
  // The C event stores a borrowed pointer to the utf8 bytes; if the JS
  // reference dies before encode() runs, GC could collect the buffer and
  // libghostty would read freed memory. These tests aren't a deterministic
  // GC stress check (those are hard to write), but a fast-loop encode
  // cycles many short-lived TextEncoder buffers and would surface memory
  // corruption as inconsistent output across iterations.
  test("repeated encode of same KeyEvent produces consistent bytes", () => {
    using enc = new KeyEncoder({ options: {} });
    const reference = enc.encode({ key: "KeyA", utf8: "a", unshiftedCodepoint: 0x61 });
    for (let i = 0; i < 1000; i++) {
      const bytes = enc.encode({ key: "KeyA", utf8: "a", unshiftedCodepoint: 0x61 });
      expect(Array.from(bytes)).toEqual(Array.from(reference));
    }
  });

  test("non-ASCII utf8 round-trips consistently across many encodes", () => {
    using enc = new KeyEncoder({ options: {} });
    // 4-byte UTF-8 emoji to maximize the chance of the buffer being
    // distinct across iterations (separate TextEncoder allocations).
    const reference = enc.encode({ key: "KeyA", utf8: "🎉", unshiftedCodepoint: 0x1F389 });
    for (let i = 0; i < 1000; i++) {
      const bytes = enc.encode({ key: "KeyA", utf8: "🎉", unshiftedCodepoint: 0x1F389 });
      expect(Array.from(bytes)).toEqual(Array.from(reference));
    }
  });
});
