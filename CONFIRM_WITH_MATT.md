# Open items for Matt — ts-libghostty

**Updated 2026-04-23 evening by Lessa.** Pass 1 complete. This doc is now the handoff for what's left before publish, plus carry-forward notes for Pass 2.

---

## ✅ Pass 1 is done

22 of 22 tasks complete. Full clean rebuild from bare state verified (25s end-to-end). `v0.1.0` annotated tag at commit `2f1be96` on `main`, local only — **NOT pushed**. Ready for you to review, push, publish.

**End-to-end verified:** `Terminal.vtWrite("hello")` → `Formatter.formatString(term)` returns `"hello"` across all three output formats (plain/vt/html). 67 smoke tests + 1 tarball test all pass against real libghostty-vt.

**Public surface** (from `src/index.ts`):
- `Terminal` — vtWrite, resize, reset, snapshot, mode/setMode, lifecycle (`close`, `using`/Symbol.dispose).
- `Formatter` — plain/vt/html output.
- `GhosttyError` hierarchy (5 classes) + `GhosttyErrorCode` type.
- `setLibraryPath` / `isLoaded` / `libraryInfo` + `LibraryInfo` type.
- `modeNames` / `ModeName` / `TerminalOptions` / `TerminalSnapshot` / `FormatterOptions` / supporting types.
- `pinnedCommit` constant.

**Pinned to:** Ghostty `e88c6c099152dd6d2d7e517516e1f3c183c152f7` (tip-of-main as of 2026-04-22). Platforms: `darwin-arm64` only.

---

## Before publish — your todo

1. ~~Fill in `REPLACE_WITH_REPO_URL`~~ — done; README points to `github.com/prime-radiant-inc/ts-libghostty-vt`.
2. ~~Decide on GitHub repo location~~ — done; `prime-radiant-inc/ts-libghostty-vt` on GitHub.
3. ~~Rename package to match `libghostty-vt` naming~~ — done; npm package name is `ts-libghostty-vt` (was `ts-libghostty`). `v0.1.0` retagged on the rename commit.
4. **Push the `v0.1.0` tag**: `git push origin v0.1.0`. First push will trigger the CI workflow — verify green before publish.
5. **Update LICENSE copyright** if needed — currently reads `Copyright 2026 Prime Radiant (and contributors)`, which matches the `prime-radiant-inc` GitHub org. Change if you prefer different attribution.
6. **Publish.** `bun publish` or `npm publish` from a clean tree. The name `ts-libghostty-vt` is unclaimed on npm as of rename time.

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
