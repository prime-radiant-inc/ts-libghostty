/**
 * rawStyleToCellStyle — shared helper extracted from Terminal for Task 11.
 *
 * Converts a `RawStyle` (decoded from a GhosttyStyle sized struct) into the
 * public `CellStyle` interface. The SGR underline-style int is mapped to the
 * `UnderlineStyle` string union here; optional color fields are only set
 * when the raw value is non-undefined (exactOptionalPropertyTypes).
 */
import type { RawStyle } from "./sized-struct";
import type { CellStyle, RGB, UnderlineStyle } from "../types";

const UNDERLINE_MAP: readonly UnderlineStyle[] =
  ["none", "single", "double", "curly", "dotted", "dashed"];

/**
 * True when the RawStyle represents libghostty's default (unstyled) style.
 * Used to avoid attaching an all-false `CellStyle` object to default cells,
 * which would violate the `style?: undefined = default` public contract and
 * bloat metadata fixtures.
 */
export function isDefaultRawStyle(raw: RawStyle): boolean {
  return (
    raw.fg === undefined &&
    raw.bg === undefined &&
    raw.underlineColor === undefined &&
    !raw.bold &&
    !raw.italic &&
    !raw.faint &&
    !raw.blink &&
    !raw.inverse &&
    !raw.invisible &&
    !raw.strikethrough &&
    !raw.overline &&
    raw.underline === 0
  );
}

export function rawStyleToCellStyle(raw: RawStyle): CellStyle {
  const underline = UNDERLINE_MAP[raw.underline] ?? "none";
  const result: CellStyle = {
    bold: raw.bold,
    faint: raw.faint,
    italic: raw.italic,
    underline,
    overline: raw.overline,
    strikethrough: raw.strikethrough,
    blink: raw.blink,
    inverse: raw.inverse,
    invisible: raw.invisible,
  };
  if (raw.fg !== undefined) result.fg = raw.fg;
  if (raw.bg !== undefined) result.bg = raw.bg;
  if (raw.underlineColor !== undefined && !("palette" in raw.underlineColor)) {
    result.underlineColor = raw.underlineColor as RGB;
  }
  return result;
}
