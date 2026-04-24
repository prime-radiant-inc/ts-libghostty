# Open items for Matt — ts-libghostty-vt

**Updated 2026-04-23 by Cazaril.** Pass 1 done; Pass-1-fix done (Hilbert); differential testing harness done (separate Bob); **Pass 2 done** (Cazaril + Turing + Maxwell + Gödel). First npm publish targets `v0.2.0`; local tag created by Task 12, not pushed.

---

## Status snapshot

| Phase | State |
|---|---|
| Pass 1 (Terminal + Formatter + lifecycle + ABI safety) | ✅ done; `v0.1.0` tag exists locally as a historical marker, **not being published** |
| Pass-1-fix (Codex contract bugs) | ✅ done — Hilbert, commit `b5c7922`. See "Pass 1 contract fix-up" below. |
| Differential testing harness v0 | ✅ done — separate Bob, commits `81e5d73`–`6362020` |
| Pass 2 (effect callbacks: onWritePty/onBell/onTitleChanged) | ✅ done — `v0.2.0` tag local, not pushed. 112 smoke tests pass. |

**Pinned to:** Ghostty `e88c6c099152dd6d2d7e517516e1f3c183c152f7` (tip-of-main as of 2026-04-22). Platforms: `darwin-arm64` only.

---

## Version policy

`v0.1.0` is **not being published.** First npm publish targets `v0.2.0` after Pass 2 lands, bundling Pass 1 + Hilbert's contract fixes + differential test harness + Pass 2 callbacks together. The local `v0.1.0` tag stays as a historical marker; no retag.

## Before `v0.2.0` publish — your todo

1. **Review** the Pass 2 commit range (`git log b5c7922..v0.2.0`) — 12 new commits, primary diff in `src/terminal.ts`, `src/internal/callbacks.ts` (new), `test/smoke/callbacks.test.ts` (new).
2. **Update LICENSE copyright** if needed — currently reads `Copyright 2026 Prime Radiant (and contributors)`, matching the `prime-radiant-inc` GitHub org. Change if you prefer different attribution.
3. **Push main + `v0.2.0` tag.** `git push origin main && git push origin v0.2.0`. First push triggers CI; verify green.
4. **Publish.** `bun publish` or `npm publish` from a clean tree. The name `ts-libghostty-vt` is unclaimed on npm as of last check.

---

## Pass 1 contract fix-up (2026-04-23, Hilbert)

Codex reviewed Pass 1 and surfaced three contract bugs. All three landed before Pass 2 starts. Summary:

1. **HIGH 1 — `apcMaxBytes` / `apcMaxBytesKitty` silently dropped.** Removed both fields from `TerminalOptions` in `src/types.ts`. README already documented these as Pass-2-deferred; the type was the lie. Behavior unchanged (constructor was ignoring them anyway), but callers that explicitly passed them now get a TS compile error instead of silent fallthrough.

