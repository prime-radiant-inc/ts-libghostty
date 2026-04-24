import { ptr, type Pointer } from "bun:ffi";
import { getLib } from "./ffi";
import {
  structLayouts,
  GhosttyRenderStateDataValues,
  GhosttyRenderStateDirtyValues,
  GhosttyRenderStateOptionValues,
  GhosttyRenderStateRowDataValues,
} from "./internal/generated";
import { GhosttyError, UseAfterCloseError, getResultCodeName } from "./errors";
import { readRenderStateColors } from "./internal/sized-struct";
import type {
  RGB,
  TerminalColors,
  ViewportCursor,
  CellStyle,
} from "./types";
import type { Terminal } from "./terminal";

type DirtyState = "none" | "rows" | "all";

interface CachedRow {
  y: number;
  wrapped: boolean;
  dirty: boolean;
  cells: CachedCell[];
}

interface CachedCell {
  x: number;
  text: string;
  wide: boolean;
  isWideContinuation: boolean;
  style?: CellStyle;
  hyperlinkUri?: string;
  protected: boolean;
}

/**
 * RenderState — caches the decoded render output of a Terminal at a point in
 * time. Call `update(term)` to snapshot; then read `dirty()`, `markClean()`,
 * `colors()`, `cursor()`. Iterator APIs (rows/cells/forEach*) land in Tasks
 * 11-12.
 *
 * Lifecycle: construct → update → read → (optional) markClean → close.
 * Implements `Symbol.dispose` for `using` declarations.
 */
export class RenderState {
  #handle: Pointer | null = null;
  #rows: CachedRow[] = [];
  #cols = 0;
  #rowCount = 0;
  #globalDirty: DirtyState = "none";
  #viewportCursor: ViewportCursor | undefined = undefined;
  #colors: TerminalColors | undefined = undefined;

  constructor() {
    const lib = getLib();
    const out = new BigUint64Array(1);
    const rc = lib.symbols.ghostty_render_state_new(null, ptr(out));
    if (rc !== 0) {
      throw new GhosttyError(
        `ghostty_render_state_new failed`,
        { code: getResultCodeName(rc), functionName: "ghostty_render_state_new" },
      );
    }
    const handleBig = out[0]!;
    if (handleBig === 0n) {
      throw new GhosttyError(
        "ghostty_render_state_new returned OK but handle is null",
        { code: "out_of_memory", functionName: "ghostty_render_state_new" },
      );
    }
    this.#handle = Number(handleBig) as Pointer;
  }

