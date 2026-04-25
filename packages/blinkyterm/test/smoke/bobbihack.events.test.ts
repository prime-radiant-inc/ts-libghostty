import { expect, test } from "bun:test";
import { parseStdinByte } from "../../examples/bobbihack/events";

test("q (lowercase) maps to quit", () => {
  expect(parseStdinByte("q".charCodeAt(0))).toBe("quit");
});

test("Q (uppercase) maps to quit", () => {
  expect(parseStdinByte("Q".charCodeAt(0))).toBe("quit");
});

test("Ctrl-C (0x03) maps to quit", () => {
  expect(parseStdinByte(0x03)).toBe("quit");
});

test("Ctrl-D (0x04) maps to quit", () => {
  expect(parseStdinByte(0x04)).toBe("quit");
});

test("other bytes are ignored (return null)", () => {
  expect(parseStdinByte("a".charCodeAt(0))).toBeNull();
  expect(parseStdinByte(0x1b)).toBeNull();      // ESC
  expect(parseStdinByte(0x20)).toBeNull();      // space
});
