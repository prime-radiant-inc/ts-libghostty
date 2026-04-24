import { dlopen, FFIType, ptr, toArrayBuffer } from "bun:ffi";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { LibraryCompatibilityError, LibraryNotFoundError } from "./errors";
import { resolveLibraryPath } from "./internal/path";
import {
  declaredHeaderSymbols,
  EXPECTED_LIBRARY_VERSION,
  pinnedCommit,
} from "./internal/generated";

// ---- Symbol declarations ---------------------------------------------------
// Every symbol the binding dlopens is declared here with its bun:ffi signature.
// `requiredSymbols` (exported below) mirrors the keys of this object and is
// what Task 18's ABI smoke asserts against declaredHeaderSymbols.
//
// Signatures are taken from docs/abi/2026-04-22-abi-discovery.md §4, §6.
// If any disagrees with the pinned header, update the discovery doc, this
// table, and the probe in Task 4 together — not independently.

const SYMBOLS = {
  // GhosttyTerminalOptions (16 B) is passed by value. bun:ffi has no struct-
  // by-value, so on darwin-arm64 we split it into two u64s per AAPCS64 register
  // rules. Returns GhosttyResult (signed i32). See ABI discovery §4 + §12
  // Surprise 5.
  ghostty_terminal_new: {
    args: [FFIType.ptr, FFIType.ptr, FFIType.u64, FFIType.u64],  // (alloc, &out, opts_lo, opts_hi)
    returns: FFIType.i32,
  },
  ghostty_terminal_free: {
    args: [FFIType.ptr],
    returns: FFIType.void,
  },
  // Returns void (documented to never fail — ABI §4).
  ghostty_terminal_vt_write: {
    args: [FFIType.ptr, FFIType.ptr, FFIType.u64],   // (term, bytes, len)
    returns: FFIType.void,
  },
  // Returns void.
  ghostty_terminal_reset: {
    args: [FFIType.ptr],
    returns: FFIType.void,
  },
  // 5 args: (term, cols:u16, rows:u16, cell_width_px:u32, cell_height_px:u32).
  ghostty_terminal_resize: {
    args: [FFIType.ptr, FFIType.u16, FFIType.u16, FFIType.u32, FFIType.u32],
    returns: FFIType.i32,
  },
  // bool is an out-param (ptr), not the return. Returns GhosttyResult.
  ghostty_terminal_mode_get: {
    args: [FFIType.ptr, FFIType.u16, FFIType.ptr],   // (term, mode_tag, &out_bool)
    returns: FFIType.i32,
  },
  ghostty_terminal_mode_set: {
    args: [FFIType.ptr, FFIType.u16, FFIType.bool],  // (term, mode_tag, value)
    returns: FFIType.i32,
  },
  // (term, count, keys_ptr, values_ptr_array, out_written_ptr)
  ghostty_terminal_get_multi: {
    args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.ptr, FFIType.ptr],
    returns: FFIType.i32,
  },
  // ghostty_terminal_set wires callbacks (WRITE_PTY, BELL, TITLE_CHANGED, ...)
  // and non-callback options. For callback options the value is a function
  // pointer; passing NULL clears the option. Signature per ABI §4.
  ghostty_terminal_set: {
    args: [FFIType.ptr, FFIType.i32, FFIType.ptr],  // (term, opt:c_int, value:void*)
    returns: FFIType.i32,
  },
  // ghostty_terminal_get reads a single terminal data key. Pass 2 uses it
  // from the title_changed trampoline to read the fresh title. For the title
  // key the out buffer must be a caller-allocated 16-byte GhosttyString slot.
  ghostty_terminal_get: {
    args: [FFIType.ptr, FFIType.i32, FFIType.ptr],  // (term, data:c_int, out*)
    returns: FFIType.i32,
  },
  // --- Pass 3 additions -----------------------------------------------------------
  // Render state lifecycle + update + dirty + colors
  ghostty_render_state_new: {
    args: [FFIType.ptr, FFIType.ptr],   // (allocator|null, &out_handle)
    returns: FFIType.i32,
  },
  ghostty_render_state_free: {
    args: [FFIType.ptr],                // (handle)
    returns: FFIType.void,
  },
  ghostty_render_state_update: {
    args: [FFIType.ptr, FFIType.ptr],   // (state, terminal)
    returns: FFIType.i32,
  },
  ghostty_render_state_set: {
    args: [FFIType.ptr, FFIType.i32, FFIType.ptr],  // (state, option, &value)
    returns: FFIType.i32,
  },
  ghostty_render_state_get: {
    args: [FFIType.ptr, FFIType.i32, FFIType.ptr],  // (state, data, &out)
    returns: FFIType.i32,
  },
  ghostty_render_state_colors_get: {
    args: [FFIType.ptr, FFIType.ptr],   // (state, &out_colors)
    returns: FFIType.i32,
  },
  // Render-state row iterator
  ghostty_render_state_row_iterator_new: {
    args: [FFIType.ptr, FFIType.ptr],   // (allocator|null, &out_iterator)
    returns: FFIType.i32,
  },
  ghostty_render_state_row_iterator_next: {
    args: [FFIType.ptr],                // (iterator)
    returns: FFIType.bool,
  },
  ghostty_render_state_row_iterator_free: {
    args: [FFIType.ptr],                // (iterator)
    returns: FFIType.void,
  },
  ghostty_render_state_row_get: {
    args: [FFIType.ptr, FFIType.i32, FFIType.ptr],  // (iterator, data, &out)
    returns: FFIType.i32,
  },
  // Render-state cell iterator (per-row)
  ghostty_render_state_row_cells_new: {
    args: [FFIType.ptr, FFIType.ptr],   // (allocator|null, &out_cells)
    returns: FFIType.i32,
  },
  ghostty_render_state_row_cells_next: {
    args: [FFIType.ptr],                // (cells)
    returns: FFIType.bool,
  },
  ghostty_render_state_row_cells_select: {
    args: [FFIType.ptr, FFIType.u16],   // (cells, x)
    returns: FFIType.i32,
  },
  ghostty_render_state_row_cells_get: {
    args: [FFIType.ptr, FFIType.i32, FFIType.ptr],  // (cells, data, &out)
    returns: FFIType.i32,
  },
  ghostty_render_state_row_cells_free: {
    args: [FFIType.ptr],                // (cells)
    returns: FFIType.void,
  },
  // Grid ref accessors (Terminal.cellAt + RenderState decode)
  // ghostty_terminal_grid_ref: GhosttyPoint (24 B, > 16 B) is passed via
  // hidden pointer per AAPCS64. We pass ptr to the marshaled point bytes.
  ghostty_terminal_grid_ref: {
    args: [FFIType.ptr, FFIType.ptr, FFIType.ptr],  // (terminal, &point, &out_ref)
    returns: FFIType.i32,
  },
  ghostty_grid_ref_cell: {
    args: [FFIType.ptr, FFIType.ptr],   // (&ref, &out_cell)
    returns: FFIType.i32,
  },
  ghostty_grid_ref_row: {
    args: [FFIType.ptr, FFIType.ptr],   // (&ref, &out_row)
    returns: FFIType.i32,
  },
  ghostty_grid_ref_graphemes: {
    args: [FFIType.ptr, FFIType.ptr, FFIType.u64, FFIType.ptr],  // (&ref, buf|null, buf_len, &out_len)
    returns: FFIType.i32,
  },
  ghostty_grid_ref_hyperlink_uri: {
    args: [FFIType.ptr, FFIType.ptr, FFIType.u64, FFIType.ptr],  // (&ref, buf|null, buf_len, &out_len)
    returns: FFIType.i32,
  },
  ghostty_grid_ref_style: {
    args: [FFIType.ptr, FFIType.ptr],   // (&ref, &out_style)
    returns: FFIType.i32,
  },
  // Focus encode (probe-size-first pattern)
  ghostty_focus_encode: {
    args: [FFIType.i32, FFIType.ptr, FFIType.u64, FFIType.ptr],  // (event, buf|null, buf_len, &out_written)
    returns: FFIType.i32,
  },
  // Terminal scroll viewport: GhosttyTerminalScrollViewport (24 B > 16 B) is
  // passed via hidden pointer per AAPCS64. We pass ptr to the marshaled bytes.
  ghostty_terminal_scroll_viewport: {
    args: [FFIType.ptr, FFIType.ptr],   // (terminal, &behavior)
    returns: FFIType.void,
  },
  // --- End Pass 3 additions ---------------------------------------------------

  // GhosttyFormatterTerminalOptions (56 B) is passed via hidden pointer on
  // arm64 AAPCS64 (structs > 16 B are passed indirectly). We declare it as
  // FFIType.ptr and pass a pointer to the options bytes.
  ghostty_formatter_terminal_new: {
    args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr],  // (alloc, &out_fmt, term, &options)
    returns: FFIType.i32,
  },
  ghostty_formatter_free: {
    args: [FFIType.ptr],
    returns: FFIType.void,
  },
  ghostty_formatter_format_alloc: {
    args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr],  // (fmt, alloc, &out_ptr, &out_len)
    returns: FFIType.i32,
  },
  ghostty_alloc: {
    args: [FFIType.ptr, FFIType.u64],
    returns: FFIType.ptr,
  },
  // ghostty_free requires length — NOT a libc-style free. See ABI §11.
  ghostty_free: {
    args: [FFIType.ptr, FFIType.ptr, FFIType.u64],   // (allocator_or_null, ptr, len)
    returns: FFIType.void,
  },
  // Build identity. data is a GhosttyBuildInfo enum (c_int); out is typed per
  // the enum value (we use VERSION_STRING=5 → GhosttyString*). ABI §2.
  ghostty_build_info: {
    args: [FFIType.i32, FFIType.ptr],
    returns: FFIType.i32,
  },
  // Runtime struct-layout introspection — returns a null-terminated JSON
  // string describing every C-API struct's layout. Used by Task 18's ABI
  // smoke test to cross-check `structLayouts`. ABI §2 / §12 Surprise 15.
  ghostty_type_json: {
    args: [],
    returns: FFIType.cstring,
  },
} as const;

