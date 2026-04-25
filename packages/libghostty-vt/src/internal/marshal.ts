import { toArrayBuffer, type Pointer } from "bun:ffi";
import { structLayouts } from "./generated";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: false });

/** Read a NUL-terminated UTF-8 string from a Uint8Array starting at `offset`. */
export function readCString(bytes: Uint8Array, offset: number): string {
  let end = offset;
  while (end < bytes.length && bytes[end] !== 0) end++;
  return textDecoder.decode(bytes.subarray(offset, end));
}

/** Encode a JS string as a NUL-terminated UTF-8 byte buffer. */
export function writeCString(s: string): Uint8Array {
  const body = textEncoder.encode(s);
  const buf = new Uint8Array(body.length + 1);
  buf.set(body, 0);
  buf[body.length] = 0;
  return buf;
}

/** Copy bytes from a libghostty-owned pointer into a freshly-allocated Uint8Array. */
export function copyBytesFromPointer(ptr: Pointer, len: number): Uint8Array {
  // Bun's FFI `toArrayBuffer(ptr, offset, length)` returns a view over native
  // memory. Copy immediately into a new buffer so the caller can retain it.
  const view = new Uint8Array(toArrayBuffer(ptr, 0, len));
  const copy = new Uint8Array(len);
  copy.set(view);
  return copy;
}

export type { Pointer }; // re-export bun:ffi's Pointer type for callers

// --- Pass 3 helpers -----------------------------------------------------------

/**
 * Read a 3-byte GhosttyColorRgb at `offset` in `buf`. Returns an [r,g,b] tuple.
 * Preserves semantic index order for palettes.
 *
 * Layout from probe: size=3, r@0, g@1, b@2 (tightly packed, align=1).
 */
export function readRgb(buf: Uint8Array, offset: number): readonly [number, number, number] {
  return [buf[offset]!, buf[offset + 1]!, buf[offset + 2]!] as const;
}

/**
 * Read a 256-entry palette starting at `offset`. Each entry is 3 bytes; total 768 bytes.
 * Caller ensures buf.length >= offset + 768.
 */
export function readPalette256(buf: Uint8Array, offset: number): readonly (readonly [number, number, number])[] {
  const out: (readonly [number, number, number])[] = new Array(256);
  for (let i = 0; i < 256; i += 1) {
    out[i] = readRgb(buf, offset + i * 3);
  }
  return out as readonly (readonly [number, number, number])[];
}

/**
 * Write a GhosttyTerminalScrollViewport tagged union into a fresh Uint8Array.
 * Layout from probe: tag(i32)@0 + 4-byte pad + value(union 16B)@8 = 24 bytes total.
 * Exact offsets come from structLayouts.GhosttyTerminalScrollViewport.
 */
export function writeScrollViewport(tag: 0 | 1 | 2, delta: number): Uint8Array {
  const layout = structLayouts["GhosttyTerminalScrollViewport"]!;
  const buf = new Uint8Array(layout.size);
  const view = new DataView(buf.buffer);
  view.setInt32(layout.fields["tag"]!.offset, tag, true);
  if (tag === 2) {
    // intptr_t on darwin-arm64 = 8 bytes signed; delta is at value offset.
    view.setBigInt64(layout.fields["value"]!.offset, BigInt(delta), true);
  }
  return buf;
}

/**
 * Write a GhosttyPoint tagged union for cellAt lookups.
 * Layout from probe: tag(i32)@0 + 4-byte pad + value(GhosttyPointValue union)@8 = 24 bytes.
 * GhosttyPointCoordinate within value: x(u16)@0, pad@2-3, y(u32)@4.
 */
export function writePoint(tag: 0 | 1 | 2 | 3, x: number, y: number): Uint8Array {
  const layout = structLayouts["GhosttyPoint"]!;
  const coordLayout = structLayouts["GhosttyPointCoordinate"]!;
  const buf = new Uint8Array(layout.size);
  const view = new DataView(buf.buffer);
  view.setInt32(layout.fields["tag"]!.offset, tag, true);
  const valueOffset = layout.fields["value"]!.offset;
  // GhosttyPointCoordinate is the first (and only used) member of the union.
  view.setUint16(valueOffset + coordLayout.fields["x"]!.offset, x, true);
  view.setUint32(valueOffset + coordLayout.fields["y"]!.offset, y, true);
  return buf;
}
