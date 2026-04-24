import { describe, test, expect } from "bun:test";
import { encodeFocus } from "../../src";

describe("encodeFocus", () => {
  test('"in" returns non-empty bytes starting with ESC', () => {
    const bytes = encodeFocus("in");
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.byteLength).toBeGreaterThan(0);
    expect(bytes[0]).toBe(0x1B);
  });

  test('"out" returns non-empty bytes starting with ESC', () => {
    const bytes = encodeFocus("out");
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.byteLength).toBeGreaterThan(0);
    expect(bytes[0]).toBe(0x1B);
  });

  test('"in" and "out" produce different byte sequences', () => {
    const inBytes = encodeFocus("in");
    const outBytes = encodeFocus("out");
    expect(Buffer.from(inBytes).equals(Buffer.from(outBytes))).toBe(false);
  });

  test("repeated calls return fresh Uint8Arrays (no shared buffer)", () => {
    const a = encodeFocus("in");
    const b = encodeFocus("in");
    expect(a).not.toBe(b);
    a[0] = 0x00;
    expect(b[0]).toBe(0x1B); // mutating a must not affect b
  });

  test("invalid direction throws", () => {
    // @ts-expect-error — intentionally invalid
    expect(() => encodeFocus("sideways")).toThrow(/invalid/i);
  });
});
