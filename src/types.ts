// Public supporting types used by Pass 1's classes (Terminal, Formatter).
// The full v0 type surface (RenderCell, Key, KittyFlags, etc.) lands in
// later passes.

// ModeName is the generated string-literal union (see src/internal/generated.ts).
// Re-exported here so consumers can import it alongside other types from "ts-libghostty-vt".
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
