# Pass 3 — RenderState + Terminal finish — Design Spec

**Status:** Approved for implementation planning
**Date:** 2026-04-23
**Author:** Ekaterin (Bob session `a2d318db`)
**Scope:** One of two remaining passes toward v0. Pass 3 closes the grid-reading surface; Pass 4 closes keystroke encoding. Together they complete the v0 scope described in `2026-04-22-ts-libghostty-design.md` §3.2.

## 1. Summary

Pass 3 implements `RenderState` (the grid-reading render loop), the four remaining `Terminal` methods (`scrollViewport`, `colors`, `setColors`, `cellAt`), the standalone `encodeFocus` function, the render-metadata `.expected.json` fixture infrastructure, and the last two v0 test gates (malformed-input resilience fuzz, large-APC memory bound).

At end of Pass 3, Gauntlet has a sufficient surface to replace tmux `capture-pane` with structured grid reads. Pass 4 (`KeyEncoder` + `KeyEvent`) follows and takes us to full v0 scope.

End-of-pass ceremony: local `v0.3.0` tag, changelog entry, `CONFIRM_WITH_MATT.md` updated. No push, no publish. Matt batches push + publish decisions after Pass 4.

## 2. Context

Pass 1 (`v0.1.0`, historical) shipped the Terminal + Formatter foundation. Pass 2 (`v0.2.0`, local tag) shipped effect callbacks. Both tags are local-only; npm publish is deferred to after Pass 4.

Gauntlet, the primary consumer, currently captures terminal state via tmux `capture-pane`. Pass 3's central deliverable — `RenderState` plus `Terminal.cellAt` — replaces that with typed structured access: grapheme cluster text, SGR style state, wide/continuation flags, hyperlink URIs, cursor position, active screen, scrollback depth. Matt reviews after Pass 3 lands; Codex may independently review this spec.

## 3. Scope

### 3.1 In scope

1. `RenderState` class with dual iterator shape (ergonomic `rows()` / `row.cells()`; hot-path `forEachCell` / `forEachDirtyCell` / `forEachDirtyRow`), dirty lifecycle (`update()` refreshes but does not clear; `markClean()` is the only clear path), `colors()` accessor.
2. `Terminal.scrollViewport(pos)` — `"top" | "bottom" | number` (signed row delta).
3. `Terminal.colors()` / `Terminal.setColors(patch)` — returns `{effective, defaults, palette[256]}` per the §4.7 semantics in the binding design.
4. `Terminal.cellAt({x, y, coordinateSpace})` — all four coord spaces at once (`"active"` / `"viewport"` / `"screen"` / `"history"`).
5. `encodeFocus("in" | "out")` — standalone function, returns `Uint8Array`.
6. Public types added to `src/types.ts` and re-exported from `src/index.ts`: `CellInfo`, `CellStyle`, `TerminalColors`, `UnderlineStyle`, `RenderRow`, `RenderCell`.
7. Render-metadata fixture infrastructure: `.expected.json` sibling files under `test/fixtures/`, harness that replays an existing `.bin` through `vtWrite` and diffs the resulting render-state snapshot against the JSON. Reuses the `--update-fixtures` pattern from Pass 1.
8. Real-program captures: pair `.expected.json` companions onto the existing `.bin` / `.expected.txt` fixtures already in `test/fixtures/`. No new captures authored in Pass 3.
9. Malformed-input resilience fuzz — bounded (seeded, ≤ 128 KiB) random byte stream into `vtWrite`, asserts no exception bubbles out and `snapshot()` still works afterward.
10. Large-APC payload test — ≥10 MiB synthetic APC payload, asserts process RSS does not grow proportionally and `vtWrite` returns cleanly (verifies the `apcMaxBytes` default wired at construction time).
11. Local `v0.3.0` tag; changelog entry under `## [0.3.0]`; `CONFIRM_WITH_MATT.md` updated with Pass 3 summary + Pass 4 carry-forward.

### 3.2 Explicitly out of scope (Pass 4)

`KeyEncoder`, `KeyEvent`, the `Key` string-literal union, `KittyFlags`, `Mods`, key-encoder goldens table. `build_info` surfacing and `sys` log callback also remain deferred.

