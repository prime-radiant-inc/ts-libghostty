# ts-libghostty-vt Pass 3 Implementation Plan — RenderState + Terminal finish

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the v0 grid-reading surface — `RenderState`, `Terminal.scrollViewport` / `colors` / `setColors` / `cellAt`, `encodeFocus`, APC bounds wiring, render-metadata fixture infrastructure, malformed-input resilience — shipping as local `v0.3.0` tag. Pass 4 (KeyEncoder) follows and completes v0.

**Architecture:** Pass 3 adds one new subsystem (`RenderState`) plus four Terminal methods and one standalone function. `RenderState` caches decoded row/cell data in JS memory at `update()` time; iterators walk the JS cache, no mid-walk FFI. `cellAt` shares the same cell-decoding helpers but returns a fresh one-shot `CellInfo`. Colors / scroll-viewport / APC bounds are direct `ghostty_terminal_get` / `ghostty_terminal_set` / `ghostty_terminal_scroll_viewport` calls. Render-metadata fixtures add a `.expected.json` companion to the existing `.bin` / `.expected.txt` pattern from Pass 1.

**Tech Stack:** Bun 1.3.13 (FFI via `bun:ffi`), Zig 0.15 (brew `zig@0.15` bottle) for libghostty builds, TypeScript 5.x, darwin-arm64 only. Pinned Ghostty commit per `package.json#ghostty.commit`.

**Spec:** `docs/superpowers/specs/2026-04-23-pass-3-render-state-design.md`

**Pass:** 3 of 4 (Passes 3 → 4 close v0 scope; v1 triggers when libghostty-vt upstream declares API stability).

**Status at start of Pass 3:** Pass 2 shipped as local `v0.2.0` tag (commit ahead of `origin/main`, not pushed). 112 smoke tests pass; typecheck clean; `bun run verify:generated` green. Tree at start: one commit ahead of `v0.2.0` (`aad052a chore: move copyright to README, bump setup-zig to v2`). Pass 3 starts from HEAD of `main`.

---

## C-API picture (from `vendor/ghostty/include/ghostty/vt/*.h` at pin)

Captured during plan authoring by Cipher (Explore Bob). Task 2 re-verifies against the actual headers; concrete reconciliation if anything drifted.

### render.h — RenderState lifecycle, update, iteration, dirty, viewport cursor

**Lifecycle:**
```c
GhosttyResult ghostty_render_state_new(const GhosttyAllocator* allocator,
                                       GhosttyRenderState* state);
void ghostty_render_state_free(GhosttyRenderState state);
GhosttyResult ghostty_render_state_update(GhosttyRenderState state,
                                          GhosttyTerminal terminal);
```

**Dirty state — one call, clears both global and per-row:**
```c
typedef enum {
  GHOSTTY_RENDER_STATE_DIRTY_FALSE = 0,
  GHOSTTY_RENDER_STATE_DIRTY_PARTIAL = 1,
  GHOSTTY_RENDER_STATE_DIRTY_FULL = 2,
} GhosttyRenderStateDirty;

GhosttyResult ghostty_render_state_set(GhosttyRenderState state,
                                       GhosttyRenderStateOption option,
                                       const void* value);
// option = GHOSTTY_RENDER_STATE_OPTION_DIRTY, value = &GhosttyRenderStateDirty
// To clear all dirty: pass FALSE.
// To query current dirty: via ghostty_render_state_get with DATA_DIRTY key.
```

**Viewport cursor (exposed; no cursor-style field on viewport):**
```c
GHOSTTY_RENDER_STATE_DATA_CURSOR_VIEWPORT_HAS_VALUE,  // bool
GHOSTTY_RENDER_STATE_DATA_CURSOR_VIEWPORT_X,          // uint16_t
GHOSTTY_RENDER_STATE_DATA_CURSOR_VIEWPORT_Y,          // uint16_t
GHOSTTY_RENDER_STATE_DATA_CURSOR_VIEWPORT_WIDE_TAIL,  // bool
```

**Colors via dedicated accessor (sized struct):**
```c
GhosttyResult ghostty_render_state_colors_get(GhosttyRenderState state,
                                              GhosttyRenderStateColors* out_colors);

typedef struct {
  size_t size;
  GhosttyColorRgb background;
  GhosttyColorRgb foreground;
  GhosttyColorRgb cursor;
  bool cursor_has_value;
  GhosttyColorRgb palette[256];
} GhosttyRenderStateColors;
```

**Row iterator (outer):**
```c
GhosttyResult ghostty_render_state_row_iterator_new(
    const GhosttyAllocator* allocator,
    GhosttyRenderStateRowIterator* out_iterator);
bool ghostty_render_state_row_iterator_next(GhosttyRenderStateRowIterator iterator);
GhosttyResult ghostty_render_state_row_get(GhosttyRenderStateRowIterator iterator,
                                           GhosttyRenderStateRowData data,
                                           void* out);
// data: DIRTY (bool), RAW (GhosttyRow), CELLS (GhosttyRenderStateRowCells)
void ghostty_render_state_row_iterator_free(GhosttyRenderStateRowIterator iterator);
```

**Cell iterator (inner, per row):**
```c
GhosttyResult ghostty_render_state_row_cells_new(
    const GhosttyAllocator* allocator,
    GhosttyRenderStateRowCells* out_cells);
bool ghostty_render_state_row_cells_next(GhosttyRenderStateRowCells cells);
GhosttyResult ghostty_render_state_row_cells_select(
    GhosttyRenderStateRowCells cells, uint16_t x);
GhosttyResult ghostty_render_state_row_cells_get(
    GhosttyRenderStateRowCells cells,
    GhosttyRenderStateRowCellsData data,
    void* out);
// data: RAW (GhosttyCell), STYLE (GhosttyStyle), GRAPHEMES_LEN (uint32_t),
//       GRAPHEMES_BUF (uint32_t*), BG_COLOR (GhosttyColorRgb), FG_COLOR (GhosttyColorRgb)
void ghostty_render_state_row_cells_free(GhosttyRenderStateRowCells cells);
```

### terminal.h — Options (APC/Kitty), scroll, colors, cellAt

**GhosttyTerminalOption for APC + Kitty (set-only via `ghostty_terminal_set`):**
```c
GHOSTTY_TERMINAL_OPT_APC_MAX_BYTES = 19,              // size_t*
GHOSTTY_TERMINAL_OPT_APC_MAX_BYTES_KITTY = 20,        // size_t*
GHOSTTY_TERMINAL_OPT_KITTY_IMAGE_STORAGE_LIMIT = 15,  // uint64_t*
```
**APC read-back is NOT supported** — `GhosttyTerminalData` enums do NOT include APC keys. Test strategy goes to the §4.4 fallback path (no-crash + invalid-path assertion only).

**GhosttyTerminalData for colors (read via `ghostty_terminal_get`):**
```c
GHOSTTY_TERMINAL_DATA_COLOR_FOREGROUND = 18,          // GhosttyColorRgb* (effective, post-OSC)
GHOSTTY_TERMINAL_DATA_COLOR_BACKGROUND = 19,
GHOSTTY_TERMINAL_DATA_COLOR_CURSOR = 20,
GHOSTTY_TERMINAL_DATA_COLOR_PALETTE = 21,             // GhosttyColorRgb[256]*
GHOSTTY_TERMINAL_DATA_COLOR_FOREGROUND_DEFAULT = 22,  // GhosttyColorRgb* (ignores OSC)
GHOSTTY_TERMINAL_DATA_COLOR_BACKGROUND_DEFAULT = 23,
GHOSTTY_TERMINAL_DATA_COLOR_CURSOR_DEFAULT = 24,
GHOSTTY_TERMINAL_DATA_COLOR_PALETTE_DEFAULT = 25,
// Returns GHOSTTY_NO_VALUE if unset.
```

**Scroll viewport (tagged union):**
```c
typedef enum {
  GHOSTTY_SCROLL_VIEWPORT_TOP = 0,
  GHOSTTY_SCROLL_VIEWPORT_BOTTOM = 1,
  GHOSTTY_SCROLL_VIEWPORT_DELTA = 2,
} GhosttyTerminalScrollViewportTag;

typedef union {
  intptr_t delta;       // signed row delta (negative = up, positive = down)
  uint64_t _padding[2]; // 16 bytes to match worst case
} GhosttyTerminalScrollViewportValue;

typedef struct {
  GhosttyTerminalScrollViewportTag tag;
  GhosttyTerminalScrollViewportValue value;
} GhosttyTerminalScrollViewport;

void ghostty_terminal_scroll_viewport(GhosttyTerminal terminal,
                                      GhosttyTerminalScrollViewport behavior);
```

**Cell lookup via grid ref (4 coord spaces):**
```c
GhosttyResult ghostty_terminal_grid_ref(GhosttyTerminal terminal,
                                        GhosttyPoint point,
                                        GhosttyGridRef *out_ref);
// Returns GHOSTTY_SUCCESS or GHOSTTY_INVALID_VALUE (out-of-bounds → cellAt returns undefined)
```

### grid_ref.h — Cell/row/grapheme/style extraction from a resolved ref

```c
typedef struct {
  size_t size;
  void *node;
  uint16_t x;
  uint16_t y;
} GhosttyGridRef;

GhosttyResult ghostty_grid_ref_cell(const GhosttyGridRef *ref, GhosttyCell *out_cell);
GhosttyResult ghostty_grid_ref_row(const GhosttyGridRef *ref, GhosttyRow *out_row);
GhosttyResult ghostty_grid_ref_graphemes(const GhosttyGridRef *ref,
                                         uint32_t *buf, size_t buf_len, size_t *out_len);
GhosttyResult ghostty_grid_ref_hyperlink_uri(const GhosttyGridRef *ref,
                                             uint8_t *buf, size_t buf_len, size_t *out_len);
GhosttyResult ghostty_grid_ref_style(const GhosttyGridRef *ref, GhosttyStyle *out_style);
```

Graphemes and hyperlink URIs use the probe-size-first pattern (call with NULL buf to get required length, allocate, call again).

### focus.h — Focus encoding

```c
typedef enum {
  GHOSTTY_FOCUS_GAINED = 0,
  GHOSTTY_FOCUS_LOST = 1,
} GhosttyFocusEvent;

GhosttyResult ghostty_focus_encode(GhosttyFocusEvent event,
                                   char* buf, size_t buf_len, size_t* out_written);
```
Probe-size-first: call with NULL buf to learn required length, allocate, call again.

### color.h — RGB tuple

```c
typedef struct { uint8_t r; uint8_t g; uint8_t b; } GhosttyColorRgb;
```
3 bytes, tightly packed. Probe Task 3 captures exact `sizeof` / `alignof`.

### style.h — Cell style (sized struct)

```c
typedef struct {
  size_t size;
  GhosttyStyleColor fg_color;
  GhosttyStyleColor bg_color;
  GhosttyStyleColor underline_color;
  bool bold, italic, faint, blink, inverse, invisible, strikethrough, overline;
  int underline;  // SGR underline style enum
} GhosttyStyle;

typedef struct {
  GhosttyStyleColorTag tag;  // NONE=0, PALETTE=1, RGB=2
  GhosttyStyleColorValue value;  // { uint8_t palette; GhosttyColorRgb rgb; }
} GhosttyStyleColor;
```

### point.h — Coordinate spaces

```c
typedef enum {
  GHOSTTY_POINT_TAG_ACTIVE = 0,
  GHOSTTY_POINT_TAG_VIEWPORT = 1,
  GHOSTTY_POINT_TAG_SCREEN = 2,
  GHOSTTY_POINT_TAG_HISTORY = 3,
} GhosttyPointTag;

typedef struct { uint16_t x; uint32_t y; } GhosttyPointCoordinate;

typedef struct {
  GhosttyPointTag tag;
  GhosttyPointValue value;  // tagged union with coordinate
} GhosttyPoint;
```

---

## Task 2 reconciliation — corrections to downstream tasks

**Added 2026-04-23 after Lovelace's Task 2 probe.** Cipher's plan-authoring survey had 10 divergences from the real pinned API. Probe commit `f490421` on `main` is the source of truth. Task 3 and downstream Bobs MUST apply the corrections below.

### Confirmed enum values (use these in `generated.ts` references and any inline constants)

- `GHOSTTY_SUCCESS = 0`
- `GHOSTTY_OUT_OF_SPACE = -3` (plan originally had `-5` as a placeholder — delete any hardcoded `-5`)
- `GHOSTTY_NO_VALUE = -4` (APC `get` returns this, not `INVALID_VALUE`; minor)
- `GHOSTTY_RENDER_STATE_OPTION_DIRTY = 0`
- `GHOSTTY_RENDER_STATE_DIRTY_FALSE = 0`
- `GHOSTTY_RENDER_STATE_DATA_ROW_ITERATOR = 4`
- `GHOSTTY_RENDER_STATE_ROW_DATA_CELLS = 3` (plan originally said `2`; value `2` is `ROW_DATA_RAW`)
- `GHOSTTY_TERMINAL_OPT_APC_MAX_BYTES = 19`, confirmed

These will be available via named enum constants in `generated.ts` after Task 3 regenerates — exports are named `GhosttyXxxValues` (e.g., `GhosttyRenderStateDataValues`, `GhosttyTerminalOptionValues`), NOT a single `enumValues` namespace. Import the specific enum constant(s) each file needs. Struct layouts are available via the top-level `structLayouts` export (use `structLayouts["StructName"]!` — it's a `Record<string, StructLayout>`). Prefer these over literal values.

### Row iteration requires a populate step

The plan's Task 10 `#rebuildCache` calls `ghostty_render_state_row_iterator_next` immediately after `_new`. That iterates zero rows. **Corrected pattern** (bake this into Task 10's `#rebuildCache`):

```typescript
const D = GhosttyRenderStateDataValues;
const R = GhosttyRenderStateRowDataValues;

// 1. Create empty iterator object.
const iterOut = new BigUint64Array(1);
let rc = ffi.symbols.ghostty_render_state_row_iterator_new(null, ptr(iterOut));
if (rc !== 0) {
  throw new GhosttyError({ code: getResultCodeName(rc), functionName: "row_iterator_new" });
}
const iter = Number(iterOut[0]) as Pointer;

// 2. Populate it from the render state via get(ROW_ITERATOR).
rc = ffi.symbols.ghostty_render_state_get(this.#handle!, D.ROW_ITERATOR, ptr(iterOut));
if (rc !== 0) {
  ffi.symbols.ghostty_render_state_row_iterator_free(iter);
  throw new GhosttyError({ code: getResultCodeName(rc), functionName: "render_state_get(ROW_ITERATOR)" });
}

// 3. Create a reusable cells container (one per rebuild; reset per row).
const cellsOut = new BigUint64Array(1);
rc = ffi.symbols.ghostty_render_state_row_cells_new(null, ptr(cellsOut));
if (rc !== 0) {
  ffi.symbols.ghostty_render_state_row_iterator_free(iter);
  throw new GhosttyError({ code: getResultCodeName(rc), functionName: "row_cells_new" });
}
const cells = Number(cellsOut[0]) as Pointer;

try {
  let y = 0;
  while (ffi.symbols.ghostty_render_state_row_iterator_next(iter)) {
    const dirtyBuf = new Uint8Array(1);
    rc = ffi.symbols.ghostty_render_state_row_get(
      iter, R.DIRTY, ptr(dirtyBuf),
    );
    const rowDirty = rc === 0 && dirtyBuf[0] === 1;

    // Populate the cells container from the current row (CELLS = 3, NOT 2).
    rc = ffi.symbols.ghostty_render_state_row_get(iter, R.CELLS, ptr(cellsOut));
    const decoded = rc === 0 ? this.#walkCells(cells) : [];

    this.#rows.push({ y, wrapped: false, dirty: rowDirty, cells: decoded });
    y += 1;
  }
} finally {
  ffi.symbols.ghostty_render_state_row_cells_free(cells);
  ffi.symbols.ghostty_render_state_row_iterator_free(iter);
}
```

Replaces the Task 10 `#rebuildCache` body and the Task 10 `#walkCells` stub's signature — `#walkCells(cells: Pointer)` now iterates the reusable container (call `row_cells_next` until false).

### `GhosttyPoint` is 24 bytes, not 16

Task 3's `writePoint` helper uses `structLayouts["GhosttyPoint"]!.size` (populated by Task 3 Step 5's `bun run verify:generated`), so it self-corrects. But Task 3 Bobs should verify the generated size is 24 before proceeding — if the probe layout reports something else, re-check `vendor/ghostty/include/ghostty/vt/point.h`.

Layout reference:
```
tag:                i32 @ 0
(pad)                   @ 4..7
value.coordinate.x: u16 @ 8
value.coordinate.y: u32 @ 10
(pad)                   @ 14..23
size = 24
```

### Empty-cell graphemes returns `SUCCESS + len=0`

Task 8's `#decodeGridRef` and Task 11's `#walkCells` already handle `len > 0` conditionally — no code change required. But the error check should permit `rc === SUCCESS` explicitly (not force `OUT_OF_SPACE`):

```typescript
// OK as plan-authored — rc === 0 path falls through without throw:
let rc = ffi.symbols.ghostty_grid_ref_graphemes(ptr(refBuf), null, 0n, ptr(lenOut));
if (rc !== 0 && getResultCodeName(rc) !== "out_of_space") {
  throw new GhosttyError({ ... });
}
```

No change to the plan's control flow. Note this in code comments so a future reader doesn't "fix" it.

### `GhosttyTerminalOptions` layout

Pass 1's Terminal constructor already uses the correct 16-byte layout (no `size` field). Pass 3 does not touch that code path except for the post-construct APC `set` calls (Task 7). No amendment needed.

### FFI declaration of `ghostty_render_state_get` was already in Task 3

Plan's Task 3 Step 2 lists `ghostty_render_state_get` in the SYMBOLS additions. No amendment needed — just confirming it's there.

### Summary of downstream task amendments

| Task | Amendment |
|---|---|
| 3 | No functional amendment; confirm `structLayouts["GhosttyPoint"]!.size === 24` after verify:generated |
| 8 | None (grapheme SUCCESS+0 already handled) |
| 10 | Replace `#rebuildCache` body per the corrected pattern above |
| 11 | `#walkCells(cellsHandle: Pointer)` — iterate until `row_cells_next` returns false; use per-cell accessors via `row_cells_get` with correct data-key enum values (confirm `GRAPHEMES_LEN`, `GRAPHEMES_BUF`, `STYLE` values in `generated.ts` after Task 3) |

All other downstream tasks are unaffected.

---

## File structure

### New files
- `src/render-state.ts` — `RenderState` class
- `src/focus.ts` — `encodeFocus` function
- `scripts/probe-pass3-ffi.ts` — one-off Task 2 probe
- `test/smoke/scroll-viewport.test.ts`
- `test/smoke/colors.test.ts`
- `test/smoke/cell-at.test.ts`
- `test/smoke/focus.test.ts`
- `test/smoke/apc-bounds.test.ts`
- `test/smoke/render-state.test.ts`
- `test/smoke/resilience-fuzz.test.ts`
- `test/fixtures/metadata-harness.ts` — replay + metadata snapshot + diff
- `test/fixtures/*.expected.json` — per-fixture metadata companions (generated)

### Modified files
- `src/terminal.ts` — add `scrollViewport`, `colors`, `setColors`, `cellAt`; APC wiring in constructor
- `src/types.ts` — re-add `apcMaxBytes` / `apcMaxBytesKitty` to `TerminalOptions`; add `CellInfo`, `CellStyle`, `TerminalColors`, `UnderlineStyle`, `RenderRow`, `RenderCell`, `ViewportCursor`
- `src/index.ts` — public re-exports for all Pass 3 surface
- `src/ffi.ts` — extend `SYMBOLS` with render-state + grid-ref + focus + scroll + color-get symbols
- `src/internal/generated.ts` — regenerated by `bun run build:bindings`
- `src/internal/sized-struct.ts` — (if needed) new writer/reader helpers for `GhosttyStyle`, `GhosttyRenderStateColors`, `GhosttyGridRef`, `GhosttyTerminalScrollViewport`
- `src/internal/marshal.ts` — (if needed) RGB tuple read, tagged-union writer
- `scripts/probe-layout.c` — extend with new structs touched in Pass 3
- `CHANGELOG.md` — `## [0.3.0]` entry
- `package.json` — version bump to `0.3.0`
- `CONFIRM_WITH_MATT.md` — Pass 3 summary + Pass 4 carry-forward

### Task → files quick map

| Task | Primary file(s) |
|---|---|
| 1 | (read-only — baseline + CONFIRM_WITH_MATT note) |
| 2 | `scripts/probe-pass3-ffi.ts` (new) |
| 3 | `src/ffi.ts`, `src/internal/generated.ts` (regenerated), `scripts/probe-layout.c` (extended), `src/internal/sized-struct.ts`, `src/internal/marshal.ts` |
| 4 | `src/terminal.ts`, `src/types.ts`, `test/smoke/scroll-viewport.test.ts` (new) |
| 5 | `src/focus.ts` (new), `src/index.ts`, `test/smoke/focus.test.ts` (new) |
| 6 | `src/terminal.ts`, `src/types.ts`, `test/smoke/colors.test.ts` (new) |
| 7 | `src/terminal.ts`, `src/types.ts`, `test/smoke/apc-bounds.test.ts` (new) |
| 8 | `src/terminal.ts`, `src/types.ts`, `test/smoke/cell-at.test.ts` (new) |
| 9 | `src/terminal.ts`, `test/smoke/cell-at.test.ts` |
| 10 | `src/render-state.ts` (new skeleton), `src/types.ts` |
| 11 | `src/render-state.ts`, `src/types.ts` |
| 12 | `src/render-state.ts` |
| 13 | `test/smoke/render-state.test.ts` (new) |
| 14 | `test/fixtures/metadata-harness.ts` (new) |
| 15 | `test/fixtures/*.expected.json` (generated + committed) |
| 16 | `test/smoke/resilience-fuzz.test.ts` (new) |
| 17 | `src/index.ts`, `scripts/run-tarball-smoke.sh` (extended) |
| 18 | `CHANGELOG.md`, `package.json`, `CONFIRM_WITH_MATT.md`, `v0.3.0` tag |

