import { ptr, toArrayBuffer, type JSCallback, type Pointer } from "bun:ffi";
import { getLib } from "./ffi";
import { GhosttyError, UseAfterCloseError } from "./errors";
import {
  GhosttyTerminalDataValues,
  GhosttyTerminalOptionValues,
  modeTagByName,
  resultCodeByValue,
  structLayouts,
} from "./internal/generated";
import { writeStruct } from "./internal/sized-struct";
import {
  makeBellCallback,
  makeTitleCallback,
  makeWritePtyCallback,
  type TrampolineResult,
} from "./internal/callbacks";
import { writeScrollViewport } from "./internal/marshal";
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

// ---- input validation -----------------------------------------------------
//
// Bounds come from the ABI doc (docs/abi/2026-04-22-abi-discovery.md):
//   - cols, rows                       -> uint16_t   (1..65535)
//   - cell_width_px, cell_height_px    -> uint32_t   (0..4_294_967_295)
//   - max_scrollback                   -> size_t     (0..MAX_SAFE_INTEGER)
//
// Without these checks, invalid values silently coerce/wrap at the FFI
// boundary: cols=70000 wraps to 4464; cellPx.width=-1 sign-extends to a huge
// uint32 and yields nonsense pixel dims; maxScrollback=-1 is BigInt-encoded
// as 2^64-1 and is happily accepted as a "huge" size_t. Codex flagged all
// three reproductions; this block makes them throw with a named field.

const U16_MAX = 0xFFFF;          // 65_535
const U32_MAX = 0xFFFF_FFFF;     // 4_294_967_295

function assertU16(name: string, value: number, functionName: string, opts: { min?: number } = {}): void {
  const min = opts.min ?? 0;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > U16_MAX) {
    throw new GhosttyError(
      `${name} must be an integer in [${min}..${U16_MAX}] (uint16_t), got ${value}`,
      { code: "invalid_value", functionName },
    );
  }
}

function assertU32(name: string, value: number, functionName: string): void {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > U32_MAX) {
    throw new GhosttyError(
      `${name} must be an integer in [0..${U32_MAX}] (uint32_t), got ${value}`,
      { code: "invalid_value", functionName },
    );
  }
}

