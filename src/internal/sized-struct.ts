import type { StructLayout } from "./generated";

/**
 * Build a byte buffer matching `layout`. Writes each provided field at its
 * declared offset using the width/kind from the probe. Unsupplied fields
 * default to zero. If the struct is sized (first field is `size_t size`),
 * the writer auto-fills that field with `layout.size` unless the caller
 * explicitly provides a value.
 *
 * Only supports `kind` in {"uint", "int", "bool"} — the kinds Pass 1's
 * option structs actually use. Pointer and nested-struct fields throw to
 * force an explicit design decision at extension time.
 */
export function writeStruct(
  layout: StructLayout,
  fields: Record<string, number | bigint | boolean>,
): Uint8Array {
  const buf = new Uint8Array(layout.size);
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

  for (const [name, spec] of Object.entries(layout.fields)) {
    let raw: number | bigint | boolean | undefined = fields[name];

    // Auto-fill `size` for sized structs if the caller didn't supply it.
    if (raw === undefined && layout.isSized && name === "size") {
      raw = BigInt(layout.size);
    }

    if (raw === undefined) continue;

    if (spec.kind === "ptr" || spec.kind === "struct") {
      throw new Error(
        `writeStruct: field "${name}" has kind "${spec.kind}" which requires explicit handling. ` +
        `Extend writeStruct or wrap this struct in a dedicated helper.`,
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
