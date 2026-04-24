import { structLayouts } from "./generated";
import type { StructLayout } from "./generated";

/**
 * Build a byte buffer matching `layout`. Writes each provided field at its
 * declared offset using the width/kind from the probe. Unsupplied fields
 * default to zero. If the struct is sized (first field is `size_t size`),
 * the writer auto-fills that field with `layout.size` unless the caller
 * explicitly provides a value.
 *
 * Field value conventions per `kind`:
 *   - "uint" / "int" / "bool": number | bigint | boolean
 *   - "struct" (nested sub-struct): Uint8Array of exactly `spec.size` bytes
 *     — callers compose by calling writeStruct recursively for the inner
 *     layout and then splicing the resulting bytes in at the outer offset.
 *   - "ptr": number | bigint, representing the raw pointer value. Use `0`
 *     or `0n` for a null pointer. Pass 1 only uses this for null
 *     (e.g. GhosttyFormatterTerminalOptions.selection).
 */
export function writeStruct(
  layout: StructLayout,
  fields: Record<string, number | bigint | boolean | Uint8Array>,
): Uint8Array {
  const buf = new Uint8Array(layout.size);
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

  for (const [name, spec] of Object.entries(layout.fields)) {
    let raw: number | bigint | boolean | Uint8Array | undefined = fields[name];

    // Auto-fill `size` for sized structs if the caller didn't supply it.
    if (raw === undefined && layout.isSized && name === "size") {
      raw = BigInt(layout.size);
    }

    if (raw === undefined) continue;

    // Nested sub-struct: splice the pre-serialized bytes at the outer offset.
    // Must match the declared size exactly so misaligned nesting is caught
    // early, not discovered as an ABI mismatch at runtime.
    if (spec.kind === "struct") {
      if (!(raw instanceof Uint8Array)) {
        throw new Error(
          `writeStruct: field "${name}" has kind "struct"; expected a Uint8Array of ` +
          `${spec.size} bytes, got ${typeof raw}.`,
        );
      }
      if (raw.byteLength !== spec.size) {
        throw new Error(
          `writeStruct: field "${name}" expected ${spec.size} bytes for nested struct, ` +
          `got ${raw.byteLength}.`,
        );
      }
      buf.set(raw, spec.offset);
      continue;
    }

    // Pointer field: accept number | bigint representing the raw address.
    // Pass 1 uses this only for null (0/0n); any nonzero address must be
    // supplied by the caller (typically a bun:ffi `ptr(...)` result).
    if (spec.kind === "ptr") {
      if (raw instanceof Uint8Array) {
        throw new Error(
          `writeStruct: field "${name}" has kind "ptr"; pass a numeric address (0 for null), not a Uint8Array.`,
        );
      }
      if (typeof raw === "boolean") {
        throw new Error(
          `writeStruct: field "${name}" has kind "ptr"; pass a numeric address, not a boolean.`,
        );
      }
      if (spec.size !== 8) {
        throw new Error(`writeStruct: unsupported pointer size ${spec.size} for "${name}"`);
      }
      const big = typeof raw === "bigint" ? raw : BigInt(raw);
      view.setBigUint64(spec.offset, BigInt.asUintN(64, big), true);
      continue;
    }

    if (raw instanceof Uint8Array) {
      throw new Error(
        `writeStruct: field "${name}" has scalar kind "${spec.kind}"; ` +
        `expected number | bigint | boolean, got Uint8Array.`,
      );
    }

    const n =
      typeof raw === "boolean" ? (raw ? 1 : 0)
      : typeof raw === "bigint" ? raw
      : Number(raw);

    switch (spec.size) {
      case 1:
        view.setUint8(spec.offset, (typeof n === "bigint" ? Number(n) : n) & 0xff);
        break;
      case 2:
        view.setUint16(spec.offset, (typeof n === "bigint" ? Number(n) : n) & 0xffff, true);
        break;
      case 4:
        view.setUint32(spec.offset, ((typeof n === "bigint" ? Number(n) : n) >>> 0), true);
        break;
      case 8: {
        const big = typeof n === "bigint" ? n : BigInt(n);
        if (spec.kind === "int") {
          view.setBigInt64(spec.offset, BigInt.asIntN(64, big), true);
        } else {
          view.setBigUint64(spec.offset, BigInt.asUintN(64, big), true);
        }
        break;
      }
      default:
        throw new Error(`writeStruct: unsupported field size ${spec.size} for "${name}"`);
    }
  }

  return buf;
}