type Symbols = typeof SYMBOLS;
type DlopenResult = {
  symbols: { [K in keyof Symbols]: (...args: any[]) => any };
  close: () => void;
};

/** The exact list of symbols this binding dlopens. Exported so Task 18 can assert
 *  requiredSymbols ⊆ declaredHeaderSymbols without duplicating the list. */
export const requiredSymbols = Object.keys(SYMBOLS) as readonly (keyof Symbols)[];

// ---- State -----------------------------------------------------------------

let overridePath: string | undefined;
let loaded: DlopenResult | null = null;
let loadedPath: string | null = null;
let loadedIdentity: string | null = null;   // actual build identity if exposed by C

// ---- Public API ------------------------------------------------------------

/** Override the library path. Must be called before first native use. */
export function setLibraryPath(path: string): void {
  if (loaded) {
    throw new LibraryCompatibilityError(
      `setLibraryPath called after library already loaded from ${loadedPath}`,
      {
        details: `already loaded from ${loadedPath}`,
        expectedCommit: pinnedCommit,
      },
    );
  }
  overridePath = path;
}

/** Whether the library has been opened. Does not trigger load. */
export function isLoaded(): boolean {
  return loaded !== null;
}

export interface LibraryInfo {
  loaded: boolean;
  path: string | null;
  pinnedCommit: string;
  /**
   * The loaded library's own build identity (commit/version) if upstream
   * exposes it via C. `null` when not loaded or when upstream does not
   * expose identity at this pin — in which case compatibility verification
   * is limited to symbol + struct layout matching.
   */
  actualIdentity: string | null;
}