function assertSizeT(name: string, value: number, functionName: string): void {
  // size_t on 64-bit darwin-arm64 is 8 bytes; we cap at MAX_SAFE_INTEGER so
  // BigInt encoding is lossless and so callers can't sneak negatives through
  // by relying on BigInt's two's-complement-ish behavior.
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > Number.MAX_SAFE_INTEGER
  ) {
    throw new GhosttyError(
      `${name} must be an integer in [0..${Number.MAX_SAFE_INTEGER}] (size_t), got ${value}`,
      { code: "invalid_value", functionName },
    );
  }
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

  // One JSCallback per enabled effect, created in the constructor and closed
  // in close(). When null, that effect is not registered on the C side.
  #writePtyCb: JSCallback | null = null;
  #bellCb: JSCallback | null = null;
  #titleCb: JSCallback | null = null;

  // Re-entry guard. Set to true by each trampoline for the duration of the
  // user callback; checked by mutating public methods to reject calls made
  // from inside a callback. Spec §5.4 + Pass-2 plan "Concurrency and re-entry".
  #inCallback = false;

  constructor(opts: TerminalOptions) {
    const fn = "Terminal.constructor";
    // cols/rows are uint16_t per ABI §4 + §11 (struct field types). They must
    // be >= 1 (a 0-cell terminal has no meaning, and Ghostty's terminal_new
    // rejects it anyway) and <= 65535. Without this check, large values wrap
    // silently at the FFI boundary (e.g. cols=70000 -> 4464).
    assertU16("cols", opts.cols, fn, { min: 1 });
    assertU16("rows", opts.rows, fn, { min: 1 });
    if (opts.maxScrollback !== undefined) {
      assertSizeT("maxScrollback", opts.maxScrollback, fn);
    }
    if (opts.cellPx !== undefined) {
      assertU32("cellPx.width", opts.cellPx.width, fn);
      assertU32("cellPx.height", opts.cellPx.height, fn);
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

    // ---- Register effect callbacks ------------------------------------------
    // Each user fn is wrapped in an #inCallback-flipping closure BEFORE going
    // to the factory so mutating methods invoked from inside the callback can
    // detect and reject re-entry (see #assertNotInCallback).
    //
    // Registration via ghostty_terminal_set; failure here is rare (indicates
    // an ABI mismatch) but we must unwind cleanly: detach anything already
    // set, close any JSCallbacks already created, free the handle, rethrow.
    const registered: TrampolineResult[] = [];
    try {
      if (opts.onWritePty !== undefined) {
        const userFn = opts.onWritePty;
        const guarded = (bytes: Uint8Array) => {
          this.#inCallback = true;
          try { userFn(bytes); }
          finally { this.#inCallback = false; }
        };
        const t = makeWritePtyCallback(guarded);
        registered.push(t);
        this.#writePtyCb = t.jsCallback;
        const r = lib.symbols.ghostty_terminal_set(
          this.#handle,
          t.optionValue,
          t.jsCallback.ptr,
        );
        checkResult(r, "ghostty_terminal_set(WRITE_PTY)");
      }
      if (opts.onBell !== undefined) {
        const userFn = opts.onBell;
        const guarded = () => {
          this.#inCallback = true;
          try { userFn(); }
          finally { this.#inCallback = false; }
        };
        const t = makeBellCallback(guarded);
        registered.push(t);
        this.#bellCb = t.jsCallback;
        const r = lib.symbols.ghostty_terminal_set(
          this.#handle,
          t.optionValue,
          t.jsCallback.ptr,
        );
        checkResult(r, "ghostty_terminal_set(BELL)");
      }
      if (opts.onTitleChanged !== undefined) {
        const userFn = opts.onTitleChanged;
        const guarded = (title: string) => {
          this.#inCallback = true;
          try { userFn(title); }
          finally { this.#inCallback = false; }
        };
        const readTitle = () => this.#readTitle();
        const t = makeTitleCallback(guarded, readTitle);
        registered.push(t);
        this.#titleCb = t.jsCallback;
        const r = lib.symbols.ghostty_terminal_set(
          this.#handle,
          t.optionValue,
          t.jsCallback.ptr,
        );
        checkResult(r, "ghostty_terminal_set(TITLE_CHANGED)");
      }
    } catch (e) {
      const h = this.#handle;
      if (h !== null) {
        for (const t of registered) {
          try { lib.symbols.ghostty_terminal_set(h, t.optionValue, null); } catch {}
        }
        for (const t of registered) {
          try { t.jsCallback.close(); } catch {}
        }
        try { lib.symbols.ghostty_terminal_free(h); } catch {}
      }
      this.#writePtyCb = null;
      this.#bellCb = null;
      this.#titleCb = null;
      this.#handle = null;
      throw e;
    }
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
    this.#assertNotInCallback("close");
    if (this.#handle === null) return;
    const lib = getLib();
    const h = this.#handle;

    // Detach callbacks BEFORE closing JSCallbacks and BEFORE terminal_free.
    // Passing NULL to ghostty_terminal_set clears the effect and ensures
    // libghostty will never invoke a thunk whose JS storage has been freed.
    // terminal_free should also sever callbacks, but detaching explicitly is
    // belt-and-suspenders. Non-OK detach results are logged but do not stop
    // teardown — we still want to free the handle and close the JSCallbacks.
    if (this.#writePtyCb !== null) {
      const r = lib.symbols.ghostty_terminal_set(
        h,
        GhosttyTerminalOptionValues["GHOSTTY_TERMINAL_OPT_WRITE_PTY"],
        null,
      );
      if (r !== 0) console.error("ts-libghostty-vt: detach WRITE_PTY returned", r);
    }
    if (this.#bellCb !== null) {
      const r = lib.symbols.ghostty_terminal_set(
        h,
        GhosttyTerminalOptionValues["GHOSTTY_TERMINAL_OPT_BELL"],
        null,
      );
      if (r !== 0) console.error("ts-libghostty-vt: detach BELL returned", r);
    }
    if (this.#titleCb !== null) {
      const r = lib.symbols.ghostty_terminal_set(
        h,
        GhosttyTerminalOptionValues["GHOSTTY_TERMINAL_OPT_TITLE_CHANGED"],
        null,
      );
      if (r !== 0) console.error("ts-libghostty-vt: detach TITLE_CHANGED returned", r);
    }

    if (this.#writePtyCb !== null) { try { this.#writePtyCb.close(); } catch {} this.#writePtyCb = null; }
    if (this.#bellCb !== null)     { try { this.#bellCb.close();     } catch {} this.#bellCb = null; }
    if (this.#titleCb !== null)    { try { this.#titleCb.close();    } catch {} this.#titleCb = null; }

    lib.symbols.ghostty_terminal_free(h);
    this.#handle = null;
  }

  [Symbol.dispose](): void {
    this.close();
  }

  // ---- Methods stubbed — real implementations in Tasks 12-15 ------------

  vtWrite(bytes: Uint8Array): void {
    this.#assertNotInCallback("vtWrite");
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
    this.#assertNotInCallback("resize");
    this.#assertOpen();
    const fn = "Terminal.resize";
    // Same ABI bounds as the constructor — see §4 in the ABI doc.
    assertU16("cols", cols, fn, { min: 1 });
    assertU16("rows", rows, fn, { min: 1 });
    if (cellPx !== undefined) {
      assertU32("cellPx.width", cellPx.width, fn);
      assertU32("cellPx.height", cellPx.height, fn);
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
    this.#assertNotInCallback("reset");
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
    // `cursor.style` and `mouseTracking` are intentionally omitted from
    // TerminalSnapshot in Pass 1 (see src/types.ts comments). CURSOR_STYLE is
    // a 72-byte GhosttyStyle struct decode (Pass 2+); MOUSE_TRACKING is a
    // bool that does not map cleanly to the 5-variant `MouseTracking` union.
    const snap: TerminalSnapshot = {
      cols: raw.cols as number,
      rows: raw.rows as number,
      pixelWidth: (raw.cols as number) * cellW,
      pixelHeight: (raw.rows as number) * cellH,
      cursor: {
        x: raw.cursorX as number,
        y: raw.cursorY as number,
        visible: raw.cursorVisible as boolean,
      },
      activeScreen,
      scrollbackRows: raw.scrollbackRows as number,
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
    this.#assertNotInCallback("setMode");
    this.#assertOpen();
    const tag = modeTagFromName(name);
    const lib = getLib();
    const result = lib.symbols.ghostty_terminal_mode_set(this.#handle, tag, value);
    checkResult(result, "ghostty_terminal_mode_set");
  }

  scrollViewport(pos: "top" | "bottom" | number): void {
    this.#assertNotInCallback("scrollViewport");
    this.#assertOpen();

    let tag: 0 | 1 | 2;
    let delta = 0;
    if (pos === "top") tag = 0;
    else if (pos === "bottom") tag = 1;
    else if (typeof pos === "number" && Number.isFinite(pos)) {
      tag = 2;
      delta = Math.trunc(pos);
    } else {
      throw new GhosttyError(
        `invalid scrollViewport argument: expected "top" | "bottom" | number; received ${JSON.stringify(pos)}`,
        {
          code: "invalid_value",
          functionName: "Terminal.scrollViewport",
        },
      );
    }

    const buf = writeScrollViewport(tag, delta);
    const lib = getLib();
    lib.symbols.ghostty_terminal_scroll_viewport(this.#handle, ptr(buf));
  }

  /**
   * Read the terminal's current title via ghostty_terminal_get(TITLE). The
   * GhosttyString ptr aliases into terminal-owned memory valid only until the
   * next mutating call, so we copy immediately. Returns "" when no title is
   * set or on any get-error — full-fidelity error reporting is not useful
   * inside a callback.
   */
  #readTitle(): string {
    if (this.#handle === null) return "";
    const lib = getLib();
    const slot = new ArrayBuffer(16); // GhosttyString: {uint8_t* ptr@0, size_t len@8}
    const result = lib.symbols.ghostty_terminal_get(
      this.#handle,
      GhosttyTerminalDataValues["GHOSTTY_TERMINAL_DATA_TITLE"],
      ptr(new Uint8Array(slot)),
    );
    if (result !== 0) return "";
    const view = new DataView(slot);
    const strPtr = Number(view.getBigUint64(0, true));
    const strLen = Number(view.getBigUint64(8, true));
    if (strPtr === 0 || strLen === 0) return "";
    const borrowed = new Uint8Array(
      toArrayBuffer(strPtr as unknown as Pointer, 0, strLen),
    );
    const copy = new Uint8Array(strLen);
    copy.set(borrowed);
    return new TextDecoder("utf-8").decode(copy);
  }

  /**
   * Guard against user code invoking a mutating Terminal method from inside
   * an effect callback. libghostty is mid-parse at callback time; mutating
   * the same Terminal corrupts or frees state the parser still references.
   */
  #assertNotInCallback(method: string): void {
    if (!this.#inCallback) return;
    throw new GhosttyError(
      `Terminal.${method} may not be called from inside an effect callback. ` +
      `Defer with queueMicrotask or setTimeout.`,
      {
        code: "invalid_value",
        functionName: `Terminal.${method}`,
      },
    );
  }

  #assertOpen(): void {
    if (this.#handle === null) {
      throw new UseAfterCloseError("Terminal has been closed", {
        handleType: "Terminal",
      });
    }
  }
}
