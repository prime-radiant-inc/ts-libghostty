import { describe, test, expect } from "bun:test";
import { isInvalidKeyUtf8 } from "../../src/internal/key-utf8-validator";

describe("isInvalidKeyUtf8", () => {
  test("plain ASCII printables are valid", () => {
    expect(isInvalidKeyUtf8("a")).toBe(false);
    expect(isInvalidKeyUtf8("A")).toBe(false);
    expect(isInvalidKeyUtf8("#")).toBe(false);
    expect(isInvalidKeyUtf8(" ")).toBe(false);
    expect(isInvalidKeyUtf8("hello")).toBe(false);
  });

  test("non-ASCII Unicode printables are valid", () => {
    expect(isInvalidKeyUtf8("é")).toBe(false);
    expect(isInvalidKeyUtf8("中")).toBe(false);
    expect(isInvalidKeyUtf8("🎉")).toBe(false);
  });

  test("C0 controls (U+0000–U+001F) are invalid", () => {
    expect(isInvalidKeyUtf8("\x00")).toBe("c0_control");
    expect(isInvalidKeyUtf8("\x01")).toBe("c0_control");
    expect(isInvalidKeyUtf8("\r")).toBe("c0_control");
    expect(isInvalidKeyUtf8("\n")).toBe("c0_control");
    expect(isInvalidKeyUtf8("\t")).toBe("c0_control");
    expect(isInvalidKeyUtf8("\x1b")).toBe("c0_control");
    expect(isInvalidKeyUtf8("\x1f")).toBe("c0_control");
  });

  test("DEL (U+007F) is invalid", () => {
    expect(isInvalidKeyUtf8("\x7f")).toBe("c0_control");
  });

  test("macOS PUA function key codepoints (U+F700–U+F8FF) are invalid", () => {
    expect(isInvalidKeyUtf8("\u{F700}")).toBe("pua");
    expect(isInvalidKeyUtf8("\u{F8FF}")).toBe("pua");
    expect(isInvalidKeyUtf8("\u{F800}")).toBe("pua");
  });

  test("just-outside-PUA codepoints are valid", () => {
    expect(isInvalidKeyUtf8("\u{F6FF}")).toBe(false);   // one before
    expect(isInvalidKeyUtf8("\u{F900}")).toBe(false);   // one after
  });

  test("strings with mixed valid + invalid are invalid", () => {
    expect(isInvalidKeyUtf8("a\rb")).toBe("c0_control");
    expect(isInvalidKeyUtf8("hi\u{F700}")).toBe("pua");
  });

  test("empty string is valid", () => {
    expect(isInvalidKeyUtf8("")).toBe(false);
  });
});