/** Cheap diagnostics — does not trigger load. */
export function libraryInfo(): LibraryInfo {
  return {
    loaded: loaded !== null,
    path: loadedPath,
    pinnedCommit,
    actualIdentity: loadedIdentity,
  };
}

/**
 * Get (and lazily load) the symbol table. First call resolves the library
 * path, opens it via dlopen declaring requiredSymbols, verifies every one
 * resolves, and (if upstream exposes build_info) verifies identity matches
 * the pinned commit.
 */
export function getLib(): DlopenResult {
  if (loaded) return loaded;

  const packageRoot = resolvePackageRoot();
  const path = resolveLibraryPath({
    override: overridePath,
    env: process.env["GHOSTTY_VT_LIB"],
    packageRoot,
  });
  // resolveLibraryPath already threw LibraryNotFoundError / UnsupportedPlatformError
  // if the file is missing; we need not re-check existsSync here.

  let opened: DlopenResult;
  try {
    opened = dlopen(path, SYMBOLS) as DlopenResult;
  } catch (e) {
    const msg = (e as Error).message ?? String(e);
    throw new LibraryCompatibilityError(
      `Failed to open ${path}: ${msg}`,
      {
        details: msg,
        expectedCommit: pinnedCommit,
        cause: e,
      },
    );
  }

  // Verify every required symbol is present. bun:ffi's dlopen can silently
  // produce null function pointers for absent symbols on some platforms;
  // this loop gives us a clear error pointing at the specific symbol.
  const missing: string[] = [];
  for (const name of requiredSymbols) {
    if (typeof (opened.symbols as any)[name] !== "function") missing.push(name as string);
  }
  if (missing.length > 0) {
    opened.close();
    throw new LibraryCompatibilityError(
      `Library at ${path} is missing ${missing.length} required symbols`,
      {
        details: `missing: ${missing.slice(0, 10).join(", ")}${missing.length > 10 ? ", ..." : ""}`,
        expectedCommit: pinnedCommit,
      },
    );
  }

  // Build-identity check. ABI discovery §2 confirms `ghostty_build_info(data,
  // out)` is available at this pin and returns a semver string (e.g.
  // "0.1.0-dev") via `GHOSTTY_BUILD_INFO_VERSION_STRING=5`. This is NOT a git
  // commit SHA — upstream does not expose one — so this is a weaker check
  // than cryptographic commit verification. The Task 21 README narrows the
  // compatibility claim accordingly.
  //
  // The pinned expected value is captured in generated.ts as
  // EXPECTED_LIBRARY_VERSION; mismatch → LibraryCompatibilityError.
  //
  //   GhosttyString layout (ABI §2/§9): { uint8_t *ptr @ 0; size_t len @ 8 }
  //   Total 16 bytes. The ptr aliases into library-owned static storage;
  //   we decode as UTF-8 and copy into a JS string.
  const GHOSTTY_BUILD_INFO_VERSION_STRING = 5;
  const stringOut = new ArrayBuffer(16);
  const infoResult = (opened.symbols.ghostty_build_info as any)(
    GHOSTTY_BUILD_INFO_VERSION_STRING,
    ptr(new Uint8Array(stringOut)),
  );
  if (infoResult !== 0) {
    opened.close();
    throw new LibraryCompatibilityError(
      `ghostty_build_info(VERSION_STRING) failed with code ${infoResult}`,
      { details: `build_info result ${infoResult}`, expectedCommit: pinnedCommit },
    );
  }
  const sView = new DataView(stringOut);
  const sPtr = Number(sView.getBigUint64(0, true));
  const sLen = Number(sView.getBigUint64(8, true));
  if (sPtr === 0 || sLen === 0) {
    loadedIdentity = "";
  } else {
    const bytes = new Uint8Array(toArrayBuffer(sPtr as any, 0, sLen));
    loadedIdentity = new TextDecoder("utf-8").decode(bytes);
  }

  if (loadedIdentity !== EXPECTED_LIBRARY_VERSION) {
    opened.close();
    throw new LibraryCompatibilityError(
      `libghostty-vt version "${loadedIdentity}" does not match expected "${EXPECTED_LIBRARY_VERSION}"`,
      {
        details: `version mismatch: got "${loadedIdentity}", expected "${EXPECTED_LIBRARY_VERSION}"`,
        expectedCommit: pinnedCommit,
      },
    );
  }

  loaded = opened;
  loadedPath = path;
  return loaded;
}

/**
 * @internal test-only hook to simulate fresh process state.
 * WARNING: tests must not call _resetForTest while a Terminal or Formatter
 * handle is open — their #handle pointers become dangling when the dylib
 * is unloaded.
 */
export function _resetForTest(): void {
  if (loaded) loaded.close();
  loaded = null;
  loadedPath = null;
  loadedIdentity = null;
  overridePath = undefined;
}

// ---- Helpers ---------------------------------------------------------------

function resolvePackageRoot(): string {
  // This file is at src/ffi.ts in dev, dist/ffi.js in production.
  // In both cases, package root is two levels up from this file's directory.
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..");
}
