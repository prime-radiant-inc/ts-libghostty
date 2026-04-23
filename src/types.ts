// Public supporting types used by Pass 1's classes (Terminal, Formatter).
// The full v0 type surface (RenderCell, Key, KittyFlags, etc.) lands in
// later passes.

// ModeName is the generated string-literal union (see src/internal/generated.ts).
// Re-exported here so consumers can import it alongside other types from "ts-libghostty-vt".
export { modeNames, type ModeName } from "./internal/generated";

export type RGB = readonly [r: number, g: number, b: number];
export type PaletteIndex = { palette: number };

// CursorStyle / MouseTracking are kept here for future passes that wire the
// real `GhosttyStyle` cursor decode and a richer mouse-tracking surface than
// the current "any tracking active" bool. They are intentionally NOT used by
// `TerminalSnapshot` in Pass 1 — see CONFIRM_WITH_MATT.md "Known plan/code
// drift" for the rationale.
export type CursorStyle = "block" | "underline" | "bar";
export type MouseTracking = "none" | "x10" | "normal" | "button" | "any";

export interface TerminalOptions {
  cols: number;
  rows: number;
  maxScrollback?: number;
  cellPx?: { width: number; height: number };
  // APC tuning (apc_max_bytes / apc_max_bytes_kitty) is NOT a constructor
  // option at the pinned Ghostty commit — it is set post-construction via
  // ghostty_terminal_set(...). Pass 1 does not expose APC tuning; the library
  // uses its upstream defaults. See README "APC tuning (Pass 1)".
}

export interface TerminalSnapshot {
  cols: number;
  rows: number;
  pixelWidth: number;
  pixelHeight: number;
  cursor: { x: number; y: number; visible: boolean };
  activeScreen: "primary" | "alternate";
  title?: string;
  pwd?: string;
  scrollbackRows: number;
  // `cursor.style` and `mouseTracking` are deliberately omitted in Pass 1.
  // CURSOR_STYLE returns a 72-byte GhosttyStyle struct (decode is a Pass 2+
  // task); MOUSE_TRACKING returns a plain bool that does not map cleanly to
  // the 5-variant `MouseTracking` union. Wiring either honestly belongs to a
  // later pass — see CONFIRM_WITH_MATT.md "Known plan/code drift".
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
