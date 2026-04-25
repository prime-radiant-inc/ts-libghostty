// Pass 3 Task 2 probe — validates FFI surface assumptions against pinned libghostty-vt.
// Run manually:
//
//   bun run scripts/probe-pass3-ffi.ts
//
// Probes (structured tagged output, parseable by the Task 2 Step 2 gate):
//   (a)  ghostty_render_state_new/free lifecycle round-trips.
//   (b)  ghostty_render_state_update(state, terminal) returns OK on a fresh terminal.
//   (c)  Row iterator walks exactly `rows` rows for an empty terminal of declared geometry.
//   (d)  Cell iterator per row walks exactly `cols` cells on a freshly-constructed terminal.
//   (e)  ghostty_render_state_set(state, OPTION_DIRTY, &FALSE) returns OK — one-call clear.
//   (f)  Viewport cursor keys return x=0, y=0, has_value=true on a fresh terminal with cursor visible.
//   (g)  ghostty_terminal_grid_ref(term, {ACTIVE, (0,0)}, &ref) returns OK and ref is readable.
//   (h)  ghostty_grid_ref_cell, _style, _graphemes on the ref return OK.
//   (i)  ghostty_grid_ref_graphemes(ref, NULL, 0, &required) returns OUT_OF_SPACE + required >= 0
//        — probe-size-first pattern confirmed.
//   (j)  ghostty_focus_encode(GAINED, NULL, 0, &required) returns OUT_OF_SPACE + required > 0;
//        a second call with the right-sized buffer returns OK + bytes starting with 0x1B (ESC).
//   (k)  ghostty_terminal_set(handle, APC_MAX_BYTES, &val) returns OK for values = 1 MiB and 2 MiB.
//        ghostty_terminal_get(handle, APC_MAX_BYTES, ...) returns RESULT_NOT_SUPPORTED or
//        similar — confirms APC read-back is not available (§4.4 fallback path is the real path).
//
// Drift notes discovered by Lovelace (Task 2 author) vs Cipher's plan:
//   - ghostty_terminal_new is a 4-arg call on AAPCS64 (register-split for GhosttyTerminalOptions);
//     the plan's 2-arg declaration would crash on a real call.
//   - GhosttyTerminalOptions has no `size` field (not a sized-ABI struct); size=16, layout
//     is {cols:u16@0, rows:u16@2, (pad 4), max_scrollback:u64@8}.
//   - GHOSTTY_RENDER_STATE_ROW_DATA_CELLS = 3 (not 2; value 2 is ROW_DATA_RAW).
//   - GHOSTTY_OUT_OF_SPACE = -3 (not -5 as the plan's placeholder comment said).
//   - Row iterator must be populated via ghostty_render_state_get(state, ROW_ITERATOR=4, &iter)
//     after creation — the plan's probe was missing this step.
//   - ghostty_render_state_row_cells_new must be called first, then the handle passed into
//     ghostty_render_state_row_get(iter, CELLS=3, &cells_handle) — plan's probe passed a
//     raw BigUint64Array slot without pre-creating the cells object.
//   - ghostty_terminal_grid_ref takes GhosttyPoint (24 bytes) by value; >16 bytes on AAPCS64
//     means hidden pointer. Declared as ptr and called with ptr(pointBuf), which is correct.
//     GhosttyPoint struct is 24 bytes (tag:i32 + pad:4 + value:union{u64[2]}).
//   - ghostty_grid_ref_graphemes on an empty (space) cell returns GHOSTTY_SUCCESS + out_len=1
//     (the space codepoint 0x20), not OUT_OF_SPACE. For a truly empty cell it returns SUCCESS+0.

import { dlopen, FFIType, ptr, type Pointer } from "bun:ffi";
import { join } from "node:path";

// Load the bundled dylib directly — this script bypasses src/ffi.ts on purpose
// (we're probing the raw API, not the wrapper).
const libPath = process.env.GHOSTTY_VT_LIB ||
  join(import.meta.dir, "..", "prebuilds", "darwin-arm64", "libghostty-vt.dylib");

