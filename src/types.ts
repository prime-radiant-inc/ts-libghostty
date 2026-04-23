// Public supporting types used by Pass 1's classes (Terminal, Formatter).
// The full v0 type surface (RenderCell, Key, KittyFlags, etc.) lands in
// later passes.

// ModeName is the generated string-literal union (see src/internal/generated.ts).
// Re-exported here so consumers can import it alongside other types from "ts-libghostty-vt".
export { modeNames, type ModeName } from "./internal/generated";

export type RGB = readonly [r: number, g: number, b: number];
export type PaletteIndex = { palette: number };

export type CursorStyle = "block" | "underline" | "bar";
export type MouseTracking = "none" | "x10" | "normal" | "button" | "any";

export interface TerminalOptions {
  cols: number;
  rows: number;
  maxScrollback?: number;
  cellPx?: { width: number; height: number };
  apcMaxBytes?: number;
  apcMaxBytesKitty?: number;
}

export interface TerminalSnapshot {
  cols: number;
  rows: number;
  pixelWidth: number;
  pixelHeight: number;
  cursor: { x: number; y: number; visible: boolean; style: CursorStyle };
  activeScreen: "primary" | "alternate";
  title?: string;
  pwd?: string;
  scrollbackRows: number;
  mouseTracking: MouseTracking;
}

export interface FormatterOptions {
  format: "plain" | "vt" | "html";
  // Outer-struct fields (GhosttyFormatterTerminalOptions):
  unwrap?: boolean;
  trim?: boolean;
  // Extra-struct fields (GhosttyFormatterTerminalExtra):
  palette?: boolean;
  modes?: boolean;
  scrollingRegion?: boolean;
  tabStops?: boolean;            // C field: `tabstops` (no underscore)
  pwd?: boolean;
  keyboard?: boolean;
  // Screen-extra fields (GhosttyFormatterScreenExtra):
  cursor?: boolean;
  style?: boolean;
  hyperlink?: boolean;
  protection?: boolean;
  kittyKeyboard?: boolean;       // C field: `kitty_keyboard`
  charsets?: boolean;
}
