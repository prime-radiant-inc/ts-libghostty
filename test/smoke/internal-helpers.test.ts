import { describe, expect, it } from "bun:test";
import { writeStruct } from "../../src/internal/sized-struct";
import { readCString, writeCString } from "../../src/internal/marshal";

const kind = (k: "uint" | "int" | "bool" | "ptr" | "struct") => k;

describe("writeStruct", () => {
  it("writes a plain (non-sized) struct matching the layout", () => {
    const layout = {
      size: 8,
      align: 4,
      isSized: false,
      fields: {
        a: { offset: 0, size: 4, kind: kind("uint") },
        b: { offset: 4, size: 4, kind: kind("uint") },
      },
    };
    const buf = writeStruct(layout, { a: 0x11223344, b: 0x55667788 });
    expect(buf.byteLength).toBe(8);
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    expect(view.getUint32(0, true)).toBe(0x11223344);
    expect(view.getUint32(4, true)).toBe(0x55667788);
  });

  it("zeros fields not present in input", () => {
    const layout = {
      size: 8, align: 4, isSized: false,
      fields: {
        a: { offset: 0, size: 4, kind: kind("uint") },
        b: { offset: 4, size: 4, kind: kind("uint") },
      },
    };
    const buf = writeStruct(layout, { a: 0xdeadbeef });
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    expect(view.getUint32(0, true)).toBe(0xdeadbeef);
    expect(view.getUint32(4, true)).toBe(0);
  });

  it("writes u8/u16/u32/u64 sizes correctly", () => {
    const layout = {
      size: 16, align: 8, isSized: false,
      fields: {
        a: { offset: 0, size: 1, kind: kind("uint") },
        b: { offset: 2, size: 2, kind: kind("uint") },
        c: { offset: 4, size: 4, kind: kind("uint") },
        d: { offset: 8, size: 8, kind: kind("uint") },
      },
    };
    const buf = writeStruct(layout, { a: 0x12, b: 0x3456, c: 0x789abcde, d: 0x1122334455667788n });
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    expect(view.getUint8(0)).toBe(0x12);
    expect(view.getUint16(2, true)).toBe(0x3456);
    expect(view.getUint32(4, true)).toBe(0x789abcde);
    expect(view.getBigUint64(8, true)).toBe(0x1122334455667788n);
  });

  it("writes bool fields as 0/1 based on the kind", () => {
    const layout = {
      size: 1, align: 1, isSized: false,
      fields: { flag: { offset: 0, size: 1, kind: kind("bool") } },
    };
    expect(new DataView(writeStruct(layout, { flag: true  }).buffer).getUint8(0)).toBe(1);
    expect(new DataView(writeStruct(layout, { flag: false }).buffer).getUint8(0)).toBe(0);
  });

  it("sized struct auto-fills the `size` field", () => {
    const layout = {
      size: 16, align: 8, isSized: true,
      fields: {
        size: { offset: 0, size: 8, kind: kind("uint") },
        cols: { offset: 8, size: 4, kind: kind("uint") },
      },
    };
    const buf = writeStruct(layout, { cols: 80 });
    const view = new DataView(buf.buffer);
    expect(view.getBigUint64(0, true)).toBe(16n);
    expect(view.getUint32(8, true)).toBe(80);
  });

  it("rejects unsupported field kinds with a clear error", () => {
    const layout = {
      size: 8, align: 8, isSized: false,
      fields: { p: { offset: 0, size: 8, kind: kind("struct") } },
    };
    expect(() => writeStruct(layout, { p: 123 as any })).toThrow(/kind.*struct/i);
  });
});

describe("marshal string helpers", () => {
  it("readCString reads a NUL-terminated string from a Uint8Array", () => {
    const bytes = new Uint8Array([0x68, 0x69, 0x00, 0xff]); // "hi"
    expect(readCString(bytes, 0)).toBe("hi");
  });

  it("readCString with offset", () => {
    const bytes = new Uint8Array([0x00, 0x68, 0x69, 0x00]);
    expect(readCString(bytes, 1)).toBe("hi");
  });

  it("writeCString produces UTF-8 bytes + NUL", () => {
    const buf = writeCString("hi");
    expect(Array.from(buf)).toEqual([0x68, 0x69, 0x00]);
  });

  it("writeCString handles non-ASCII", () => {
    const buf = writeCString("é");
    // é = U+00E9 = 0xC3 0xA9 in UTF-8
    expect(Array.from(buf)).toEqual([0xc3, 0xa9, 0x00]);
  });
});