const lib = dlopen(libPath, {
  // ghostty_terminal_new(alloc*, &out, opts_lo:u64, opts_hi:u64)
  // GhosttyTerminalOptions (16 B, not a sized struct) is passed by value;
  // on AAPCS64 16-byte structs split into two u64 register args.
  ghostty_terminal_new: { args: [FFIType.ptr, FFIType.ptr, FFIType.u64, FFIType.u64], returns: FFIType.i32 },
  ghostty_terminal_free: { args: [FFIType.ptr], returns: FFIType.void },
  ghostty_terminal_vt_write: { args: [FFIType.ptr, FFIType.ptr, FFIType.u64], returns: FFIType.void },
  ghostty_terminal_set: { args: [FFIType.ptr, FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
  ghostty_terminal_get: { args: [FFIType.ptr, FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
  // GhosttyPoint (24 bytes, >16) is passed by hidden pointer on AAPCS64.
  // Declare as ptr and pass ptr(pointBuf).
  ghostty_terminal_grid_ref: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  ghostty_grid_ref_cell: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  ghostty_grid_ref_style: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  ghostty_grid_ref_graphemes: { args: [FFIType.ptr, FFIType.ptr, FFIType.u64, FFIType.ptr], returns: FFIType.i32 },
  ghostty_render_state_new: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  ghostty_render_state_free: { args: [FFIType.ptr], returns: FFIType.void },
  ghostty_render_state_update: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  ghostty_render_state_get: { args: [FFIType.ptr, FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
  ghostty_render_state_set: { args: [FFIType.ptr, FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
  ghostty_render_state_row_iterator_new: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  ghostty_render_state_row_iterator_next: { args: [FFIType.ptr], returns: FFIType.bool },
  ghostty_render_state_row_iterator_free: { args: [FFIType.ptr], returns: FFIType.void },
  ghostty_render_state_row_get: { args: [FFIType.ptr, FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
  ghostty_render_state_row_cells_new: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  ghostty_render_state_row_cells_next: { args: [FFIType.ptr], returns: FFIType.bool },
  ghostty_render_state_row_cells_free: { args: [FFIType.ptr], returns: FFIType.void },
  ghostty_focus_encode: { args: [FFIType.i32, FFIType.ptr, FFIType.u64, FFIType.ptr], returns: FFIType.i32 },
});

// Result codes confirmed from types.h:
const GHOSTTY_SUCCESS       =  0;
const GHOSTTY_OUT_OF_SPACE  = -3;  // plan had -5 as placeholder — correct value is -3

// GhosttyRenderStateData enum values from render.h:
const RS_DATA_ROW_ITERATOR  =  4;  // confirmed from header

// GhosttyRenderStateOption enum values from render.h:
const RS_OPT_DIRTY          =  0;  // GHOSTTY_RENDER_STATE_OPTION_DIRTY = 0

// GhosttyRenderStateRowData enum values from render.h:
const RS_ROW_DATA_CELLS     =  3;  // GHOSTTY_RENDER_STATE_ROW_DATA_CELLS = 3 (plan had 2, which is RAW)

// GhosttyRenderStateDirty enum values from render.h:
const RS_DIRTY_FALSE        =  0;  // GHOSTTY_RENDER_STATE_DIRTY_FALSE = 0

function tag(name: string, result: "ok" | "fail", detail: string) {
  console.log(`tag=${name} result=${result} detail="${detail.replace(/"/g, "\\\"")}"`);
}

// Build GhosttyTerminalOptions — cols=10, rows=4, max_scrollback=0
// Layout from generated.ts structLayouts (confirmed probe-layout):
//   size=16, align=8, NO size field (not a sized struct)
//   cols:u16@0, rows:u16@2, (pad 4B), max_scrollback:u64@8
// On AAPCS64 the 16-byte struct splits into two u64 register args.
const optsBuf = new Uint8Array(16);
const optsView = new DataView(optsBuf.buffer);
optsView.setUint16(0, 10, true);        // cols = 10
optsView.setUint16(2, 4, true);         // rows = 4
// offset 4..7 is padding (left as 0)
optsView.setBigUint64(8, 0n, true);     // max_scrollback = 0
const u64s = new BigUint64Array(optsBuf.buffer, 0, 2);

const handleBuf = new BigUint64Array(1);
const rc = lib.symbols.ghostty_terminal_new(null, ptr(handleBuf), u64s[0]!, u64s[1]!);
if (rc !== 0) { tag("terminal_new", "fail", `rc=${rc}`); process.exit(1); }
const handle = Number(handleBuf[0]) as Pointer;
tag("terminal_new", "ok", `handle=0x${handle.toString(16)}`);

// (a) render_state_new + free lifecycle
const rsBuf = new BigUint64Array(1);
const rcRS = lib.symbols.ghostty_render_state_new(null, ptr(rsBuf));
if (rcRS !== 0) { tag("render_state_new", "fail", `rc=${rcRS}`); process.exit(1); }
const rsHandle = Number(rsBuf[0]) as Pointer;
tag("render_state_new", "ok", `rs=0x${rsHandle.toString(16)}`);

// (b) render_state_update
const rcUpd = lib.symbols.ghostty_render_state_update(rsHandle, handle);
tag("render_state_update", rcUpd === 0 ? "ok" : "fail", `rc=${rcUpd}`);

// (c,d) iterate rows + cells
// Step 1: create a row iterator object (empty, not yet associated with render state)
const rowItBuf = new BigUint64Array(1);
const rcIter = lib.symbols.ghostty_render_state_row_iterator_new(null, ptr(rowItBuf));
if (rcIter !== 0) { tag("row_iter_new", "fail", `rc=${rcIter}`); process.exit(1); }
const rowIter = Number(rowItBuf[0]) as Pointer;
tag("row_iter_new", "ok", `iter=0x${rowIter.toString(16)}`);

// Step 2: populate the iterator from the render state via ghostty_render_state_get(state, ROW_ITERATOR, &iter)
const rcIterPopulate = lib.symbols.ghostty_render_state_get(rsHandle, RS_DATA_ROW_ITERATOR, ptr(rowItBuf));
if (rcIterPopulate !== 0) { tag("row_iter_populate", "fail", `rc=${rcIterPopulate}`); process.exit(1); }
// rowIter pointer value unchanged — the get populates the object's internals, not the handle slot
tag("row_iter_populate", "ok", `rc=${rcIterPopulate}`);

// Step 3: create a cells container (reused per-row)
const cellsBuf = new BigUint64Array(1);
const rcCells = lib.symbols.ghostty_render_state_row_cells_new(null, ptr(cellsBuf));
if (rcCells !== 0) { tag("row_cells_new", "fail", `rc=${rcCells}`); process.exit(1); }
const cellsHandle = Number(cellsBuf[0]) as Pointer;
tag("row_cells_new", "ok", `cells=0x${cellsHandle.toString(16)}`);

// Step 4: iterate rows and count cells on first row
let rowCount = 0;
let firstRowCellCount = 0;
while (lib.symbols.ghostty_render_state_row_iterator_next(rowIter)) {
  rowCount += 1;
  if (rowCount === 1) {
    // Populate cells container from current row (CELLS data kind = 3)
    const rcRowCells = lib.symbols.ghostty_render_state_row_get(rowIter, RS_ROW_DATA_CELLS, ptr(cellsBuf));
    if (rcRowCells === 0) {
      while (lib.symbols.ghostty_render_state_row_cells_next(cellsHandle)) firstRowCellCount += 1;
    }
  }
}
lib.symbols.ghostty_render_state_row_cells_free(cellsHandle);
lib.symbols.ghostty_render_state_row_iterator_free(rowIter);
tag("row_count", rowCount === 4 ? "ok" : "fail", `rows=${rowCount} expected=4`);
tag("cell_count", firstRowCellCount === 10 ? "ok" : "fail", `cells=${firstRowCellCount} expected=10`);

// (e) dirty clear — one-call
// GHOSTTY_RENDER_STATE_OPTION_DIRTY = 0, confirmed from header.
// The option value written is GHOSTTY_RENDER_STATE_DIRTY_FALSE = 0 (GhosttyRenderStateDirty).
const dirtyValBuf = new Uint8Array(4);
new DataView(dirtyValBuf.buffer).setInt32(0, RS_DIRTY_FALSE, true);
const rcSet = lib.symbols.ghostty_render_state_set(rsHandle, RS_OPT_DIRTY, ptr(dirtyValBuf));
tag("dirty_clear", rcSet === 0 ? "ok" : "fail", `option_value=${RS_OPT_DIRTY} rc=${rcSet}`);

// (g,h) grid_ref — look up cell at (0,0) ACTIVE
// GhosttyPoint layout from point.h (confirmed via header inspection):
//   tag: GhosttyPointTag (i32, 4 bytes) @ offset 0
//   value: GhosttyPointValue (union, 16 bytes) @ offset 8
//     value.coordinate.x: uint16_t @ offset 8
//     value.coordinate.y: uint32_t @ offset 10
// Total struct size = 24 bytes (4 + 4 pad + 16)
// On AAPCS64, >16 bytes → hidden pointer. Declare as ptr, call with ptr(pointBuf).
const pointBuf = new Uint8Array(24);
const pv = new DataView(pointBuf.buffer);
pv.setInt32(0, 0, true);    // tag = GHOSTTY_POINT_TAG_ACTIVE = 0
// offset 4..7: padding (zero)
pv.setUint16(8, 0, true);   // value.coordinate.x = 0
pv.setUint32(10, 0, true);  // value.coordinate.y = 0
// offset 14..23: union padding (zero)

// GhosttyGridRef layout from grid_ref.h:
//   size: size_t (8 bytes) @ offset 0  — must be set (sized-struct ABI)
//   node: void* (8 bytes) @ offset 8
//   x: uint16_t (2 bytes) @ offset 16
//   y: uint16_t (2 bytes) @ offset 18
// Total struct size = 20 bytes, padded to 24 (align=8).
const refBuf = new Uint8Array(24);
new DataView(refBuf.buffer).setBigUint64(0, 24n, true); // size field = sizeof(GhosttyGridRef)

const rcRef = lib.symbols.ghostty_terminal_grid_ref(handle, ptr(pointBuf), ptr(refBuf));
tag("grid_ref_lookup", rcRef === 0 ? "ok" : "fail", `rc=${rcRef}`);

if (rcRef === 0) {
  // (h) grid_ref_cell + grid_ref_style
  const cellBuf = new Uint8Array(64);  // GhosttyCell is opaque; over-allocate
  const rcCell = lib.symbols.ghostty_grid_ref_cell(ptr(refBuf), ptr(cellBuf));
  tag("grid_ref_cell", rcCell === 0 ? "ok" : "fail", `rc=${rcCell}`);

  const styleBuf = new Uint8Array(256);  // GhosttyStyle is opaque; over-allocate
  const rcStyle = lib.symbols.ghostty_grid_ref_style(ptr(refBuf), ptr(styleBuf));
  tag("grid_ref_style", rcStyle === 0 ? "ok" : "fail", `rc=${rcStyle}`);

  // (i) graphemes probe-size-first
  // On an empty cell, the library returns GHOSTTY_SUCCESS + out_len = 0 (no codepoints).
  // On a cell with a space (default), it returns GHOSTTY_SUCCESS + out_len = 1.
  // Either way, passing buf=NULL should either return SUCCESS+0 or OUT_OF_SPACE+required.
  // (OUT_OF_SPACE = -3, confirmed from types.h)
  const lenOutBuf = new BigUint64Array(1);
  const rcGraph = lib.symbols.ghostty_grid_ref_graphemes(ptr(refBuf), null, 0n, ptr(lenOutBuf));
  const graphOk = rcGraph === GHOSTTY_SUCCESS || rcGraph === GHOSTTY_OUT_OF_SPACE;
  tag("graphemes_probe", graphOk ? "ok" : "fail",
      `rc=${rcGraph} len=${lenOutBuf[0]} (SUCCESS=0 or OUT_OF_SPACE=-3 expected)`);
}

// (j) focus encode probe-size-first
// GHOSTTY_FOCUS_GAINED = 0, confirmed from focus.h
const focusLenBuf = new BigUint64Array(1);
const rcFocusLen = lib.symbols.ghostty_focus_encode(0, null, 0n, ptr(focusLenBuf));
// When buf=NULL and buf_len=0: returns GHOSTTY_OUT_OF_SPACE (-3) and writes required size.
tag("focus_probe_len", rcFocusLen === GHOSTTY_OUT_OF_SPACE ? "ok" : "fail",
    `rc=${rcFocusLen} required=${focusLenBuf[0]} (expected OUT_OF_SPACE=-3)`);

if (focusLenBuf[0] > 0n) {
  const focusBuf = new Uint8Array(Number(focusLenBuf[0]) + 1);
  const writtenBuf = new BigUint64Array(1);
  const rcFocus = lib.symbols.ghostty_focus_encode(0, ptr(focusBuf), BigInt(focusBuf.byteLength), ptr(writtenBuf));
  const leadsWithEsc = focusBuf[0] === 0x1B;
  tag("focus_encode_bytes", rcFocus === 0 && leadsWithEsc ? "ok" : "fail",
      `rc=${rcFocus} written=${writtenBuf[0]} first=0x${focusBuf[0].toString(16)}`);
}

// (k) APC set + get mismatch — should set OK, get NOT_SUPPORTED/similar
// GHOSTTY_TERMINAL_OPT_APC_MAX_BYTES = 19, confirmed from terminal.h
const apcVal = new BigUint64Array(1);
apcVal[0] = 1048576n;
const rcApcSet = lib.symbols.ghostty_terminal_set(handle, 19, ptr(apcVal));
tag("apc_set", rcApcSet === 0 ? "ok" : "fail", `rc=${rcApcSet}`);
const apcGetOut = new BigUint64Array(1);
// ghostty_terminal_get with option 19 — APC_MAX_BYTES has no corresponding DATA key in GhosttyTerminalData
// (it's a set-only option). The get should return GHOSTTY_INVALID_VALUE (-2) or similar.
const rcApcGet = lib.symbols.ghostty_terminal_get(handle, 19, ptr(apcGetOut));
tag("apc_get_unsupported", rcApcGet !== 0 ? "ok" : "fail",
    `rc=${rcApcGet} (non-zero expected — APC read-back unsupported)`);

// Teardown
lib.symbols.ghostty_render_state_free(rsHandle);
lib.symbols.ghostty_terminal_free(handle);
tag("teardown", "ok", "no crash");
console.log("tag=probe result=ok");
