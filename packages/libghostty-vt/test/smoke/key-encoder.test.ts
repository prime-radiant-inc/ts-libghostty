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