2. **HIGH 2 — Missing ABI-range input validation.** Added `assertU16` / `assertU32` / `assertSizeT` helpers in `src/terminal.ts` and wired them into `Terminal.constructor` and `Terminal.resize`. Bounds cited from `docs/abi/2026-04-22-abi-discovery.md`: cols/rows are `uint16_t` (1..65535), `cell_width_px`/`cell_height_px` are `uint32_t`, `max_scrollback` is `size_t` (capped at `Number.MAX_SAFE_INTEGER` so BigInt encoding stays lossless and negatives can't sneak through). All three Codex repros (`cols: 70000`, `cellPx: { width: -1, ... }`, `maxScrollback: -1`) now throw `GhosttyError` with code `"invalid_value"` and a message naming the offending field + received value.

3. **MEDIUM 3 — Stub snapshot fields → narrow path chosen.** Removed `cursor.style` and `mouseTracking` from `TerminalSnapshot` in `src/types.ts`. Decision rationale: `MOUSE_TRACKING` returns just a bool ("any tracking active") which doesn't map honestly to the 5-variant `MouseTracking` union — wiring it as `"none"` vs `"normal"` would trade one footgun for another. `CURSOR_STYLE` is a 72-byte `GhosttyStyle` struct decode that warrants real Pass-2-or-later work. The `CursorStyle` and `MouseTracking` *types* remain exported for future passes that wire them properly. README's `snapshot` description was high-level and didn't enumerate fields, so no README change needed.

**Tests added** (`test/smoke/terminal.test.ts`, +11 cases, 67 → 78 pass):
- `Terminal input validation` describe block: each Codex repro asserts both throw + `GhosttyError.code === "invalid_value"` + offending field name in message; boundary case `cols: 65535` constructs cleanly; `resize()` repros covered too.
- `TerminalSnapshot shape` describe block: runtime `in` check that `cursor.style` and `mouseTracking` are absent; compile-time `@ts-expect-error` test that fails typecheck if either field is re-added to the interface.

**Decision deferred to Matt:** version bump policy. Default is to NOT retag `v0.1.0` and let the next bump (probably `v0.2.0` after Pass 2) carry these forward. Matt hasn't pushed/published `v0.1.0` yet, so a retag is also viable — Matt's call.

**Pass 2 Task 1 preflight gate:** all four checks (apc grep, u16 bounds grep, repro-line grep, snapshot-shape grep) evaluate to OK against this tree. Pass 2 is unblocked.

---

## Pass 2 notes

### Pass 2 start-state (2026-04-23, Cazaril)

Pass 2 starts from commit `b5c7922` on `main` (Hilbert's Pass-1-fix commit, the parent of HEAD before Pass 2). Baseline captured at Task 1:

- `bun run typecheck` — clean
- `bun test test/smoke` — **78 pass / 0 fail / 333 expect() calls across 8 files** (the Pass-2 target after all callback tests lands is ~107)
- `bun run verify:generated` — green; `generated.ts` matches the pin
- Tree clean; 11 commits ahead of `origin/main` (the unpushed `v0.1.0` range)

All four preflight greps pass. Pass 2 is unblocked.

### Task 2 findings (2026-04-23, Turing)

`scripts/probe-callbacks.ts` ran clean on the first pass (exit 0, `tag=probe result=ok`). All three callback options — `WRITE_PTY` (1), `BELL` (2), `TITLE_CHANGED` (5) — bind, fire synchronously from `vt_write`, and detach cleanly when re-set to NULL. JSCallback.ptr passes straight through `ghostty_terminal_set` with no wrapping or shim. The `terminal` argument libghostty passes to each trampoline is bit-identical to the handle returned from `ghostty_terminal_new` (observed three times, all matched) — so JS closures can rely on it for identity and userdata can remain NULL through Pass 2. Post-detach BEL produced no extra callback, and the teardown order (set NULL → jscallback.close → terminal_free) did not crash. **Open Question #1 resolves to the default path:** `ghostty_terminal_get(DATA_TITLE)` invoked from *inside* the title_changed trampoline returned `"probe-title"` — the new title is synchronously readable within the callback. Task 9 Step 3's fallback (HALT AND ESCALATE on empty/stale read) is a no-op; proceed with the default snapshot-inside-callback strategy. No surprises versus the ABI doc. One minor observation worth flagging for Task 9: DA1 (`CSI c`) produced exactly one `write_pty` invocation with an `ESC`-prefixed reply, not a chunked stream — the reply handler can assume whole-sequence delivery per write.

### Pass 2 complete (2026-04-23, Cazaril)

All 12 tasks landed. Final state: 112 smoke tests pass (78 pre-Pass-2 baseline + 34 Pass-2 additions), typecheck clean, tarball smoke green, `verify:generated` green.

**Plan edits.** Tasks 5/6/7 were executed in order 7→5→6 instead of the plan's 5→6→7, because Task 5 references `opts.onWritePty` / `opts.onBell` / `opts.onTitleChanged` — fields that Task 7 adds to `TerminalOptions`. Plan-as-written would typecheck-fail mid-stream. No other plan edits; all commit messages match the plan's templates.

**Open Question #1 verified twice.** Turing's raw-FFI probe (Task 2) and Gödel's end-to-end test in `test/smoke/callbacks.test.ts` (Task 9, `"fires on OSC 0 title change with the new title"`) both confirmed `ghostty_terminal_get(TITLE)` inside the title trampoline returns the post-change title. No HALT-and-escalate triggered.

**Pass 2 Bob run.** Cazaril (orchestrator, Tasks 1/3/5/6/7/12 inline), Turing (Task 2 probe), Maxwell (Task 4 factories), Gödel (Tasks 8–11 smoke tests on a worktree — 29 new tests in `test/smoke/callbacks.test.ts`, merged back fast-forward). Tasks 8–11 ran in a git worktree per the "default to git worktree for dispatched Bobs" feedback memory.

**Carry-forward for Pass 3+.** (a) The `GhosttyTerminal` handle stored as `Number(BigInt) as Pointer` is still safe on darwin-arm64; revisit with platform expansion. (b) Query-response callbacks (`ENQUIRY`, `XTVERSION`, `SIZE`, `COLOR_SCHEME`, `DEVICE_ATTRIBUTES`) need an allocator-callback pattern — the three Pass 2 callbacks are void-returning and can't serve as a template for the response path. (c) The `#inCallback` guard covers the five mutating methods identified; if Pass 3 adds new mutating methods, they need `this.#assertNotInCallback("<name>")` as their first line. (d) `writePtyCb` / `bellCb` / `titleCb` private-field naming convention: one field per effect, keyed by lowercased camelCase of the option name. Follow this pattern for new callbacks.

### Pass 2 commit timeline

- `bc52ded` Task 1: preflight baseline
- `ccb4acf` Task 2: probe JSCallback + terminal_set compat (Turing)
- `a04fc2a` Task 3: extend SYMBOLS with ghostty_terminal_set + _get
- `2383c5d` Task 4: `src/internal/callbacks.ts` trampoline factories (Maxwell)
- `80aa429` Task 7: TerminalOptions callback fields
- `542fcd0` Task 5: Terminal.constructor wires callbacks + `#inCallback` guard
- `6f88394` Task 6: close() callback teardown + idempotency
- `0ecfeff` Task 8: smoke — onBell (Gödel)
- `a16fa6a` Task 9: smoke — onTitleChanged (Gödel)
- `60c29c6` Task 10: smoke — onWritePty (Gödel)
- `95fd9dc` Task 11: smoke — error paths + re-entry guard (Gödel)
- (Task 12 commit) docs + `v0.2.0` tag

---

## Pass 3 notes

### Pass 3 start-state (2026-04-23, Ekaterin)

Pass 3 starts from HEAD of `main` at commit `fcf5494ac5e0915c265f101687fcc9574e32ef76` (the Pass 3 plan commit, following the Pass 3 spec commits and Pass 2's v0.2.0 tag). Baseline captured at Task 1:

- `bun run typecheck` — clean
- `bun test test/smoke` — **112 pass / 0 fail / 390 expect() calls across 10 files** (the Pass-3 target after all new smoke tests lands is ~180: 112 baseline + ~53 Pass-3 additions + ~15 RenderState tests)
- `bun run verify:generated` — green; `generated.ts` matches the pin (141 declared symbols, 49 enums, 4 structs, 41 modes)
- Tree clean; Pass 2's `v0.2.0` tag is local-only, unpushed; 4 commits ahead of `origin/main` (spec + plan for Pass 3)

Pass 3 is unblocked.

### Pass 3 complete (2026-04-23, Ekaterin)

All 18 tasks landed. Final state: **198 smoke tests pass / 0 fail** (112 baseline + 86 Pass-3 additions), typecheck clean, `verify:generated` green (141 symbols, 49 enums, 12 structs), tarball smoke green.

**Plan edits during execution — three rounds of reconciliation.** Pass 3's plan was written with Cipher's plan-authoring header survey, which diverged from the real libghostty-vt in several ways. Each discovery fed a reconciliation commit that downstream Bobs read:

1. **Task 2 reconciliation** (after Lovelace's probe) — caught 10 divergences: `ROW_DATA_CELLS = 3` (plan had 2), row iterator requires a `get(ROW_ITERATOR)` populate step, cell iteration uses a reusable container (`cells_new` + `row_get(CELLS, &cells)`), `GhosttyPoint` is 24 bytes, APC read-back is NOT supported (test strategy branches to the "no-crash" fallback), `OUT_OF_SPACE = -3` (plan had `-5` placeholder), empty cells return `SUCCESS + len=0` not `OUT_OF_SPACE`.
2. **Post-Task-3 naming correction** (after Vaucanson) — plan referenced `generated.sizedStructs.X` / `generated.enumValues.GhosttyX` but the generator actually exports `structLayouts["X"]!` (top-level Record) / `GhosttyXValues` (individual per-enum exports). Sed-wide rename plus 4 import statements corrected.
3. **Global API conventions amendment** (after Niven + Faraday's Task 4/5 findings) — plan used `ffi.symbols.X` but real code uses `const lib = getLib(); lib.symbols.X`; plan used `new GhosttyError({code, functionName, message})` but real signature is `new GhosttyError(message, {code, functionName})`; plan used `#assertNotClosed("method")` but real name is `#assertOpen()` (no arg). Added a conventions table to the Task 2 reconciliation block; subsequent Bobs apply substitutions when copying plan snippets. `#assertNotClosed` → `#assertOpen` rename was sed'd plan-wide as well.

Every downstream Bob read the reconciliation block before starting their task — the pattern held and no more cascading drift emerged after Task 5.

**Open Question resolutions from probing:**

- **Native dirty clear: ONE call** via `ghostty_render_state_set(state, GHOSTTY_RENDER_STATE_OPTION_DIRTY, &GHOSTTY_RENDER_STATE_DIRTY_FALSE)`. Clears both the global dirty flag and per-row flags in a single operation. Benchmarker's Task 13 "markClean + re-update with no activity stays 'none'" test verifies the native clear actually clears (not just the JS mirror — that was the P1 item from Codex round 1).
- **Viewport cursor IS exposed** via `CURSOR_VIEWPORT_*` render-state data keys (x/y/has_value/wide_tail). Cursor style on viewport is NOT exposed — consistent with `TerminalSnapshot.cursor.style` staying deferred. `RenderState.cursor()` returns `ViewportCursor { x, y, visible, wideTail }`.
- **APC read-back is NOT supported.** `ghostty_terminal_get(handle, APC_MAX_BYTES, ...)` returns `NO_VALUE (-4)`. §4.4 test strategy went to the fallback path (no-crash + invalid-path assertions only). APC bounds themselves still wire correctly via `ghostty_terminal_set`.
- **OSC 10/11/12 overrides are PRESERVED** across `setColors` calls (Prism's Task 6 probe). README documents this.

**Pass 3 Bob run.** 14 Bobs contributed across 18 tasks: Ekaterin (orchestrator, Tasks 1/3-reconciliation/15/17/18 inline), Cipher (plan-authoring header survey), Lovelace (Task 2), Vaucanson (Task 3), Niven (Task 4), Faraday (Task 5), Prism (Task 6), Lorentz (Task 7), Ptolemy (Task 8), Annals (Task 9), Vesalius (Task 10), Weaver (Task 11), Knuth (Task 12), Benchmarker (Task 13), Dewey (Task 14), Barlow (Task 16). Orchestrator-on-main with dispatched-Bobs-on-worktrees through Task 10; switched to dispatched-Bobs-on-main from Task 11 onward (the `isolation: "worktree"` pattern branched off `origin/main` rather than current HEAD, forcing manual integration at each step; direct-on-main dispatch with sequential execution avoided that).

**Carry-forward for Pass 4.**

- `KeyEncoder`, `KeyEvent`, `KittyFlags`, `Mods` — the full keystroke-encoding surface. `src/internal/generated.ts` already has `Key` as a string-literal union (generated from `vt.h`); Pass 4 wires the encoder around it.
- `rawStyleToCellStyle` helper now lives in `src/internal/style.ts` (Weaver's Task 11 extraction). If Pass 4 needs style decoding, import from there.
- `RenderState`'s mutable-singleton hot-path pattern does NOT apply to `KeyEncoder.encode` — encode returns a fresh `Uint8Array` per call (binding design §4.4 confirms).
- Unstable-fixture skip pattern (the `.skip.reason` sidecar idea) was planned but not needed — all 3 fixtures at v0.3.0 (hello-world, sgr-basic, utf8-emoji) produced stable output. Pass 4 fixtures follow the same pattern if needed.
- Global API conventions from the Task 2 reconciliation (getLib, GhosttyError signature, #assertOpen, structLayouts / GhosttyXValues) — reuse these in Pass 4 task prompts so the plan-vs-real drift loop doesn't repeat.

### Pass 3 Codex review pass 1 (2026-04-24, post-v0.3.0-tag)

Codex reviewed the landed branch and surfaced four issues:

- **P1 — `markClean` only cleared global native dirty, not per-row.** libghostty tracks global and per-row dirty independently. The single-call clear (`ghostty_render_state_set(OPTION_DIRTY, FALSE)`) clears global only; per-row flags stay set. After `update` → `markClean` → `update` with no terminal activity, `forEachDirtyRow` still visited every row while `dirty()` reported `"none"` — contradiction. **Fix:** `markClean` now iterates a populated row iterator and calls `ghostty_render_state_row_set(iter, ROW_OPTION_DIRTY, &false)` per row after the global clear, then mirrors into JS. Covered by new test `"Codex P1 repro: update → markClean → update (no activity) → forEachDirtyRow is empty"`.
- **P1 — `RenderState` stubbed grid metadata fields.** `wrapped` was hardcoded false, `wide` / `isWideContinuation` were heuristic-only, `protected` was hardcoded false, `hyperlinkUri` never populated. Fixture JSONs had passed because they were generated from these same stubs. **Fix:** `#rebuildCache` now reads `ghostty_render_state_row_get(ROW_DATA_RAW)` → `ghostty_row_get(ROW_DATA_WRAP)` for wrapped; `#walkCells` reads `row_cells_get(RAW)` → `ghostty_cell_get(CELL_DATA_WIDE / PROTECTED)` for per-cell flags. Hyperlink URI on render-state cells remains unexposed at this pin (no HYPERLINK_URI data key on `GhosttyRenderStateRowCellsData`); `Terminal.cellAt` still provides hyperlink URI via `grid_ref_hyperlink_uri` for consumers that need it. Tests added for CJK wide detection, unstyled cells, and SGR-bold cells. Three fixture JSONs regenerated with correct content.
- **P2 — Default cells attached all-false style objects.** `rawStyleToCellStyle` always returned a `CellStyle`, violating `style?: undefined = default` contract. **Fix:** new `isDefaultRawStyle(raw)` helper in `src/internal/style.ts`; both `Terminal.cellAt` and `RenderState.#walkCells` now only set `style` when the decoded `RawStyle` is non-default. Fixture JSONs shrank meaningfully.
- **P2 — `RenderState.colors` didn't mirror `Terminal.colors` snapshot.** It returned `defaults: {}` and read effective via `ghostty_render_state_colors_get`, missing the caller's `setColors` defaults. **Fix:** `update(term)` now caches `term.colors()` directly; `RenderState.colors()` returns that cached snapshot. New test verifies `rs.colors().defaults.fg` matches `term.colors().defaults.fg` after `setColors`.

Also added two SYMBOLS loads to `src/ffi.ts`: `ghostty_row_get` and `ghostty_render_state_row_set` (declared in the headers but not previously loaded); plus `ghostty_style_is_default` for future reuse.

All 203 smoke tests pass (198 pre-review + 5 new regression tests). The `v0.3.0` tag was moved forward to include this fix — no intermediate `v0.3.0-rc` / `v0.3.1` to avoid cluttering the timeline. Per Matt's direction (mark-in-the-sand only, no push/publish), moving a local tag is safe.

### Pass 3 commit timeline

- `e71885a` `c9a7489` `93b4451` Pass 3 spec + two Codex review reconciliation rounds
- `fcf5494` Pass 3 plan (pre-Codex)
- `2e84abd` Task 1 preflight (Ekaterin)
- `f490421` `1295834` Task 2 probe (Lovelace) + plan reconciliation
- `364a823` `4e1f948` Task 3 SYMBOLS + helpers (Vaucanson) + plan naming correction
- `17c508e` `57faea2` Task 4 scrollViewport (Niven) + #assertOpen plan rename
- `e187c4c` `b0b82c6` Task 5 encodeFocus (Faraday) + global API conventions amendment
- `2816a88` Task 6 colors/setColors (Prism) — records OSC survival = YES
- `9c6d94c` Task 7 APC bounds (Lorentz)
- `4295f78` `5256243` Task 8 + Task 9 cellAt (Ptolemy, Annals)
- `d241a49` Task 10 RenderState skeleton (Vesalius, manual integration)
- `4531222` Task 11 ergonomic iterators + walkCells decode (Weaver)
- `758c606` Task 12 hot-path iterators (Knuth)
- `39bf80c` Task 13 RenderState smoke tests, 18 tests (Benchmarker)
- `3ed9e20` Task 14 metadata fixture harness (Dewey)
- `2104571` Task 15 sgr-basic + utf8-emoji fixtures (Ekaterin inline)
- `c7210c2` Task 16 resilience fuzz + large-APC (Barlow)
- `2abafdc` Task 17 tarball smoke extension (Ekaterin inline)
- (Task 18 commit) release prep + `v0.3.0` tag

---

## Known plan/code drift (low priority — does not block publish)

These are small inconsistencies between the plan's snippets and the actually-committed code. They don't affect runtime behavior; a future Bob re-regenerating files from the plan would hit them. Optional cleanup for a quiet afternoon.

1. **Task 3 template section** (plan lines ~520–660) has its original illustrative placeholders with stale names (`GHOSTTY_RESULT_OK`, `GhosttyFormatterOptions`) that don't exist at the pin. The real ABI doc is at `docs/abi/2026-04-22-abi-discovery.md` — source of truth. The template is now historical.

2. **Task 5 `gen-bindings.ts` snippet** in the plan doesn't include Ockham's `GHOSTTY_ENUM_MAX_VALUE` sentinel handling or the `GHOSTTY_RESULT_MAX_VALUE` skip, both required to parse the real headers. Committed code is correct.

3. **Task 9 `sized-struct.ts` snippet** in the plan throws on `kind: "struct"` and `kind: "ptr"`, but Postel's Task 16 work extended `writeStruct` to accept `Uint8Array`-for-struct and `number | bigint`-for-ptr because `Formatter.format` needs both. Committed code has the extensions.

4. **Task 16 `formatter.test.ts` snippet** asserts `expect(s).toContain(" ")` for empty-terminal output. Reality: the plain formatter trims to empty string. Postel replaced with `expect(s).toBe("")` + an interior-blank test. Committed tests pass.

5. **Task 18 `abi.test.ts` snippet** iterates `runtime.fields` as an array. Actual `ghostty_type_json()` payload has `fields` as a record keyed by field name. Whitfield fixed to `Object.entries(runtime.fields)`. Committed code works.

6. **FormatterOptions in `src/types.ts`** was extended during Task 16 to add `unwrap`, `trim`, `kittyKeyboard` (the plan's Task 10 snippet didn't include these fields but the Formatter impl needed them). camelCase-to-snake_case mapping happens at `writeStruct` time in `Formatter.format`.

---

## Bob run summary (for your amusement / records)

20 Bobs contributed across 22 tasks: Asimov · Probity · Gauge · Forge · Atticus · Sentry · Marlowe · Lavoisier · Linnaeus · Mendeleev · Hansard · Redline · Kernighan · Planck · Thompson · Ockham · Euclid · Pratchett · Backus · Whirlwind · Plauger · Hejlsberg · Naismith · Stroustrup · Lamport · Hoare · Codd · Hamming · Pike · Wirth · Postel · Shoemaker · Whitfield · Crockford · Ampere · Sybil · Cerberus. (Plus me — Lessa — and Dax for the plan itself.) Implementers, spec reviewers, code quality reviewers.

Three known scut-plugin bugs surfaced and should probably get filed: (a) `bun -e ... C=$CHOSEN` bash-syntax bug in plan's Task 2 Step 1; (b) scut `send` fails for structured session IDs like `26dacfa0-task22-cerberus` (Cerberus caught this at release gate); (c) code-reviewer subagents default to terse "Signed off" unless the prompt explicitly demands structured output.

---

## Carry-forward notes for Pass 2 implementer

From quality reviewers + implementer surprises across Pass 1:

**FFI / platform:**
- `Terminal.#handle` stored as `Number(bigint) as Pointer` — safe on darwin-arm64 (48-bit pointers fit in Number). Reconsider in Pass 2 if expanding platforms.
- Register-split pattern for struct-by-value (16-byte structs → two u64 args) is AAPCS64-specific. Linux x64 and darwin-x64 use different ABI conventions — a C shim is probably inevitable for Pass 2 platform expansion. See §12 Surprise 5 in `docs/abi/2026-04-22-abi-discovery.md`.
- `resize()` with `cellPx = {0, 0}` works against libghostty-vt at the current pin. Documented.

**Public API:**
- When wiring a public-surface env-var reader, normalize `GHOSTTY_VT_LIB=""` to `undefined` before calling `resolveLibraryPath` — otherwise empty strings silently fall through to the bundled path.
- Full Task 6 surface is re-exported from `src/index.ts` including `GhosttyErrorCode` type and `LibraryInfo` interface.

**Testing:**
- The plain formatter trims trailing whitespace; empty-terminal → empty string (not padded). Surprising if you expected a rectangular block.
- `GHOSTTY_ENUM_MAX_VALUE = 2147483647` appears as a member in every `*Values` map from `generated.ts`. Consumers iterating values should filter or ignore it.
- Mode values in `modeTagByName` are packed u16: `rawValue | (ansi ? 1<<15 : 0)`. Unpack with `value & 0x7fff`.
- `resultCodeByValue` numeric keys are emitted as strings (`"-1"`, etc.) because TS object-literal syntax rejects bare negative numeric keys. `Record<number, ...>` indexing still works because JS coerces.

**Upstream:**
- Ghostty pin tracks a specific commit, not a semver. `ghostty_build_info(VERSION_STRING)` returns `"0.1.0-dev"` at this pin — semver, NOT a commit SHA. Compatibility check is best-effort; if upstream adds commit-SHA exposure later, we can narrow.
- Next Ghostty pin-bump: re-run Task 3 (ABI discovery) + Task 4 (probe) + Task 5 (bindings gen). If ABI changes, reconcile per Task 3 Step 5's 11-item gate. `bun run verify:generated` is the CI trip-wire.
- Tahoe + zig 0.15.x: local builds need brew's `zig@0.15` bottle. CI (macos-14, pre-Tahoe) uses stock ziglang.org zig 0.15.2 per `.github/workflows/ci.yml`.

---

## Pass 1 commit timeline

Highlights (full log via `git log v0.1.0`):

- `23def11` Task 1: project scaffolding
- `f2c2904` `ffedfcd` `ad50456` `364371f` build infra (mise pins, ghostty build script, brew zig resolution, tip-of-main pin)
- `ce42dc5` `0c4ed5c` `6045666` Task 3: ABI discovery + plan reconciliation (the gate)
- `c309aab` `4aecd4d` Task 4 + 5: probe + generator
- `46d23e8` Task 6: errors
- `4cc020b` Task 7: path
- `691061a` Task 8: FFI loader
- `71931be` Task 9: marshal helpers
- `72834fc` Task 10: public types
- `a48fda3` `2e50835` `205312e` `c0be131` `d29ccd3` Tasks 11–15: Terminal class
- `c8fc047` Task 16: Formatter
- `ce686c7` Task 17: fixture harness
- `b5c074d` Task 18: ABI smoke
- `cb3f0ad` `7d6f224` Task 19: tarball smoke (+ index.ts stub)
- `adb1799` Task 20: CI workflow
- `2f1be96` Task 21: re-exports + full README ← **`v0.1.0` tag**
