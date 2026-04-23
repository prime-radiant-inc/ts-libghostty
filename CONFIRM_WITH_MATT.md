# Open items for Matt — Pass 1 of ts-libghostty

Saved 2026-04-22 evening by Lessa (Bob 26dacfa0). Updated late-evening with the Task 2 unblock. **Read before resuming Pass 1.**

---

## ✅ RESOLVED: Task 2 toolchain blocker

The earlier blocker (Ghostty 1.3.1 demands zig 0.15.x; ziglang.org's zig 0.15.2 can't link on macOS Tahoe; zig 0.16 is source-incompatible with Ghostty) is **fixed**.

**Resolution:** Use Homebrew's `zig@0.15` formula. The brew bottle is built against the Tahoe SDK and links cleanly. This is the upstream-recommended workaround per Ghostty PR [#12363](https://github.com/ghostty-org/ghostty/pull/12363) (merged 2026-04-21 — one day before we needed it). The mise-installed zig 0.15.2 from ziglang.org's official tarballs predates Tahoe and has the broken libSystem stubs.

**Setup for anyone fresh on this machine:**
```fish
brew install zig@0.15      # one-time, installs to /opt/homebrew/opt/zig@0.15/
```

`scripts/build-libghostty.sh` (committed at `ad50456`) auto-resolves zig in this order: `/opt/homebrew/opt/zig@0.15/bin/zig` first, then any `zig` on PATH. Falls back gracefully on Linux. Also corrected to use the `lib-vt` build target (Ghostty 1.3.x renamed it from `libghostty-vt`; the plan flagged this as a verify-with-`zig build --help` step).

**Verified end-to-end:** `bun run build:libghostty` produces `prebuilds/darwin-arm64/libghostty-vt.dylib` (real arm64 Mach-O, exports `_ghostty_*` symbols) and refreshes `LICENSE_GHOSTTY` from upstream MIT.

**Implications for `mise.toml`:** the `zig = "0.15.2"` line in `mise.toml` is now stale — the build script ignores it and uses brew's. Lessa left it untouched (Matt installed it explicitly tonight; might use it for other zig things in this project) but it could be deleted without affecting builds. Your call.

**Implications for the v1.3.1 pin:** unchanged. Stays at `332b2aefc6e72d363aa93ab6ecfc86eeeeb5ed28`. The Tahoe issue had nothing to do with the SHA choice; brew's patched zig fixes it for any Ghostty 1.3.x.

---

## Open items (lower priority)

### Mise activation
You added `mise activate` to your fish config — confirmed working when you said so. Future sessions in fresh shells should now have `~/.local/share/mise/shims` in PATH automatically, and plain `bun` will resolve to mise's pin. The `export PATH=...` workaround Lessa baked into earlier dispatch prompts is no longer strictly needed for new sessions, but it's harmless to keep.

### Bob ID convention
Asimov's Co-Authored-By trailer reads `Bob df184748/Opus 4.7` — `df184748` is a synthetic hash because Lessa's first dispatch instruction said `<your-id-first-8>` which collided with the parent prefix. From Task 6 onward, Bobs sign with their descriptive shorthand (e.g. `Bob task6-atticus/Sonnet 4.6`). Asimov's commit stays as-is; just don't propagate the hash style.

### Bob name collision (cosmetic)
"Asimov" was already on the offline SCUT roster. Lessa now instructs subagents to call the SCUT roster including offline before picking. Pure protocol housekeeping.

### Plan-level fix needed
Task 2 Step 1 in `docs/superpowers/plans/2026-04-22-ts-libghostty-pass-1.md` has a bash bug: `bun -e "..." C=$CHOSEN`. The trailing `C=$CHOSEN` is parsed as a positional arg, not an env var. Lessa worked around it in the dispatch prompt by telling the Bob to use `Edit` directly. The plan itself should be patched — also, Step 2's `zig build libghostty-vt` should change to `zig build lib-vt`, matching the actual Ghostty 1.3.x target name.

---

## Status of work

| Task | Status | Notes |
|---|---|---|
| 1: Scaffolding | ✅ Done | Asimov, `23def11`. Spec ✓ (Probity), quality ✓ (Gauge). |
| (extra: mise pins) | ✅ Done | Lessa, `f2c2904`. Mise.toml later modified to zig=0.15.2 by Forge in `ffedfcd` (now stale — see Resolution above). |
| 2: Pin + build | ✅ Done | Forge attempted; Lessa committed scaffold at `ffedfcd`; Lessa committed unblock at `ad50456`. Build verified end-to-end. Local dylib exists in `prebuilds/darwin-arm64/` (gitignored). |
| 3: ABI discovery + reconciliation | ✅ Done | Pin switched to tip-of-main `e88c6c0` (`364371f`). Hansard wrote 524-line ABI doc (`ce42dc5`). Redline applied 33 reconciliation items across the plan + 2 committed source files (`0c4ed5c`). All 17 surprises resolved. Task 3's hard gate passed. |
| 4: Struct probe | 🟢 Up next | Four-struct probe: `GhosttyTerminalOptions` (16B, not sized), `GhosttyFormatterTerminalOptions` (56B sized) + nested `Extra` (32B) + `ScreenExtra` (16B). |
| 5: Bindings generator | 🟢 Up next | `parseModeDefines()` for `#define`-based modes; 5 real result codes; renamed Formatter enum. |
| 6: Error hierarchy | ✅ Done | Atticus, `46d23e8`. `GhosttyErrorCode` union updated in `0c4ed5c` to match reality (invalid_value / out_of_space / no_value replace invalid_argument / uninitialized). Tests still 5/5 pass. |
| 7: Path resolution | ✅ Done | Lavoisier, `4cc020b`. Spec ✓ (Linnaeus), quality ✓ (Mendeleev). 10/10 tests pass. |
| 8: FFI loader | ⏸ Holding | SYMBOLS table reconciled; register-split call shape for `ghostty_terminal_new`; build-identity wiring via `ghostty_build_info` (semver). Ready to implement. |
| 9–22 | ⏸ Holding | All snippets reconciled with ABI doc; ready to execute in order. |