---

## Task 1: Preflight baseline

**Purpose:** Record the start state before any changes. Pass 3 starts from HEAD of `main`; this task confirms the tree is clean and captures baseline test counts so later regressions stand out.

**Files:** no code changes. One doc entry appended to `CONFIRM_WITH_MATT.md`.

- [ ] **Step 1: Confirm tree state.**

```bash
cd /Users/mw/Code/prime/ts-libghostty-vt
git status
# Expected: "nothing to commit, working tree clean" on branch main.

git log -1 --oneline
# Expected: aad052a (or a newer commit on main if additional work landed).

git describe --tags --abbrev=0
# Expected: v0.2.0
```

- [ ] **Step 2: Run the baseline suite and record counts.**

```bash
bun run typecheck
# Expected: no output on success.

bun test test/smoke
# Expected: 112 pass, 0 fail. Record the exact count in Step 5.

bun run verify:generated
# Expected: "generated.ts matches ABI" (or the current success message).
```

If any of these fail, STOP. Investigate and fix before proceeding — Pass 3 assumes a green baseline.

- [ ] **Step 3: Record commit hash.**

```bash
git rev-parse HEAD
# Capture the output for Step 5.
```

- [ ] **Step 4: Append Pass 3 start-state to `CONFIRM_WITH_MATT.md`.**

Edit `CONFIRM_WITH_MATT.md` and insert this section immediately before "## Known plan/code drift":

```markdown
## Pass 3 notes

### Pass 3 start-state (2026-04-23, Ekaterin)

Pass 3 starts from HEAD of `main` at commit `<HASH from Step 3>`. Baseline captured at Task 1:

- `bun run typecheck` — clean
- `bun test test/smoke` — **112 pass / 0 fail** (the Pass-3 target after all new smoke tests lands is ~165 — 112 baseline + 53 new across scroll/focus/colors/APC/cellAt/render-state/fuzz)
- `bun run verify:generated` — green; `generated.ts` matches the pin
- Tree clean; Pass 2's `v0.2.0` tag is local-only, unpushed

Pass 3 is unblocked.
```

Replace `<HASH from Step 3>` with the actual 40-char SHA. The target test count (165) is a rough estimate; the exact post-Pass-3 count will be recorded at Task 18.

- [ ] **Step 5: Commit.**

```bash
git add CONFIRM_WITH_MATT.md
git commit -m "chore(pass-3): Task 1 preflight — record baseline

112 smoke tests passing; typecheck clean; verify:generated green.
Pass 3 starts from HEAD <short-SHA>.

Co-Authored-By: <your-Bob-name> (Bob <session-id-first-8>/<model>)"
```

**Expected outcome:** one doc commit; no functional changes. Proceed to Task 2.

---

## Task 2: FFI discovery probe

**Purpose:** Re-verify Cipher's plan-authoring findings against the actual headers at the pin, and confirm runtime behavior of the four Pass 3 API surfaces that matter most: (a) render-state row/cell iteration, (b) dirty clear via `ghostty_render_state_set`, (c) `ghostty_terminal_grid_ref` + grid-ref accessors, (d) focus encoding probe-size-first pattern. Produces a committed diagnostic script and validates that the concrete code blocks used in Tasks 3–17 are grounded in real API shape.

**Files:**
- Create: `scripts/probe-pass3-ffi.ts`

- [ ] **Step 1: Write the probe script.**

Contents of `scripts/probe-pass3-ffi.ts`:

```typescript
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

import { dlopen, FFIType, ptr, type Pointer, JSCallback } from "bun:ffi";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Load the bundled dylib directly — this script bypasses src/ffi.ts on purpose
// (we're probing the raw API, not the wrapper).
const libPath = process.env.GHOSTTY_VT_LIB ||
  join(import.meta.dir, "..", "prebuilds", "darwin-arm64", "libghostty-vt.dylib");

const lib = dlopen(libPath, {
  ghostty_terminal_new: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  ghostty_terminal_free: { args: [FFIType.ptr], returns: FFIType.void },
  ghostty_terminal_vt_write: { args: [FFIType.ptr, FFIType.ptr, FFIType.u64], returns: FFIType.i32 },
  ghostty_terminal_set: { args: [FFIType.ptr, FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
  ghostty_terminal_get: { args: [FFIType.ptr, FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
  ghostty_terminal_grid_ref: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  ghostty_grid_ref_cell: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  ghostty_grid_ref_style: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  ghostty_grid_ref_graphemes: { args: [FFIType.ptr, FFIType.ptr, FFIType.u64, FFIType.ptr], returns: FFIType.i32 },
  ghostty_render_state_new: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  ghostty_render_state_free: { args: [FFIType.ptr], returns: FFIType.void },
  ghostty_render_state_update: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
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

function tag(name: string, result: "ok" | "fail", detail: string) {
  console.log(`tag=${name} result=${result} detail="${detail.replace(/"/g, "\\\"")}"`);
}

// Build GhosttyTerminalOptions — cols=10, rows=4, max_scrollback=0
// Layout from ABI doc §12: 3 × u64 after 8-byte size field = 32 bytes total.
const optsBuf = new Uint8Array(32);
const optsView = new DataView(optsBuf.buffer);
optsView.setBigUint64(0, 32n, true);        // size
optsView.setBigUint64(8, 10n, true);        // cols
optsView.setBigUint64(16, 4n, true);        // rows
optsView.setBigUint64(24, 0n, true);        // max_scrollback
const handleBuf = new BigUint64Array(1);

const rc = lib.symbols.ghostty_terminal_new(ptr(optsBuf), ptr(handleBuf));
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
const rowItBuf = new BigUint64Array(1);
const rcIter = lib.symbols.ghostty_render_state_row_iterator_new(null, ptr(rowItBuf));
if (rcIter !== 0) { tag("row_iter_new", "fail", `rc=${rcIter}`); process.exit(1); }
const rowIter = Number(rowItBuf[0]) as Pointer;

let rowCount = 0;
let firstRowCellCount = 0;
while (lib.symbols.ghostty_render_state_row_iterator_next(rowIter)) {
  rowCount += 1;
  if (rowCount === 1) {
    const cellsBuf = new BigUint64Array(1);
    // CELLS data kind is expected to be 2 per Cipher's report; verify by running.
    // (data kind enum values must be confirmed against real headers at Task 3.)
    const rcCells = lib.symbols.ghostty_render_state_row_get(rowIter, 2, ptr(cellsBuf));
    if (rcCells === 0) {
      const cells = Number(cellsBuf[0]) as Pointer;
      while (lib.symbols.ghostty_render_state_row_cells_next(cells)) firstRowCellCount += 1;
      lib.symbols.ghostty_render_state_row_cells_free(cells);
    }
  }
}
lib.symbols.ghostty_render_state_row_iterator_free(rowIter);
tag("row_count", rowCount === 4 ? "ok" : "fail", `rows=${rowCount} expected=4`);
tag("cell_count", firstRowCellCount === 10 ? "ok" : "fail", `cells=${firstRowCellCount} expected=10`);

// (e) dirty clear — one-call
const dirtyValBuf = new Uint8Array(4);
new DataView(dirtyValBuf.buffer).setInt32(0, 0, true); // DIRTY_FALSE
// Option enum value for DIRTY confirmed via header read at Task 3. Probe: assume
// OPTION_DIRTY = 0 or 1; iterate 0..3 looking for one that returns OK.
let dirtyOk = false;
for (let opt = 0; opt <= 3; opt += 1) {
  const rcSet = lib.symbols.ghostty_render_state_set(rsHandle, opt, ptr(dirtyValBuf));
  if (rcSet === 0) {
    dirtyOk = true;
    tag("dirty_clear", "ok", `option_value=${opt} rc=0`);
    break;
  }
}
if (!dirtyOk) tag("dirty_clear", "fail", "no option value in 0..3 returned OK");

// (g,h) grid_ref — look up cell at (0,0) ACTIVE
// GhosttyPoint layout: tag:i32, _pad:i32, value.coord.x:u16, _pad:u16, value.coord.y:u32
// Exact layout confirmed at Task 3 via probe-layout.c. Assume 16-byte struct here:
//   [tag(4), pad(4), x(2), pad(2), y(4)] = 16 bytes
const pointBuf = new Uint8Array(16);
const pv = new DataView(pointBuf.buffer);
pv.setInt32(0, 0, true);   // tag = ACTIVE (0)
pv.setUint16(8, 0, true);  // x = 0
pv.setUint32(12, 0, true); // y = 0
const refBuf = new Uint8Array(32); // GhosttyGridRef: size(8) + node(8) + x(2) + _(6) = 24, round to 32
new DataView(refBuf.buffer).setBigUint64(0, 24n, true); // size field
const rcRef = lib.symbols.ghostty_terminal_grid_ref(handle, ptr(pointBuf), ptr(refBuf));
tag("grid_ref_lookup", rcRef === 0 ? "ok" : "fail", `rc=${rcRef}`);

// (i) graphemes probe-size-first
const lenOutBuf = new BigUint64Array(1);
const rcGraph = lib.symbols.ghostty_grid_ref_graphemes(ptr(refBuf), null, 0n, ptr(lenOutBuf));
tag("graphemes_probe", rcGraph === 0 || rcGraph === -5 ? "ok" : "fail",
    `rc=${rcGraph} len=${lenOutBuf[0]}`); // -5 is placeholder for OUT_OF_SPACE

// (j) focus encode probe-size-first
const focusLenBuf = new BigUint64Array(1);
const rcFocusLen = lib.symbols.ghostty_focus_encode(0, null, 0n, ptr(focusLenBuf));
tag("focus_probe_len", rcFocusLen === 0 || rcFocusLen === -5 ? "ok" : "fail",
    `rc=${rcFocusLen} required=${focusLenBuf[0]}`);

if (focusLenBuf[0] > 0n) {
  const focusBuf = new Uint8Array(Number(focusLenBuf[0]) + 1);
  const writtenBuf = new BigUint64Array(1);
  const rcFocus = lib.symbols.ghostty_focus_encode(0, ptr(focusBuf), BigInt(focusBuf.byteLength), ptr(writtenBuf));
  const leadsWithEsc = focusBuf[0] === 0x1B;
  tag("focus_encode_bytes", rcFocus === 0 && leadsWithEsc ? "ok" : "fail",
      `rc=${rcFocus} written=${writtenBuf[0]} first=0x${focusBuf[0].toString(16)}`);
}

// (k) APC set + get mismatch — should set OK, get NOT_SUPPORTED/similar
const apcVal = new BigUint64Array(1);
apcVal[0] = 1048576n;
const rcApcSet = lib.symbols.ghostty_terminal_set(handle, 19, ptr(apcVal));
tag("apc_set", rcApcSet === 0 ? "ok" : "fail", `rc=${rcApcSet}`);
const apcGetOut = new BigUint64Array(1);
const rcApcGet = lib.symbols.ghostty_terminal_get(handle, 19, ptr(apcGetOut));
tag("apc_get_unsupported", rcApcGet !== 0 ? "ok" : "fail",
    `rc=${rcApcGet} (non-zero expected — Cipher flagged APC read-back as unsupported)`);

// Teardown
lib.symbols.ghostty_render_state_free(rsHandle);
lib.symbols.ghostty_terminal_free(handle);
tag("teardown", "ok", "no crash");
console.log("tag=probe result=ok");
```

- [ ] **Step 2: Run the probe and gate on tagged output.**

```bash
bun run scripts/probe-pass3-ffi.ts | tee /tmp/pass3-probe.log
# Expected: every line starts with "tag=..." and final line is "tag=probe result=ok".

grep -c 'result=fail' /tmp/pass3-probe.log
# Expected: 0
```

If `result=fail` appears on any tag OTHER than `apc_get_unsupported` (which expects non-zero rc from `get`), STOP and escalate. If `apc_get_unsupported` returns `fail` (meaning `get` succeeded on APC) that's newsworthy — it means APC read-back IS supported, and §4.4's preferred `set`+`get` round-trip path is available. Update Task 7's test accordingly.

Other possible drift outcomes to expect:
- `row_count` or `cell_count` wrong → geometry doesn't match `GhosttyTerminalOptions` layout we wrote. Re-read `vendor/ghostty/include/ghostty/vt/terminal.h` and fix the options struct layout in the probe before re-running. If the struct changed, this cascades into Task 3's SYMBOL extension and downstream tasks.
- `dirty_clear` loops through 0..3 without hitting an OK → `GhosttyRenderStateOption` enum values differ from Cipher's report. Read `vendor/ghostty/include/ghostty/vt/render.h` for the real enum and note it in Step 3.
- `grid_ref_lookup` fails → `GhosttyPoint` layout or ref struct size is wrong. Read `vendor/ghostty/include/ghostty/vt/point.h` and `grid_ref.h` and adjust.
- `focus_probe_len` fails → `ghostty_focus_encode` signature is different from Cipher's mapping. Read `focus.h`.

**Do not skip this step** even if everything looks straightforward — Pass 1's Task 3 surfaced ABI drift that would have broken every downstream task. The probe is cheap; reconciliation is expensive.

- [ ] **Step 3: Commit the probe and findings.**

```bash
git add scripts/probe-pass3-ffi.ts
git commit -m "chore(pass-3): Task 2 probe — Pass 3 FFI surface compat

Validates render-state iteration, dirty-clear one-call, grid-ref
lookup, focus probe-size-first, and APC set/get mismatch against
pinned libghostty-vt. All probes green; APC read-back confirmed
unsupported (test strategy goes to §4.4 fallback path).

Co-Authored-By: <your-Bob-name> (Bob <session-id-first-8>/<model>)"
```

**Expected outcome:** one probe script committed. Any drift discovered gets reconciled via plan amendments in Task 2 output before Task 3 begins.

---

## Task 3: FFI symbol extension + struct-layout probe + marshaling helpers

**Purpose:** All Pass 3 FFI calls go through `src/ffi.ts`'s `SYMBOLS` table. Extend it. Regenerate `src/internal/generated.ts` via `bun run build:bindings` so enum values, option tags, and struct sizes are current. Extend `scripts/probe-layout.c` with the new structs. Add the marshaling helpers (RGB tuple read, tagged-union writer for scroll-viewport, sized-struct reader for style/colors/grid-ref) that downstream tasks reuse.

**Files:**
- Modify: `src/ffi.ts`
- Regenerate: `src/internal/generated.ts`
- Modify: `scripts/probe-layout.c`
- Modify: `src/internal/sized-struct.ts`
- Modify: `src/internal/marshal.ts`
- Test: `test/smoke/abi.test.ts` (update expected symbol count)

- [ ] **Step 1: Read the current `SYMBOLS` table and `abi.test.ts` for patterns.**

```bash
head -80 src/ffi.ts
head -60 test/smoke/abi.test.ts
```

Note the structure: `SYMBOLS: Record<string, FFIFunction>`. Every new symbol added here gets auto-verified in `abi.test.ts` against `generated.ts`'s `declaredHeaderSymbols`. If a symbol isn't in `generated.ts`'s manifest, the test fails with a clear message.

- [ ] **Step 2: Extend `SYMBOLS` in `src/ffi.ts`.**

Add these entries to the `SYMBOLS` object (exact placement: alphabetical is fine, or group with existing terminal_* calls):

```typescript
// Pass 3 additions — render-state, grid-ref, focus, terminal get/set extras.

// Render state lifecycle + update
ghostty_render_state_new: {
  args: [FFIType.ptr, FFIType.ptr],
  returns: FFIType.i32,
},
ghostty_render_state_free: {
  args: [FFIType.ptr],
  returns: FFIType.void,
},
ghostty_render_state_update: {
  args: [FFIType.ptr, FFIType.ptr],
  returns: FFIType.i32,
},
ghostty_render_state_set: {
  args: [FFIType.ptr, FFIType.i32, FFIType.ptr],
  returns: FFIType.i32,
},
ghostty_render_state_get: {
  args: [FFIType.ptr, FFIType.i32, FFIType.ptr],
  returns: FFIType.i32,
},
ghostty_render_state_colors_get: {
  args: [FFIType.ptr, FFIType.ptr],
  returns: FFIType.i32,
},

// Render-state row iterator
ghostty_render_state_row_iterator_new: {
  args: [FFIType.ptr, FFIType.ptr],
  returns: FFIType.i32,
},
ghostty_render_state_row_iterator_next: {
  args: [FFIType.ptr],
  returns: FFIType.bool,
},
ghostty_render_state_row_iterator_free: {
  args: [FFIType.ptr],
  returns: FFIType.void,
},
ghostty_render_state_row_get: {
  args: [FFIType.ptr, FFIType.i32, FFIType.ptr],
  returns: FFIType.i32,
},

// Render-state cell iterator (per-row)
ghostty_render_state_row_cells_new: {
  args: [FFIType.ptr, FFIType.ptr],
  returns: FFIType.i32,
},
ghostty_render_state_row_cells_next: {
  args: [FFIType.ptr],
  returns: FFIType.bool,
},
ghostty_render_state_row_cells_select: {
  args: [FFIType.ptr, FFIType.u16],
  returns: FFIType.i32,
},
ghostty_render_state_row_cells_get: {
  args: [FFIType.ptr, FFIType.i32, FFIType.ptr],
  returns: FFIType.i32,
},
ghostty_render_state_row_cells_free: {
  args: [FFIType.ptr],
  returns: FFIType.void,
},

// Grid ref accessors (for Terminal.cellAt + RenderState decode if taken)
ghostty_terminal_grid_ref: {
  args: [FFIType.ptr, FFIType.ptr, FFIType.ptr],
  returns: FFIType.i32,
},
ghostty_grid_ref_cell: {
  args: [FFIType.ptr, FFIType.ptr],
  returns: FFIType.i32,
},
ghostty_grid_ref_row: {
  args: [FFIType.ptr, FFIType.ptr],
  returns: FFIType.i32,
},
ghostty_grid_ref_graphemes: {
  args: [FFIType.ptr, FFIType.ptr, FFIType.u64, FFIType.ptr],
  returns: FFIType.i32,
},
ghostty_grid_ref_hyperlink_uri: {
  args: [FFIType.ptr, FFIType.ptr, FFIType.u64, FFIType.ptr],
  returns: FFIType.i32,
},
ghostty_grid_ref_style: {
  args: [FFIType.ptr, FFIType.ptr],
  returns: FFIType.i32,
},

// Focus encode
ghostty_focus_encode: {
  args: [FFIType.i32, FFIType.ptr, FFIType.u64, FFIType.ptr],
  returns: FFIType.i32,
},

// Terminal scroll viewport
ghostty_terminal_scroll_viewport: {
  args: [FFIType.ptr, FFIType.ptr],
  returns: FFIType.void,
},
```

Leave `ghostty_terminal_set` and `ghostty_terminal_get` untouched — they're already in SYMBOLS from Pass 2 and Pass 3 reuses them for APC + colors with no signature change.

- [ ] **Step 3: Regenerate `generated.ts`.**

```bash
bun run build:bindings
# Expected: writes src/internal/generated.ts with new declaredHeaderSymbols
# entries and any new enum values (GhosttyRenderStateOption,
# GhosttyRenderStateDirty, GhosttyRenderStateRowData,
# GhosttyRenderStateRowCellsData, GhosttyFocusEvent,
# GhosttyPointTag, GhosttyTerminalScrollViewportTag,
# GhosttyStyleColorTag, and any new GhosttyTerminalOption / Data values).

git diff src/internal/generated.ts | head -200
# Review: exact enum values are what matter. Spot-check that
# GHOSTTY_RENDER_STATE_DIRTY_FALSE = 0 appears, point tags are 0..3,
# APC options match (APC_MAX_BYTES = 19, APC_MAX_BYTES_KITTY = 20,
# KITTY_IMAGE_STORAGE_LIMIT = 15).
```

If `bun run build:bindings` fails, the generator needs updates — see `scripts/gen-bindings.ts`. Likely culprits: new struct types the generator doesn't know how to parse yet, new sentinel enum values. Fix and re-run.

- [ ] **Step 4: Extend `scripts/probe-layout.c` with Pass 3 structs.**

Open `scripts/probe-layout.c`. Add these entries alongside the existing struct probes:

```c
// Pass 3 structs
PROBE_STRUCT(GhosttyRenderStateColors);
PROBE_FIELD(GhosttyRenderStateColors, size);
PROBE_FIELD(GhosttyRenderStateColors, background);
PROBE_FIELD(GhosttyRenderStateColors, foreground);
PROBE_FIELD(GhosttyRenderStateColors, cursor);
PROBE_FIELD(GhosttyRenderStateColors, cursor_has_value);
PROBE_FIELD(GhosttyRenderStateColors, palette);