### 3.3 Still deferred per the binding design (tranches 1–4)

Mouse encoder + event, paste helpers (`ghostty_paste_*`), zero-copy `onWritePty` variant, query-response callbacks (`ENQUIRY` / `XTVERSION` / `DEVICE_ATTRIBUTES` / `SIZE` / `COLOR_SCHEME` — the allocator-callback-pattern work), Kitty graphics, OSC parser / SGR parser / Selection, `KeyEvent` dev-mode validation.

## 4. Detailed design

References to "§N.M" below are sections of `docs/superpowers/specs/2026-04-22-ts-libghostty-design.md` (the binding design). This spec does not restate the public types defined there; it describes Pass 3's added implementation semantics, constraints, and verification.

### 4.1 `RenderState`

Public shape matches the binding design §4.2. Behavior in Pass 3:

**Data model.** `update(term)` makes a single round trip into libghostty to retrieve the render-state snapshot (the C API exposes `ghostty_render_state_*` / `ghostty_page_list_*` calls; exact symbol set is determined during Task 2 of the plan by reading `vt.h` at the pin). The result is decoded into JS memory eagerly: a row array sized to the terminal's row count, each row holding the decoded cells for that row plus `wrapped` / `dirty` flags. All subsequent iterator walks read this cached JS memory. No FFI call happens mid-walk. This is deliberate: it keeps the cell hot path strictly JS, lets `markClean()` be a pure-JS flag flip, and gives us one obvious place to free / reallocate on `resize`.

**Dirty lifecycle.** `update()` refreshes the cached snapshot from the terminal but does not clear dirty flags on rows. `markClean()` walks the cached rows and sets each `dirty = false`. This mirrors the C API and lets multiple consumers (renderer + log-tailer) observe independent dirty state by calling `markClean()` on their own cadence. `dirty()` returns `"none" | "rows" | "all"`: `"all"` if the terminal indicated a full redraw (e.g., alt-screen swap, reset), `"rows"` if a subset is dirty, `"none"` if nothing changed since the last `markClean()`.

**Iterator shapes and allocation costs.**
- Ergonomic path — `rows()` returns an `IterableIterator<RenderRow>`, one fresh `RenderRow` object per row. `row.cells()` returns an `IterableIterator<RenderCell>`, one fresh `RenderCell` object per cell. Consumer-friendly; allocates on every frame.
- Hot path — `forEachCell(row, cb)` and `forEachDirtyCell(cb)` reuse a single mutable `RenderCell` object per invocation; fields mutate before the next iteration. `forEachDirtyRow(cb)` reuses a single `RenderRow` object similarly. The callback must not retain the reference.
- Both paths read the same cached JS memory. The only difference is allocation pattern.

**Object lifetimes.** Documented in code comments on the public types and called out in README:
- Objects from `rows()` / `row.cells()` / `forEachDirtyRow` — snapshots, valid until the next `update()` call.
- The mutable `RenderCell` passed to `forEachCell` / `forEachDirtyCell` — valid only for the duration of the single callback invocation; mutated before the next cell.
- Retaining past these windows is undefined behavior.

**Cell text model.** `text` is the grapheme cluster at the cell (combining marks, ZWJ sequences, variation selectors resolved by libghostty). Empty string for blank cells. Wide-grapheme continuation: primary cell has `wide: true` and full `text`; trailing cell has `isWideContinuation: true` and `text = ""`. Consumers reconstructing text skip continuation cells.

**Style reuse.** `RenderCell.style` is `undefined` when the cell is default-styled. Non-default styles decode `GhosttyStyle` into a `CellStyle` object. The hot path reuses a single `CellStyle` buffer embedded inside the reused `RenderCell`, mutating its fields; the ergonomic path allocates a fresh `CellStyle` per cell.

**`colors()` on `RenderState`.** Proxies to the cached color state that was captured during the last `update(term)`. Implementation may read `ghostty_terminal_get(COLORS)` or equivalent at `update()` time and cache. Returns the same `TerminalColors` shape as `Terminal.colors()`.

