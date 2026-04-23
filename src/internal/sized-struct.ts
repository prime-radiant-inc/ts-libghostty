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