  /**
   * Snapshot the terminal's current render state into this object.
   * Updates the dirty state, per-row cache, viewport cursor, and lazily
   * invalidates the colors cache.
   */
  update(term: Terminal): void {
    this.#assertOpen();
    const termHandle = term.unsafeHandle();
    const lib = getLib();
    const rc = lib.symbols.ghostty_render_state_update(this.#handle!, termHandle);
    if (rc !== 0) {
      throw new GhosttyError(
        `ghostty_render_state_update failed`,
        { code: getResultCodeName(rc), functionName: "ghostty_render_state_update" },
      );
    }
    this.#rebuildCache(term);
  }

  /**
   * Returns the current global dirty state:
   * - "none"  — nothing has changed since the last markClean
   * - "rows"  — some rows are dirty (PARTIAL)
   * - "all"   — all rows are dirty (FULL)
   *
   * Note: dirty state is read from the JS mirror updated during `update()`.
   * Call `update()` first to refresh it from libghostty.
   */
  dirty(): DirtyState {
    return this.#globalDirty;
  }

  /**
   * Clear dirty state both natively (one call to ghostty_render_state_set
   * with OPTION_DIRTY=FALSE, which clears both global and per-row layers)
   * and in the JS mirror.
   */
  markClean(): void {
    this.#assertOpen();
    const lib = getLib();
    // Write GhosttyRenderStateDirty.FALSE = 0 as a 4-byte LE i32.
    const dirtyValBuf = new Uint8Array(4);
    new DataView(dirtyValBuf.buffer).setInt32(
      0,
      GhosttyRenderStateDirtyValues["GHOSTTY_RENDER_STATE_DIRTY_FALSE"],
      true,
    );
    const rc = lib.symbols.ghostty_render_state_set(
      this.#handle!,
      GhosttyRenderStateOptionValues["GHOSTTY_RENDER_STATE_OPTION_DIRTY"],
      ptr(dirtyValBuf),
    );
    if (rc !== 0) {
      throw new GhosttyError(
        `ghostty_render_state_set(DIRTY) failed`,
        { code: getResultCodeName(rc), functionName: "ghostty_render_state_set" },
      );
    }
    // Mirror the clear into the JS cache.
    this.#globalDirty = "none";
    for (const row of this.#rows) row.dirty = false;
  }

  /**
   * Returns the render-state colors (background, foreground, cursor, palette).
   * Lazily fetched from libghostty on first call after each `update()`.
   * `update()` must be called before `colors()` returns meaningful data.
   */
  colors(): TerminalColors {
    this.#assertOpen();
    if (!this.#colors) this.#readColors();
    return this.#colors!;
  }

  /**
   * Returns the viewport cursor position, or `undefined` if the cursor is not
   * in the viewport after the last `update()`.
   */
  cursor(): ViewportCursor | undefined {
    this.#assertOpen();
    return this.#viewportCursor;
  }

  /**
   * Free the native render state handle. Safe to call multiple times.
   * After close(), all other methods throw UseAfterCloseError.
   */
  close(): void {
    if (this.#handle === null) return;
    const lib = getLib();
    lib.symbols.ghostty_render_state_free(this.#handle);
    this.#handle = null;
    this.#rows = [];
    this.#colors = undefined;
    this.#viewportCursor = undefined;
  }

  [Symbol.dispose](): void {
    this.close();
  }

  // ---- Private helpers -------------------------------------------------------

  #assertOpen(): void {
    if (this.#handle === null) {
      throw new UseAfterCloseError("RenderState has been closed", {
        handleType: "RenderState",
      });
    }
  }

  /**
   * Rebuild the JS-side row/cell cache after update(). Applies the corrected
   * pattern from Task 2 reconciliation:
   * 1. Create empty iterator object via _new.
   * 2. Populate it from the render state via get(ROW_ITERATOR).
   * 3. Create a reusable cells container (one per rebuild).
   * 4. Walk rows via _next, per-row get DIRTY + get CELLS (into cells container).
   *
   * CELLS enum value = 3 (ROW_DATA_CELLS = 3, NOT 2 which is ROW_DATA_RAW).
   */
  #rebuildCache(term: Terminal): void {
    const snap = term.snapshot();
    this.#cols = snap.cols;
    this.#rowCount = snap.rows;
    this.#rows = [];
    this.#readDirtyGlobal();
    this.#readViewportCursor();
    this.#colors = undefined; // lazy re-read on next colors() call

    const lib = getLib();
    const D = GhosttyRenderStateDataValues;
    const R = GhosttyRenderStateRowDataValues;

    // 1. Create empty iterator object.
    const iterOut = new BigUint64Array(1);
    let rc = lib.symbols.ghostty_render_state_row_iterator_new(null, ptr(iterOut));
    if (rc !== 0) {
      throw new GhosttyError(
        "ghostty_render_state_row_iterator_new failed",
        { code: getResultCodeName(rc), functionName: "ghostty_render_state_row_iterator_new" },
      );
    }
    const iter = Number(iterOut[0]) as Pointer;

    // 2. Populate iterator from render state via get(ROW_ITERATOR).
    rc = lib.symbols.ghostty_render_state_get(
      this.#handle!,
      D["GHOSTTY_RENDER_STATE_DATA_ROW_ITERATOR"],
      ptr(iterOut),
    );
    if (rc !== 0) {
      lib.symbols.ghostty_render_state_row_iterator_free(iter);
      throw new GhosttyError(
        "ghostty_render_state_get(ROW_ITERATOR) failed",
        { code: getResultCodeName(rc), functionName: "ghostty_render_state_get" },
      );
    }

    // 3. Create a reusable cells container (one per rebuild; reset per row).
    const cellsOut = new BigUint64Array(1);
    rc = lib.symbols.ghostty_render_state_row_cells_new(null, ptr(cellsOut));
    if (rc !== 0) {
      lib.symbols.ghostty_render_state_row_iterator_free(iter);
      throw new GhosttyError(
        "ghostty_render_state_row_cells_new failed",
        { code: getResultCodeName(rc), functionName: "ghostty_render_state_row_cells_new" },
      );
    }
    const cells = Number(cellsOut[0]) as Pointer;

    try {
      let y = 0;
      while (lib.symbols.ghostty_render_state_row_iterator_next(iter)) {
        // Read per-row dirty flag.
        const dirtyBuf = new Uint8Array(1);
        rc = lib.symbols.ghostty_render_state_row_get(
          iter,
          R["GHOSTTY_RENDER_STATE_ROW_DATA_DIRTY"],
          ptr(dirtyBuf),
        );
        const rowDirty = rc === 0 && dirtyBuf[0] === 1;

        // Populate the cells container from the current row (CELLS = 3, NOT 2).
        rc = lib.symbols.ghostty_render_state_row_get(
          iter,
          R["GHOSTTY_RENDER_STATE_ROW_DATA_CELLS"],
          ptr(cellsOut),
        );
        const rowCells = rc === 0 ? this.#walkCells(cells) : [];

        this.#rows.push({
          y,
          wrapped: false, // Task 11 extends RAW-row decode to populate wrap state
          dirty: rowDirty,
          cells: rowCells,
        });
        y++;
      }
    } finally {
      lib.symbols.ghostty_render_state_row_cells_free(cells);
      lib.symbols.ghostty_render_state_row_iterator_free(iter);
    }
  }

  /**
   * Walk the reusable cells container for the current row. Task 10 stub:
   * returns an empty array. Task 11 replaces this with full cell decoding
   * (text, style, wide, isWideContinuation, hyperlinkUri).
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  #walkCells(_cells: Pointer): CachedCell[] {
    return [];
  }

  /** Read the global dirty state from libghostty and update #globalDirty. */
  #readDirtyGlobal(): void {
    const lib = getLib();
    const buf = new Uint8Array(4);
    const rc = lib.symbols.ghostty_render_state_get(
      this.#handle!,
      GhosttyRenderStateDataValues["GHOSTTY_RENDER_STATE_DATA_DIRTY"],
      ptr(buf),
    );
    if (rc !== 0) {
      this.#globalDirty = "none";
      return;
    }
    const v = new DataView(buf.buffer).getInt32(0, true);
    const E = GhosttyRenderStateDirtyValues;
    if (v === E["GHOSTTY_RENDER_STATE_DIRTY_FULL"]) this.#globalDirty = "all";
    else if (v === E["GHOSTTY_RENDER_STATE_DIRTY_PARTIAL"]) this.#globalDirty = "rows";
    else this.#globalDirty = "none";
  }