**`close()`** releases any libghostty-side render state handle the implementation holds. Idempotent; `Symbol.dispose` wrapper identical to other classes.

### 4.2 `Terminal.scrollViewport`

One FFI call to the `ghostty_terminal_scroll_viewport` equivalent. Argument mapping:
- `"top"` — scroll to history top.
- `"bottom"` — scroll to active-screen bottom (the live view).
- `number` — signed row delta: positive scrolls toward bottom (newer content), negative scrolls toward top (older content). Consumers responsible for bounds; libghostty clamps.

No snapshot invalidation concerns; `RenderState.update(term)` re-reads the visible window on next call.

### 4.3 `Terminal.colors` / `Terminal.setColors`

`colors()` returns a `TerminalColors` object with three fields per §4.7 of the binding design:
- `effective` — `{fg?, bg?, cursor?}` — colors currently displayed after any OSC 10/11/12 overrides.
- `defaults` — `{fg?, bg?, cursor?}` — the configured defaults the terminal would use absent OSC override.
- `palette` — `RGB[]` of length exactly 256.

Entries are `undefined` when libghostty reports the color as unset, not a placeholder color.

`setColors(patch)` accepts a `Partial<TerminalColors>` and applies it to **defaults**. An empty `patch` is a no-op.

**OSC-override survival.** The binding design (§4.7) explicitly flags whether OSC overrides survive a `setColors` call as "pending implementation-time verification." Pass 3 resolves this via a dedicated test in `test/smoke/colors.test.ts`:

1. Construct a terminal.
2. Call `setColors({defaults: {fg: [10, 20, 30]}})`.
3. Feed an OSC 10 sequence (`ESC ] 10 ; rgb:ff/00/00 ESC \\`) via `vtWrite`.
4. Observe `colors().effective.fg` — should be `[255, 0, 0]`.
5. Call `setColors({defaults: {fg: [40, 50, 60]}})`.
6. Observe whether `colors().effective.fg` is still `[255, 0, 0]` (override preserved) or now `[40, 50, 60]` (override cleared).

The observed behavior is documented in README verbatim. If upstream offers a preservation API, we expose it; if not, the README notes "`setColors` clears OSC overrides" and we move on. This decision is *not* blocking Pass 3 — both outcomes are acceptable; we document what libghostty does.

### 4.4 `Terminal.cellAt`

All four coordinate spaces implemented in Pass 3. Dispatch:

| coord space | C path (illustrative; confirmed at Task 2) | Cost | Returns |
|---|---|---|---|
| `"active"` (default) | direct active-screen lookup | O(1) | decoded `CellInfo` |
| `"viewport"` | viewport-offset lookup | O(1) | decoded `CellInfo` |
| `"screen"` | walk wrapped rows | O(row) | decoded `CellInfo` |
| `"history"` | scrollback touch | O(depth) | decoded `CellInfo` |

Out-of-bounds returns `undefined`, not a throw. (Consumers routinely ask about cells outside the current geometry — e.g., probing whether a historical coordinate is still reachable — and a throw on every miss is wrong ergonomics.)

Returned `CellInfo` reuses the same decoding helpers as `RenderCell` (grapheme text, `wide`, `isWideContinuation`, `style?`, `hyperlinkUri?`, `protected`). The returned object is a fresh allocation per call; no reuse buffer here (this is a one-shot API, not a hot-loop API).

Cost differences documented in README as a table.

### 4.5 `encodeFocus`

```ts
function encodeFocus(direction: "in" | "out"): Uint8Array;
```

Single FFI call to the relevant `ghostty_encode_*` function (exact symbol confirmed at Task 2). No Terminal required. Returns a fresh `Uint8Array` of the encoded bytes.

Standalone smoke test: `encodeFocus("in")` returns non-empty bytes starting with `ESC` (byte 0x1b); `encodeFocus("out")` returns non-empty bytes starting with `ESC`; both are stable (no nondeterminism).

### 4.6 Render-metadata fixture infrastructure

**Schema.** Each `.expected.json` sibling to a `.bin` fixture captures what a consumer would see after replaying the bytes through a fresh terminal of the fixture's declared geometry. Top-level shape:

```json
{
  "geometry": { "cols": 80, "rows": 24 },
  "terminal": {
    "cursor": { "x": 0, "y": 0, "visible": true, "style": "block" },
    "activeScreen": "primary",
    "title": "bash",
    "pwd": "/home/matt",
    "scrollbackRows": 0
  },
  "colors": {
    "effective": { "fg": [200, 200, 200], "bg": [30, 30, 30] },
    "defaults": { "fg": [200, 200, 200], "bg": [30, 30, 30] },
    "palette": ["...256 entries..."]
  },
  "rows": [
    {
      "y": 0,
      "wrapped": false,
      "cells": [
        { "x": 0, "text": "$", "wide": false },
        { "x": 1, "text": " ", "wide": false },
        { "x": 2, "text": "l", "wide": false, "style": { "bold": true } }
      ]
    }
  ]
}
```

Fields are omitted when they take their default values (cells with `isWideContinuation: false`, `protected: false`, undefined `style`, etc.) to keep the JSON readable. The harness normalizes before compare: fills in defaults, sorts palette into a single flat array, truncates rows to the declared geometry.

**Dirty flags are not captured** in fixtures. Dirty state depends on observer cadence (a fixture captured on a fresh terminal is "all dirty"), which is not a useful invariant to assert.

**Harness** lives alongside the existing `test/fixtures/` replay harness. Flow:
1. Read `<scenario>.bin` and the declared geometry from the existing fixture manifest (or a per-fixture header; detail decided at plan time).
2. Construct a `Terminal` at the declared geometry.
3. `vtWrite` the bytes.
4. Collect the snapshot: `terminal.snapshot()`, `terminal.colors()`, and `RenderState.update(term)` → walk cells.
5. Normalize to the schema above.
6. Compare against `<scenario>.expected.json`. On mismatch, emit a structured diff (per-row or per-cell, not a raw JSON blob diff — JSON diff on 24×80 grids is unreadable).
7. `--update-fixtures` overwrites the `.expected.json` with the observed output.

**Which fixtures get `.expected.json`.** All existing `.bin` fixtures in `test/fixtures/` that have an `.expected.txt` get a companion `.expected.json` generated in Pass 3. New fixtures added in future passes follow the same pattern.

### 4.7 Malformed-input resilience

Two tests, both in `test/smoke/resilience-fuzz.test.ts`:

1. **Seeded random bytes.** Use a deterministic seed and generate up to 128 KiB of random bytes (biased to include ESC / CSI / OSC / DCS lead-ins so the parser actually exercises its machinery). Feed through `vtWrite` in variable-sized chunks. Assert: no exception escapes; `snapshot()` works afterward; `cellAt({x:0, y:0})` works afterward; `close()` works afterward. Run the full pass ~20 times with different seeds.

2. **Large APC payload.** Synthesize `ESC _` + 10 MiB of `A` + `ESC \\`. Feed through `vtWrite`. Record process RSS before and after (via `process.memoryUsage().rss`). Assert: `vtWrite` returns; post-write RSS is within a reasonable bound of the pre-write RSS (default is `apcMaxBytes: 1 MiB`, so the parser should discard well before 10 MiB retention); `snapshot()` works afterward.

The RSS bound is intentionally lenient (e.g., "post-RSS < pre-RSS + 4 MiB"); we want to catch "process grows 10 MiB" regressions, not enforce a tight bound.

### 4.8 Public re-exports

`src/index.ts` grows to re-export everything Pass 3 adds. Approximately:

```ts
export { RenderState } from "./render-state";
export { encodeFocus } from "./focus";
export type {
  CellInfo, CellStyle, TerminalColors, UnderlineStyle,
  RenderRow, RenderCell,
} from "./types";
```

Existing Pass 1/2 re-exports unchanged. Type-only exports use `export type` per the current file's convention.

## 5. Implementation approach

Pass 3 follows the Pass 1 / Pass 2 subagent-driven model:
- An orchestrator Bob (probably me, Ekaterin, in a later session) executes the plan inline for small tasks and dispatches Guppies for larger isolated chunks.
- Dispatched Bobs run on git worktrees per the `feedback_dispatch_worktree` memory.
- Spec reviewers and code-quality reviewers review major commits per the Pass 2 protocol (explicit structured-output prompt; the "Signed off" default is unhelpful).

