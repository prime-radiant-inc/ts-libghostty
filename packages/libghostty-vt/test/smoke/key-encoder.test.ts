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
