import type { CellStyle, PaletteIndex, RGB } from "./types";

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