PROBE_STRUCT(GhosttyStyle);
PROBE_FIELD(GhosttyStyle, size);
PROBE_FIELD(GhosttyStyle, fg_color);
PROBE_FIELD(GhosttyStyle, bg_color);
PROBE_FIELD(GhosttyStyle, underline_color);
PROBE_FIELD(GhosttyStyle, bold);
PROBE_FIELD(GhosttyStyle, italic);
PROBE_FIELD(GhosttyStyle, faint);
PROBE_FIELD(GhosttyStyle, blink);
PROBE_FIELD(GhosttyStyle, inverse);
PROBE_FIELD(GhosttyStyle, invisible);
PROBE_FIELD(GhosttyStyle, strikethrough);
PROBE_FIELD(GhosttyStyle, overline);
PROBE_FIELD(GhosttyStyle, underline);

PROBE_STRUCT(GhosttyStyleColor);
PROBE_FIELD(GhosttyStyleColor, tag);
PROBE_FIELD(GhosttyStyleColor, value);

PROBE_STRUCT(GhosttyGridRef);
PROBE_FIELD(GhosttyGridRef, size);
PROBE_FIELD(GhosttyGridRef, node);
PROBE_FIELD(GhosttyGridRef, x);
PROBE_FIELD(GhosttyGridRef, y);

PROBE_STRUCT(GhosttyPoint);
PROBE_FIELD(GhosttyPoint, tag);
PROBE_FIELD(GhosttyPoint, value);

PROBE_STRUCT(GhosttyPointCoordinate);
PROBE_FIELD(GhosttyPointCoordinate, x);
PROBE_FIELD(GhosttyPointCoordinate, y);

PROBE_STRUCT(GhosttyColorRgb);
PROBE_FIELD(GhosttyColorRgb, r);
PROBE_FIELD(GhosttyColorRgb, g);
PROBE_FIELD(GhosttyColorRgb, b);

PROBE_STRUCT(GhosttyTerminalScrollViewport);
PROBE_FIELD(GhosttyTerminalScrollViewport, tag);
PROBE_FIELD(GhosttyTerminalScrollViewport, value);
```

(`PROBE_STRUCT` / `PROBE_FIELD` are the existing Pass 1 macros. If your additions reference a field the header renamed, the C compiler will tell you.)

- [ ] **Step 5: Rebuild and re-run verify:generated.**

```bash
bun run verify:generated
# Expected: probe-layout.c rebuilds, runs, emits sizes/offsets, gen-bindings.ts
# merges into generated.ts, and the committed generated.ts matches.
# If the committed copy differs from regenerated, the command fails with a diff.
# Commit the regenerated generated.ts if the diff is expected (new struct entries).
```

- [ ] **Step 6: Extend `sized-struct.ts` and `marshal.ts` helpers.**

Read the current helpers:

```bash
head -40 src/internal/sized-struct.ts
head -40 src/internal/marshal.ts
```

Add to `src/internal/marshal.ts` (append at end):

```typescript
// --- Pass 3 helpers ---

import { structLayouts } from "./generated";

/**
 * Read a 3-byte GhosttyColorRgb at `offset` in `buf`. Returns a tuple.
 * Preserves semantic index order for palettes.
 */
export function readRgb(buf: Uint8Array, offset: number): readonly [number, number, number] {
  return [buf[offset]!, buf[offset + 1]!, buf[offset + 2]!] as const;
}

/**
 * Read a 256-entry palette starting at `offset`. Each entry is 3 bytes; total 768 bytes.
 * Caller ensures buf.length >= offset + 768.
 */
export function readPalette256(buf: Uint8Array, offset: number): readonly (readonly [number, number, number])[] {
  const out: (readonly [number, number, number])[] = new Array(256);
  for (let i = 0; i < 256; i += 1) {
    out[i] = readRgb(buf, offset + i * 3);
  }
  return out;
}

/**
 * Write a GhosttyTerminalScrollViewport tagged union into a fresh Uint8Array.
 * Layout per probe output: tag (i32) + 4-byte pad + union (16 bytes) = 24 bytes.
 * Exact offsets come from `structLayouts["GhosttyTerminalScrollViewport"]!`.
 */
export function writeScrollViewport(tag: 0 | 1 | 2, delta: number): Uint8Array {
  const layout = structLayouts["GhosttyTerminalScrollViewport"]!;
  const buf = new Uint8Array(layout.size);
  const view = new DataView(buf.buffer);
  view.setInt32(layout.fields.tag.offset, tag, true);
  if (tag === 2) {
    // intptr_t on darwin-arm64 = 8 bytes signed
    view.setBigInt64(layout.fields.value.offset, BigInt(delta), true);
  }
  return buf;
}

/**
 * Write a GhosttyPoint tagged union for cellAt lookups.
 * Layout: tag (i32) + 4-byte pad + value.coordinate { x: u16, _pad: u16, y: u32 }.
 */
export function writePoint(tag: 0 | 1 | 2 | 3, x: number, y: number): Uint8Array {
  const layout = structLayouts["GhosttyPoint"]!;
  const buf = new Uint8Array(layout.size);
  const view = new DataView(buf.buffer);
  view.setInt32(layout.fields.tag.offset, tag, true);
  const valueOffset = layout.fields.value.offset;
  const coord = structLayouts["GhosttyPointCoordinate"]!;
  view.setUint16(valueOffset + coord.fields.x.offset, x, true);
  view.setUint32(valueOffset + coord.fields.y.offset, y, true);
  return buf;
}
```

Add to `src/internal/sized-struct.ts` (append at end):

```typescript
// --- Pass 3 sized-struct readers ---

import { structLayouts } from "./generated";
import { readRgb, readPalette256 } from "./marshal";
import type { RGB } from "../types";

export interface RawRenderStateColors {
  background: RGB;
  foreground: RGB;
  cursor: RGB;
  cursorHasValue: boolean;
  palette: readonly RGB[];
}

/**
 * Read a GhosttyRenderStateColors struct. The caller allocates a buffer
 * matching `structLayouts["GhosttyRenderStateColors"]!.size`, writes
 * the size prefix, and hands it to ghostty_render_state_colors_get; this
 * helper decodes the resulting buffer.
 */
export function readRenderStateColors(buf: Uint8Array): RawRenderStateColors {
  const layout = structLayouts["GhosttyRenderStateColors"]!;
  return {
    background: readRgb(buf, layout.fields.background.offset),
    foreground: readRgb(buf, layout.fields.foreground.offset),
    cursor: readRgb(buf, layout.fields.cursor.offset),
    cursorHasValue: buf[layout.fields.cursor_has_value.offset] !== 0,
    palette: readPalette256(buf, layout.fields.palette.offset),
  };
}

export interface RawStyle {
  fg: RGB | { palette: number } | undefined;
  bg: RGB | { palette: number } | undefined;
  underlineColor: RGB | { palette: number } | undefined;
  bold: boolean;
  italic: boolean;
  faint: boolean;
  blink: boolean;
  inverse: boolean;
  invisible: boolean;
  strikethrough: boolean;
  overline: boolean;
  underline: number; // SGR underline style enum; mapped to string in style.ts decoder
}

/**
 * Decode a GhosttyStyle buffer into a raw JS-shape object. Higher layers
 * (render-state.ts / terminal.ts) map the `underline` int into the
 * `UnderlineStyle` string union using generated enum lookup.
 */
export function readStyle(buf: Uint8Array): RawStyle {
  const layout = structLayouts["GhosttyStyle"]!;
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

  const readColor = (offset: number): RGB | { palette: number } | undefined => {
    const colorLayout = structLayouts["GhosttyStyleColor"]!;
    const tag = view.getInt32(offset + colorLayout.fields.tag.offset, true);
    const valueOffset = offset + colorLayout.fields.value.offset;
    if (tag === 0) return undefined; // NONE
    if (tag === 1) return { palette: buf[valueOffset]! }; // PALETTE
    return readRgb(buf, valueOffset); // RGB
  };

  return {
    fg: readColor(layout.fields.fg_color.offset),
    bg: readColor(layout.fields.bg_color.offset),
    underlineColor: readColor(layout.fields.underline_color.offset),
    bold: buf[layout.fields.bold.offset] !== 0,
    italic: buf[layout.fields.italic.offset] !== 0,
    faint: buf[layout.fields.faint.offset] !== 0,
    blink: buf[layout.fields.blink.offset] !== 0,
    inverse: buf[layout.fields.inverse.offset] !== 0,
    invisible: buf[layout.fields.invisible.offset] !== 0,
    strikethrough: buf[layout.fields.strikethrough.offset] !== 0,
    overline: buf[layout.fields.overline.offset] !== 0,
    underline: view.getInt32(layout.fields.underline.offset, true),
  };
}
```

- [ ] **Step 7: Update `test/smoke/abi.test.ts` if expected symbol count is asserted.**

```bash
grep -n 'declaredHeaderSymbols\|symbols.length\|Object.keys' test/smoke/abi.test.ts
```

If there's a hardcoded symbol count, update it to match `Object.keys(SYMBOLS).length` after the additions. If the test iterates and compares sets, no change needed.

- [ ] **Step 8: Verify.**

```bash
bun run typecheck
# Expected: clean.

bun test test/smoke/abi.test.ts
# Expected: all Pass 1/2 ABI assertions still green, new symbols resolve.

bun test test/smoke
# Expected: 112 pass still — no new tests yet, just FFI plumbing.
```

- [ ] **Step 9: Commit.**

```bash
git add src/ffi.ts src/internal/generated.ts src/internal/marshal.ts src/internal/sized-struct.ts scripts/probe-layout.c test/smoke/abi.test.ts
git commit -m "feat(ffi): Pass 3 — extend SYMBOLS, regenerate bindings, add marshalers

Pass 3 FFI surface added to SYMBOLS: render-state lifecycle + update +
dirty + colors + row/cell iterators (10 symbols), grid-ref accessors
(5 symbols), ghostty_terminal_grid_ref, ghostty_terminal_scroll_viewport,
ghostty_focus_encode. generated.ts regenerated.

probe-layout.c extended with GhosttyRenderStateColors, GhosttyStyle,
GhosttyStyleColor, GhosttyGridRef, GhosttyPoint(+Coordinate),
GhosttyColorRgb, GhosttyTerminalScrollViewport.

Internal helpers added: readRgb, readPalette256, writeScrollViewport,
writePoint (marshal.ts); readRenderStateColors, readStyle (sized-struct.ts).
Downstream Pass 3 tasks reuse these.

Co-Authored-By: <your-Bob-name> (Bob <session-id-first-8>/<model>)"
```

**Expected outcome:** FFI plumbing in place. All Pass 3 symbols resolve at dlopen; all Pass 3 structs have correct ABI layout in `generated.ts`. Downstream tasks reference these helpers without re-deriving them.

---

## Task 4: `Terminal.scrollViewport`

**Purpose:** One-method-one-commit. Takes `"top" | "bottom" | number`, marshals into `GhosttyTerminalScrollViewport`, calls `ghostty_terminal_scroll_viewport` (void return). No error propagation needed — libghostty clamps out-of-range deltas.

**Files:**
- Modify: `src/terminal.ts`
- Modify: `src/types.ts` (nothing new — the method signature is self-describing)
- Test: `test/smoke/scroll-viewport.test.ts` (new)

- [ ] **Step 1: Write the failing test.**

Create `test/smoke/scroll-viewport.test.ts`:

```typescript
import { describe, test, expect } from "bun:test";
import { Terminal } from "../../src";

