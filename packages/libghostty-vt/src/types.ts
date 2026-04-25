// Public supporting types used by Pass 1's classes (Terminal, Formatter).
// The full v0 type surface (RenderCell, Key, KittyFlags, etc.) lands in
// later passes.

// ModeName is the generated string-literal union (see src/internal/generated.ts).
// Re-exported here so consumers can import it alongside other types from "libghostty-vt".
export { modeNames, type ModeName } from "./internal/generated";

export type RGB = readonly [r: number, g: number, b: number];
export type PaletteIndex = { palette: number };

export interface TerminalColors {
  /** Colors currently displayed after any OSC 10/11/12 overrides. */
  effective: {
    fg?: RGB;
    bg?: RGB;
    cursor?: RGB;
  };
  /** Configured defaults the terminal would use absent OSC override. */
  defaults: {
    fg?: RGB;
    bg?: RGB;
    cursor?: RGB;
  };
  /** The 256-entry palette. Indices are semantic; order is preserved. */
  palette: readonly RGB[];
}

// CursorStyle / MouseTracking are kept here for future passes that wire the
// real `GhosttyStyle` cursor decode and a richer mouse-tracking surface than
// the current "any tracking active" bool. They are intentionally NOT used by
// `TerminalSnapshot` — see the note on `TerminalSnapshot` below.
// --- Cell query types (Task 8) -----------------------------------------------

export type UnderlineStyle =
  | "none"
  | "single"
  | "double"
  | "curly"
  | "dotted"
  | "dashed";

export interface CellStyle {
  fg?: RGB | PaletteIndex;
  bg?: RGB | PaletteIndex;
  bold: boolean;
  faint: boolean;
  italic: boolean;
  underline: UnderlineStyle;
  underlineColor?: RGB;
  overline: boolean;
  strikethrough: boolean;
  blink: boolean;
  inverse: boolean;
  invisible: boolean;
}

export interface CellInfo {
  text: string;
  wide: boolean;
  isWideContinuation: boolean;
  style?: CellStyle;
  hyperlinkUri?: string;
  protected: boolean;
}

export interface CellAtPoint {
  x: number;
  y: number;
  coordinateSpace?: "active" | "viewport" | "screen" | "history";
}

// --- End cell query types -----------------------------------------------------

// --- Pass 3 render-state types (Task 10) --------------------------------------

export interface ViewportCursor {
  x: number;
  y: number;
  visible: boolean;
  /** True if the cursor sits on the trailing half of a wide grapheme. */
  wideTail: boolean;
}

export interface RenderRow {
  y: number;
  wrapped: boolean;
  dirty: boolean;
  cells(): IterableIterator<RenderCell>;
}

export interface RenderCell {
  x: number;
  text: string;
  wide: boolean;
  isWideContinuation: boolean;
  style?: CellStyle;
  hyperlinkUri?: string;
  protected: boolean;
}

// --- End Pass 3 render-state types -------------------------------------------

export type CursorStyle = "block" | "underline" | "bar";
export type MouseTracking = "none" | "x10" | "normal" | "button" | "any";

export interface TerminalOptions {
  cols: number;
  rows: number;
  maxScrollback?: number;
  cellPx?: { width: number; height: number };

  /**
   * Bound on the per-sequence byte limit libghostty's VT parser retains
   * for APC (Application Program Command) escape payloads. Generic APC.
   * Defaults to 1 MiB (1_048_576). Applied post-construction via
   * `ghostty_terminal_set(GHOSTTY_TERMINAL_OPT_APC_MAX_BYTES)`.
   */
  apcMaxBytes?: number;

  /**
   * Bound on the per-sequence byte limit for Kitty-graphics APC payloads
   * specifically. Defaults to 0 — Kitty-graphics APC sequences are not
   * retained at v0. Distinct from Kitty keyboard protocol (Pass 4) and
   * from Kitty image storage limit (internal default, not user-settable).
   * Applied post-construction via
   * `ghostty_terminal_set(GHOSTTY_TERMINAL_OPT_APC_MAX_BYTES_KITTY)`.
   */
  apcMaxBytesKitty?: number;

  /**
   * Invoked when libghostty needs to write data back to the pty in response
   * to a VT query sequence (e.g. DA1, DECRQM, device status report). The
   * `bytes` array is a JS-owned copy of libghostty's borrowed buffer — safe
   * to retain past the callback's return.
   *
   * Constraints:
   * - MUST NOT call any mutating method on the same Terminal: `vtWrite`,
   *   `resize`, `reset`, `setMode`, `close`, or `[Symbol.dispose]`. libghostty
   *   is mid-parse; mutating the same Terminal corrupts or frees state the
   *   parser still references. `snapshot()` and `mode(name)` are read-only
   *   and are allowed. Doing any banned call throws a typed `GhosttyError`
   *   with code `"invalid_value"` — defer with `queueMicrotask` or
   *   `setTimeout` to perform the mutation after `vtWrite()` returns.
   * - MUST NOT throw. Exceptions are caught at the FFI boundary and logged
   *   via `console.error`; they cannot cross the C frame.
   * - SHOULD NOT block. The callback runs synchronously inside `vtWrite()`
   *   and blocks further input parsing until it returns.
   */
  onWritePty?: (bytes: Uint8Array) => void;

  /**
   * Invoked when libghostty processes a BEL character (0x07).
   *
   * Same constraints as `onWritePty` — no mutating calls on this Terminal
   * (vtWrite/resize/reset/setMode/close/Symbol.dispose are runtime-rejected),
   * no throwing, no blocking.
   */
  onBell?: () => void;

  /**
   * Invoked when libghostty processes an OSC 0 or OSC 2 escape that changes
   * the terminal title. The `title` string is a JS-owned copy — safe to
   * retain past the callback's return.
   *
   * Same constraints as `onWritePty` — no mutating calls on this Terminal,
   * no throwing, no blocking.
   */
  onTitleChanged?: (title: string) => void;
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
  // `cursor.style` and `mouseTracking` are deliberately omitted. CURSOR_STYLE
  // returns a 72-byte GhosttyStyle struct we don't decode yet; MOUSE_TRACKING
  // returns a plain bool that does not map cleanly to the 5-variant
  // `MouseTracking` union. Wiring either honestly belongs to a later pass.
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