  /** Read viewport cursor position from libghostty. */
  #readViewportCursor(): void {
    const lib = getLib();
    const D = GhosttyRenderStateDataValues;

    const hasBuf = new Uint8Array(1);
    let rc = lib.symbols.ghostty_render_state_get(
      this.#handle!,
      D["GHOSTTY_RENDER_STATE_DATA_CURSOR_VIEWPORT_HAS_VALUE"],
      ptr(hasBuf),
    );
    if (rc !== 0 || hasBuf[0] !== 1) {
      this.#viewportCursor = undefined;
      return;
    }

    const u16Buf = new Uint8Array(2);
    const boolBuf = new Uint8Array(1);

    lib.symbols.ghostty_render_state_get(
      this.#handle!,
      D["GHOSTTY_RENDER_STATE_DATA_CURSOR_VIEWPORT_X"],
      ptr(u16Buf),
    );
    const x = new DataView(u16Buf.buffer).getUint16(0, true);

    lib.symbols.ghostty_render_state_get(
      this.#handle!,
      D["GHOSTTY_RENDER_STATE_DATA_CURSOR_VIEWPORT_Y"],
      ptr(u16Buf),
    );
    const y = new DataView(u16Buf.buffer).getUint16(0, true);

    rc = lib.symbols.ghostty_render_state_get(
      this.#handle!,
      D["GHOSTTY_RENDER_STATE_DATA_CURSOR_VIEWPORT_WIDE_TAIL"],
      ptr(boolBuf),
    );
    const wideTail = rc === 0 && boolBuf[0] === 1;

    this.#viewportCursor = { x, y, visible: true, wideTail };
  }

  /**
   * Read colors from libghostty via ghostty_render_state_colors_get.
   * Requires Task 3 to have run so structLayouts["GhosttyRenderStateColors"]
   * is populated; throws a clear error if it's missing (pre-Task-3 state).
   */
  #readColors(): void {
    const layout = structLayouts["GhosttyRenderStateColors"];
    if (!layout) {
      throw new GhosttyError(
        "structLayouts[\"GhosttyRenderStateColors\"] is not available — " +
        "run `bun run verify:generated` (Task 3) to populate it",
        { code: "unknown", functionName: "RenderState.colors" },
      );
    }
    const lib = getLib();
    const buf = new Uint8Array(layout.size);
    // Write size prefix (GhosttyRenderStateColors is a sized struct).
    new DataView(buf.buffer).setBigUint64(
      layout.fields.size?.offset ?? 0,
      BigInt(layout.size),
      true,
    );
    const rc = lib.symbols.ghostty_render_state_colors_get(this.#handle!, ptr(buf));
    if (rc !== 0) {
      throw new GhosttyError(
        "ghostty_render_state_colors_get failed",
        { code: getResultCodeName(rc), functionName: "ghostty_render_state_colors_get" },
      );
    }
    const raw = readRenderStateColors(buf);
    // exactOptionalPropertyTypes: build optional-property objects conditionally
    // rather than assigning `prop: undefined` directly.
    const effective: { fg: RGB; bg: RGB; cursor?: RGB } = {
      fg: raw.foreground,
      bg: raw.background,
    };
    if (raw.cursorHasValue) effective.cursor = raw.cursor;
    this.#colors = {
      effective,
      // Render-state's colors struct carries post-OSC effective values only;
      // defaults (pre-OSC) live on Terminal.colors() (Task 6). Stubs here.
      defaults: {},
      palette: raw.palette,
    };
  }

  // Tasks 11-12 add rows(), row.cells(), forEachDirtyRow, forEachCell,
  // forEachDirtyCell. The #rows cache is already built in #rebuildCache.
}