### 5.1 Task ordering (sketched — plan fills in detail)

1. **Task 1 — preflight baseline.** Capture `bun test`, `bun run typecheck`, `bun run verify:generated` state. Record commit hash. Ensure tree is clean off `main` at v0.2.0.
2. **Task 2 — FFI discovery.** Read `vendor/ghostty/include/ghostty/vt.h` at pin; enumerate symbols needed for render-state, scroll-viewport, colors, cell-at, focus-encode. Extend `SYMBOLS` in `src/ffi.ts`, update `generated.ts` via `bun run build:bindings`, commit. This is the Pass 3 equivalent of Pass 2 Task 3.
3. **Task 3 — struct-layout probe extension.** If any new structs are touched (render cell layout, style field additions, etc.), extend `scripts/probe-layout.c` and regenerate. `bun run verify:generated` must stay green.
4. **Tasks 4–6 — small Terminal methods.** `scrollViewport`, `encodeFocus`, then `colors`/`setColors`. Each is a small commit with a smoke test. These are the "easy wins" that also establish the FFI patterns new to Pass 3 (single scalar call, array return for palette, partial-struct update).
5. **Tasks 7–8 — `Terminal.cellAt`.** One task per "half" if the 4 coord spaces split cleanly into (active/viewport) and (screen/history); otherwise one task. Smoke tests cover all four spaces and the out-of-bounds → `undefined` case.
6. **Tasks 9–12 — `RenderState`.** Split: (a) class skeleton + `update()` + `colors()` + `dirty()` + `markClean()` + `close()`; (b) ergonomic iterators; (c) hot-path iterators; (d) smoke tests for all three paths + dirty lifecycle. Dispatched Bob for (b) through (d) if the orchestrator wants parallelism; sequential is fine too.
7. **Tasks 13–14 — metadata fixture infrastructure.** (a) Harness (normalize, compare, `--update-fixtures`). (b) Generate `.expected.json` companions for existing fixtures; any fixtures where libghostty produces unstable output across runs get flagged for later investigation (but don't block Pass 3 — just skip with a documented reason).
8. **Task 15 — resilience fuzz.** Both sub-tests in one file.
9. **Task 16 — public re-exports sweep.** `src/index.ts`, tarball-smoke spot-check.
10. **Task 17 — release gate.** Changelog entry. Local `v0.3.0` tag. Update `CONFIRM_WITH_MATT.md`.

Estimated: 17 tasks. (Earlier rough-count was 20; consolidated. Plan may re-split.)

### 5.2 Known unknowns to resolve in-flight

- Exact libghostty symbol names for render-state extraction. `ghostty_render_state_*` is speculative. Resolved at Task 2 by reading `vt.h`.
- Whether `Terminal.colors()` can be satisfied by `ghostty_terminal_get` keys or needs a dedicated accessor. Resolved at Task 2.
- Whether OSC 10/11 overrides survive `setColors` (see §4.3). Resolved by the test at Task 6.
- Whether any existing `.bin` fixtures produce unstable render-state output (cursor blink phase, timing, etc.). Resolved at Task 14 — unstable fixtures get skipped with a documented reason, not a blocker.

## 6. Testing strategy

### 6.1 Smoke tests added in Pass 3

- `test/smoke/scroll-viewport.test.ts` — lifecycle + `"top"` / `"bottom"` / positive delta / negative delta / beyond-bounds (clamps cleanly).
- `test/smoke/colors.test.ts` — read defaults; `setColors` patch; OSC 10/11 overrides; OSC-override survival test (records observed behavior).
- `test/smoke/cell-at.test.ts` — positive lookup in each of the four coord spaces; out-of-bounds returns `undefined`; wide-grapheme cell returns `wide: true`, continuation returns `isWideContinuation: true`.
- `test/smoke/focus.test.ts` — both directions encode non-empty bytes starting with ESC.
- `test/smoke/render-state.test.ts` — lifecycle (construct + close + dispose); `update()` on fresh terminal produces rows matching geometry; ergonomic path (`rows()` + `row.cells()`); hot path (`forEachCell`); dirty lifecycle (`update()` does not clear; `markClean()` does); alt-screen swap sets `dirty() === "all"`; resize rebuilds cached layout.
- `test/smoke/resilience-fuzz.test.ts` — seeded random bytes (×20 seeds); large APC payload; both post-conditions (no exception, snapshot works).

### 6.2 Fixture tests

- Harness at `test/fixtures/` gains `.expected.json` compare alongside existing `.expected.txt` compare.
- All existing `.bin` fixtures get `.expected.json` companions generated via `--update-fixtures` and then reviewed by hand for sanity (no committed JSON that's obviously wrong).

### 6.3 Tarball smoke

`scripts/run-tarball-smoke.sh` updated to exercise one new surface (likely `RenderState.forEachCell` on a prompt-like byte stream) on top of the existing Pass 1 / Pass 2 assertions. This catches packaging regressions.

### 6.4 ABI smoke

Extended to verify every new symbol added in Pass 3 resolves at load. The existing `test/smoke/abi.test.ts` structure accommodates additions without refactor.

## 7. Release gate

At end of Pass 3:

- All smoke tests pass. Tarball smoke passes.
- `bun run typecheck` clean.
- `bun run verify:generated` clean.
- `CHANGELOG.md` gains a `## [0.3.0] - 2026-04-23` (or the date Pass 3 actually lands) entry under Keep-a-Changelog format. Sections: Added (everything in §3.1). No Changed / Fixed / Removed / Deprecated / Security unless something surfaces during implementation.
- `package.json` `version` bumped to `0.3.0`.
- Changelog and version bump committed together with a `docs(changelog): v0.3.0` or `chore(release): v0.3.0` prefix, then `git tag -a v0.3.0` at that commit.
- `CONFIRM_WITH_MATT.md` gains a Pass 3 summary section and Pass 4 carry-forward notes. Matt reviews + decides push/publish cadence after Pass 4.

No push, no publish. Per Matt's direction: "mark in the sand" only.

## 8. Carry-forward to Pass 4

What Pass 4 needs from Pass 3:

- `SYMBOLS` table already has any shared key-encoder symbols if they overlap with render-state FFI (unlikely; Pass 4 will add its own).
- Struct probe pattern established; Pass 4 extends probe if `GhosttyKeyEvent` or similar requires layout.
- Public re-exports convention established; Pass 4 follows the same pattern.
- Test-infrastructure patterns: golden-table tests follow the fixture-harness lead; per-class smoke tests follow Pass 3's shape.
- RenderState's object-reuse pattern (mutable singleton for hot path) establishes a convention Pass 4's `KeyEncoder.encode` does NOT follow (encode returns a fresh `Uint8Array` each call; the hot-loop concern there is a different problem).

## 9. Risks and mitigations

- **libghostty render-state FFI surface may differ from this spec's guesses.** Mitigation: Task 2 is a hard gate. If the FFI shape diverges significantly, we reconcile the spec before proceeding (same reconciliation pattern as Pass 1 Task 3).
- **Render-state cached-in-JS memory model may be too heavy on large terminals** (e.g., 500×200 = 100K cells). Mitigation: the cache holds only cells that have ever been touched by `update()`, sized to geometry. At 100K cells and a conservative 200 bytes/cell (including grapheme strings), that's 20 MB — acceptable. If a real consumer hits memory pressure, the hot path's buffer-reuse mitigates and a lazy-per-row cache is a straightforward optimization in a later pass. Not a Pass 3 concern.
- **Unstable fixture output** (e.g., timing-dependent cursor blink state) could fail CI spuriously. Mitigation: the fixture harness supports skipping individual fixtures with a documented `.skip.reason` sidecar, and Task 14 uses that escape hatch if needed. Blocking Pass 3 on hypothetically-unstable fixtures is not worth it.
- **Matt reviews + Codex reviews this spec before implementation starts.** Any material changes come as a spec revision, then propagate into the plan. Same cadence as Pass 2's two reconciliation rounds.

## 10. Revision history

- **2026-04-23** — Initial spec written (Ekaterin).
