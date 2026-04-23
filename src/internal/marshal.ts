import { toArrayBuffer, type Pointer } from "bun:ffi";

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
