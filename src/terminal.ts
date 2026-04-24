import { ptr, toArrayBuffer, type JSCallback, type Pointer } from "bun:ffi";
import { getLib } from "./ffi";
import { GhosttyError, UseAfterCloseError, getResultCodeName } from "./errors";
import {
  GhosttyTerminalDataValues,
  GhosttyTerminalOptionValues,
  GhosttyCellDataValues,
  GhosttyCellWideValues,
  GhosttyPointTagValues,
  modeTagByName,
  resultCodeByValue,
  structLayouts,
} from "./internal/generated";
import { writeStruct, readStyle } from "./internal/sized-struct";
import { rawStyleToCellStyle, isDefaultRawStyle } from "./internal/style";
import {
  makeBellCallback,
  makeTitleCallback,
  makeWritePtyCallback,
  type TrampolineResult,
} from "./internal/callbacks";
import { writeScrollViewport, readRgb, readPalette256, writePoint } from "./internal/marshal";
import type {
  CellAtPoint,
  CellInfo,
  CellStyle,
  ModeName,
  RGB,
  TerminalColors,
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

    // APC bounds: applied post-construction via ghostty_terminal_set.
    // Validate eagerly so bad values throw before any FFI call is made.
    // Defaults: apcMaxBytes=1 MiB, apcMaxBytesKitty=0 (Kitty APC not retained
    // at v0). KITTY_IMAGE_STORAGE_LIMIT is wired as an internal safety default
    // of 0 — not user-configurable at v0 (binding design §5.9).
    const apcMaxBytes = opts.apcMaxBytes ?? 1_048_576;
    assertSizeT("apcMaxBytes", apcMaxBytes, fn);
    const apcMaxBytesKitty = opts.apcMaxBytesKitty ?? 0;
    assertSizeT("apcMaxBytesKitty", apcMaxBytesKitty, fn);

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
    // GhosttyTerminalOptions at this pin — it is applied post-construction via
    // ghostty_terminal_set (see #applyApcBounds call below after terminal_new).
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

    // ---- Apply APC bounds + Kitty image-storage internal default -----------
    // Must run BEFORE callback registration so that if a set call fails we free
    // the handle without needing to detach partially-registered callbacks.
    this.#applyApcBounds(apcMaxBytes, apcMaxBytesKitty);

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

  /**
   * Internal-use handle accessor for RenderState.update. Not part of the
   * public API; do not call from consumer code.
   * @internal
   */
  unsafeHandle(): Pointer {
    this.#assertOpen();
    return this.#handle!;
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
   * Read the current color state: effective colors (after OSC 10/11/12
   * overrides), configured defaults, and the full 256-entry palette.
   *
   * "effective" values are `undefined` when no OSC override is active (the
   * terminal uses its built-in defaults). "defaults" values are `undefined`
   * when no explicit default has been configured.
   *
   * Read-only — safe to call from inside a callback.
   */
  colors(): TerminalColors {
    this.#assertOpen();

    const lib = getLib();
    const rgbSize = structLayouts["GhosttyColorRgb"]!.size; // 3 bytes
    const paletteSize = rgbSize * 256; // 768 bytes
    const scratch = new Uint8Array(Math.max(rgbSize, paletteSize));

    const D = GhosttyTerminalDataValues;

    const readColor = (dataKey: number): RGB | undefined => {
      scratch.fill(0, 0, rgbSize);
      const rc = lib.symbols.ghostty_terminal_get(this.#handle, dataKey, ptr(scratch));
      if (rc === 0) return readRgb(scratch, 0);
      // GHOSTTY_NO_VALUE (-4) means "no override set".
      if (getResultCodeName(rc) === "no_value") return undefined;
      throw new GhosttyError(
        `ghostty_terminal_get(DATA=${dataKey}) failed with code ${rc}`,
        {
          code: (getResultCodeName(rc) as GhosttyError["code"]),
          functionName: `ghostty_terminal_get(DATA=${dataKey})`,
        },
      );
    };

    const readPalette = (dataKey: number): readonly RGB[] => {
      scratch.fill(0);
      const rc = lib.symbols.ghostty_terminal_get(this.#handle, dataKey, ptr(scratch));
      if (rc !== 0) {
        throw new GhosttyError(
          `ghostty_terminal_get(DATA=${dataKey}) failed with code ${rc}`,
          {
            code: (getResultCodeName(rc) as GhosttyError["code"]),
            functionName: `ghostty_terminal_get(DATA=${dataKey})`,
          },
        );
      }
      return readPalette256(scratch, 0);
    };

    // Build effective/defaults without assigning undefined explicitly —
    // exactOptionalPropertyTypes rejects `{ fg: undefined }` for `{ fg?: RGB }`.
    const effectiveFg = readColor(D["GHOSTTY_TERMINAL_DATA_COLOR_FOREGROUND"]);
    const effectiveBg = readColor(D["GHOSTTY_TERMINAL_DATA_COLOR_BACKGROUND"]);
    const effectiveCursor = readColor(D["GHOSTTY_TERMINAL_DATA_COLOR_CURSOR"]);
    const defaultsFg = readColor(D["GHOSTTY_TERMINAL_DATA_COLOR_FOREGROUND_DEFAULT"]);
    const defaultsBg = readColor(D["GHOSTTY_TERMINAL_DATA_COLOR_BACKGROUND_DEFAULT"]);
    const defaultsCursor = readColor(D["GHOSTTY_TERMINAL_DATA_COLOR_CURSOR_DEFAULT"]);

    const effective: TerminalColors["effective"] = {};
    if (effectiveFg !== undefined) effective.fg = effectiveFg;
    if (effectiveBg !== undefined) effective.bg = effectiveBg;
    if (effectiveCursor !== undefined) effective.cursor = effectiveCursor;

    const defaults: TerminalColors["defaults"] = {};
    if (defaultsFg !== undefined) defaults.fg = defaultsFg;
    if (defaultsBg !== undefined) defaults.bg = defaultsBg;
    if (defaultsCursor !== undefined) defaults.cursor = defaultsCursor;

    return {
      effective,
      defaults,
      palette: readPalette(D["GHOSTTY_TERMINAL_DATA_COLOR_PALETTE"]),
    };
  }

  /**
   * Apply a partial color patch to the terminal's configured defaults.
   * Writes `defaults.fg` / `defaults.bg` / `defaults.cursor` and, if provided,
   * the full 256-entry `palette` (via GHOSTTY_TERMINAL_OPT_COLOR_PALETTE).
   * An empty patch (`{}`) is a no-op.
   *
   * Notes:
   * - `palette` must have exactly 256 entries when provided (matching
   *   libghostty's fixed-size palette). Anything else throws `invalid_value`.
   * - The `effective` sub-object in the public `TerminalColors` shape is
   *   read-only: OSC 10/11/12 overrides are set by the child program via
   *   vtWrite, not through setColors. Passing `patch.effective` is ignored.
   *
   * Mutating — rejected from inside a callback.
   */
  setColors(patch: Partial<TerminalColors>): void {
    this.#assertOpen();
    this.#assertNotInCallback("setColors");

    const defaults = patch.defaults;
    const palette = patch.palette;
    if (!defaults && !palette) return; // empty patch — no-op

    const lib = getLib();
    const O = GhosttyTerminalOptionValues;
    const rgbSize = structLayouts["GhosttyColorRgb"]!.size; // 3 bytes
    const scratch = new Uint8Array(rgbSize);

    const writeColor = (optKey: number, rgb: RGB): void => {
      scratch[0] = rgb[0];
      scratch[1] = rgb[1];
      scratch[2] = rgb[2];
      const rc = lib.symbols.ghostty_terminal_set(this.#handle, optKey, ptr(scratch));
      if (rc !== 0) {
        throw new GhosttyError(
          `ghostty_terminal_set(OPT=${optKey}) failed with code ${rc}`,
          {
            code: (getResultCodeName(rc) as GhosttyError["code"]),
            functionName: `ghostty_terminal_set(OPT=${optKey})`,
          },
        );
      }
    };

    if (defaults?.fg) writeColor(O["GHOSTTY_TERMINAL_OPT_COLOR_FOREGROUND"], defaults.fg);
    if (defaults?.bg) writeColor(O["GHOSTTY_TERMINAL_OPT_COLOR_BACKGROUND"], defaults.bg);
    if (defaults?.cursor) writeColor(O["GHOSTTY_TERMINAL_OPT_COLOR_CURSOR"], defaults.cursor);

    if (palette) {
      if (palette.length !== 256) {
        throw new GhosttyError(
          `invalid palette length: expected 256 entries, got ${palette.length}`,
          { code: "invalid_value", functionName: "Terminal.setColors" },
        );
      }
      // OPT_COLOR_PALETTE takes a GhosttyColorRgb[256]* — 256 × 3 bytes packed.
      const paletteBuf = new Uint8Array(256 * rgbSize);
      for (let i = 0; i < 256; i += 1) {
        const rgb = palette[i]!;
        paletteBuf[i * 3] = rgb[0];
        paletteBuf[i * 3 + 1] = rgb[1];
        paletteBuf[i * 3 + 2] = rgb[2];
      }
      const rc = lib.symbols.ghostty_terminal_set(
        this.#handle,
        O["GHOSTTY_TERMINAL_OPT_COLOR_PALETTE"],
        ptr(paletteBuf),
      );
      if (rc !== 0) {
        throw new GhosttyError(
          `ghostty_terminal_set(OPT_COLOR_PALETTE) failed with code ${rc}`,
          {
            code: (getResultCodeName(rc) as GhosttyError["code"]),
            functionName: "ghostty_terminal_set(OPT_COLOR_PALETTE)",
          },
        );
      }
    }
  }

  /**
   * Look up a single cell by grid coordinate. Returns `undefined` when the
   * coordinate is outside the grid for the requested coord space (not a throw).
   *
   * Supported coord spaces: "active" (default), "viewport", "screen", "history".
   * "screen" and "history" require scrollback content to be meaningful; they
   * dispatch the same path as active/viewport — Task 9 adds tests for those.
   *
   * Read-only — safe to call from inside a callback.
   */
  cellAt(pt: CellAtPoint): CellInfo | undefined {
    this.#assertOpen();

    const { x, y, coordinateSpace = "active" } = pt;
    const tag = this.#pointTag(coordinateSpace);

    // Bounds pre-check at TS boundary — x must fit u16, y must fit u32.
    // Out-of-range values are not errors; they just can't be in the grid.
    if (!Number.isInteger(x) || x < 0 || x > 0xFFFF) return undefined;
    if (!Number.isInteger(y) || y < 0 || y > 0xFFFFFFFF) return undefined;

    const pointBuf = writePoint(tag, x, y);
    const refBuf = this.#freshGridRefBuffer();
    const lib = getLib();
    const rc = lib.symbols.ghostty_terminal_grid_ref(this.#handle, ptr(pointBuf), ptr(refBuf));
    if (rc !== 0) {
      // INVALID_VALUE = coordinate outside the resolved grid for this coord space.
      // This is a legitimate "miss", not an error. Any other non-OK code is real.
      if (getResultCodeName(rc) === "invalid_value") return undefined;
      throw new GhosttyError(
        `ghostty_terminal_grid_ref failed with code ${rc}`,
        { code: getResultCodeName(rc) as GhosttyError["code"], functionName: "ghostty_terminal_grid_ref" },
      );
    }

    return this.#decodeGridRef(refBuf);
  }

  /** Map a coordinateSpace string to its GhosttyPointTag numeric value. */
  #pointTag(space: "active" | "viewport" | "screen" | "history"): 0 | 1 | 2 | 3 {
    const T = GhosttyPointTagValues;
    switch (space) {
      case "active":   return T["GHOSTTY_POINT_TAG_ACTIVE"] as 0;
      case "viewport": return T["GHOSTTY_POINT_TAG_VIEWPORT"] as 1;
      case "screen":   return T["GHOSTTY_POINT_TAG_SCREEN"] as 2;
      case "history":  return T["GHOSTTY_POINT_TAG_HISTORY"] as 3;
      default:
        throw new GhosttyError(
          `invalid coordinateSpace: expected "active" | "viewport" | "screen" | "history"; received ${JSON.stringify(space)}`,
          { code: "invalid_value", functionName: "Terminal.cellAt" },
        );
    }
  }

  /**
   * Allocate a GhosttyGridRef output buffer, pre-written with the required
   * `size` field so libghostty recognises it as a valid sized struct.
   */
  #freshGridRefBuffer(): Uint8Array {
    const layout = structLayouts["GhosttyGridRef"]!;
    const buf = new Uint8Array(layout.size);
    new DataView(buf.buffer).setBigUint64(layout.fields["size"]!.offset, BigInt(layout.size), true);
    return buf;
  }

  /**
   * Decode a filled GhosttyGridRef buffer into a CellInfo object.
   * Calls the four grid-ref accessor FFI functions in sequence.
   */
  #decodeGridRef(refBuf: Uint8Array): CellInfo {
    const lib = getLib();

    // ---- 1. Grapheme codepoints → text ----------------------------------------
    // Probe with buf=null to learn required codepoint count.
    // Returns SUCCESS+len=0 for empty cells (no text), OUT_OF_SPACE+len>0 for
    // cells with text. rc===SUCCESS here is not an error condition — it is the
    // documented empty-cell path per grid_ref.h.
    const lenOut = new BigUint64Array(1);
    let rc = lib.symbols.ghostty_grid_ref_graphemes(ptr(refBuf), null, 0n, ptr(lenOut));
    if (rc !== 0 && getResultCodeName(rc) !== "out_of_space") {
      throw new GhosttyError(
        `ghostty_grid_ref_graphemes (probe) failed with code ${rc}`,
        { code: getResultCodeName(rc) as GhosttyError["code"], functionName: "ghostty_grid_ref_graphemes" },
      );
    }

    const requiredCodepoints = Number(lenOut[0]);
    let text = "";
    if (requiredCodepoints > 0) {
      const codepointBuf = new Uint32Array(requiredCodepoints);
      const writtenOut = new BigUint64Array(1);
      rc = lib.symbols.ghostty_grid_ref_graphemes(
        ptr(refBuf),
        ptr(codepointBuf),
        BigInt(requiredCodepoints),
        ptr(writtenOut),
      );
      if (rc !== 0) {
        throw new GhosttyError(
          `ghostty_grid_ref_graphemes (fetch) failed with code ${rc}`,
          { code: getResultCodeName(rc) as GhosttyError["code"], functionName: "ghostty_grid_ref_graphemes" },
        );
      }
      const written = Number(writtenOut[0]);
      text = String.fromCodePoint(...codepointBuf.subarray(0, written));
    }

    // ---- 2. Cell-level read for wide + protected flags -------------------------
    // GhosttyCell is uint64_t (opaque). ghostty_grid_ref_cell writes it into
    // a BigUint64Array slot; we then pass the value (not a pointer to it) to
    // ghostty_cell_get.
    const cellOut = new BigUint64Array(1);
    rc = lib.symbols.ghostty_grid_ref_cell(ptr(refBuf), ptr(cellOut));
    if (rc !== 0) {
      throw new GhosttyError(
        `ghostty_grid_ref_cell failed with code ${rc}`,
        { code: getResultCodeName(rc) as GhosttyError["code"], functionName: "ghostty_grid_ref_cell" },
      );
    }
    const cellValue = cellOut[0]!; // u64 cell value (not a pointer)

    // GhosttyCellWide enum: NARROW=0, WIDE=1, SPACER_TAIL=2, SPACER_HEAD=3.
    const wideEnumOut = new Int32Array(1);
    const rcWide = lib.symbols.ghostty_cell_get(
      cellValue,
      GhosttyCellDataValues["GHOSTTY_CELL_DATA_WIDE"],
      ptr(wideEnumOut),
    );
    const wideEnum = rcWide === 0 ? wideEnumOut[0] : 0;
    const wide = wideEnum === GhosttyCellWideValues["GHOSTTY_CELL_WIDE_WIDE"];
    const isWideContinuation =
      wideEnum === GhosttyCellWideValues["GHOSTTY_CELL_WIDE_SPACER_TAIL"] ||
      wideEnum === GhosttyCellWideValues["GHOSTTY_CELL_WIDE_SPACER_HEAD"];

    const protectedOut = new Uint8Array(1);
    const rcProt = lib.symbols.ghostty_cell_get(
      cellValue,
      GhosttyCellDataValues["GHOSTTY_CELL_DATA_PROTECTED"],
      ptr(protectedOut),
    );
    const isProtected = rcProt === 0 && protectedOut[0] !== 0;

    // ---- 3. Style — sized struct GhosttyStyle ----------------------------------
    // Must pre-fill the `size` field before handing to ghostty_grid_ref_style.
    const styleLayout = structLayouts["GhosttyStyle"]!;
    const styleBuf = new Uint8Array(styleLayout.size);
    new DataView(styleBuf.buffer).setBigUint64(
      styleLayout.fields["size"]!.offset,
      BigInt(styleLayout.size),
      true,
    );
    rc = lib.symbols.ghostty_grid_ref_style(ptr(refBuf), ptr(styleBuf));
    let style: CellStyle | undefined;
    if (rc === 0) {
      const raw = readStyle(styleBuf);
      // Omit style entirely for default-styled cells per the public
      // `style?: undefined = default` contract.
      if (!isDefaultRawStyle(raw)) style = rawStyleToCellStyle(raw);
    } else if (getResultCodeName(rc) !== "no_value" && getResultCodeName(rc) !== "invalid_value") {
      throw new GhosttyError(
        `ghostty_grid_ref_style failed with code ${rc}`,
        { code: getResultCodeName(rc) as GhosttyError["code"], functionName: "ghostty_grid_ref_style" },
      );
    }

    // ---- 4. Hyperlink URI — probe-size-first -----------------------------------
    const hyperlinkUri = this.#readHyperlinkUri(refBuf);

    // exactOptionalPropertyTypes: only include optional fields when non-undefined
    const info: CellInfo = {
      text,
      wide,
      isWideContinuation,
      protected: isProtected,
    };
    if (style !== undefined) info.style = style;
    if (hyperlinkUri !== undefined) info.hyperlinkUri = hyperlinkUri;
    return info;
  }

  /**
   * Read hyperlink URI from a grid ref using probe-size-first pattern.
   * Returns undefined when no hyperlink is attached to the cell.
   * Per grid_ref.h: SUCCESS + len=0 means no hyperlink (not NO_VALUE).
   */
  #readHyperlinkUri(refBuf: Uint8Array): string | undefined {
    const lib = getLib();
    const lenOut = new BigUint64Array(1);
    let rc = lib.symbols.ghostty_grid_ref_hyperlink_uri(ptr(refBuf), null, 0n, ptr(lenOut));
    // SUCCESS + len=0 → no hyperlink; OUT_OF_SPACE + len>0 → hyperlink present.
    // (grid_ref.h: "If the cell has no hyperlink, out_len is set to 0 and
    // GHOSTTY_SUCCESS is returned." — plan's NO_VALUE claim was incorrect.)
    if (rc !== 0 && getResultCodeName(rc) !== "out_of_space") {
      // Any other error code is unexpected — propagate.
      throw new GhosttyError(
        `ghostty_grid_ref_hyperlink_uri (probe) failed with code ${rc}`,
        { code: getResultCodeName(rc) as GhosttyError["code"], functionName: "ghostty_grid_ref_hyperlink_uri" },
      );
    }
    const required = Number(lenOut[0]);
    if (required === 0) return undefined;

    const buf = new Uint8Array(required);
    const writtenOut = new BigUint64Array(1);
    rc = lib.symbols.ghostty_grid_ref_hyperlink_uri(ptr(refBuf), ptr(buf), BigInt(required), ptr(writtenOut));
    if (rc !== 0) {
      throw new GhosttyError(
        `ghostty_grid_ref_hyperlink_uri (fetch) failed with code ${rc}`,
        { code: getResultCodeName(rc) as GhosttyError["code"], functionName: "ghostty_grid_ref_hyperlink_uri" },
      );
    }
    return new TextDecoder("utf-8").decode(buf.subarray(0, Number(writtenOut[0])));
  }

  /**
   * Apply APC byte-limit bounds and the internal Kitty-image-storage-limit
   * default via ghostty_terminal_set. Called once at construction, immediately
   * after ghostty_terminal_new succeeds, before any callback registration.
   *
   * On failure the handle is freed and #handle nulled so the constructor's
   * catch block does not attempt to detach callbacks that were never registered.
   * The original GhosttyError is then re-thrown.
   *
   * APC read-back is not supported by libghostty (Task 2 probe confirmed), so
   * correctness is verified via no-crash on construction + assertSizeT guards.
   */
  #applyApcBounds(apcMaxBytes: number, apcMaxBytesKitty: number): void {
    const lib = getLib();
    const O = GhosttyTerminalOptionValues;
    const scratch = new BigUint64Array(1);

    const setSizeT = (opt: number, value: number, fieldName: string): void => {
      scratch[0] = BigInt(value);
      const rc = lib.symbols.ghostty_terminal_set(this.#handle, opt, ptr(scratch));
      if (rc !== 0) {
        // Roll back: the terminal handle is live but partially configured.
        // Free it to avoid leaking, then clear the field so the constructor
        // catch block (which tries to detach callbacks) does not run.
        const h = this.#handle;
        this.#handle = null;
        try { lib.symbols.ghostty_terminal_free(h); } catch {}
        throw new GhosttyError(
          `ghostty_terminal_set(${fieldName}) failed with code ${rc}`,
          {
            code: getResultCodeName(rc) as GhosttyError["code"],
            functionName: `ghostty_terminal_set(${fieldName})`,
          },
        );
      }
    };

    setSizeT(O["GHOSTTY_TERMINAL_OPT_APC_MAX_BYTES"], apcMaxBytes, "APC_MAX_BYTES");
    setSizeT(O["GHOSTTY_TERMINAL_OPT_APC_MAX_BYTES_KITTY"], apcMaxBytesKitty, "APC_MAX_BYTES_KITTY");
    // Internal safety default — binding design §5.9. Not user-configurable at v0.
    setSizeT(O["GHOSTTY_TERMINAL_OPT_KITTY_IMAGE_STORAGE_LIMIT"], 0, "KITTY_IMAGE_STORAGE_LIMIT");
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
