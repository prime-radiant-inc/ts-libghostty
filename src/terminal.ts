import { ptr, toArrayBuffer, type Pointer } from "bun:ffi";
import { getLib } from "./ffi";
import { GhosttyError, UseAfterCloseError } from "./errors";
import {
  GhosttyTerminalDataValues,
  modeTagByName,
  resultCodeByValue,
  structLayouts,
} from "./internal/generated";
import { writeStruct } from "./internal/sized-struct";
import type {
  ModeName,
  TerminalOptions,
  TerminalSnapshot,
} from "./types";

/**
 * Map a GhosttyResult numeric value returned from FFI into either success
 * or a thrown GhosttyError. Uses the generated resultCodeByValue map — no
 * string-substring guessing, no hardcoded numeric value.
 */
export function checkResult(result: number, functionName: string): void {
  const code = resultCodeByValue[result];
  if (code === "ok") return;
  throw new GhosttyError(
    `${functionName} returned non-OK GhosttyResult (code ${result}, mapped to "${code ?? "unknown"}")`,
    { code: (code ?? "unknown") as GhosttyError["code"], functionName },
  );
}

/**
 * Resolve a ModeName string to its packed u16 tag. Throws a typed
 * GhosttyError with code "invalid_value" when the name is not present in
 * the generated lookup (e.g. test passes a mistyped name, or the pinned
 * header no longer exposes that mode).
 */
function modeTagFromName(name: ModeName): number {
  const v = (modeTagByName as Record<string, number | undefined>)[name];
  if (v === undefined) {
    throw new GhosttyError(`unknown ModeName: ${name}`, {
      code: "invalid_value",
      functionName: "Terminal.mode",
    });
  }
  return v;
}

// ---- snapshot() helpers ----------------------------------------------------
//
// ghostty_terminal_get_multi takes `void** values` — an array of N
// caller-allocated OUTPUT pointers, each pointing to a typed slot sized for
// its specific key's output type. NOT a flat byte buffer. Per-key slot
// sizes come from ABI §9.

type SlotKind = "u16" | "bool" | "i32" | "size_t" | "string";

const SNAPSHOT_KEYS: Array<{ name: string; key: keyof typeof GhosttyTerminalDataValues; kind: SlotKind }> = [
  { name: "cols",           key: "GHOSTTY_TERMINAL_DATA_COLS"             as const, kind: "u16" },
  { name: "rows",           key: "GHOSTTY_TERMINAL_DATA_ROWS"             as const, kind: "u16" },
  { name: "cursorX",        key: "GHOSTTY_TERMINAL_DATA_CURSOR_X"         as const, kind: "u16" },
  { name: "cursorY",        key: "GHOSTTY_TERMINAL_DATA_CURSOR_Y"         as const, kind: "u16" },
  { name: "cursorVisible",  key: "GHOSTTY_TERMINAL_DATA_CURSOR_VISIBLE"   as const, kind: "bool" },
  { name: "activeScreen",   key: "GHOSTTY_TERMINAL_DATA_ACTIVE_SCREEN"    as const, kind: "i32" },
  { name: "scrollbackRows", key: "GHOSTTY_TERMINAL_DATA_SCROLLBACK_ROWS"  as const, kind: "size_t" },
  { name: "title",          key: "GHOSTTY_TERMINAL_DATA_TITLE"            as const, kind: "string" },
  { name: "pwd",            key: "GHOSTTY_TERMINAL_DATA_PWD"              as const, kind: "string" },
  // CURSOR_STYLE, MOUSE_TRACKING, WIDTH_PX/HEIGHT_PX, color data, and Kitty
  // fields are Pass 2+. See ABI §9 for the full enum.
];

function slotByteSize(kind: SlotKind): number {
  switch (kind) {
    case "u16":    return 2;
    case "bool":   return 1;
    case "i32":    return 4;
    case "size_t": return 8;
    case "string": return 16;  // GhosttyString: {uint8_t* ptr@0, size_t len@8}
  }
}

export class Terminal {
  #handle: Pointer | null = null;
  #cellPx: { width: number; height: number };

  constructor(opts: TerminalOptions) {
    if (!Number.isInteger(opts.cols) || opts.cols <= 0) {
      throw new GhosttyError("cols must be a positive integer", {
        code: "invalid_value",
        functionName: "Terminal.constructor",
      });
    }
    if (!Number.isInteger(opts.rows) || opts.rows <= 0) {
      throw new GhosttyError("rows must be a positive integer", {
        code: "invalid_value",
        functionName: "Terminal.constructor",
      });
    }

    this.#cellPx = {
      width: opts.cellPx?.width ?? 0,
      height: opts.cellPx?.height ?? 0,
    };