**Tonight's commits on `main` (newest first):**
- `ad50456` build: resolve zig via brew, use lib-vt target — unblocks Task 2
- `44f602b` docs: update CONFIRM_WITH_MATT.md with tonight's work + carry-forward notes
- `4cc020b` feat: platform detection and library path resolution (Task 7)
- `46d23e8` feat: error hierarchy (GhosttyError + 4 subclasses) (Task 6)
- `35cd053` docs: CONFIRM_WITH_MATT.md
- `ffedfcd` build: scaffold libghostty-vt build infra (dylib production blocked at the time)
- `f2c2904` chore: pin toolchain via mise

---

## Carry-forward notes for the next implementer Bob

Picked up by code-quality reviewers (Marlowe on Task 6, Mendeleev on Task 7) — surfaced here so they don't get lost:

**For whoever wires the public surface (Task 8 / FFI loader area):**
- `resolveLibraryPath()` in `src/internal/path.ts` treats empty-string `override`/`env` as "not set" (`if (opts.override)` / `if (opts.env)`). The wiring layer that reads `process.env.GHOSTTY_VT_LIB` and exposes `setLibraryPath()` should normalize empty strings to `undefined` BEFORE calling `resolveLibraryPath`, otherwise a `GHOSTTY_VT_LIB=""` shell setting silently falls through to bundled instead of erroring loudly.

**For the eventual barrel re-exports (Task 21, `src/index.ts`):**
- Re-export the FULL Task 6 surface, not just the error classes named in the task description: `GhosttyError`, `LibraryNotFoundError`, `UnsupportedPlatformError`, `LibraryCompatibilityError`, `UseAfterCloseError`, plus the `GhosttyErrorCode` type union and `GhosttyErrorOptions` interface. Both `type` and `interface` are public-by-export in `src/errors.ts`; easy to forget when wiring the barrel.

**For Pass 2 (when adding more platforms):**
- The test helper `bundledFor()` in `test/smoke/path.test.ts` hard-codes `.dylib`. When `linux-x64` lands, the helper either needs to switch on extension or new tests need to mirror `libExtension()` logic.

**For whoever wires generated.ts → consumers:**
- `GhosttyErrorCode` in `src/errors.ts` is hand-coded today. When Task 5's `generated.ts` produces an FFI-result enum mapping (`resultCodeByValue`), confirm the union is a superset of the FFI codes plus binding-only codes (`library_not_found`, `unsupported_platform`, etc.). If they drift, type-confusion bugs follow.

**For Task 11 (Terminal constructor) executor:**
- The plan's reconciled constructor stores `#handle: Pointer` via `Number(handleBig) as Pointer` — safe on darwin-arm64 (48-bit pointers fit in `Number.MAX_SAFE_INTEGER`) but fragile if we ever expand to platforms with larger address spaces. Consider storing as `bigint` if bun:ffi's Pointer-arg coercion cooperates.

**For Task 13 (resize) executor:**
- The plan's resize tests call `term.resize(100, 30)` without `cellPx`. Constructor defaults `#cellPx = {0, 0}`. The reconciled 5-arg FFI call passes those zeros to `ghostty_terminal_resize(handle, 100, 30, 0, 0)`. Whether libghostty-vt accepts cellPx=0 isn't in the ABI doc. If it returns `INVALID_VALUE`, either (a) default cellPx to something like 8x16 in the constructor when not provided, or (b) make cellPx required in `TerminalOptions`, or (c) update the tests to pass explicit cellPx. Decide by running the test and seeing what happens — libghostty might accept 0 as "don't care."

**For Task 16 (Formatter) executor:**
- `#closed` flag is load-bearing for the `UseAfterCloseError` test. No native handle is held between `format()` calls (constructed+freed per call per Matt's decision 3b), so the flag is the only thing preventing use-after-close.
- `GhosttyFormatterTerminalOptions` is 56B sized with nested sized sub-structs (`extra` at offset 16 is 32B sized; nested `extra.screen` at offset 16-within-extra is 16B sized). Task 9's `sized-struct.ts` helpers need to handle nested composition.

**For Task 3 template cleanup (nice-to-have):**
- Plan lines ~520-660 contain Task 3's original illustrative template with stale example names (`GHOSTTY_RESULT_OK`, `GhosttyFormatterOptions`, etc.). Task 3 is done and the real ABI doc is at `docs/abi/2026-04-22-abi-discovery.md`. The template is harmless but reading it in isolation could confuse a future Bob. Low-priority cleanup to either update the examples or add a pointer to the actual ABI doc.