// --- Pass 3 sized-struct readers ---------------------------------------------

import { readRgb, readPalette256 } from "./marshal";
import type { RGB } from "../types";

export interface RawRenderStateColors {
  background: RGB;
  foreground: RGB;
  cursor: RGB;
  cursorHasValue: boolean;
  palette: readonly RGB[];
}

/**
 * Read a GhosttyRenderStateColors struct. The caller allocates a buffer
 * matching structLayouts.GhosttyRenderStateColors.size, writes the size
 * prefix, and hands it to ghostty_render_state_colors_get; this helper
 * decodes the resulting buffer.
 *
 * Layout from probe (size=792, align=8, isSized=true):
 *   size@0(8), background@8(3), foreground@11(3), cursor@14(3),
 *   cursor_has_value@17(1), palette@18(768).
 */
export function readRenderStateColors(buf: Uint8Array): RawRenderStateColors {
  const layout = structLayouts["GhosttyRenderStateColors"]!;
  return {
    background: readRgb(buf, layout.fields["background"]!.offset),
    foreground: readRgb(buf, layout.fields["foreground"]!.offset),
    cursor: readRgb(buf, layout.fields["cursor"]!.offset),
    cursorHasValue: buf[layout.fields["cursor_has_value"]!.offset] !== 0,
    palette: readPalette256(buf, layout.fields["palette"]!.offset),
  };
}

export interface RawStyle {
  fg: RGB | { palette: number } | undefined;
  bg: RGB | { palette: number } | undefined;
  underlineColor: RGB | { palette: number } | undefined;
  bold: boolean;
  italic: boolean;
  faint: boolean;
  blink: boolean;
  inverse: boolean;
  invisible: boolean;
  strikethrough: boolean;
  overline: boolean;
  underline: number; // SGR underline style enum int; higher layers map to string union
}

/**
 * Decode a GhosttyStyle buffer into a raw JS-shape object. Higher layers
 * (render-state.ts / terminal.ts) map the `underline` int into the
 * UnderlineStyle string union using generated enum lookup.
 *
 * Layout from probe (size=72, align=8, isSized=true):
 *   size@0(8), fg_color@8(16), bg_color@24(16), underline_color@40(16),
 *   bold@56(1), italic@57(1), faint@58(1), blink@59(1),
 *   inverse@60(1), invisible@61(1), strikethrough@62(1), overline@63(1),
 *   underline@64(4).
 *
 * GhosttyStyleColor layout (size=16, align=8):
 *   tag@0(4, int), pad@4-7, value@8(8).
 *   value union: palette(u8) | rgb(GhosttyColorRgb 3B) | _padding(u64).
 *   GHOSTTY_STYLE_COLOR_NONE=0, PALETTE=1, RGB=2.
 */
export function readStyle(buf: Uint8Array): RawStyle {
  const layout = structLayouts["GhosttyStyle"]!;
  const colorLayout = structLayouts["GhosttyStyleColor"]!;
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

  const readColor = (outerOffset: number): RGB | { palette: number } | undefined => {
    const tag = view.getInt32(outerOffset + colorLayout.fields["tag"]!.offset, true);
    const valueOffset = outerOffset + colorLayout.fields["value"]!.offset;
    if (tag === 0) return undefined; // GHOSTTY_STYLE_COLOR_NONE
    if (tag === 1) return { palette: buf[valueOffset]! }; // GHOSTTY_STYLE_COLOR_PALETTE
    return readRgb(buf, valueOffset); // GHOSTTY_STYLE_COLOR_RGB (3 bytes at value offset)
  };

  return {
    fg: readColor(layout.fields["fg_color"]!.offset),
    bg: readColor(layout.fields["bg_color"]!.offset),
    underlineColor: readColor(layout.fields["underline_color"]!.offset),
    bold: buf[layout.fields["bold"]!.offset] !== 0,
    italic: buf[layout.fields["italic"]!.offset] !== 0,
    faint: buf[layout.fields["faint"]!.offset] !== 0,
    blink: buf[layout.fields["blink"]!.offset] !== 0,
    inverse: buf[layout.fields["inverse"]!.offset] !== 0,
    invisible: buf[layout.fields["invisible"]!.offset] !== 0,
    strikethrough: buf[layout.fields["strikethrough"]!.offset] !== 0,
    overline: buf[layout.fields["overline"]!.offset] !== 0,
    underline: view.getInt32(layout.fields["underline"]!.offset, true),
  };
}
