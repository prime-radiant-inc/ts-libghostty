import { ptr, type Pointer } from "bun:ffi";
import { getLib } from "./ffi";
import { GhosttyError, UseAfterCloseError } from "./errors";
import { resultCodeByValue, structLayouts } from "./internal/generated";
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
    throw new Error("Terminal.snapshot not implemented yet (Task 14)");
  }

  mode(_name: ModeName): boolean {
    this.#assertOpen();
    throw new Error("Terminal.mode not implemented yet (Task 15)");
  }

  setMode(_name: ModeName, _value: boolean): void {
    this.#assertOpen();
    throw new Error("Terminal.setMode not implemented yet (Task 15)");
  }

  #assertOpen(): void {
    if (this.#handle === null) {
      throw new UseAfterCloseError("Terminal has been closed", {
        handleType: "Terminal",
      });
    }
  }
}