    const lib = getLib();
    const layout = structLayouts["GhosttyTerminalOptions"];
    if (!layout) {
      throw new GhosttyError(
        "generated.ts is missing GhosttyTerminalOptions layout — rerun gen-bindings",
        { code: "unknown", functionName: "Terminal.constructor" },
      );
    }

    // APC tuning (apc_max_bytes / apc_max_bytes_kitty) is NOT a field on
    // GhosttyTerminalOptions at this pin — it is set post-construction via
    // ghostty_terminal_set(term, GHOSTTY_TERMINAL_OPT_APC_MAX_BYTES, ...).
    // Pass 1 does not expose APC tuning (deferred to Pass 2+); the library
    // uses its upstream defaults. See Task 21 README APC footnote.
    const fields: Record<string, number | bigint | boolean> = {
      cols: opts.cols,
      rows: opts.rows,
      max_scrollback: BigInt(opts.maxScrollback ?? 1000),  // size_t
    };

    const optBytes = writeStruct(layout, fields);

    // ghostty_terminal_new passes GhosttyTerminalOptions BY VALUE. bun:ffi has
    // no struct-by-value, so on darwin-arm64 (AAPCS64) we split the 16-byte
    // options struct into two u64 register-sized args. The output handle is
    // written back through the 2nd arg (pointer-to-pointer). Return value is
    // GhosttyResult (signed i32). See ABI discovery §4 + §12 Surprise 5.
    const u64s = new BigUint64Array(optBytes.buffer, optBytes.byteOffset, 2);
    const outSlot = new BigUint64Array(1);

    const result = lib.symbols.ghostty_terminal_new(
      null,
      ptr(outSlot),
      u64s[0]!,
      u64s[1]!,
    );
    checkResult(result, "ghostty_terminal_new");

