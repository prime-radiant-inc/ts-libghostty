import { RectSizeMismatch } from "./errors";
import type { RenderState } from "./render-state";
import type {
  CellStyle,
  PaletteIndex,
  RGB,
  RectRenderOptions,
  RenderRect,
} from "./types";

/**
 * Build a reset-prefixed SGR CSI sequence for `style`. Reset-prefix
 * (`\x1b[0;…m`) means each emitted SGR is independent of the prior cell's
 * state — no need to track and un-set attributes from the previous cell.
 *
 * Returns `""` when:
 *   - colorDepth is "none" (always)
 *   - style is undefined (cell has default style)
 *   - style is defined but every field is the default value
 */
export function computeSgr(
  style: CellStyle | undefined,
  colorDepth: "preserve" | "none",
): string {
  if (colorDepth === "none" || style === undefined) return "";

  const params: string[] = ["0"];

  if (style.bold) params.push("1");
  if (style.faint) params.push("2");
  if (style.italic) params.push("3");
  if (style.underline !== "none") params.push("4");
  if (style.blink) params.push("5");
  if (style.inverse) params.push("7");
  if (style.invisible) params.push("8");
  if (style.strikethrough) params.push("9");
  if (style.overline) params.push("53");

  if (style.fg !== undefined) appendColor(params, style.fg, "fg");
  if (style.bg !== undefined) appendColor(params, style.bg, "bg");

  if (params.length === 1) return ""; // only reset, nothing else — default
  return `\x1b[${params.join(";")}m`;
}

function appendColor(
  params: string[],
  color: RGB | PaletteIndex,
  channel: "fg" | "bg",
): void {
  if (isPaletteIndex(color)) {
    const idx = color.palette;
    if (idx < 8) {
      params.push(String((channel === "fg" ? 30 : 40) + idx));
    } else if (idx < 16) {
      params.push(String((channel === "fg" ? 90 : 100) + (idx - 8)));
    } else {
      params.push(channel === "fg" ? "38" : "48", "5", String(idx));
    }
  } else {
    const [r, g, b] = color;
    params.push(
      channel === "fg" ? "38" : "48",
      "2",
      String(r),
      String(g),
      String(b),
    );
  }
}

function isPaletteIndex(c: RGB | PaletteIndex): c is PaletteIndex {
  return !Array.isArray(c);
}

const ESC = "\x1b[";
const RESET = `${ESC}0m`;
const goto = (row: number, col: number) => `${ESC}${row};${col}H`;

/**
 * Walk the cell grid in `state` and emit ANSI bytes that paint the source
 * into the destination rectangle. Pure: no FFI calls; reads only the
 * cached cell data from the most recent `state.update()`.
 *
 * Per row: emit `goto(dest.row+y, dest.col)`, a defensive `\x1b[0m`, then
 * walk the row's cells. SGR is emitted only on transition (within-row
 * diff). Empty cells emit a single space. Wide-char continuation cells
 * are skipped (the terminal advances the cursor by 2 cells when the
 * primary cell's wide glyph renders).
 *
 * Throws `RectSizeMismatch` when `dest` dims don't equal the source's
 * cols × rows (which is 0 × 0 if `state` was never `update()`'d).
 */
export function renderRect(
  state: RenderState,
  dest: RenderRect,
  opts: RectRenderOptions,
): string {
  const size = state.size();
  if (dest.cols !== size.cols || dest.rows !== size.rows) {
    throw new RectSizeMismatch(size, dest);
  }

  const colorDepth = opts.colorDepth ?? "preserve";
  const parts: string[] = [];

  let y = 0;
  for (const row of state.rows()) {
    parts.push(goto(dest.row + y, dest.col));
    parts.push(RESET);
    let lastSgr = "";
    for (const cell of row.cells()) {
      if (cell.isWideContinuation) continue;
      const sgr = computeSgr(cell.style, colorDepth);
      if (sgr !== lastSgr) {
        parts.push(sgr || RESET);
        lastSgr = sgr;
      }
      parts.push(cell.text === "" ? " " : cell.text);
    }
    y++;
  }

  return parts.join("");
}
