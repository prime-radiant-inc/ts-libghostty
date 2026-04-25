import { expect, test } from "bun:test";
import { computeSgr } from "../../src/render-rect";
import type { CellStyle } from "../../src/types";

const baseStyle = (overrides: Partial<CellStyle> = {}): CellStyle => ({
  bold: false,
  faint: false,
  italic: false,
  underline: "none",
  overline: false,
  strikethrough: false,
  blink: false,
  inverse: false,
  invisible: false,
  ...overrides,
});

test("undefined style returns empty string", () => {
  expect(computeSgr(undefined, "preserve")).toBe("");
});

test("colorDepth 'none' always returns empty string", () => {
  expect(
    computeSgr(baseStyle({ bold: true, fg: { palette: 1 } }), "none"),
  ).toBe("");
  expect(computeSgr(undefined, "none")).toBe("");
});

test("all-default style returns empty string", () => {
  expect(computeSgr(baseStyle(), "preserve")).toBe("");
});

test("single attribute: bold", () => {
  expect(computeSgr(baseStyle({ bold: true }), "preserve")).toBe("\x1b[0;1m");
});

test("multiple attributes preserve the documented order", () => {
  // bold (1), faint (2), italic (3), underline (4), blink (5), inverse (7),
  // invisible (8), strikethrough (9), overline (53)
  const style = baseStyle({
    bold: true,
    italic: true,
    underline: "single",
    inverse: true,
    overline: true,
  });
  expect(computeSgr(style, "preserve")).toBe("\x1b[0;1;3;4;7;53m");
});

test("any non-'none' underline value emits SGR 4", () => {
  for (const u of ["single", "double", "curly", "dotted", "dashed"] as const) {
    expect(computeSgr(baseStyle({ underline: u }), "preserve")).toBe(
      "\x1b[0;4m",
    );
  }
});

test("palette fg 0-7 uses short form 30-37", () => {
  expect(computeSgr(baseStyle({ fg: { palette: 0 } }), "preserve")).toBe(
    "\x1b[0;30m",
  );
  expect(computeSgr(baseStyle({ fg: { palette: 1 } }), "preserve")).toBe(
    "\x1b[0;31m",
  );
  expect(computeSgr(baseStyle({ fg: { palette: 7 } }), "preserve")).toBe(
    "\x1b[0;37m",
  );
});

test("palette fg 8-15 uses bright short form 90-97", () => {
  expect(computeSgr(baseStyle({ fg: { palette: 8 } }), "preserve")).toBe(
    "\x1b[0;90m",
  );
  expect(computeSgr(baseStyle({ fg: { palette: 15 } }), "preserve")).toBe(
    "\x1b[0;97m",
  );
});

test("palette fg 16+ uses 256-color form 38;5;N", () => {
  expect(computeSgr(baseStyle({ fg: { palette: 16 } }), "preserve")).toBe(
    "\x1b[0;38;5;16m",
  );
  expect(computeSgr(baseStyle({ fg: { palette: 200 } }), "preserve")).toBe(
    "\x1b[0;38;5;200m",
  );
});

test("RGB fg uses truecolor form 38;2;R;G;B", () => {
  expect(computeSgr(baseStyle({ fg: [1, 2, 3] }), "preserve")).toBe(
    "\x1b[0;38;2;1;2;3m",
  );
});

test("palette bg 0-7 uses short form 40-47", () => {
  expect(computeSgr(baseStyle({ bg: { palette: 0 } }), "preserve")).toBe(
    "\x1b[0;40m",
  );
  expect(computeSgr(baseStyle({ bg: { palette: 7 } }), "preserve")).toBe(
    "\x1b[0;47m",
  );
});

test("palette bg 8-15 uses bright short form 100-107", () => {
  expect(computeSgr(baseStyle({ bg: { palette: 8 } }), "preserve")).toBe(
    "\x1b[0;100m",
  );
  expect(computeSgr(baseStyle({ bg: { palette: 15 } }), "preserve")).toBe(
    "\x1b[0;107m",
  );
});

test("palette bg 16+ uses 256-color form 48;5;N", () => {
  expect(computeSgr(baseStyle({ bg: { palette: 16 } }), "preserve")).toBe(
    "\x1b[0;48;5;16m",
  );
});

test("RGB bg uses truecolor form 48;2;R;G;B", () => {
  expect(computeSgr(baseStyle({ bg: [10, 20, 30] }), "preserve")).toBe(
    "\x1b[0;48;2;10;20;30m",
  );
});

test("attributes + fg + bg combine in order", () => {
  const style = baseStyle({
    bold: true,
    fg: { palette: 1 },
    bg: [0, 0, 0],
  });
  expect(computeSgr(style, "preserve")).toBe("\x1b[0;1;31;48;2;0;0;0m");
});