    const handleBig = outSlot[0]!;
    if (handleBig === 0n) {
      throw new GhosttyError("ghostty_terminal_new returned OK but out pointer is null", {
        code: "out_of_memory",
        functionName: "ghostty_terminal_new",
      });
    }
    this.#handle = Number(handleBig) as Pointer;
  }

  /** @internal — for use by other classes in the package (e.g. Formatter). */
  get _handle(): Pointer {
    this.#assertOpen();
    return this.#handle!;
  }

  /** @internal — cellPx used by snapshot() to compute pixel dimensions. */
  get _cellPx(): { width: number; height: number } {
    return this.#cellPx;
  }

  close(): void {
    if (this.#handle === null) return;
    const lib = getLib();
    lib.symbols.ghostty_terminal_free(this.#handle);
    this.#handle = null;
  }

  [Symbol.dispose](): void {
    this.close();
  }

  // ---- Methods stubbed — real implementations in Tasks 12-15 ------------

  vtWrite(bytes: Uint8Array): void {
    this.#assertOpen();
    if (bytes.length === 0) return;
    const lib = getLib();
    // ghostty_terminal_vt_write returns void (documented to never fail — ABI §4).
    // Zero-copy: ptr(bytes) aliases the Uint8Array's backing buffer for the
    // duration of the call.
    lib.symbols.ghostty_terminal_vt_write(
      this.#handle,
      ptr(bytes),
      BigInt(bytes.length),
    );
  }

  resize(cols: number, rows: number, cellPx?: { width: number; height: number }): void {
    this.#assertOpen();
    if (!Number.isInteger(cols) || cols <= 0) {
      throw new GhosttyError("cols must be a positive integer", {
        code: "invalid_value",
        functionName: "Terminal.resize",
      });
    }
    if (!Number.isInteger(rows) || rows <= 0) {
      throw new GhosttyError("rows must be a positive integer", {
        code: "invalid_value",
        functionName: "Terminal.resize",
      });
    }
    if (cellPx !== undefined) {
      this.#cellPx = { width: cellPx.width, height: cellPx.height };
    }
    const lib = getLib();
    // Signature per ABI §4: (term, cols:u16, rows:u16, cell_width_px:u32,
    // cell_height_px:u32) → GhosttyResult. cols/rows narrow to u16 at the
    // FFI layer; cellPx widths pass as u32.
    const result = lib.symbols.ghostty_terminal_resize(
      this.#handle,
      cols,
      rows,
      this.#cellPx.width,
      this.#cellPx.height,
    );
    checkResult(result, "ghostty_terminal_resize");
  }

  reset(): void {
    this.#assertOpen();
    const lib = getLib();
    // Returns void (ABI §4).
    lib.symbols.ghostty_terminal_reset(this.#handle);
  }

  snapshot(): TerminalSnapshot {
    this.#assertOpen();
    const lib = getLib();

    const n = SNAPSHOT_KEYS.length;

    // Build the keys array (i32 each — GhosttyTerminalData is c_int-backed).
    const keysBuf = new Int32Array(n);
    // Allocate one typed slot per key. We keep the slot ArrayBuffers alive
    // via the `slots` array so the pointers we capture in `ptrArray` remain
    // valid for the duration of the FFI call.
    const slots: ArrayBuffer[] = new Array(n);
    const ptrArray = new BigUint64Array(n);

    for (let i = 0; i < n; i++) {
      const entry = SNAPSHOT_KEYS[i];
      if (!entry) continue;
      const v = GhosttyTerminalDataValues[entry.key];
      if (v === undefined) {
        throw new GhosttyError(`GhosttyTerminalData.${entry.key} is missing at the pinned Ghostty commit`, {
          code: "unknown",
          functionName: "Terminal.snapshot",
        });
      }
      keysBuf[i] = v;
      const slot = new ArrayBuffer(slotByteSize(entry.kind));
      slots[i] = slot;
      ptrArray[i] = BigInt(ptr(new Uint8Array(slot)));
    }

    const outWritten = new BigUint64Array(1);
    const result = lib.symbols.ghostty_terminal_get_multi(
      this.#handle,
      BigInt(n),
      ptr(keysBuf),
      ptr(ptrArray),
      ptr(outWritten),
    );
    checkResult(result, "ghostty_terminal_get_multi");

    // Decode each slot per its kind. String values (TITLE, PWD) are borrowed
    // — the ptr aliases into terminal-owned memory valid only until the next
    // mutating call. We copy them into JS strings immediately (ABI §4/§9).
    const raw: Record<string, number | boolean | string | undefined> = {};
    for (let i = 0; i < n; i++) {
      const entry = SNAPSHOT_KEYS[i];
      if (!entry) continue;
      const slot = slots[i];
      if (!slot) continue;
      const view = new DataView(slot);
      switch (entry.kind) {
        case "u16":
          raw[entry.name] = view.getUint16(0, true);
          break;
        case "bool":
          raw[entry.name] = view.getUint8(0) !== 0;
          break;
        case "i32":
          raw[entry.name] = view.getInt32(0, true);
          break;
        case "size_t":
          raw[entry.name] = Number(view.getBigUint64(0, true));
          break;
        case "string": {
          const strPtr = view.getBigUint64(0, true);
          const strLen = Number(view.getBigUint64(8, true));
          if (strPtr === 0n || strLen === 0) {
            raw[entry.name] = undefined;
          } else {
            // Copy immediately — borrowed pointer, invalidated by the next
            // mutating terminal call.
            const borrowed = new Uint8Array(
              toArrayBuffer(Number(strPtr) as unknown as Pointer, 0, strLen),
            );
            const copy = new Uint8Array(strLen);
            copy.set(borrowed);
            raw[entry.name] = new TextDecoder("utf-8").decode(copy);
          }
          break;
        }
      }
    }

    const activeScreenNum = raw.activeScreen as number | undefined;
    const activeScreen: "primary" | "alternate" =
      activeScreenNum === 1 ? "alternate" : "primary";

    const { width: cellW, height: cellH } = this.#cellPx;

    // Under exactOptionalPropertyTypes, optional fields cannot be assigned
    // `undefined` explicitly — we only include them when the C side returned
    // a non-empty borrowed pointer.
    const snap: TerminalSnapshot = {
      cols: raw.cols as number,
      rows: raw.rows as number,
      pixelWidth: (raw.cols as number) * cellW,
      pixelHeight: (raw.rows as number) * cellH,
      cursor: {
        x: raw.cursorX as number,
        y: raw.cursorY as number,
        visible: raw.cursorVisible as boolean,
        style: "block",  // CURSOR_STYLE returns a 72 B GhosttyStyle struct; Pass 2+.
      },
      activeScreen,
      scrollbackRows: raw.scrollbackRows as number,
      mouseTracking: "none",  // MOUSE_TRACKING returns a bool; richer reporting is Pass 2+.
    };
    if (typeof raw.title === "string") snap.title = raw.title;
    if (typeof raw.pwd === "string") snap.pwd = raw.pwd;
    return snap;
  }

  mode(name: ModeName): boolean {
    this.#assertOpen();
    const tag = modeTagFromName(name);
    const lib = getLib();
    const outBool = new Uint8Array(1);
    const result = lib.symbols.ghostty_terminal_mode_get(
      this.#handle,
      tag,
      ptr(outBool),
    );
    checkResult(result, "ghostty_terminal_mode_get");
    return outBool[0] !== 0;
  }

  setMode(name: ModeName, value: boolean): void {
    this.#assertOpen();
    const tag = modeTagFromName(name);
    const lib = getLib();
    const result = lib.symbols.ghostty_terminal_mode_set(this.#handle, tag, value);
    checkResult(result, "ghostty_terminal_mode_set");
  }

  #assertOpen(): void {
    if (this.#handle === null) {
      throw new UseAfterCloseError("Terminal has been closed", {
        handleType: "Terminal",
      });
    }
  }
}
