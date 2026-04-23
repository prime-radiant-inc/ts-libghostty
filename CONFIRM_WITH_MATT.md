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
| 3: ABI discovery | 🟢 **Up next** | Now unblocked — needs the dylib + headers, both present. **Hard gate, 11-item reconciliation checklist; Matt should be in the loop for this one.** |
| 4: Struct probe | ⏸ Holding | After Task 3. |
| 5: Bindings generator | ⏸ Holding | After Task 3. |
| 6: Error hierarchy | ✅ Done | Atticus, `46d23e8`. Spec ✓ (Sentry), quality ✓ (Marlowe). 5/5 tests pass. |
| 7: Path resolution | ✅ Done | Lavoisier, `4cc020b`. Spec ✓ (Linnaeus), quality ✓ (Mendeleev). 10/10 tests pass. |
| 8–22 | ⏸ Holding | All depend on Task 3+5 outputs (`generated.ts`, ABI doc) and the dylib. |

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

**For Task 3 (ABI discovery — next up):**
- The dylib at `prebuilds/darwin-arm64/libghostty-vt.dylib` was produced from `vendor/ghostty` at commit `332b2aefc6e72d363aa93ab6ecfc86eeeeb5ed28` (v1.3.1). Headers live at `vendor/ghostty/include/ghostty/vt.h`.
- Quick sanity check before starting reconciliation: `nm -gU prebuilds/darwin-arm64/libghostty-vt.dylib | grep -c '_ghostty_'` should return a large number (currently produces hundreds of `_ghostty_*` symbols).
- Plan's Task 3 Step 5 has the 11-item reconciliation gate — every box ticked before Task 4 begins. Expect to edit the plan during reconciliation if reality and snippets disagree.
