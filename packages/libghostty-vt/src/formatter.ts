import { ptr, toArrayBuffer, type Pointer } from "bun:ffi";
import { getLib } from "./ffi";
import { checkResult } from "./terminal";
import { GhosttyError, UseAfterCloseError } from "./errors";
import { formatterFormatByName, structLayouts } from "./internal/generated";
import { writeStruct } from "./internal/sized-struct";
import { Terminal } from "./terminal";
import type { FormatterOptions } from "./types";

function formatEnum(format: "plain" | "vt" | "html"): number {
  const v = formatterFormatByName[format];
  if (v === null || v === undefined) {
    throw new GhosttyError(
      `No GhosttyFormatterFormat value for "${format}" at the pinned Ghostty commit.`,
      { code: "unknown", functionName: "Formatter.constructor" },
    );
  }
  return v;
}

// API note (Matt decision 3b): we keep the public API as
// `new Formatter(opts)` + `fmt.format(term)` / `fmt.formatString(term)`.
// Internally each call constructs a native formatter via
// ghostty_formatter_terminal_new (bound to a specific Terminal), invokes
// ghostty_formatter_format_alloc, copies the output into JS-owned memory,
// then frees the buffer and the formatter. The slight per-call native alloc
// cost buys us a simpler JS API that doesn't force users to thread a
// Terminal through the constructor. Formatter instances hold no native
// resources between calls; `close()` just flips a closed flag so subsequent
// calls throw UseAfterCloseError (mirroring Terminal's lifecycle contract).
export class Formatter {
  #opts: FormatterOptions;
  #closed = false;

  constructor(opts: FormatterOptions) {
    this.#opts = opts;
    // Validate format enum eagerly so construction errors surface here, not
    // on first format() call.
    formatEnum(opts.format);
  }

  close(): void {
    this.#closed = true;
  }

  [Symbol.dispose](): void {
    this.close();
  }

  format(term: Terminal): Uint8Array {
    this.#assertOpen();
    const lib = getLib();

    // Build GhosttyFormatterTerminalOptions (56 B, sized). The nested `extra`
    // sub-struct (32 B @ offset 16) itself contains a nested `screen`
    // sub-struct (16 B @ offset 16). All three layers are sized; writeStruct
    // auto-fills each `size` field. ABI §7 for authoritative field offsets.
    const outerLayout  = structLayouts["GhosttyFormatterTerminalOptions"];
    const extraLayout  = structLayouts["GhosttyFormatterTerminalExtra"];
    const screenLayout = structLayouts["GhosttyFormatterScreenExtra"];
    if (!outerLayout || !extraLayout || !screenLayout) {
      throw new GhosttyError(
        "generated.ts missing formatter options layouts — rerun gen-bindings",
        { code: "unknown", functionName: "Formatter.format" },
      );
    }

    // camelCase (public JS API) → snake_case (C field names) mapping happens
    // here at the writeStruct boundary.
    const screenBytes = writeStruct(screenLayout, {
      cursor:         this.#opts.cursor         ?? false,
      style:          this.#opts.style          ?? false,
      hyperlink:      this.#opts.hyperlink      ?? false,
      protection:     this.#opts.protection     ?? false,
      kitty_keyboard: this.#opts.kittyKeyboard  ?? false,   // camelCase → snake_case
      charsets:       this.#opts.charsets       ?? false,
    });

    const extraBytes = writeStruct(extraLayout, {
      palette:          this.#opts.palette         ?? false,
      modes:            this.#opts.modes           ?? false,
      scrolling_region: this.#opts.scrollingRegion ?? false,   // camelCase → snake_case
      tabstops:         this.#opts.tabStops        ?? false,   // camelCase → snake_case (no underscore in C either)
      pwd:              this.#opts.pwd             ?? false,
      keyboard:         this.#opts.keyboard        ?? false,
      screen:           screenBytes,
    });

    const optsBytes = writeStruct(outerLayout, {
      emit:      formatEnum(this.#opts.format),
      unwrap:    this.#opts.unwrap ?? false,
      trim:      this.#opts.trim   ?? false,
      extra:     extraBytes,
      selection: 0n,  // null ptr — Pass 1 does not expose selection
    });

    // ghostty_formatter_terminal_new(alloc, &out_fmt, term, &opts_bytes).
    // 56 B options pass via hidden pointer on arm64 AAPCS64. ABI §6.
    const outFmt = new BigUint64Array(1);
    const r1 = lib.symbols.ghostty_formatter_terminal_new(
      null,
      ptr(outFmt),
      term._handle,
      ptr(optsBytes),
    );
    checkResult(r1, "ghostty_formatter_terminal_new");
    const fmtHandle = Number(outFmt[0]!) as Pointer;
    if (!fmtHandle) {
      throw new GhosttyError(
        "ghostty_formatter_terminal_new returned OK but out pointer is null",
        { code: "unknown", functionName: "ghostty_formatter_terminal_new" },
      );
    }

    try {
      const outPtr = new BigUint64Array(1);
      const outLen = new BigUint64Array(1);
      const r2 = lib.symbols.ghostty_formatter_format_alloc(
        fmtHandle,
        null,
        ptr(outPtr),
        ptr(outLen),
      );
      checkResult(r2, "ghostty_formatter_format_alloc");

      const bufPtr = outPtr[0]!;
      const len = Number(outLen[0]!);
      if (bufPtr === 0n || len === 0) return new Uint8Array(0);

      // Copy bytes immediately, then free the native buffer in finally so
      // an exception while copying cannot leak native memory. ghostty_free
      // requires the length (not a libc free — ABI §11).
      try {
        const copy = new Uint8Array(len);
        copy.set(new Uint8Array(toArrayBuffer(Number(bufPtr) as unknown as Pointer, 0, len)));
        return copy;
      } finally {
        lib.symbols.ghostty_free(null, Number(bufPtr), BigInt(len));
      }
    } finally {
      lib.symbols.ghostty_formatter_free(fmtHandle);
    }
  }

  formatString(term: Terminal): string {
    return new TextDecoder("utf-8").decode(this.format(term));
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new UseAfterCloseError("Formatter has been closed", {
        handleType: "Formatter",
      });
    }
  }
}