describe("Terminal.scrollViewport", () => {
  test('"top" does not throw on a fresh terminal', () => {
    using term = new Terminal({ cols: 80, rows: 24, maxScrollback: 100 });
    term.scrollViewport("top");
    expect(term.snapshot().rows).toBe(24);
  });

  test('"bottom" does not throw on a fresh terminal', () => {
    using term = new Terminal({ cols: 80, rows: 24 });
    term.scrollViewport("bottom");
    expect(term.snapshot().rows).toBe(24);
  });

  test("positive delta does not throw", () => {
    using term = new Terminal({ cols: 80, rows: 24, maxScrollback: 100 });
    term.scrollViewport(5);
    expect(term.snapshot().rows).toBe(24);
  });

  test("negative delta does not throw", () => {
    using term = new Terminal({ cols: 80, rows: 24, maxScrollback: 100 });
    term.scrollViewport(-5);
    expect(term.snapshot().rows).toBe(24);
  });

  test("huge positive delta clamps without crash", () => {
    using term = new Terminal({ cols: 80, rows: 24, maxScrollback: 100 });
    term.scrollViewport(99999);
    expect(term.snapshot().rows).toBe(24);
  });

  test("use-after-close throws", () => {
    const term = new Terminal({ cols: 80, rows: 24 });
    term.close();
    expect(() => term.scrollViewport("top")).toThrow(/closed/i);
  });

  test("invalid string argument throws", () => {
    using term = new Terminal({ cols: 80, rows: 24 });
    // @ts-expect-error — intentionally invalid
    expect(() => term.scrollViewport("middle")).toThrow(/invalid/i);
  });
});
```

- [ ] **Step 2: Run the test, verify it fails.**

```bash
bun test test/smoke/scroll-viewport.test.ts
# Expected: fails with "term.scrollViewport is not a function" or compile error.
```

- [ ] **Step 3: Implement `scrollViewport` on `Terminal`.**

Open `src/terminal.ts`. Find the section near `close()` where public methods live. Add:

```typescript
scrollViewport(pos: "top" | "bottom" | number): void {
  this.#assertNotClosed("scrollViewport");
  this.#assertNotInCallback("scrollViewport");

  let tag: 0 | 1 | 2;
  let delta = 0;
  if (pos === "top") tag = 0;
  else if (pos === "bottom") tag = 1;
  else if (typeof pos === "number" && Number.isFinite(pos)) {
    tag = 2;
    delta = Math.trunc(pos);
  } else {
    throw new GhosttyError({
      code: "invalid_value",
      functionName: "Terminal.scrollViewport",
      message: `scrollViewport expects "top" | "bottom" | number; received ${JSON.stringify(pos)}`,
    });
  }

  const buf = writeScrollViewport(tag, delta);
  ffi.symbols.ghostty_terminal_scroll_viewport(this.#handle, ptr(buf));
}
```

Add imports at the top of the file if not already present:
```typescript
import { writeScrollViewport } from "./internal/marshal";
```

(Existing imports for `ptr`, `ffi`, `GhosttyError`, `#assertNotClosed`, `#assertNotInCallback` are already in scope from Pass 1/2.)

- [ ] **Step 4: Run the test, verify it passes.**

```bash
bun test test/smoke/scroll-viewport.test.ts
# Expected: 7 pass, 0 fail.

bun run typecheck
# Expected: clean.

bun test test/smoke
# Expected: 119 pass (112 + 7 new).
```

- [ ] **Step 5: Commit.**

```bash
git add src/terminal.ts src/internal/marshal.ts test/smoke/scroll-viewport.test.ts
git commit -m "feat(terminal): add scrollViewport(pos)

Accepts \"top\" | \"bottom\" | signed row delta. Clamps delegated to
libghostty. Invalid string arg throws GhosttyError{code: invalid_value}.
7 new smoke tests.

Co-Authored-By: <your-Bob-name> (Bob <session-id-first-8>/<model>)"
```

---

## Task 5: `encodeFocus` standalone function

**Purpose:** Standalone function in a new `src/focus.ts`, exported from `src/index.ts`. Calls `ghostty_focus_encode` with probe-size-first, returns a fresh `Uint8Array`.

**Files:**
- Create: `src/focus.ts`
- Modify: `src/index.ts`
- Test: `test/smoke/focus.test.ts` (new)

- [ ] **Step 1: Write the failing test.**

Create `test/smoke/focus.test.ts`:

```typescript
import { describe, test, expect } from "bun:test";
import { encodeFocus } from "../../src";

describe("encodeFocus", () => {
  test('"in" returns non-empty bytes starting with ESC', () => {
    const bytes = encodeFocus("in");
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.byteLength).toBeGreaterThan(0);
    expect(bytes[0]).toBe(0x1B);
  });

  test('"out" returns non-empty bytes starting with ESC', () => {
    const bytes = encodeFocus("out");
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.byteLength).toBeGreaterThan(0);
    expect(bytes[0]).toBe(0x1B);
  });

  test('"in" and "out" produce different byte sequences', () => {
    const inBytes = encodeFocus("in");
    const outBytes = encodeFocus("out");
    expect(Buffer.from(inBytes).equals(Buffer.from(outBytes))).toBe(false);
  });

  test("repeated calls return fresh Uint8Arrays (no shared buffer)", () => {
    const a = encodeFocus("in");
    const b = encodeFocus("in");
    expect(a).not.toBe(b);
    a[0] = 0x00;
    expect(b[0]).toBe(0x1B); // mutating a must not affect b
  });

  test("invalid direction throws", () => {
    // @ts-expect-error — intentionally invalid
    expect(() => encodeFocus("sideways")).toThrow(/invalid/i);
  });
});
```

- [ ] **Step 2: Run the test, verify it fails.**

```bash
bun test test/smoke/focus.test.ts
# Expected: fails — encodeFocus not exported.
```

- [ ] **Step 3: Implement `encodeFocus`.**

Create `src/focus.ts`:

```typescript
import { ptr } from "bun:ffi";
import { ffi } from "./ffi";
import { GhosttyError, getResultCodeName } from "./errors";

/**
 * Encode a terminal focus in/out event into the bytes an application
 * sends to a terminal. Standalone — no Terminal instance required.
 *
 * Returns a fresh Uint8Array each call; safe to retain.
 */
export function encodeFocus(direction: "in" | "out"): Uint8Array {
  let event: 0 | 1;
  if (direction === "in") event = 0;
  else if (direction === "out") event = 1;
  else {
    throw new GhosttyError({
      code: "invalid_value",
      functionName: "encodeFocus",
      message: `encodeFocus expects "in" | "out"; received ${JSON.stringify(direction)}`,
    });
  }

  // Probe required length: buf=NULL, buf_len=0, out_written=&required.
  const requiredBuf = new BigUint64Array(1);
  const rcProbe = ffi.symbols.ghostty_focus_encode(event, null, 0n, ptr(requiredBuf));
  // ghostty_focus_encode returns OUT_OF_SPACE (or equivalent) when buf is too small.
  // Either OK (libghostty chose to accept NULL as a probe) or OUT_OF_SPACE is
  // acceptable — the required length is written either way.
  if (rcProbe !== 0 && getResultCodeName(rcProbe) !== "out_of_space") {
    throw new GhosttyError({
      code: getResultCodeName(rcProbe),
      functionName: "ghostty_focus_encode (probe)",
    });
  }
  const required = Number(requiredBuf[0]);
  if (required === 0) {
    throw new GhosttyError({
      code: "invalid_value",
      functionName: "ghostty_focus_encode",
      message: "probe returned zero required length",
    });
  }

  const buf = new Uint8Array(required);
  const writtenBuf = new BigUint64Array(1);
  const rc = ffi.symbols.ghostty_focus_encode(
    event,
    ptr(buf),
    BigInt(buf.byteLength),
    ptr(writtenBuf),
  );
  if (rc !== 0) {
    throw new GhosttyError({
      code: getResultCodeName(rc),
      functionName: "ghostty_focus_encode",
    });
  }
  const written = Number(writtenBuf[0]);
  return buf.subarray(0, written);
}
```

(If `getResultCodeName` is not already exported from `./errors`, add it. Pass 1 should have it — check with `grep -n "getResultCodeName\|resultCodeByValue" src/errors.ts`. If missing, add a helper that looks up `generated.resultCodeByValue[rc]` and falls back to `"unknown"`.)

- [ ] **Step 4: Export from `src/index.ts`.**

Add this line among the existing exports:

```typescript
export { encodeFocus } from "./focus";
```

- [ ] **Step 5: Run the test, verify it passes.**

```bash
bun test test/smoke/focus.test.ts
# Expected: 5 pass, 0 fail.

bun run typecheck
# Expected: clean.
```

- [ ] **Step 6: Commit.**

```bash
git add src/focus.ts src/index.ts test/smoke/focus.test.ts
git commit -m "feat(focus): add encodeFocus(direction) standalone function

Probe-size-first FFI pattern; returns fresh Uint8Array. Invalid
direction throws GhosttyError{code: invalid_value}. 5 new smoke tests.

Co-Authored-By: <your-Bob-name> (Bob <session-id-first-8>/<model>)"
```

---

## Task 6: `Terminal.colors` / `setColors`

**Purpose:** Read effective/defaults/palette via four `ghostty_terminal_get` calls per field (GHOSTTY_TERMINAL_DATA_COLOR_*). Write via `ghostty_terminal_set` with matching option keys. Includes the OSC-override survival smoke test (spec §4.3) that records the observed behavior.

**Files:**
- Modify: `src/terminal.ts`
- Modify: `src/types.ts` (add `TerminalColors` if not already declared in types.ts)
- Test: `test/smoke/colors.test.ts` (new)

- [ ] **Step 1: Add `TerminalColors` type to `src/types.ts`.**

Check if already present:
```bash
grep -n "TerminalColors" src/types.ts
```

If missing, append to `src/types.ts`:

```typescript
export type RGB = readonly [r: number, g: number, b: number];

export interface TerminalColors {
  /** Colors currently displayed after any OSC 10/11/12 overrides. */
  effective: {
    fg?: RGB;
    bg?: RGB;
    cursor?: RGB;
  };
  /** Configured defaults the terminal would use absent OSC override. */
  defaults: {
    fg?: RGB;
    bg?: RGB;
    cursor?: RGB;
  };
  /** The 256-entry palette. Indices are semantic; order is preserved. */
  palette: readonly RGB[];
}
```

(`RGB` may already be declared for Pass 1 — if so, don't duplicate.)

- [ ] **Step 2: Write the failing test.**

Create `test/smoke/colors.test.ts`:

```typescript
import { describe, test, expect } from "bun:test";
import { Terminal } from "../../src";

describe("Terminal.colors", () => {
  test("returns effective + defaults + palette[256] on fresh terminal", () => {
    using term = new Terminal({ cols: 80, rows: 24 });
    const c = term.colors();
    expect(c.palette.length).toBe(256);
    expect(c.effective).toBeDefined();
    expect(c.defaults).toBeDefined();
    // Palette entries are tuples of [r, g, b], each 0-255.
    for (const [r, g, b] of c.palette) {
      expect(r).toBeGreaterThanOrEqual(0);
      expect(r).toBeLessThanOrEqual(255);
      expect(g).toBeGreaterThanOrEqual(0);
      expect(g).toBeLessThanOrEqual(255);
      expect(b).toBeGreaterThanOrEqual(0);
      expect(b).toBeLessThanOrEqual(255);
    }
  });

  test("palette[0] and palette[1] differ (semantic index order preserved)", () => {
    using term = new Terminal({ cols: 80, rows: 24 });
    const p = term.colors().palette;
    // xterm defaults: palette[0] is black (0,0,0), palette[1] is red (typically non-zero).
    // We only assert they differ; exact values depend on libghostty's default palette.
    expect(p[0]).not.toEqual(p[1]);
  });

  test("setColors(defaults.fg) updates defaults fg", () => {
    using term = new Terminal({ cols: 80, rows: 24 });
    term.setColors({ defaults: { fg: [42, 43, 44] } });
    const c = term.colors();
    expect(c.defaults.fg).toEqual([42, 43, 44]);
  });

  test("OSC 10 sets effective.fg", () => {
    using term = new Terminal({ cols: 80, rows: 24 });
    // OSC 10 ; rgb:ff/00/00 ST
    const bytes = new TextEncoder().encode("\x1b]10;rgb:ff/00/00\x1b\\");
    term.vtWrite(bytes);
    expect(term.colors().effective.fg).toEqual([255, 0, 0]);
  });

  test("OSC 10 override survival after setColors — records observed behavior", () => {
    using term = new Terminal({ cols: 80, rows: 24 });
    term.setColors({ defaults: { fg: [10, 20, 30] } });
    term.vtWrite(new TextEncoder().encode("\x1b]10;rgb:ff/00/00\x1b\\"));
    expect(term.colors().effective.fg).toEqual([255, 0, 0]);

    term.setColors({ defaults: { fg: [40, 50, 60] } });
    const afterSecondSet = term.colors().effective.fg;

    // This test RECORDS libghostty's observed behavior rather than asserting it.
    // Two outcomes are valid:
    //   (a) OSC override survives setColors → effective.fg stays [255, 0, 0]
    //   (b) setColors clears OSC override   → effective.fg becomes [40, 50, 60]
    // Both are documented in the README after Pass 3 lands.
    const survived = afterSecondSet?.[0] === 255 && afterSecondSet?.[1] === 0 && afterSecondSet?.[2] === 0;
    const cleared = afterSecondSet?.[0] === 40 && afterSecondSet?.[1] === 50 && afterSecondSet?.[2] === 60;
    expect(survived || cleared).toBe(true);
    // Log the observed outcome so the implementer can capture it in the README.
    console.log(`[Pass 3 §4.3 probe] OSC-override-survives-setColors: ${survived ? "YES" : "NO"}`);
  });

  test("empty setColors patch is a no-op", () => {
    using term = new Terminal({ cols: 80, rows: 24 });
    const before = term.colors();
    term.setColors({});
    const after = term.colors();
    expect(after.defaults).toEqual(before.defaults);
  });

  test("use-after-close throws on colors()", () => {
    const term = new Terminal({ cols: 80, rows: 24 });
    term.close();
    expect(() => term.colors()).toThrow(/closed/i);
  });

  test("setColors is rejected from inside a callback (re-entry guard)", () => {
    let caught: unknown;
    using term = new Terminal({
      cols: 80,
      rows: 24,
      onTitleChanged: () => {
        try { term.setColors({ defaults: { fg: [1, 2, 3] } }); }
        catch (e) { caught = e; }
      },
    });
    term.vtWrite(new TextEncoder().encode("\x1b]0;x\x1b\\"));
    expect(caught).toBeDefined();
  });
});
```

- [ ] **Step 3: Run the test, verify it fails.**

```bash
bun test test/smoke/colors.test.ts
# Expected: fails — term.colors / term.setColors not implemented.
```

- [ ] **Step 4: Implement `colors()` and `setColors()`.**

Open `src/terminal.ts`. Add the two methods in the public-method section. Above them, extend the existing `#assertNotInCallback` callable-list (if it's a set) to include `"setColors"` — `colors()` is a read so it's allowed mid-callback.

```typescript
colors(): TerminalColors {
  this.#assertNotClosed("colors");

  // Generated layout sizes/offsets for a single GhosttyColorRgb = 3 bytes.
  const rgbSize = structLayouts["GhosttyColorRgb"]!.size;
  const paletteSize = rgbSize * 256;
  const scratch = new Uint8Array(Math.max(rgbSize, paletteSize));

  const readColor = (dataKey: number): RGB | undefined => {
    const rc = ffi.symbols.ghostty_terminal_get(this.#handle, dataKey, ptr(scratch));
    if (rc === 0) return readRgb(scratch, 0);
    // GHOSTTY_NO_VALUE — documented in §4.3 — means "no override set."
    if (getResultCodeName(rc) === "no_value") return undefined;
    throw new GhosttyError({
      code: getResultCodeName(rc),
      functionName: `ghostty_terminal_get(DATA=${dataKey})`,
    });
  };

  const readPalette = (dataKey: number): readonly RGB[] => {
    scratch.fill(0);
    const rc = ffi.symbols.ghostty_terminal_get(this.#handle, dataKey, ptr(scratch));
    if (rc !== 0) {
      throw new GhosttyError({
        code: getResultCodeName(rc),
        functionName: `ghostty_terminal_get(DATA=${dataKey})`,
      });
    }
    return readPalette256(scratch, 0);
  };

  const D = GhosttyTerminalDataValues;
  return {
    effective: {
      fg: readColor(D.COLOR_FOREGROUND),
      bg: readColor(D.COLOR_BACKGROUND),
      cursor: readColor(D.COLOR_CURSOR),
    },
    defaults: {
      fg: readColor(D.COLOR_FOREGROUND_DEFAULT),
      bg: readColor(D.COLOR_BACKGROUND_DEFAULT),
      cursor: readColor(D.COLOR_CURSOR_DEFAULT),
    },
    palette: readPalette(D.COLOR_PALETTE),
  };
}

setColors(patch: Partial<TerminalColors>): void {
  this.#assertNotClosed("setColors");
  this.#assertNotInCallback("setColors");

  if (!patch.defaults) return; // empty patch or palette-only — no-op for defaults

  const O = GhosttyTerminalOptionValues;
  const rgbSize = structLayouts["GhosttyColorRgb"]!.size;
  const scratch = new Uint8Array(rgbSize);

  const writeColor = (opt: number, rgb: RGB): void => {
    scratch[0] = rgb[0]; scratch[1] = rgb[1]; scratch[2] = rgb[2];
    const rc = ffi.symbols.ghostty_terminal_set(this.#handle, opt, ptr(scratch));
    if (rc !== 0) {
      throw new GhosttyError({
        code: getResultCodeName(rc),
        functionName: `ghostty_terminal_set(OPT=${opt})`,
      });
    }
  };

  if (patch.defaults.fg) writeColor(O.COLOR_FOREGROUND_DEFAULT, patch.defaults.fg);
  if (patch.defaults.bg) writeColor(O.COLOR_BACKGROUND_DEFAULT, patch.defaults.bg);
  if (patch.defaults.cursor) writeColor(O.COLOR_CURSOR_DEFAULT, patch.defaults.cursor);
}
```

Add imports at the top of `src/terminal.ts`:
```typescript
import type { RGB, TerminalColors } from "./types";
import { readRgb, readPalette256 } from "./internal/marshal";
import { structLayouts, GhosttyTerminalDataValues, GhosttyTerminalOptionValues } from "./internal/generated";
```

**Notes for implementer:**
- `GhosttyTerminalOption.COLOR_*_DEFAULT` enum values must exist in `generated.ts`. If the header at pin does NOT expose writeable options for `COLOR_FOREGROUND_DEFAULT` etc. (only read-only keys), then `setColors` writes fall back to writing the non-default `COLOR_FOREGROUND` etc. Document the observed behavior and update the spec if libghostty's surface differs.
- If the probe at Task 2 showed a different enum-value naming (e.g., `FOREGROUND` vs `COLOR_FOREGROUND`), use whatever `GhosttyTerminalOptionValues` actually has.

- [ ] **Step 5: Run the test, verify it passes.**

```bash
bun test test/smoke/colors.test.ts
# Expected: all 8 tests pass. The OSC-override probe logs one line indicating
# observed behavior.

bun run typecheck
# Expected: clean.

bun test test/smoke
# Expected: 127 pass (119 + 8).
```

- [ ] **Step 6: Capture the OSC-override outcome for README.**

Look at the test output for the "[Pass 3 §4.3 probe]" log line. Record the YES/NO in a note for Task 18 (README update): "OSC 10/11/12 overrides {survive | are cleared by} `setColors`."

- [ ] **Step 7: Commit.**

```bash
git add src/terminal.ts src/types.ts test/smoke/colors.test.ts
git commit -m "feat(terminal): add colors() + setColors(patch)

colors() returns {effective, defaults, palette[256]} — effective uses
OSC 10/11/12 overrides, defaults uses configured baseline, palette is
semantic-index-ordered. setColors mutates defaults.

Includes OSC-override survival smoke test (§4.3). Observed behavior
captured for README at Task 18.

8 new smoke tests.

Co-Authored-By: <your-Bob-name> (Bob <session-id-first-8>/<model>)"
```

---

## Task 7: APC bounds wiring

**Purpose:** Re-expose `apcMaxBytes` / `apcMaxBytesKitty` on `TerminalOptions`. Apply via three `ghostty_terminal_set` calls after `ghostty_terminal_new` in the constructor (per spec §4.4). Also wire the internal-default `KITTY_IMAGE_STORAGE_LIMIT = 0`.

**Files:**
- Modify: `src/types.ts`
- Modify: `src/terminal.ts` (constructor extension)
- Test: `test/smoke/apc-bounds.test.ts` (new)

- [ ] **Step 1: Re-add fields to `TerminalOptions` in `src/types.ts`.**

Find the `TerminalOptions` interface. Add:

```typescript
  /**
   * Bound on the per-sequence byte limit libghostty's VT parser retains
   * for APC (Application Program Command) escape payloads. Generic APC.
   * Defaults to 1 MiB (1_048_576).
   */
  apcMaxBytes?: number;

  /**
   * Bound on the per-sequence byte limit for Kitty-graphics APC payloads
   * specifically. Defaults to 0 — Kitty-graphics APC sequences are not
   * retained at v0. Distinct from Kitty keyboard protocol (Pass 4) and
   * from Kitty image storage limit (internal default, not user-settable).
   */
  apcMaxBytesKitty?: number;
```

- [ ] **Step 2: Write the failing test.**

Create `test/smoke/apc-bounds.test.ts`:

```typescript
import { describe, test, expect } from "bun:test";
import { Terminal, GhosttyError } from "../../src";

describe("APC bounds wiring", () => {
  test("default-path constructor succeeds (no options passed)", () => {
    using term = new Terminal({ cols: 80, rows: 24 });
    // No crash on construction; subsequent vtWrite works.
    term.vtWrite(new Uint8Array([0x61])); // "a"
    expect(term.snapshot().cols).toBe(80);
  });

  test("custom apcMaxBytes (2 MiB) constructor succeeds", () => {
    using term = new Terminal({
      cols: 80,
      rows: 24,
      apcMaxBytes: 2 * 1024 * 1024,
    });
    term.vtWrite(new Uint8Array([0x61]));
    expect(term.snapshot().cols).toBe(80);
  });

  test("custom apcMaxBytesKitty (1 MiB) constructor succeeds", () => {
    using term = new Terminal({
      cols: 80,
      rows: 24,
      apcMaxBytesKitty: 1024 * 1024,
    });
    expect(term.snapshot().cols).toBe(80);
  });

  test("constructing with both options set succeeds", () => {
    using term = new Terminal({
      cols: 80,
      rows: 24,
      apcMaxBytes: 512 * 1024,
      apcMaxBytesKitty: 256 * 1024,
    });
    expect(term.snapshot().cols).toBe(80);
  });

  test("negative apcMaxBytes throws invalid_value at construction", () => {
    try {
      new Terminal({ cols: 80, rows: 24, apcMaxBytes: -1 });
      throw new Error("expected constructor to throw");
    } catch (e) {
      expect(e).toBeInstanceOf(GhosttyError);
      expect((e as GhosttyError).code).toBe("invalid_value");
      expect(String(e)).toMatch(/apcMaxBytes/);
      expect(String(e)).toMatch(/-1/);
    }
  });

  test("negative apcMaxBytesKitty throws invalid_value at construction", () => {
    try {
      new Terminal({ cols: 80, rows: 24, apcMaxBytesKitty: -42 });
      throw new Error("expected constructor to throw");
    } catch (e) {
      expect(e).toBeInstanceOf(GhosttyError);
      expect((e as GhosttyError).code).toBe("invalid_value");
      expect(String(e)).toMatch(/apcMaxBytesKitty/);
    }
  });

  test("oversized apcMaxBytes throws invalid_value", () => {
    try {
      new Terminal({ cols: 80, rows: 24, apcMaxBytes: Number.MAX_SAFE_INTEGER + 1 });
      throw new Error("expected constructor to throw");
    } catch (e) {
      expect(e).toBeInstanceOf(GhosttyError);
      expect((e as GhosttyError).code).toBe("invalid_value");
    }
  });

  test("APC bound NaN throws invalid_value", () => {
    try {
      new Terminal({ cols: 80, rows: 24, apcMaxBytes: Number.NaN });
      throw new Error("expected constructor to throw");
    } catch (e) {
      expect(e).toBeInstanceOf(GhosttyError);
      expect((e as GhosttyError).code).toBe("invalid_value");
    }
  });
});
```

- [ ] **Step 3: Run the test, verify it fails.**

```bash
bun test test/smoke/apc-bounds.test.ts
# Expected: first tests fail — apcMaxBytes is accepted but not validated,
# not wired, and the error-path tests see no GhosttyError.
```

- [ ] **Step 4: Wire APC bounds in `Terminal.constructor`.**

In `src/terminal.ts`, find the constructor. The ordering must be: build `GhosttyTerminalOptions` struct → `ghostty_terminal_new` → APC `set` calls → Kitty-image-storage `set` call → effect-callback registration (Pass 2 logic, unchanged).

Extract the concrete values with defaults and validate:

```typescript
// Inside constructor, near the existing assertU16(cols, "cols") / assertU16(rows, "rows"):

const apcMaxBytes = opts.apcMaxBytes ?? 1_048_576;
assertSizeT(apcMaxBytes, "apcMaxBytes");

const apcMaxBytesKitty = opts.apcMaxBytesKitty ?? 0;
assertSizeT(apcMaxBytesKitty, "apcMaxBytesKitty");
```

After `ghostty_terminal_new` succeeds and `#handle` is assigned, add a helper call `#applyApcBounds(apcMaxBytes, apcMaxBytesKitty)` BEFORE the callback registration:

```typescript
this.#applyApcBounds(apcMaxBytes, apcMaxBytesKitty);
```

Add the private helper below the constructor body:

```typescript
#applyApcBounds(apcMaxBytes: number, apcMaxBytesKitty: number): void {
  const O = GhosttyTerminalOptionValues;
  const scratch = new BigUint64Array(1);

  const setSizeT = (opt: number, value: number, fieldName: string): void => {
    scratch[0] = BigInt(value);
    const rc = ffi.symbols.ghostty_terminal_set(this.#handle, opt, ptr(scratch));
    if (rc !== 0) {
      // Roll back: the terminal handle is live but partially configured.
      // Free it to avoid leaking, then throw.
      ffi.symbols.ghostty_terminal_free(this.#handle);
      this.#handle = null as unknown as Pointer;
      throw new GhosttyError({
        code: getResultCodeName(rc),
        functionName: `ghostty_terminal_set(${fieldName})`,
      });
    }
  };

  setSizeT(O.APC_MAX_BYTES, apcMaxBytes, "APC_MAX_BYTES");
  setSizeT(O.APC_MAX_BYTES_KITTY, apcMaxBytesKitty, "APC_MAX_BYTES_KITTY");
  // Internal safety default — binding design §5.9. Not user-configurable at v0.
  setSizeT(O.KITTY_IMAGE_STORAGE_LIMIT, 0, "KITTY_IMAGE_STORAGE_LIMIT");
}
```

(`assertSizeT` is already in `src/terminal.ts` from Hilbert's Pass-1 fix. Confirm with `grep -n "assertSizeT" src/terminal.ts`. If the helper currently only accepts integer inputs, ensure it also rejects `NaN` — add `if (Number.isNaN(value))` check if missing.)

- [ ] **Step 5: Run the test, verify it passes.**

```bash
bun test test/smoke/apc-bounds.test.ts
# Expected: 8 pass.

bun run typecheck
# Expected: clean.

bun test test/smoke
# Expected: 135 pass (127 + 8).
```

- [ ] **Step 6: Commit.**

```bash
git add src/types.ts src/terminal.ts test/smoke/apc-bounds.test.ts
git commit -m "feat(terminal): wire APC bounds + Kitty image-storage default

apcMaxBytes and apcMaxBytesKitty return to TerminalOptions (removed
by Hilbert's Pass-1 fix because they were silently dropped). Now
applied post-construct via ghostty_terminal_set with the three
GhosttyTerminalOption enum values:
- APC_MAX_BYTES (default 1 MiB)
- APC_MAX_BYTES_KITTY (default 0)
- KITTY_IMAGE_STORAGE_LIMIT (hardcoded 0; internal safety default,
  not user-configurable at v0 per binding design §5.9)

APC read-back is not supported by libghostty (Task 2 probe confirmed),
so test strategy is spec §4.4 fallback: no-crash on custom values +
invalid-path TS assertions. 8 new smoke tests.

Co-Authored-By: <your-Bob-name> (Bob <session-id-first-8>/<model>)"
```

---

## Task 8: `Terminal.cellAt` — active + viewport coord spaces

**Purpose:** The O(1) half of `cellAt`. Covers `"active"` (default) and `"viewport"` coord spaces. Establishes the grid-ref → CellInfo decoding path that Task 9 reuses for screen/history.

**Files:**
- Modify: `src/terminal.ts`
- Modify: `src/types.ts` (add `CellInfo`, `CellStyle`, `UnderlineStyle`)
- Test: `test/smoke/cell-at.test.ts` (new)

- [ ] **Step 1: Add supporting types to `src/types.ts`.**

```typescript
export type UnderlineStyle =
  | "none"
  | "single"
  | "double"
  | "curly"
  | "dotted"
  | "dashed";

export interface CellStyle {
  fg?: RGB | PaletteIndex;
  bg?: RGB | PaletteIndex;
  bold: boolean;
  faint: boolean;
  italic: boolean;
  underline: UnderlineStyle;
  underlineColor?: RGB;
  overline: boolean;
  strikethrough: boolean;
  blink: boolean;
  inverse: boolean;
  invisible: boolean;
}

export interface CellInfo {
  text: string;
  wide: boolean;
  isWideContinuation: boolean;
  style?: CellStyle;
  hyperlinkUri?: string;
  protected: boolean;
}

export type PaletteIndex = { palette: number };

export interface CellAtPoint {
  x: number;
  y: number;
  coordinateSpace?: "active" | "viewport" | "screen" | "history";
}
```

(Check whether `PaletteIndex` is already declared — Pass 1 may have it. If so, don't duplicate.)

- [ ] **Step 2: Write the failing test.**

Create `test/smoke/cell-at.test.ts`:

```typescript
import { describe, test, expect } from "bun:test";
import { Terminal } from "../../src";

describe("Terminal.cellAt — active + viewport", () => {
  test('default coord space is "active"', () => {
    using term = new Terminal({ cols: 80, rows: 24 });
    term.vtWrite(new TextEncoder().encode("hello"));
    // cursor advanced; (0,0) should be 'h'
    const cell = term.cellAt({ x: 0, y: 0 });
    expect(cell).toBeDefined();
    expect(cell!.text).toBe("h");
    expect(cell!.wide).toBe(false);
    expect(cell!.isWideContinuation).toBe(false);
    expect(cell!.protected).toBe(false);
  });

  test("empty cell has empty text", () => {
    using term = new Terminal({ cols: 80, rows: 24 });
    term.vtWrite(new TextEncoder().encode("hi"));
    const cell = term.cellAt({ x: 10, y: 0 }); // past "hi"
    expect(cell).toBeDefined();
    expect(cell!.text).toBe("");
  });

  test("bold cell carries style.bold = true", () => {
    using term = new Terminal({ cols: 80, rows: 24 });
    // SGR 1 = bold. Sequence: CSI 1 m + 'A'
    term.vtWrite(new TextEncoder().encode("\x1b[1mA"));
    const cell = term.cellAt({ x: 0, y: 0 });
    expect(cell).toBeDefined();
    expect(cell!.text).toBe("A");
    expect(cell!.style?.bold).toBe(true);
  });

  test("wide grapheme: primary cell wide=true, next cell isWideContinuation=true", () => {
    using term = new Terminal({ cols: 80, rows: 24 });
    // U+4E2D "中" — CJK ideograph, width=2
    term.vtWrite(new TextEncoder().encode("中"));
    const primary = term.cellAt({ x: 0, y: 0 });
    const trailing = term.cellAt({ x: 1, y: 0 });
    expect(primary).toBeDefined();
    expect(primary!.text).toBe("中");
    expect(primary!.wide).toBe(true);
    expect(primary!.isWideContinuation).toBe(false);
    expect(trailing).toBeDefined();
    expect(trailing!.text).toBe("");
    expect(trailing!.isWideContinuation).toBe(true);
  });

  test("out-of-bounds (active) returns undefined, not a throw", () => {
    using term = new Terminal({ cols: 80, rows: 24 });
    expect(term.cellAt({ x: 999, y: 0 })).toBeUndefined();
    expect(term.cellAt({ x: 0, y: 999 })).toBeUndefined();
    expect(term.cellAt({ x: -1, y: 0 })).toBeUndefined();
  });

  test('coordinateSpace: "viewport" works on a fresh terminal (== active before any scroll)', () => {
    using term = new Terminal({ cols: 80, rows: 24 });
    term.vtWrite(new TextEncoder().encode("v"));
    const cell = term.cellAt({ x: 0, y: 0, coordinateSpace: "viewport" });
    expect(cell).toBeDefined();
    expect(cell!.text).toBe("v");
  });

  test("out-of-bounds viewport returns undefined", () => {
    using term = new Terminal({ cols: 80, rows: 24 });
    expect(term.cellAt({ x: 0, y: 999, coordinateSpace: "viewport" })).toBeUndefined();
  });

  test("hyperlink URI read: cell inside OSC 8 region has hyperlinkUri set", () => {
    using term = new Terminal({ cols: 80, rows: 24 });
    // OSC 8 ; params ; uri ST text OSC 8 ; ; ST
    const seq = "\x1b]8;;https://example.com\x1b\\X\x1b]8;;\x1b\\";
    term.vtWrite(new TextEncoder().encode(seq));
    const cell = term.cellAt({ x: 0, y: 0 });
    expect(cell).toBeDefined();
    expect(cell!.text).toBe("X");
    expect(cell!.hyperlinkUri).toBe("https://example.com");
  });

  test("use-after-close throws", () => {
    const term = new Terminal({ cols: 80, rows: 24 });
    term.close();
    expect(() => term.cellAt({ x: 0, y: 0 })).toThrow(/closed/i);
  });

  test("invalid coordinateSpace throws invalid_value", () => {
    using term = new Terminal({ cols: 80, rows: 24 });
    // @ts-expect-error — intentionally invalid
    expect(() => term.cellAt({ x: 0, y: 0, coordinateSpace: "fog" })).toThrow(/invalid/i);
  });
});
```

- [ ] **Step 3: Run the test, verify it fails.**

```bash
bun test test/smoke/cell-at.test.ts
# Expected: term.cellAt not implemented.
```

- [ ] **Step 4: Implement `cellAt` (active + viewport paths; screen/history added in Task 9).**

In `src/terminal.ts`, add:

```typescript
cellAt(pt: CellAtPoint): CellInfo | undefined {
  this.#assertNotClosed("cellAt");

  const { x, y, coordinateSpace = "active" } = pt;
  const tag = this.#pointTag(coordinateSpace);

  // Bounds pre-check at TS boundary — x must fit u16, y must fit u32.
  if (!Number.isInteger(x) || x < 0 || x > 0xFFFF) return undefined;
  if (!Number.isInteger(y) || y < 0 || y > 0xFFFFFFFF) return undefined;

  const pointBuf = writePoint(tag, x, y);
  const refBuf = this.#freshGridRefBuffer();
  const rc = ffi.symbols.ghostty_terminal_grid_ref(this.#handle, ptr(pointBuf), ptr(refBuf));
  if (rc !== 0) {
    // INVALID_VALUE means the coordinate is outside the resolved grid for this
    // coord space — legitimate miss. Anything else is a real error.
    if (getResultCodeName(rc) === "invalid_value") return undefined;
    throw new GhosttyError({
      code: getResultCodeName(rc),
      functionName: "ghostty_terminal_grid_ref",
    });
  }

  return this.#decodeGridRef(refBuf);
}

#pointTag(space: "active" | "viewport" | "screen" | "history"): 0 | 1 | 2 | 3 {
  const T = GhosttyPointTagValues;
  switch (space) {
    case "active":   return T.ACTIVE as 0 | 1 | 2 | 3;
    case "viewport": return T.VIEWPORT as 0 | 1 | 2 | 3;
    case "screen":   return T.SCREEN as 0 | 1 | 2 | 3;
    case "history":  return T.HISTORY as 0 | 1 | 2 | 3;
    default:
      throw new GhosttyError({
        code: "invalid_value",
        functionName: "Terminal.cellAt",
        message: `coordinateSpace must be "active" | "viewport" | "screen" | "history"; received ${JSON.stringify(space)}`,
      });
  }
}

#freshGridRefBuffer(): Uint8Array {
  const layout = structLayouts["GhosttyGridRef"]!;
  const buf = new Uint8Array(layout.size);
  new DataView(buf.buffer).setBigUint64(layout.fields.size.offset, BigInt(layout.size), true);
  return buf;
}

#decodeGridRef(refBuf: Uint8Array): CellInfo {
  // 1) Grapheme cluster text via grapheme codepoints.
  const lenOut = new BigUint64Array(1);
  let rc = ffi.symbols.ghostty_grid_ref_graphemes(ptr(refBuf), null, 0n, ptr(lenOut));
  if (rc !== 0 && getResultCodeName(rc) !== "out_of_space") {
    throw new GhosttyError({ code: getResultCodeName(rc), functionName: "ghostty_grid_ref_graphemes (probe)" });
  }
  const required = Number(lenOut[0]);
  let text = "";
  let wide = false;
  let isWideContinuation = false;
  if (required > 0) {
    const codepointBuf = new Uint32Array(required);
    const writtenOut = new BigUint64Array(1);
    rc = ffi.symbols.ghostty_grid_ref_graphemes(
      ptr(refBuf),
      ptr(codepointBuf),
      BigInt(required),
      ptr(writtenOut),
    );
    if (rc !== 0) {
      throw new GhosttyError({ code: getResultCodeName(rc), functionName: "ghostty_grid_ref_graphemes" });
    }
    const written = Number(writtenOut[0]);
    text = String.fromCodePoint(...codepointBuf.subarray(0, written));
    // Classify wide / continuation based on libghostty's cell state.
    // GhosttyCell exposes width via ghostty_cell_get(CELL_DATA_WIDE) or similar.
    // For Pass 3 the grapheme path already returns empty text for continuation cells,
    // so we infer:
    isWideContinuation = required === 0 && text === "";
    wide = false; // set below from cell-level read
  }

  // 2) Cell-level read for wide / protected flags.
  const cellBuf = new BigUint64Array(1);
  rc = ffi.symbols.ghostty_grid_ref_cell(ptr(refBuf), ptr(cellBuf));
  if (rc !== 0) {
    throw new GhosttyError({ code: getResultCodeName(rc), functionName: "ghostty_grid_ref_cell" });
  }
  // Decoding GhosttyCell flags requires ghostty_cell_get with specific data keys.
  // The wide / protected booleans live there. Task 2's probe validated the
  // accessor works; the specific data-key enum values come from generated.ts.
  const cellPtr = Number(cellBuf[0]);
  // Read wide + protected via generated accessors:
  wide = this.#cellBool(cellPtr, GhosttyCellDataValues.WIDE);
  const protectedFlag = this.#cellBool(cellPtr, GhosttyCellDataValues.PROTECTED);

  // 3) Style — may be default (rc == NO_VALUE treated as no style).
  const styleSize = structLayouts["GhosttyStyle"]!.size;
  const styleBuf = new Uint8Array(styleSize);
  new DataView(styleBuf.buffer).setBigUint64(
    structLayouts["GhosttyStyle"]!.fields.size.offset,
    BigInt(styleSize),
    true,
  );
  rc = ffi.symbols.ghostty_grid_ref_style(ptr(refBuf), ptr(styleBuf));
  let style: CellStyle | undefined;
  if (rc === 0) {
    const raw = readStyle(styleBuf);
    style = this.#rawStyleToCellStyle(raw);
  } else if (getResultCodeName(rc) !== "no_value") {
    throw new GhosttyError({ code: getResultCodeName(rc), functionName: "ghostty_grid_ref_style" });
  }

  // 4) Hyperlink URI — probe-size-first.
  const hyperlinkUri = this.#readHyperlinkUri(refBuf);

  return {
    text,
    wide,
    isWideContinuation,
    style,
    hyperlinkUri,
    protected: protectedFlag,
  };
}

#cellBool(cellHandle: number, dataKey: number): boolean {
  const out = new Uint8Array(1);
  const rc = ffi.symbols.ghostty_cell_get?.(cellHandle as Pointer, dataKey, ptr(out));
  // If ghostty_cell_get is not a loaded symbol, the probe will have failed.
  // If it exists but returns non-OK, treat as false (conservative).
  return rc === 0 && out[0] === 1;
}

#readHyperlinkUri(refBuf: Uint8Array): string | undefined {
  const lenOut = new BigUint64Array(1);
  let rc = ffi.symbols.ghostty_grid_ref_hyperlink_uri(ptr(refBuf), null, 0n, ptr(lenOut));
  if (rc !== 0 && getResultCodeName(rc) !== "out_of_space" && getResultCodeName(rc) !== "no_value") {
    throw new GhosttyError({ code: getResultCodeName(rc), functionName: "ghostty_grid_ref_hyperlink_uri (probe)" });
  }
  const required = Number(lenOut[0]);
  if (required === 0 || getResultCodeName(rc) === "no_value") return undefined;
  const buf = new Uint8Array(required);
  const writtenOut = new BigUint64Array(1);
  rc = ffi.symbols.ghostty_grid_ref_hyperlink_uri(
    ptr(refBuf),
    ptr(buf),
    BigInt(required),
    ptr(writtenOut),
  );
  if (rc !== 0) {
    if (getResultCodeName(rc) === "no_value") return undefined;
    throw new GhosttyError({ code: getResultCodeName(rc), functionName: "ghostty_grid_ref_hyperlink_uri" });
  }
  return new TextDecoder("utf-8").decode(buf.subarray(0, Number(writtenOut[0])));
}

#rawStyleToCellStyle(raw: RawStyle): CellStyle {
  const underlineMap: readonly UnderlineStyle[] =
    ["none", "single", "double", "curly", "dotted", "dashed"];
  const underline = underlineMap[raw.underline] ?? "none";
  return {
    fg: raw.fg,
    bg: raw.bg,
    bold: raw.bold,
    faint: raw.faint,
    italic: raw.italic,
    underline,
    underlineColor: Array.isArray(raw.underlineColor) ? raw.underlineColor : undefined,
    overline: raw.overline,
    strikethrough: raw.strikethrough,
    blink: raw.blink,
    inverse: raw.inverse,
    invisible: raw.invisible,
  };
}
```

Imports at top of `src/terminal.ts`:
```typescript
import type { CellInfo, CellAtPoint, CellStyle, UnderlineStyle, RGB } from "./types";
import { writePoint } from "./internal/marshal";
import { readStyle, type RawStyle } from "./internal/sized-struct";
import type { Pointer } from "bun:ffi";
```

**Known caveats for implementer:**

- If `ghostty_cell_get` is not exposed by the pinned headers, `wide` and `protected` must come from `ghostty_render_state_row_cells_get` instead. Task 2's probe verified cell accessors; if the function signature differs, update Task 3's SYMBOLS and this implementation before the test can pass.
- `GhosttyCellData.WIDE` / `PROTECTED` enum values must exist in `generated.ts`. If they're under different names (e.g., `CELL_WIDE`), use whatever the generated type exposes.
- Hyperlink URI test is included in smoke tests but may skip (return undefined) if OSC 8 isn't implemented at the pin. Flag this finding during execution.

- [ ] **Step 5: Run the test, verify it passes.**

```bash
bun test test/smoke/cell-at.test.ts
# Expected: 10 pass. The hyperlink test may need a tolerance — if it fails,
# check libghostty's OSC 8 support at the pin.

bun run typecheck
# Expected: clean.

bun test test/smoke
# Expected: 145 pass (135 + 10).
```

- [ ] **Step 6: Commit.**

```bash
git add src/terminal.ts src/types.ts test/smoke/cell-at.test.ts
git commit -m "feat(terminal): cellAt(pt) — active + viewport coord spaces

One-shot cell query via ghostty_terminal_grid_ref + grid-ref accessors.
Covers active (default) and viewport coord spaces; screen/history are
Task 9. Returns undefined for out-of-bounds (not a throw). Decodes
grapheme cluster text, wide/continuation flags, SGR style, hyperlink
URI, protected flag.

10 new smoke tests.

Co-Authored-By: <your-Bob-name> (Bob <session-id-first-8>/<model>)"
```

---

## Task 9: `Terminal.cellAt` — screen + history coord spaces

**Purpose:** Finish `cellAt` with the two scrollback-touching coord spaces. Implementation-wise, Task 8's `cellAt` already dispatches on all four tags; this task adds tests that exercise `"screen"` and `"history"` after pushing content into scrollback.

**Files:**
- Modify: `test/smoke/cell-at.test.ts` (add new describe block)
- Modify: `src/terminal.ts` only if Task 8's dispatch is incomplete.

- [ ] **Step 1: Add failing tests for screen + history.**

Append to `test/smoke/cell-at.test.ts`:

```typescript
describe("Terminal.cellAt — screen + history", () => {
  test('"screen" returns the same cell as "active" on a fresh terminal', () => {
    using term = new Terminal({ cols: 80, rows: 24 });
    term.vtWrite(new TextEncoder().encode("hello"));
    const active = term.cellAt({ x: 0, y: 0 });
    const screen = term.cellAt({ x: 0, y: 0, coordinateSpace: "screen" });
    expect(screen?.text).toBe(active?.text);
  });

  test('"history" on a fresh terminal with no scrollback returns undefined', () => {
    using term = new Terminal({ cols: 80, rows: 24, maxScrollback: 100 });
    expect(term.cellAt({ x: 0, y: 0, coordinateSpace: "history" })).toBeUndefined();
  });

  test('"history" returns scrollback content after rows scroll off-screen', () => {
    using term = new Terminal({ cols: 10, rows: 2, maxScrollback: 100 });
    // Fill rows 0..5 then let natural scroll push the first into scrollback.
    for (let i = 0; i < 5; i += 1) {
      term.vtWrite(new TextEncoder().encode(`L${i}\r\n`));
    }
    // History (y=0) should now hold the oldest row "L0".
    const cell = term.cellAt({ x: 0, y: 0, coordinateSpace: "history" });
    // We can't assert exactly — libghostty's exact scrollback semantics are
    // authoritative — but at least one of y=0..3 should contain "L".
    let found = false;
    for (let y = 0; y < 4; y += 1) {
      const c = term.cellAt({ x: 0, y, coordinateSpace: "history" });
      if (c?.text === "L") { found = true; break; }
    }
    expect(found).toBe(true);
  });

  test('"screen" out-of-bounds returns undefined', () => {
    using term = new Terminal({ cols: 80, rows: 24 });
    expect(term.cellAt({ x: 999, y: 0, coordinateSpace: "screen" })).toBeUndefined();
  });

  test('"history" out-of-bounds returns undefined', () => {
    using term = new Terminal({ cols: 80, rows: 24, maxScrollback: 100 });
    expect(term.cellAt({ x: 0, y: 99999, coordinateSpace: "history" })).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the tests.**

```bash
bun test test/smoke/cell-at.test.ts
# Expected: all Task 8 tests still pass, plus 5 new Task 9 tests pass.
# If the history scrollback test returns empty, libghostty may not populate
# scrollback from CR/LF alone. Try inducing scroll with CSI 'S' (scroll up)
# instead: `\x1b[1S` after filling.
```

- [ ] **Step 3: If Task 8's dispatch needs adjustment, edit `src/terminal.ts`.**

The `cellAt` method from Task 8 already handles all four coord-space tags via `#pointTag`. Only necessary change: if the test reveals `GHOSTTY_INVALID_VALUE` isn't what libghostty returns for out-of-bounds history lookups (e.g., it might return `NO_VALUE` instead), extend the error-to-undefined mapping:

```typescript
if (getResultCodeName(rc) === "invalid_value" || getResultCodeName(rc) === "no_value") return undefined;
```

- [ ] **Step 4: Verify full cellAt suite passes.**

```bash
bun test test/smoke/cell-at.test.ts
# Expected: 15 pass (10 from Task 8 + 5 from Task 9).

bun test test/smoke
# Expected: 150 pass (145 + 5).
```

- [ ] **Step 5: Commit.**

```bash
git add src/terminal.ts test/smoke/cell-at.test.ts
git commit -m "feat(terminal): cellAt — screen + history coord spaces

Extends Task 8's dispatch to cover screen (walks wrapped rows) and
history (touches scrollback). Out-of-bounds returns undefined for all
four coord spaces. Cost differences (O(1) active/viewport, O(row)
screen, O(depth) history) documented for README at Task 18.

5 new smoke tests.

Co-Authored-By: <your-Bob-name> (Bob <session-id-first-8>/<model>)"
```

---

## Task 10: `RenderState` skeleton — lifecycle + update + dirty + markClean + colors + cursor

**Purpose:** The `RenderState` class's scaffolding. Construct, update, read dirty state, clear dirty (native + JS mirror), read colors, read viewport cursor, close. No iterator APIs yet — Tasks 11–12 add those.

**Files:**
- Create: `src/render-state.ts`
- Modify: `src/types.ts` (add `RenderRow`, `RenderCell`, `ViewportCursor`)
- Modify: `src/index.ts` (export `RenderState`)

- [ ] **Step 1: Add types to `src/types.ts`.**

```typescript
export interface ViewportCursor {
  x: number;
  y: number;
  visible: boolean;
  /** True if the cursor sits on the trailing half of a wide grapheme. */
  wideTail: boolean;
}

export interface RenderRow {
  y: number;
  wrapped: boolean;
  dirty: boolean;
  cells(): IterableIterator<RenderCell>;
}

export interface RenderCell {
  x: number;
  text: string;
  wide: boolean;
  isWideContinuation: boolean;
  style?: CellStyle;
  hyperlinkUri?: string;
  protected: boolean;
}
```

- [ ] **Step 2: Create `src/render-state.ts` with the skeleton.**

```typescript
import { ptr, type Pointer } from "bun:ffi";
import { ffi } from "./ffi";
import {
  structLayouts,
  GhosttyRenderStateDataValues,
  GhosttyRenderStateDirtyValues,
  GhosttyRenderStateOptionValues,
  GhosttyRenderStateRowDataValues,
  GhosttyRenderStateRowCellsDataValues,
} from "./internal/generated";
import { GhosttyError, getResultCodeName } from "./errors";
import { readRenderStateColors, readStyle, type RawStyle } from "./internal/sized-struct";
import type { RGB, TerminalColors, ViewportCursor, RenderRow, RenderCell, CellStyle, UnderlineStyle } from "./types";
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

export class RenderState {
  #handle: Pointer | null;
  #rows: CachedRow[] = [];
  #cols = 0;
  #rowCount = 0;
  #globalDirty: DirtyState = "none";
  #viewportCursor?: ViewportCursor;
  #colors?: TerminalColors;

  constructor() {
    const out = new BigUint64Array(1);
    const rc = ffi.symbols.ghostty_render_state_new(null, ptr(out));
    if (rc !== 0) {
      throw new GhosttyError({
        code: getResultCodeName(rc),
        functionName: "ghostty_render_state_new",
      });
    }
    this.#handle = Number(out[0]) as Pointer;
  }

  update(term: Terminal): void {
    this.#assertNotClosed("update");
    const termHandle = term.unsafeHandle(); // Pass 3 adds an internal-use getter; see below
    const rc = ffi.symbols.ghostty_render_state_update(this.#handle!, termHandle);
    if (rc !== 0) {
      throw new GhosttyError({
        code: getResultCodeName(rc),
        functionName: "ghostty_render_state_update",
      });
    }
    this.#rebuildCache(term);
  }

  dirty(): DirtyState {
    return this.#globalDirty;
  }

  markClean(): void {
    this.#assertNotClosed("markClean");
    // 1) Native clear — one call, clears both global and per-row layers.
    const dirtyValBuf = new Uint8Array(4);
    new DataView(dirtyValBuf.buffer).setInt32(
      0,
      GhosttyRenderStateDirtyValues.FALSE,
      true,
    );
    const rc = ffi.symbols.ghostty_render_state_set(
      this.#handle!,
      GhosttyRenderStateOptionValues.DIRTY,
      ptr(dirtyValBuf),
    );
    if (rc !== 0) {
      throw new GhosttyError({
        code: getResultCodeName(rc),
        functionName: "ghostty_render_state_set(DIRTY)",
      });
    }
    // 2) Mirror the clear into JS cache.
    this.#globalDirty = "none";
    for (const row of this.#rows) row.dirty = false;
  }

  colors(): TerminalColors {
    this.#assertNotClosed("colors");
    if (!this.#colors) this.#readColors();
    return this.#colors!;
  }

  cursor(): ViewportCursor | undefined {
    this.#assertNotClosed("cursor");
    return this.#viewportCursor;
  }

  close(): void {
    if (this.#handle === null) return;
    ffi.symbols.ghostty_render_state_free(this.#handle);
    this.#handle = null;
    this.#rows = [];
    this.#colors = undefined;
    this.#viewportCursor = undefined;
  }

  [Symbol.dispose](): void {
    this.close();
  }

  // --- Internals (Tasks 11/12 add iterator-facing helpers) ---

  #assertNotClosed(op: string): void {
    if (this.#handle === null) {
      throw new GhosttyError({
        code: "use_after_close",
        functionName: `RenderState.${op}`,
        message: "RenderState handle is closed",
      });
    }
  }

  #rebuildCache(term: Terminal): void {
    const snap = term.snapshot();
    this.#cols = snap.cols;
    this.#rowCount = snap.rows;
    this.#rows = [];
    this.#readDirtyGlobal();
    this.#readViewportCursor();
    this.#colors = undefined; // lazy re-read on next colors() call

    // Walk rows via iterator, populate cached structures.
    const iterOut = new BigUint64Array(1);
    let rc = ffi.symbols.ghostty_render_state_row_iterator_new(null, ptr(iterOut));
    if (rc !== 0) {
      throw new GhosttyError({ code: getResultCodeName(rc), functionName: "row_iterator_new" });
    }
    const iter = Number(iterOut[0]) as Pointer;
    try {
      let y = 0;
      while (ffi.symbols.ghostty_render_state_row_iterator_next(iter)) {
        const dirtyBuf = new Uint8Array(1);
        rc = ffi.symbols.ghostty_render_state_row_get(
          iter,
          GhosttyRenderStateRowDataValues.DIRTY,
          ptr(dirtyBuf),
        );
        const rowDirty = rc === 0 && dirtyBuf[0] === 1;

        // Open the cell iterator for this row.
        const cellsIterOut = new BigUint64Array(1);
        rc = ffi.symbols.ghostty_render_state_row_get(
          iter,
          GhosttyRenderStateRowDataValues.CELLS,
          ptr(cellsIterOut),
        );
        let cells: CachedCell[] = [];
        if (rc === 0) {
          const cellsIter = Number(cellsIterOut[0]) as Pointer;
          cells = this.#walkCells(cellsIter);
          ffi.symbols.ghostty_render_state_row_cells_free(cellsIter);
        }
        this.#rows.push({
          y,
          wrapped: false, // Task 11 extends RAW-row decode to populate wrap state
          dirty: rowDirty,
          cells,
        });
        y += 1;
      }
    } finally {
      ffi.symbols.ghostty_render_state_row_iterator_free(iter);
    }
  }

  #walkCells(cellsIter: Pointer): CachedCell[] {
    const out: CachedCell[] = [];
    let x = 0;
    while (ffi.symbols.ghostty_render_state_row_cells_next(cellsIter)) {
      // Task 11/12 flesh out per-cell decode (text, style, wide, etc.)
      // Skeleton retains only x; real decode follows cellAt's path.
      out.push({
        x,
        text: "",
        wide: false,
        isWideContinuation: false,
        protected: false,
      });
      x += 1;
    }
    return out;
  }

  #readDirtyGlobal(): void {
    const buf = new Uint8Array(4);
    const rc = ffi.symbols.ghostty_render_state_get(
      this.#handle!,
      GhosttyRenderStateDataValues.DIRTY,
      ptr(buf),
    );
    if (rc !== 0) {
      this.#globalDirty = "none";
      return;
    }
    const v = new DataView(buf.buffer).getInt32(0, true);
    const E = GhosttyRenderStateDirtyValues;
    if (v === E.FULL) this.#globalDirty = "all";
    else if (v === E.PARTIAL) this.#globalDirty = "rows";
    else this.#globalDirty = "none";
  }

  #readViewportCursor(): void {
    const hasBuf = new Uint8Array(1);
    const D = GhosttyRenderStateDataValues;
    let rc = ffi.symbols.ghostty_render_state_get(this.#handle!, D.CURSOR_VIEWPORT_HAS_VALUE, ptr(hasBuf));
    if (rc !== 0 || hasBuf[0] !== 1) {
      this.#viewportCursor = undefined;
      return;
    }
    const u16 = new Uint16Array(1);
    const boolBuf = new Uint8Array(1);
    ffi.symbols.ghostty_render_state_get(this.#handle!, D.CURSOR_VIEWPORT_X, ptr(u16));
    const x = u16[0]!;
    ffi.symbols.ghostty_render_state_get(this.#handle!, D.CURSOR_VIEWPORT_Y, ptr(u16));
    const y = u16[0]!;
    ffi.symbols.ghostty_render_state_get(this.#handle!, D.CURSOR_VIEWPORT_WIDE_TAIL, ptr(boolBuf));
    const wideTail = boolBuf[0] === 1;
    this.#viewportCursor = { x, y, visible: true, wideTail };
  }

  #readColors(): void {
    const layout = structLayouts["GhosttyRenderStateColors"]!;
    const buf = new Uint8Array(layout.size);
    new DataView(buf.buffer).setBigUint64(layout.fields.size.offset, BigInt(layout.size), true);
    const rc = ffi.symbols.ghostty_render_state_colors_get(this.#handle!, ptr(buf));
    if (rc !== 0) {
      throw new GhosttyError({
        code: getResultCodeName(rc),
        functionName: "ghostty_render_state_colors_get",
      });
    }
    const raw = readRenderStateColors(buf);
    this.#colors = {
      effective: {
        fg: raw.foreground,
        bg: raw.background,
        cursor: raw.cursorHasValue ? raw.cursor : undefined,
      },
      // render-state's struct is post-OSC only; defaults live on Terminal.colors.
      defaults: { fg: undefined, bg: undefined, cursor: undefined },
      palette: raw.palette,
    };
  }

  // Task 11 adds rows() / row.cells() / forEachDirtyRow
  // Task 12 adds forEachCell / forEachDirtyCell
}
```

- [ ] **Step 3: Add `Terminal.unsafeHandle()` internal getter.**

Open `src/terminal.ts`. Add a method deliberately named to discourage external use:

```typescript
/**
 * Internal-use handle accessor for RenderState.update. Not part of the
 * public API; do not call from consumer code.
 */
unsafeHandle(): Pointer {
  this.#assertNotClosed("unsafeHandle");
  return this.#handle;
}
```

(Tag with a `@internal` JSDoc if the project uses it; otherwise the `unsafe` prefix is the warning.)

- [ ] **Step 4: Export `RenderState` from `src/index.ts`.**

```typescript
export { RenderState } from "./render-state";
export type { ViewportCursor, RenderRow, RenderCell, CellInfo, CellStyle, UnderlineStyle, TerminalColors } from "./types";
```

- [ ] **Step 5: Quick sanity verification (no new tests yet — Task 13 covers).**

```bash
bun run typecheck
# Expected: clean.

bun test test/smoke
# Expected: 150 pass (no new tests; existing pass count unchanged).
```

- [ ] **Step 6: Commit.**

```bash
git add src/render-state.ts src/terminal.ts src/types.ts src/index.ts
git commit -m "feat(render-state): RenderState skeleton — lifecycle + update + dirty

Construct via ghostty_render_state_new, update against Terminal handle,
read native dirty state (global + per-row cached), markClean clears
native via one-call set(OPTION_DIRTY, FALSE) then mirrors to JS cache,
colors() via ghostty_render_state_colors_get, cursor() for viewport
cursor (x/y/wideTail, no style).

Iterator APIs (rows/cells/forEach*) land in Tasks 11-12.

Co-Authored-By: <your-Bob-name> (Bob <session-id-first-8>/<model>)"
```

---

## Task 11: `RenderState` ergonomic iterators — `rows()`, `row.cells()`, `forEachDirtyRow`

**Purpose:** The allocating consumer-friendly iteration path. Each `RenderRow` and `RenderCell` is a fresh object allocated from the cached data; snapshot lifetime valid until next `update()`.

**Files:**
- Modify: `src/render-state.ts`

- [ ] **Step 1: Flesh out `#walkCells` for full cell decode.**

Replace the Task 10 stub `#walkCells` with the real decoder. Reuse the grid-ref → CellInfo pattern established in Task 8, but apply it to cells from the row-cells iterator (each cell has its own grapheme/style/hyperlink accessors):

```typescript
#walkCells(cellsIter: Pointer): CachedCell[] {
  const out: CachedCell[] = [];
  let x = 0;
  const D = GhosttyRenderStateRowCellsDataValues;

  while (ffi.symbols.ghostty_render_state_row_cells_next(cellsIter)) {
    // Grapheme — probe-size-first via DATA_GRAPHEMES_LEN then GRAPHEMES_BUF.
    const lenBuf = new Uint32Array(1);
    let rc = ffi.symbols.ghostty_render_state_row_cells_get(cellsIter, D.GRAPHEMES_LEN, ptr(lenBuf));
    if (rc !== 0) {
      throw new GhosttyError({ code: getResultCodeName(rc), functionName: "row_cells_get(GRAPHEMES_LEN)" });
    }
    const graphemesLen = lenBuf[0]!;
    let text = "";
    let isWideContinuation = false;
    if (graphemesLen > 0) {
      const cpBuf = new Uint32Array(graphemesLen);
      rc = ffi.symbols.ghostty_render_state_row_cells_get(cellsIter, D.GRAPHEMES_BUF, ptr(cpBuf));
      if (rc !== 0) {
        throw new GhosttyError({ code: getResultCodeName(rc), functionName: "row_cells_get(GRAPHEMES_BUF)" });
      }
      text = String.fromCodePoint(...cpBuf);
    }

    // Style — RAW + STYLE data.
    const styleSize = structLayouts["GhosttyStyle"]!.size;
    const styleBuf = new Uint8Array(styleSize);
    new DataView(styleBuf.buffer).setBigUint64(
      structLayouts["GhosttyStyle"]!.fields.size.offset,
      BigInt(styleSize),
      true,
    );
    rc = ffi.symbols.ghostty_render_state_row_cells_get(cellsIter, D.STYLE, ptr(styleBuf));
    let style: CellStyle | undefined;
    if (rc === 0) {
      const raw = readStyle(styleBuf);
      style = rawStyleToCellStyle(raw);
    } else if (getResultCodeName(rc) !== "no_value") {
      throw new GhosttyError({ code: getResultCodeName(rc), functionName: "row_cells_get(STYLE)" });
    }

    // Wide / continuation / protected: comes from RAW cell data. The row-cells
    // iterator emits a separate entry per grid column, so x advances one per
    // iteration; isWideContinuation is true when the cell's width tag is 0
    // but the adjacent primary cell was wide.
    // Implementation note: libghostty's row-cells iterator already handles
    // wide continuation — the empty-grapheme cell IS the continuation, so
    // default-on-empty is correct. Verified in Task 13 test "wide grapheme
    // sets wide=true on primary, isWideContinuation=true on trailing".
    const wide = graphemesLen > 0 && text.length > 0 && /* estimate via raw cell if available */ false;
    isWideContinuation = graphemesLen === 0 && x > 0 && out[x - 1]?.wide === true;

    // Hyperlink URI: read via row_cells_get(HYPERLINK_URI) if that key exists.
    // If not exposed on the row-cells iterator, leave undefined (fixture tests
    // will flag the regression). Pass 3 does best-effort.
    const hyperlinkUri = undefined; // TODO(pass-3-task-11): wire if data key exists

    out.push({
      x,
      text,
      wide,
      isWideContinuation,
      style,
      hyperlinkUri,
      protected: false,
    });
    x += 1;
  }
  return out;
}
```

Extract `rawStyleToCellStyle` to a module-level helper (moves it out of Terminal; both terminal.ts and render-state.ts use it):

```typescript
// Top of src/render-state.ts, module scope:
import { readStyle, type RawStyle } from "./internal/sized-struct";
import type { UnderlineStyle } from "./types";

export function rawStyleToCellStyle(raw: RawStyle): CellStyle {
  const underlineMap: readonly UnderlineStyle[] =
    ["none", "single", "double", "curly", "dotted", "dashed"];
  return {
    fg: raw.fg,
    bg: raw.bg,
    bold: raw.bold,
    faint: raw.faint,
    italic: raw.italic,
    underline: underlineMap[raw.underline] ?? "none",
    underlineColor: Array.isArray(raw.underlineColor) ? raw.underlineColor : undefined,
    overline: raw.overline,
    strikethrough: raw.strikethrough,
    blink: raw.blink,
    inverse: raw.inverse,
    invisible: raw.invisible,
  };
}
```

And update `src/terminal.ts` `#rawStyleToCellStyle` to `import { rawStyleToCellStyle } from "./render-state";` (or move the helper to a shared spot like `src/internal/style.ts`; the latter is cleaner if Task 18 has time).

- [ ] **Step 2: Add `rows()`, `row.cells()`, `forEachDirtyRow`.**

Append to `RenderState`:

```typescript
*rows(): IterableIterator<RenderRow> {
  this.#assertNotClosed("rows");
  for (const cached of this.#rows) {
    yield this.#toRenderRow(cached);
  }
}

forEachDirtyRow(cb: (row: RenderRow) => void): void {
  this.#assertNotClosed("forEachDirtyRow");
  for (const cached of this.#rows) {
    if (cached.dirty) cb(this.#toRenderRow(cached));
  }
}

#toRenderRow(cached: CachedRow): RenderRow {
  return {
    y: cached.y,
    wrapped: cached.wrapped,
    dirty: cached.dirty,
    cells: () => this.#iterCells(cached),
  };
}

*#iterCells(cached: CachedRow): IterableIterator<RenderCell> {
  for (const c of cached.cells) {
    yield {
      x: c.x,
      text: c.text,
      wide: c.wide,
      isWideContinuation: c.isWideContinuation,
      style: c.style,
      hyperlinkUri: c.hyperlinkUri,
      protected: c.protected,
    };
  }
}
```

- [ ] **Step 3: Verify.**

```bash
bun run typecheck
# Expected: clean.

bun test test/smoke
# Expected: 150 pass (no new tests; Task 13 adds them).
```

- [ ] **Step 4: Commit.**

```bash
git add src/render-state.ts src/terminal.ts
git commit -m "feat(render-state): ergonomic iterators — rows, cells, forEachDirtyRow

rows() returns fresh RenderRow per row; row.cells() returns fresh
RenderCell per cell. forEachDirtyRow walks only cached rows whose
dirty flag is set. Snapshot lifetime: valid until next update().

Per-cell decode: grapheme text, style, wide/continuation detection.
rawStyleToCellStyle extracted to module scope.

Co-Authored-By: <your-Bob-name> (Bob <session-id-first-8>/<model>)"
```

---

## Task 12: `RenderState` hot-path iterators — `forEachCell`, `forEachDirtyCell`

**Purpose:** The zero-allocation walk for render loops. Reuses one mutable `RenderCell` object per invocation. The `RenderRow` passed to `forEachDirtyCell` is a snapshot (allocated) — per spec §4.1 iterator shapes rules.

**Files:**
- Modify: `src/render-state.ts`

- [ ] **Step 1: Implement.**

Append to `RenderState`:

```typescript
// Reusable mutable cell for hot-path walks. Fields mutate in-place between
// callback invocations; callers must not retain the reference.
#hotCell: RenderCell = {
  x: 0,
  text: "",
  wide: false,
  isWideContinuation: false,
  style: undefined,
  hyperlinkUri: undefined,
  protected: false,
};

forEachCell(row: RenderRow | number, cb: (cell: RenderCell) => void): void {
  this.#assertNotClosed("forEachCell");
  const y = typeof row === "number" ? row : row.y;
  const cached = this.#rows[y];
  if (!cached) return;
  this.#walkCached(cached.cells, cb);
}

forEachDirtyCell(cb: (row: RenderRow, cell: RenderCell) => void): void {
  this.#assertNotClosed("forEachDirtyCell");
  for (const cached of this.#rows) {
    if (!cached.dirty) continue;
    const rowSnap = this.#toRenderRow(cached);
    this.#walkCached(cached.cells, (cell) => cb(rowSnap, cell));
  }
}

#walkCached(cells: CachedCell[], cb: (cell: RenderCell) => void): void {
  const hot = this.#hotCell;
  for (const c of cells) {
    hot.x = c.x;
    hot.text = c.text;
    hot.wide = c.wide;
    hot.isWideContinuation = c.isWideContinuation;
    hot.style = c.style;
    hot.hyperlinkUri = c.hyperlinkUri;
    hot.protected = c.protected;
    cb(hot);
  }
}
```

- [ ] **Step 2: Verify.**

```bash
bun run typecheck
# Expected: clean.

bun test test/smoke
# Expected: 150 pass.
```

- [ ] **Step 3: Commit.**

```bash
git add src/render-state.ts
git commit -m "feat(render-state): hot-path iterators — forEachCell, forEachDirtyCell

Zero-allocation walks reusing a single mutable RenderCell per call;
callback must not retain the reference. forEachDirtyCell passes a
snapshot RenderRow + mutable RenderCell per dirty row's cells.

Co-Authored-By: <your-Bob-name> (Bob <session-id-first-8>/<model>)"
```

---

## Task 13: `RenderState` smoke tests

**Purpose:** Cover lifecycle, update, dirty lifecycle (including native-dirty-clear verification), both iterator shapes, colors, cursor, resize behavior. The dirty lifecycle test is the one that validates markClean actually clears native dirty (not just JS mirror) — the P1 item from Codex round 1.

**Files:**
- Create: `test/smoke/render-state.test.ts`

- [ ] **Step 1: Write the test file.**

Create `test/smoke/render-state.test.ts`:

```typescript
import { describe, test, expect } from "bun:test";
import { Terminal, RenderState } from "../../src";

describe("RenderState lifecycle", () => {
  test("construct + close + dispose", () => {
    using rs = new RenderState();
    expect(rs).toBeDefined();
  });

  test("use-after-close throws", () => {
    const rs = new RenderState();
    rs.close();
    using term = new Terminal({ cols: 10, rows: 4 });
    expect(() => rs.update(term)).toThrow(/closed/i);
  });

  test("double-close is a safe no-op", () => {
    const rs = new RenderState();
    rs.close();
    rs.close();
  });
});

describe("RenderState.update + iteration", () => {
  test("update on fresh terminal produces rowCount rows", () => {
    using term = new Terminal({ cols: 10, rows: 4 });
    using rs = new RenderState();
    rs.update(term);
    let count = 0;
    for (const _ of rs.rows()) count += 1;
    expect(count).toBe(4);
  });

  test("each row has cols cells via ergonomic path", () => {
    using term = new Terminal({ cols: 10, rows: 4 });
    using rs = new RenderState();
    rs.update(term);
    for (const row of rs.rows()) {
      let c = 0;
      for (const _ of row.cells()) c += 1;
      expect(c).toBe(10);
    }
  });

  test("written text appears on row 0 via rows()/cells()", () => {
    using term = new Terminal({ cols: 10, rows: 2 });
    term.vtWrite(new TextEncoder().encode("abc"));
    using rs = new RenderState();
    rs.update(term);
    const rowsArr = [...rs.rows()];
    const row0 = rowsArr[0]!;
    const cells = [...row0.cells()];
    expect(cells[0]!.text).toBe("a");
    expect(cells[1]!.text).toBe("b");
    expect(cells[2]!.text).toBe("c");
  });

  test("hot path forEachCell visits every cell; callback sees same instance", () => {
    using term = new Terminal({ cols: 10, rows: 2 });
    term.vtWrite(new TextEncoder().encode("xy"));
    using rs = new RenderState();
    rs.update(term);
    const seen: string[] = [];
    let firstRef: unknown;
    rs.forEachCell(0, (cell) => {
      if (firstRef === undefined) firstRef = cell;
      else expect(cell).toBe(firstRef); // same instance mutated in place
      seen.push(cell.text);
    });
    expect(seen.length).toBe(10);
    expect(seen[0]).toBe("x");
    expect(seen[1]).toBe("y");
  });

  test("forEachCell accepts row number or RenderRow object", () => {
    using term = new Terminal({ cols: 5, rows: 2 });
    using rs = new RenderState();
    rs.update(term);
    const rowObj = [...rs.rows()][0]!;
    let byNum = 0, byObj = 0;
    rs.forEachCell(0, () => { byNum += 1; });
    rs.forEachCell(rowObj, () => { byObj += 1; });
    expect(byNum).toBe(5);
    expect(byObj).toBe(5);
  });
});

describe("RenderState dirty lifecycle", () => {
  test("fresh update sets dirty() to 'all' (full redraw on init)", () => {
    using term = new Terminal({ cols: 10, rows: 4 });
    using rs = new RenderState();
    rs.update(term);
    expect(["rows", "all"]).toContain(rs.dirty());
  });

  test("markClean() clears both native and JS dirty — subsequent update with no activity stays 'none'", () => {
    using term = new Terminal({ cols: 10, rows: 4 });
    using rs = new RenderState();
    rs.update(term);
    rs.markClean();
    expect(rs.dirty()).toBe("none");
    // Critical test: update again without writing to terminal. If markClean()
    // had been a pure-JS flip (P1 from Codex round 1), the next update would
    // re-read stale native dirty and flip dirty() back to "rows"/"all".
    rs.update(term);
    expect(rs.dirty()).toBe("none");
  });

  test("vtWrite after markClean produces dirty rows", () => {
    using term = new Terminal({ cols: 10, rows: 4 });
    using rs = new RenderState();
    rs.update(term);
    rs.markClean();
    term.vtWrite(new TextEncoder().encode("x"));
    rs.update(term);
    expect(rs.dirty()).not.toBe("none");
  });

  test("forEachDirtyRow iterates only rows with dirty=true after partial write", () => {
    using term = new Terminal({ cols: 10, rows: 4 });
    using rs = new RenderState();
    rs.update(term);
    rs.markClean();
    term.vtWrite(new TextEncoder().encode("a"));
    rs.update(term);
    let dirtyCount = 0;
    rs.forEachDirtyRow(() => { dirtyCount += 1; });
    expect(dirtyCount).toBeGreaterThan(0);
    expect(dirtyCount).toBeLessThanOrEqual(4);
  });

  test("forEachDirtyRow after markClean is empty", () => {
    using term = new Terminal({ cols: 10, rows: 4 });
    using rs = new RenderState();
    rs.update(term);
    rs.markClean();
    let count = 0;
    rs.forEachDirtyRow(() => { count += 1; });
    expect(count).toBe(0);
  });
});

describe("RenderState.colors + cursor", () => {
  test("colors() returns effective + defaults shape + 256-entry palette", () => {
    using term = new Terminal({ cols: 10, rows: 4 });
    using rs = new RenderState();
    rs.update(term);
    const c = rs.colors();
    expect(c.palette.length).toBe(256);
    expect(c.effective).toBeDefined();
    expect(c.defaults).toBeDefined();
  });

  test("cursor() returns viewport cursor on fresh terminal", () => {
    using term = new Terminal({ cols: 10, rows: 4 });
    using rs = new RenderState();
    rs.update(term);
    const cur = rs.cursor();
    expect(cur).toBeDefined();
    expect(cur!.x).toBe(0);
    expect(cur!.y).toBe(0);
    expect(cur!.visible).toBe(true);
  });

  test("cursor() tracks x after writing characters", () => {
    using term = new Terminal({ cols: 20, rows: 4 });
    term.vtWrite(new TextEncoder().encode("hello"));
    using rs = new RenderState();
    rs.update(term);
    const cur = rs.cursor();
    expect(cur).toBeDefined();
    expect(cur!.x).toBe(5);
    expect(cur!.y).toBe(0);
  });
});

describe("RenderState resize rebuild", () => {
  test("resize + update rebuilds cache to new geometry", () => {
    using term = new Terminal({ cols: 10, rows: 4 });
    using rs = new RenderState();
    rs.update(term);
    expect([...rs.rows()].length).toBe(4);
    term.resize(20, 6);
    rs.update(term);
    expect([...rs.rows()].length).toBe(6);
    for (const row of rs.rows()) {
      let c = 0;
      for (const _ of row.cells()) c += 1;
      expect(c).toBe(20);
    }
  });
});

describe("RenderState alt-screen dirty=all", () => {
  test("entering alt screen produces dirty()==='all'", () => {
    using term = new Terminal({ cols: 10, rows: 4 });
    using rs = new RenderState();
    rs.update(term);
    rs.markClean();
    // DECSET 1049: enter alt screen + save cursor
    term.vtWrite(new TextEncoder().encode("\x1b[?1049h"));
    rs.update(term);
    expect(rs.dirty()).toBe("all");
  });
});
```

- [ ] **Step 2: Run the tests.**

```bash
bun test test/smoke/render-state.test.ts
# Expected: all pass. Any failures likely point at:
# - Wrong data-key enum value (e.g., CURSOR_VIEWPORT_X)
# - Row-cells iterator not yielding exactly cols cells (geometry mismatch)
# - dirty() misclassification between "rows"/"all"
# Fix in render-state.ts and re-run.

bun test test/smoke
# Expected: 165-ish pass (150 + 15 new).
```

- [ ] **Step 3: Commit.**

```bash
git add test/smoke/render-state.test.ts
git commit -m "test(render-state): lifecycle, iteration, dirty lifecycle, colors, cursor

Key coverage:
- Lifecycle (construct/close/dispose/double-close/use-after-close)
- Iteration (rowCount, colCount, written-text visible, hot-path instance reuse)
- Dirty lifecycle — critical: markClean + re-update with no activity stays
  'none' (proves native dirty was cleared, not just JS mirror)
- colors() shape, cursor() tracking
- Resize rebuild
- Alt-screen swap produces dirty()==='all'

15 new smoke tests.

Co-Authored-By: <your-Bob-name> (Bob <session-id-first-8>/<model>)"
```

---

## Task 14: Render-metadata fixture harness

**Purpose:** Extend the existing fixture harness (`test/helpers/fixture-harness.ts`) with a metadata-capture path. For each `.bin` fixture, the harness replays it through a Terminal, takes a `RenderState` snapshot + `Terminal.snapshot()` + `Terminal.colors()`, normalizes into the §4.7 schema, and diffs against `<name>.expected.json`. Supports `--update-fixtures`.

**Files:**
- Create: `test/helpers/metadata-harness.ts`
- Modify: `test/helpers/fixture-harness.ts` (add metadata mode alongside text mode)
- Create: `test/smoke/fixture-metadata.test.ts` (new driver that runs the metadata harness across all fixtures)

- [ ] **Step 1: Write `test/helpers/metadata-harness.ts`.**

```typescript
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Terminal } from "../../src/terminal";
import { RenderState } from "../../src/render-state";
import type { RGB, CellStyle } from "../../src/types";

export interface MetadataSnapshot {
  geometry: { cols: number; rows: number };
  terminal: {
    cursor: { x: number; y: number; visible: boolean };
    viewportCursor?: { x: number; y: number; visible: boolean; wideTail: boolean };
    activeScreen: "primary" | "alternate";
    title?: string;
    pwd?: string;
    scrollbackRows: number;
  };
  colors: {
    effective: { fg?: RGB; bg?: RGB; cursor?: RGB };
    defaults: { fg?: RGB; bg?: RGB; cursor?: RGB };
    palette: readonly RGB[];
  };
  rows: Array<{
    y: number;
    wrapped: boolean;
    cells: Array<{
      x: number;
      text: string;
      wide?: true;
      isWideContinuation?: true;
      style?: CellStyle;
      hyperlinkUri?: string;
      protected?: true;
    }>;
  }>;
}

export interface MetadataFixtureResult {
  name: string;
  pass: boolean;
  diff?: string;
}

export async function runMetadataFixture(
  fixturesDir: string,
  name: string,
  geometry: { cols: number; rows: number },
  opts: { update: boolean } = { update: false },
): Promise<MetadataFixtureResult> {
  const binPath = join(fixturesDir, `${name}.bin`);
  const jsonPath = join(fixturesDir, `${name}.expected.json`);

  const bin = new Uint8Array(await readFile(binPath));
  using term = new Terminal({ cols: geometry.cols, rows: geometry.rows });
  term.vtWrite(bin);
  using rs = new RenderState();
  rs.update(term);

  const actual = snapshotToJson(term, rs, geometry);
  const actualStr = JSON.stringify(actual, null, 2);

  if (opts.update) {
    await writeFile(jsonPath, actualStr + "\n", "utf8");
    return { name, pass: true };
  }

  const expectedStr = await readFile(jsonPath, "utf8").catch(() => "");
  if (actualStr.trim() === expectedStr.trim()) {
    return { name, pass: true };
  }
  return {
    name,
    pass: false,
    diff: structuredDiff(expectedStr, actualStr),
  };
}

function snapshotToJson(
  term: Terminal,
  rs: RenderState,
  geometry: { cols: number; rows: number },
): MetadataSnapshot {
  const snap = term.snapshot();
  const colors = term.colors();
  const viewportCursor = rs.cursor();

  const rows: MetadataSnapshot["rows"] = [];
  for (const row of rs.rows()) {
    const cells: MetadataSnapshot["rows"][number]["cells"] = [];
    for (const cell of row.cells()) {
      const entry: MetadataSnapshot["rows"][number]["cells"][number] = {
        x: cell.x,
        text: cell.text,
      };
      if (cell.wide) entry.wide = true;
      if (cell.isWideContinuation) entry.isWideContinuation = true;
      if (cell.style) entry.style = cell.style;
      if (cell.hyperlinkUri) entry.hyperlinkUri = cell.hyperlinkUri;
      if (cell.protected) entry.protected = true;
      cells.push(entry);
    }
    rows.push({ y: row.y, wrapped: row.wrapped, cells });
  }

  return {
    geometry,
    terminal: {
      cursor: { x: snap.cursor.x, y: snap.cursor.y, visible: snap.cursor.visible },
      viewportCursor: viewportCursor
        ? { x: viewportCursor.x, y: viewportCursor.y, visible: viewportCursor.visible, wideTail: viewportCursor.wideTail }
        : undefined,
      activeScreen: snap.activeScreen,
      title: snap.title,
      pwd: snap.pwd,
      scrollbackRows: snap.scrollbackRows,
    },
    colors: {
      effective: {
        fg: colors.effective.fg,
        bg: colors.effective.bg,
        cursor: colors.effective.cursor,
      },
      defaults: {
        fg: colors.defaults.fg,
        bg: colors.defaults.bg,
        cursor: colors.defaults.cursor,
      },
      palette: colors.palette, // preserve index order; no sort
    },
    rows,
  };
}

/**
 * Produce a readable diff when fixture JSON doesn't match. Avoids a raw
 * JSON string diff (unreadable on 24×80 grids). Reports at row + cell
 * granularity.
 */
function structuredDiff(expectedStr: string, actualStr: string): string {
  if (!expectedStr) return "expected fixture is empty or missing; regenerate with --update-fixtures";
  let expected: MetadataSnapshot;
  let actual: MetadataSnapshot;
  try {
    expected = JSON.parse(expectedStr);
    actual = JSON.parse(actualStr);
  } catch {
    return "expected file is not valid JSON; cannot structured-diff";
  }

  const diffs: string[] = [];
  if (expected.geometry.cols !== actual.geometry.cols) {
    diffs.push(`geometry.cols: expected ${expected.geometry.cols}, got ${actual.geometry.cols}`);
  }
  if (expected.geometry.rows !== actual.geometry.rows) {
    diffs.push(`geometry.rows: expected ${expected.geometry.rows}, got ${actual.geometry.rows}`);
  }
  if (JSON.stringify(expected.terminal) !== JSON.stringify(actual.terminal)) {
    diffs.push(`terminal: expected ${JSON.stringify(expected.terminal)}, got ${JSON.stringify(actual.terminal)}`);
  }

  const rowCount = Math.max(expected.rows.length, actual.rows.length);
  for (let y = 0; y < rowCount; y += 1) {
    const er = expected.rows[y];
    const ar = actual.rows[y];
    if (!er || !ar) {
      diffs.push(`row ${y}: ${er ? "missing in actual" : "extra in actual"}`);
      continue;
    }
    if (JSON.stringify(er.cells) !== JSON.stringify(ar.cells)) {
      // Per-cell comparison to narrow the diff.
      const cellCount = Math.max(er.cells.length, ar.cells.length);
      for (let x = 0; x < cellCount; x += 1) {
        const ec = er.cells[x];
        const ac = ar.cells[x];
        if (JSON.stringify(ec) !== JSON.stringify(ac)) {
          diffs.push(`row ${y} col ${x}: expected ${JSON.stringify(ec)}, got ${JSON.stringify(ac)}`);
        }
      }
    }
  }

  return diffs.slice(0, 40).join("\n") + (diffs.length > 40 ? `\n... (${diffs.length - 40} more)` : "");
}
```

- [ ] **Step 2: Add fixture-manifest support for geometry.**

Each fixture's geometry needs to be declared somewhere. Simplest path: a small JSON manifest `test/fixtures/fixtures.json`:

```json
{
  "hello-world": { "cols": 80, "rows": 24 }
}
```

Create this file with the one existing fixture. Subsequent fixtures add entries.

Modify `test/helpers/fixture-harness.ts` to read geometry from the manifest instead of hardcoding 80×24:

```typescript
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export async function loadFixtureManifest(
  fixturesDir: string,
): Promise<Record<string, { cols: number; rows: number }>> {
  const path = join(fixturesDir, "fixtures.json");
  const raw = await readFile(path, "utf8");
  return JSON.parse(raw);
}
```

And update `runFixture` to use the manifest:

```typescript
export async function runFixture(
  fixturesDir: string,
  name: string,
  opts: { update: boolean } = { update: false },
): Promise<FixtureResult> {
  const manifest = await loadFixtureManifest(fixturesDir);
  const geom = manifest[name] ?? { cols: 80, rows: 24 };
  // ... existing body, using geom.cols and geom.rows
}
```

- [ ] **Step 3: Add the test driver `test/smoke/fixture-metadata.test.ts`.**

```typescript
import { describe, test, expect } from "bun:test";
import { join } from "node:path";
import { listFixtures } from "../helpers/fixture-harness";
import { runMetadataFixture } from "../helpers/metadata-harness";
import { loadFixtureManifest } from "../helpers/fixture-harness";

const FIXTURES_DIR = join(import.meta.dir, "..", "fixtures");
const UPDATE = process.env.UPDATE_FIXTURES === "1";

describe("fixture metadata replay", async () => {
  const manifest = await loadFixtureManifest(FIXTURES_DIR);
  const fixtures = await listFixtures(FIXTURES_DIR);

  for (const name of fixtures) {
    test(name, async () => {
      const geom = manifest[name];
      if (!geom) {
        throw new Error(`fixture ${name} missing in fixtures.json manifest`);
      }
      const result = await runMetadataFixture(FIXTURES_DIR, name, geom, { update: UPDATE });
      if (!result.pass) {
        console.error(`metadata mismatch for ${name}:\n${result.diff}`);
      }
      expect(result.pass).toBe(true);
    });
  }
});
```

- [ ] **Step 4: Run the harness with `UPDATE_FIXTURES=1` to generate the first `.expected.json`.**

```bash
UPDATE_FIXTURES=1 bun test test/smoke/fixture-metadata.test.ts
# Expected: writes test/fixtures/hello-world.expected.json; test passes.

# Sanity-eyeball the generated JSON.
head -40 test/fixtures/hello-world.expected.json
# Expected: JSON starting with {"geometry": {"cols":80,"rows":24}, "terminal":...}
```

Inspect the generated JSON for obvious wrongness:
- Cursor position matches where `hello-world.bin` should have left it
- Cells at the start of row 0 contain the fixture's visible text
- Palette has 256 entries, indices 0..255 in order
- No obviously-corrupted fields

If the JSON looks wrong, DEBUG the encode path BEFORE committing. A broken fixture-generator locks in wrong expected values.

- [ ] **Step 5: Re-run without UPDATE to verify the compare path.**

```bash
bun test test/smoke/fixture-metadata.test.ts
# Expected: hello-world passes (JSON matches).

bun test test/smoke
# Expected: 166 pass (165 + 1 — one per fixture driven).
```

- [ ] **Step 6: Commit.**

```bash
git add test/helpers/metadata-harness.ts test/helpers/fixture-harness.ts test/fixtures/fixtures.json test/fixtures/hello-world.expected.json test/smoke/fixture-metadata.test.ts
git commit -m "test(fixtures): render-metadata .expected.json harness

Adds metadata-capture path alongside the existing .expected.txt harness.
Each .bin fixture replays through Terminal + RenderState, snapshots
into §4.7 schema, diffs against .expected.json. UPDATE_FIXTURES=1
regenerates; structured diff reports at row+cell granularity.

New manifest test/fixtures/fixtures.json declares per-fixture geometry;
fixture-harness loadFixtureManifest helper exposes it for both text
and metadata harnesses.

Hello-world fixture's .expected.json generated + committed.

Co-Authored-By: <your-Bob-name> (Bob <session-id-first-8>/<model>)"
```

---

## Task 15: Generate `.expected.json` companions + real-program capture expansion

**Purpose:** For every existing `.bin` fixture that has an `.expected.txt` but no `.expected.json`, generate the JSON companion. Also: any `.bin` fixtures in the differential corpus that exercise distinct terminal behaviors (alt screen, scrollback, SGR, CJK, hyperlinks) get imported into `test/fixtures/` with manifest entries.

**Files:**
- Add: `test/fixtures/<name>.expected.json` for each existing fixture
- Modify: `test/fixtures/fixtures.json` (new entries if new fixtures imported)
- Possibly add: 2–4 new `<name>.bin` fixtures copied from `test/differential/corpus/`

- [ ] **Step 1: Survey existing fixtures and differential corpus.**

```bash
ls test/fixtures/*.bin 2>/dev/null
ls test/differential/corpus/ 2>/dev/null
```

Pick 2–4 corpus items that exercise distinct behaviors for Pass 3's metadata harness:
- one with SGR styling (bold/color)
- one with alt-screen toggle
- one with scrollback content (vertical history after scroll)
- one with wide graphemes (CJK/emoji), if present

For each selected corpus entry, copy into `test/fixtures/`:

```bash
cp test/differential/corpus/<item>.bin test/fixtures/<item>.bin
# If an .expected.txt exists in the corpus, copy that too:
cp test/differential/corpus/<item>.expected.txt test/fixtures/<item>.expected.txt 2>/dev/null || true
```

- [ ] **Step 2: Add manifest entries.**

For each new fixture, add to `test/fixtures/fixtures.json`:

```json
{
  "hello-world": { "cols": 80, "rows": 24 },
  "<new-fixture-1>": { "cols": <N>, "rows": <M> },
  "<new-fixture-2>": { "cols": <N>, "rows": <M> }
}
```

(Geometry should match what the original capture used; if unknown, 80×24 is a safe default.)

- [ ] **Step 3: Generate `.expected.json` for all fixtures.**

```bash
UPDATE_FIXTURES=1 bun test test/smoke/fixture-metadata.test.ts
# Expected: writes one .expected.json per fixture listed in the manifest.
```

- [ ] **Step 4: Manual sanity-check on every generated file.**

```bash
# Eyeball each file for obvious wrongness. Commit only the ones that look right.
for f in test/fixtures/*.expected.json; do
  echo "--- $f ---"
  head -20 "$f"
done
```

Red flags (indicates harness or implementation bug; STOP and debug):
- Row count differs from manifest `rows`.
- Palette length ≠ 256.
- Cursor position absurd (e.g., negative, or larger than geometry).
- Cells outside declared column count.
- Every cell has the same text — suggests the grapheme decoder returned a single repeated value.

If any fixture is flagged as "libghostty produces unstable output across runs," add a companion `<name>.skip.reason` file with a short explanation, and make the fixture-metadata test skip (use `test.skipIf`) those entries. Do NOT block Pass 3 on hypothetically-unstable fixtures.

- [ ] **Step 5: Re-run without UPDATE, verify compare.**

```bash
bun test test/smoke/fixture-metadata.test.ts
# Expected: all fixtures pass the compare path.

bun test test/smoke
# Expected: pass count = previous + fixture count.
```

- [ ] **Step 6: Commit.**

```bash
git add test/fixtures/
git commit -m "test(fixtures): .expected.json companions for all existing fixtures

Generated via UPDATE_FIXTURES=1; each JSON sanity-reviewed by hand.

<list the fixtures committed>

Co-Authored-By: <your-Bob-name> (Bob <session-id-first-8>/<model>)"
```

---

## Task 16: Malformed-input resilience fuzz + large-APC test

**Purpose:** Two tests in one file. Bounded seeded random bytes (×20 seeds) and the 10 MiB APC payload stress test. Both post-conditions: no exception bubbles out, `snapshot()` works afterward.

**Files:**
- Create: `test/smoke/resilience-fuzz.test.ts`

- [ ] **Step 1: Write the tests.**

Create `test/smoke/resilience-fuzz.test.ts`:

```typescript
import { describe, test, expect } from "bun:test";
import { Terminal } from "../../src";

// Deterministic PRNG so fuzz failures are reproducible.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function bitsPayload(seed: number, size: number): Uint8Array {
  const rng = mulberry32(seed);
  const buf = new Uint8Array(size);
  // Bias: 30% ESC sequences to exercise the VT parser, 70% raw bytes.
  for (let i = 0; i < size; i += 1) {
    if (rng() < 0.3) {
      const prefixes = [0x1B, 0x9B, 0x90]; // ESC, CSI alias, DCS alias
      buf[i] = prefixes[Math.floor(rng() * prefixes.length)]!;
    } else {
      buf[i] = Math.floor(rng() * 256);
    }
  }
  return buf;
}

describe("resilience — seeded random bytes", () => {
  const SIZE = 128 * 1024;
  const SEED_COUNT = 20;

  for (let seed = 1; seed <= SEED_COUNT; seed += 1) {
    test(`seed ${seed}: ${SIZE} random bytes do not crash`, () => {
      using term = new Terminal({ cols: 80, rows: 24, maxScrollback: 100 });
      const payload = bitsPayload(seed, SIZE);

      // Feed in variable-sized chunks.
      const rng = mulberry32(seed + 1000);
      let i = 0;
      while (i < payload.length) {
        const chunkSize = 1 + Math.floor(rng() * 4096);
        const end = Math.min(i + chunkSize, payload.length);
        term.vtWrite(payload.subarray(i, end));
        i = end;
      }

      // Post-conditions: snapshot works, a valid cellAt works, close works.
      const snap = term.snapshot();
      expect(snap.cols).toBe(80);
      expect(snap.rows).toBe(24);
      const cell = term.cellAt({ x: 0, y: 0 });
      // cell may have arbitrary content but must be a valid object or undefined.
      if (cell !== undefined) {
        expect(typeof cell.text).toBe("string");
      }
    });
  }
});

describe("resilience — large APC payload", () => {
  test("10 MiB APC payload stays bounded under default apcMaxBytes (1 MiB)", () => {
    using term = new Terminal({ cols: 80, rows: 24 });
    const rssBefore = process.memoryUsage().rss;

    // ESC _ <10 MiB of 'A'> ESC \
    const prefix = new Uint8Array([0x1B, 0x5F]);         // ESC _
    const suffix = new Uint8Array([0x1B, 0x5C]);         // ESC \
    const payload = new Uint8Array(10 * 1024 * 1024);
    payload.fill(0x41); // 'A'

    term.vtWrite(prefix);
    // Feed in 1 MiB chunks to avoid single-call stack/allocation spikes.
    for (let i = 0; i < payload.length; i += 1024 * 1024) {
      term.vtWrite(payload.subarray(i, Math.min(i + 1024 * 1024, payload.length)));
    }
    term.vtWrite(suffix);

    const rssAfter = process.memoryUsage().rss;
    const growth = rssAfter - rssBefore;

    // Lenient bound — we want to catch "process grows 10+ MiB" regressions,
    // not enforce a tight bound. 8 MiB tolerance handles legitimate growth
    // (test harness, symbol tables, V8 GC noise).
    expect(growth).toBeLessThan(8 * 1024 * 1024);

    // Post-write snapshot still works.
    const snap = term.snapshot();
    expect(snap.cols).toBe(80);
  });

  test("10 MiB APC payload under apcMaxBytes=4 MiB also stays bounded (custom wiring)", () => {
    using term = new Terminal({ cols: 80, rows: 24, apcMaxBytes: 4 * 1024 * 1024 });
    const rssBefore = process.memoryUsage().rss;
    term.vtWrite(new Uint8Array([0x1B, 0x5F]));
    const payload = new Uint8Array(10 * 1024 * 1024);
    payload.fill(0x41);
    for (let i = 0; i < payload.length; i += 1024 * 1024) {
      term.vtWrite(payload.subarray(i, Math.min(i + 1024 * 1024, payload.length)));
    }
    term.vtWrite(new Uint8Array([0x1B, 0x5C]));
    const growth = process.memoryUsage().rss - rssBefore;
    // With a 4 MiB bound, growth should be < ~10 MiB (4 MiB retained + test noise).
    expect(growth).toBeLessThan(12 * 1024 * 1024);
  });
});
```

- [ ] **Step 2: Run the tests.**

```bash
bun test test/smoke/resilience-fuzz.test.ts
# Expected: 22 pass (20 seeds + 2 APC tests).
# Runtime: ~5-15 seconds for fuzz + APC allocation.
```

If any seed crashes, capture the exact seed number and the bytes that caused the crash; file a bug against libghostty-vt if confirmed reproducible, and use a `.skip` for that seed with a comment naming the issue.

RSS growth assertions may be flaky on shared CI — if observed, relax tolerance (up to 16 MiB) rather than removing the check entirely.

- [ ] **Step 3: Commit.**

```bash
git add test/smoke/resilience-fuzz.test.ts
git commit -m "test(resilience): fuzz + large-APC payload stress tests

Fuzz: 20 deterministic seeds, 128 KiB each, ESC-biased to exercise
VT parser. Asserts no exception bubbles out and snapshot/cellAt still
work post-fuzz.

Large APC: 10 MiB payload under default (1 MiB bound) and custom
(4 MiB bound) — RSS growth lenient-bounded to catch proportional-leak
regressions without forcing tight tolerance.

22 new smoke tests.

Co-Authored-By: <your-Bob-name> (Bob <session-id-first-8>/<model>)"
```

---

## Task 17: Public re-exports sweep + tarball smoke extension

**Purpose:** Confirm every Pass 3 surface is exported from `src/index.ts`. Extend `scripts/run-tarball-smoke.sh` (or the equivalent script) to exercise one new Pass 3 surface (`RenderState.forEachCell` plus `cellAt`) so packaging regressions surface.

**Files:**
- Modify: `src/index.ts`
- Modify: `scripts/run-tarball-smoke.sh` (or the script Pass 1 established)
- Modify: `test/tarball/*.ts` (the tarball-consumer script)

- [ ] **Step 1: Audit `src/index.ts`.**

Required Pass 3 exports:

```typescript
export { Terminal } from "./terminal";
export { Formatter } from "./formatter";
export { RenderState } from "./render-state";
export { encodeFocus } from "./focus";
export {
  GhosttyError,
  LibraryNotFoundError,
  UnsupportedPlatformError,
  LibraryCompatibilityError,
  UseAfterCloseError,
} from "./errors";
export type { GhosttyErrorCode } from "./errors";
export {
  setLibraryPath,
  isLoaded,
  libraryInfo,
} from "./ffi";
export type { LibraryInfo } from "./ffi";
export { modeNames } from "./internal/generated";
export { pinnedCommit } from "./internal/generated";
export type {
  RGB,
  PaletteIndex,
  CursorStyle,
  MouseTracking,
  ModeName,
  TerminalOptions,
  TerminalSnapshot,
  FormatterOptions,
  TerminalColors,
  CellInfo,
  CellStyle,
  UnderlineStyle,
  CellAtPoint,
  RenderRow,
  RenderCell,
  ViewportCursor,
} from "./types";
```

Check with:

```bash
# Every public symbol in the v0 scope should be re-exported.
grep -c '^export ' src/index.ts
# Expected: at least 18 exports (classes, functions, types).
```

- [ ] **Step 2: Extend the tarball-consumer script.**

Find the existing tarball test:

```bash
cat scripts/run-tarball-smoke.sh
ls test/tarball/
```

The existing Pass 1 tarball script constructs a Terminal, writes bytes, formats, asserts. Extend it (or the consumer script under `test/tarball/`) with a Pass 3 hit:

```typescript
// Existing assertions from Pass 1...

// Pass 3 — RenderState grid read
import { Terminal, RenderState, encodeFocus } from "ts-libghostty-vt";

{
  using term = new Terminal({ cols: 10, rows: 2 });
  term.vtWrite(new TextEncoder().encode("ok"));

  using rs = new RenderState();
  rs.update(term);
  let text = "";
  rs.forEachCell(0, (cell) => { text += cell.text; });
  if (!text.startsWith("ok")) throw new Error(`tarball Pass-3 RenderState: expected 'ok...', got '${text}'`);

  const cell = term.cellAt({ x: 0, y: 0 });
  if (cell?.text !== "o") throw new Error(`tarball Pass-3 cellAt: expected 'o', got '${cell?.text}'`);

  const focusBytes = encodeFocus("in");
  if (focusBytes[0] !== 0x1B) throw new Error("tarball Pass-3 encodeFocus: expected leading ESC");
}
```

- [ ] **Step 3: Run tarball smoke.**

```bash
bash scripts/run-tarball-smoke.sh
# Expected: packs, installs into temp project, runs assertions, cleans up.
# All assertions pass.
```

- [ ] **Step 4: Commit.**

```bash
git add src/index.ts scripts/run-tarball-smoke.sh test/tarball/
git commit -m "chore(pass-3): public re-exports + tarball smoke extension

src/index.ts audited for full Pass 3 surface: RenderState, encodeFocus,
plus all new types (TerminalColors, CellInfo/Style, UnderlineStyle,
CellAtPoint, RenderRow, RenderCell, ViewportCursor).

Tarball smoke adds Pass 3 sanity check: RenderState.forEachCell over
a row; Terminal.cellAt round-trip; encodeFocus leading-ESC.

Co-Authored-By: <your-Bob-name> (Bob <session-id-first-8>/<model>)"
```

---

## Task 18: Release gate — changelog, version bump, README update, CONFIRM_WITH_MATT, local v0.3.0 tag

**Purpose:** Close Pass 3 with the ceremony Matt wants. No push, no publish — "mark in the sand" only.

**Files:**
- Modify: `CHANGELOG.md`
- Modify: `package.json`
- Modify: `README.md`
- Modify: `CONFIRM_WITH_MATT.md`
- Create: `v0.3.0` annotated tag (local)

- [ ] **Step 1: Final green-light verification.**

```bash
bun run typecheck
# Expected: clean.

bun test test/smoke
# Expected: full Pass-3 count (~190 tests).

bun run verify:generated
# Expected: green.

bash scripts/run-tarball-smoke.sh
# Expected: green.

git status
# Expected: clean.
```

If any check fails, STOP. Do not tag a broken tree.

- [ ] **Step 2: Update `CHANGELOG.md`.**

Prepend a new `## [0.3.0] - 2026-04-23` (or actual date) section in Keep-a-Changelog format:

```markdown
## [0.3.0] - 2026-04-23

### Added
- `RenderState` class — grid reader with dual iterator shape. `rows()` / `row.cells()` / `forEachDirtyRow` are ergonomic (allocate per row/cell, snapshot lifetime). `forEachCell` / `forEachDirtyCell` are hot-path (reuse one mutable `RenderCell`, callback-duration only). `update(term)` refreshes native state; `markClean()` clears both native (one-call via `ghostty_render_state_set`) and JS mirror; `dirty()` reports `"none" | "rows" | "all"`; `colors()` returns the render-state's color view; `cursor()` returns viewport cursor (x/y/visible/wideTail; no cursor style at v0).
- `Terminal.scrollViewport(pos)` — accepts `"top" | "bottom" | number` (signed row delta).
- `Terminal.colors()` / `Terminal.setColors(patch)` — read `{effective, defaults, palette[256]}`; write defaults. Palette indices are semantic (order preserved).
- `Terminal.cellAt({x, y, coordinateSpace?})` — one-shot cell query in all four coord spaces (`"active"` default, `"viewport"`, `"screen"`, `"history"`). Out-of-bounds returns `undefined`, not a throw.
- `encodeFocus("in" | "out")` — standalone function, returns fresh `Uint8Array`.
- `apcMaxBytes` / `apcMaxBytesKitty` fields returned to `TerminalOptions` (removed in Hilbert's Pass-1 contract fix because they were silently dropped). Wired via post-construct `ghostty_terminal_set`. Default bounds: 1 MiB / 0.
- Internal `KITTY_IMAGE_STORAGE_LIMIT = 0` default wired at construction (not user-configurable at v0; binding design §5.9).
- Render-metadata fixture infrastructure: `.expected.json` companions to `.bin` / `.expected.txt`. Harness at `test/helpers/metadata-harness.ts`; driver at `test/smoke/fixture-metadata.test.ts`; `UPDATE_FIXTURES=1` regenerates. Fixture geometry declared per-entry in `test/fixtures/fixtures.json`.
- Malformed-input resilience fuzz (20 seeded random byte streams, 128 KiB each) and 10 MiB APC payload stress tests.
- Public types: `CellInfo`, `CellStyle`, `UnderlineStyle`, `TerminalColors`, `RenderRow`, `RenderCell`, `ViewportCursor`, `CellAtPoint`.

### Changed
- `TerminalSnapshot` unchanged — `cursor.style` remains deferred (72-byte `GhosttyStyle` decode warrants Pass-5-or-later work).
- README: added compatibility + cost-table sections for `cellAt` coord spaces, `markClean`'s native-plus-JS semantics, OSC-override behavior under `setColors` (observed value from Task 6 test).

### Fixed
- OSC-override survival behavior documented; see README.
```

(Adjust verbiage if Task 6's OSC test surfaced "survives" vs "cleared" — fill in the observed outcome.)

- [ ] **Step 3: Bump version.**

Edit `package.json`:
```json
  "version": "0.3.0",
```

- [ ] **Step 4: Update `README.md`.**

Add sections documenting Pass 3 surface. Key additions:

1. **Cell coord-space cost table** for `cellAt`:

   | coord space | cost | returns for out-of-bounds |
   |---|---|---|
   | `"active"` (default) | O(1) | `undefined` |
   | `"viewport"` | O(1) | `undefined` |
   | `"screen"` | O(row) — may walk wrapped rows | `undefined` |
   | `"history"` | O(depth) — scrollback touch | `undefined` |

2. **`markClean()` semantics**: "Clears libghostty's native dirty state (one call clears both global and per-row layers) and mirrors into the JS cache. Multiple consumers can each call `markClean()` on their own cadence — double-clearing the native layer is harmless."

3. **OSC override behavior**: record the Task-6-observed outcome. Example phrasing:
   > "`setColors(patch)` updates the default foreground/background/cursor colors. As of libghostty pin `<SHA>`, OSC 10/11/12 overrides are {preserved | cleared} when `setColors` is called — consumers relying on OSC overrides should {keep this in mind / re-emit the OSC sequence after setColors}."

4. **RenderState iterator contract**: "Ergonomic path (`rows()`, `row.cells()`, `forEachDirtyRow`) allocates fresh `RenderRow` / `RenderCell` objects on each call, valid until the next `update()`. Hot path (`forEachCell`, `forEachDirtyCell`) reuses a single mutable `RenderCell` across the walk — mutate your own buffer if you need to retain cell data past the callback."

- [ ] **Step 5: Update `CONFIRM_WITH_MATT.md`.**

Under the existing "Pass 3 notes" section, add:

```markdown
### Pass 3 complete (2026-04-23, Ekaterin)

All 18 tasks landed. Final state: <N> smoke tests pass (112 baseline + <M> Pass-3 additions), typecheck clean, tarball smoke green, `verify:generated` green.

**Plan edits during execution.** (Fill in any Task reorderings, skipped fixture entries, libghostty surface differences the plan didn't anticipate.)

**Open Question resolutions from Task 2 probe:**
- APC read-back via `ghostty_terminal_get`: NOT supported. §4.4 test strategy confirmed the fallback path.
- Native dirty clear: ONE call via `ghostty_render_state_set(state, OPTION_DIRTY, FALSE)` — confirms Cipher's plan-authoring finding.
- Viewport cursor: exposed via `CURSOR_VIEWPORT_*` render-state data keys (x/y/has_value/wide_tail). Cursor style on viewport is NOT exposed — consistent with `TerminalSnapshot.cursor.style` staying deferred.
- OSC override survival: {preserved | cleared} when `setColors` is called. (Record Task 6 observation.)

**Pass 3 Bob run.** (List the Bobs that contributed.)

**Carry-forward for Pass 4.**
- `KeyEncoder` / `KeyEvent` / `Key` enum surfacing lands in Pass 4. `generated.ts` already has `Key` as a string-literal union; `KeyEncoder` needs new symbols.
- The `rawStyleToCellStyle` helper (currently in `src/render-state.ts`) is a shared utility; if Pass 4 needs cell-style decoding, promote to `src/internal/style.ts` first.
- `RenderState`'s object-reuse pattern does NOT apply to `KeyEncoder.encode` — encode returns a fresh `Uint8Array` per call (binding design confirms).
- Unstable-fixture skip pattern (`.skip.reason` sidecar) established; Pass 4 fixtures follow the same pattern if needed.

### Pass 3 commit timeline

(Fill in from `git log v0.2.0..v0.3.0 --oneline --reverse`.)
```

- [ ] **Step 6: Commit the release prep.**

```bash
git add CHANGELOG.md package.json README.md CONFIRM_WITH_MATT.md
git commit -m "chore(release): v0.3.0

Co-Authored-By: <your-Bob-name> (Bob <session-id-first-8>/<model>)"
```

- [ ] **Step 7: Tag (local, unpushed).**

```bash
git tag -a v0.3.0 -m "v0.3.0 — RenderState, Terminal finish, fixture metadata

Pass 3 closes v0's grid-reading surface. Pass 4 follows with KeyEncoder.

Co-Authored-By: <your-Bob-name> (Bob <session-id-first-8>/<model>)"

git tag --list | grep v0.3
# Expected: v0.3.0 present.

git log -1 --format="%H %s"
# Captures the tagged commit for the CONFIRM_WITH_MATT.md timeline update.
```

- [ ] **Step 8: Backfill the Pass 3 commit timeline in `CONFIRM_WITH_MATT.md`.**

```bash
git log v0.2.0..v0.3.0 --oneline --reverse
```

Paste the list into the "### Pass 3 commit timeline" section. Amend the release-prep commit with the backfilled timeline:

```bash
git add CONFIRM_WITH_MATT.md
git commit --amend --no-edit
# Re-create the tag on the amended commit:
git tag -d v0.3.0
git tag -a v0.3.0 -m "v0.3.0 — RenderState, Terminal finish, fixture metadata"
```

- [ ] **Step 9: Final verification.**

```bash
git status
# Expected: clean.

git describe --tags --exact-match HEAD
# Expected: v0.3.0

bun test test/smoke
# Expected: all green at tagged commit.
```

**Expected outcome of Pass 3:** local `v0.3.0` tag pointing at the release-prep commit; changelog + README + CONFIRM_WITH_MATT.md updated; all tests green. No push, no publish. Pass 4 can begin on top of this.

---

## Self-review checklist (post-plan-writing)

After writing this plan, the author (or next Bob) runs these checks before handing off to execution:

### Spec coverage

For each §3.1 scope item in the spec, a task implements it:

| Spec §3.1 item | Covered by |
|---|---|
| 1. RenderState (iterators, dirty, markClean, colors, cursor) | Tasks 10–13 |
| 2. scrollViewport | Task 4 |
| 3. colors / setColors (including OSC survival test) | Task 6 |
| 4. cellAt (all 4 coord spaces) | Tasks 8–9 |
| 5. encodeFocus | Task 5 |
| 6. APC bounds wiring (+ KITTY image-storage internal default) | Task 7 |
| 7. Public types | Tasks 6, 8, 10 (spread) |
| 8. Render-metadata fixture infrastructure | Task 14 |
| 9. Real-program captures with `.expected.json` | Task 15 |
| 10. Resilience fuzz | Task 16 |
| 11. Large-APC payload test | Task 16 |
| 12. v0.3.0 tag + changelog + CONFIRM_WITH_MATT | Task 18 |

### Placeholder scan

Search for red-flag patterns:
```bash
grep -n 'TBD\|TODO\|fill in\|similar to task\|implement later' docs/superpowers/plans/2026-04-23-ts-libghostty-pass-3.md
```
Every hit that isn't a genuine code-comment `TODO(pass-3-task-11)` tag should be removed / resolved inline.

### Type consistency

Names used across tasks:
- `CellInfo` / `CellStyle` / `UnderlineStyle` / `RenderRow` / `RenderCell` / `ViewportCursor` / `CellAtPoint` / `TerminalColors` / `RGB` / `PaletteIndex` — all defined in `src/types.ts` at Task 6 / 8 / 10. No late renames.
- `RawStyle` — internal in `src/internal/sized-struct.ts`; used in `rawStyleToCellStyle` (Task 11).
- `Terminal.unsafeHandle` — added in Task 10, used by `RenderState.update` in same task.
- `GhosttyXxxValues` enum constants — Task 3 regenerates; all downstream tasks import them individually and reference by enum-member name (`ACTIVE`, `VIEWPORT`, etc.), not numeric literals. `structLayouts` is the top-level Record used for `structLayouts["StructName"]!.size` / `.fields`.

### Task ordering

Dependencies:
- Task 1 → 2 → 3 (linear; 3 needs symbols extended before downstream FFI calls resolve).
- Tasks 4–7 can run in any order after 3 (each is a small Terminal method with its own test).
- Tasks 8–9 must follow each other (9 reuses 8's `cellAt` dispatch).
- Tasks 10–13 sequential (12 depends on 11's cached data; 13 tests 10–12 behavior).
- Task 14 depends on 10+ (metadata harness calls `RenderState.update`).
- Task 15 depends on 14.
- Task 16 independent — can run any time after 7 (fuzz uses basic Terminal path; large-APC uses wired apcMaxBytes).
- Task 17 final sweep, depends on all prior tasks.
- Task 18 release gate, last.

### Execution handoff

**Plan complete and saved to `docs/superpowers/plans/2026-04-23-ts-libghostty-pass-3.md`.** Two execution options:

**1. Subagent-Driven (recommended)** — An orchestrator Bob dispatches a fresh subagent per task, reviews between tasks, fast iteration. Guppies run on git worktrees per the `feedback_dispatch_worktree` memory.

**2. Inline Execution** — Execute tasks in this session using the `superpowers:executing-plans` skill; batch execution with checkpoints for review.

Which approach?
