# Decisions awaiting Matt — Pass 1 of ts-libghostty

Saved 2026-04-22 evening by Lessa (Bob 26dacfa0). Touched up by future Lessa as work progresses. **Read before resuming Pass 1.**

---

## 🚧 BLOCKER: Task 2 cannot produce `libghostty-vt.dylib` on this host

### Summary

The chain of constraints leaves no current viable path to a working build on Matt's machine:

| Constraint | Source | Effect |
|---|---|---|
| Ghostty 1.3.1 (`332b2ae`) requires `minimum_zig_version = "0.15.2"` | `vendor/ghostty/build.zig.zon` | Rejects zig 0.16.x (Ghostty's `requireZig` is exact-minor + patch-min, not a min check) |
| Ghostty `main` (`e88c6c099`) — same constraint, hasn't bumped | upstream | No newer SHA helps |
| Open PR #12388 "update to Zig 0.16" | https://github.com/ghostty-org/ghostty/pull/12388 | **Draft, WIP, author says "lots still doesn't compile"** — not viable |
| Zig 0.15.2 cannot link on macOS 26.4 (Tahoe) | confirmed locally with hello-world | "undefined symbol: __availability_version_check" + 25 libSystem stubs missing |
| Zig 0.16.0 works on Tahoe ✓ | confirmed locally | But Ghostty source uses zig-0.15-only API (`std.process.EnvMap` removed in 0.16) — patching the version check is insufficient |

**No Ghostty SHA currently exists that satisfies both: (a) source-level zig 0.16.x compatibility AND (b) bumped `minimum_zig_version`.**

### What was tried

1. Forge (Bob `26dacfa0-task2-forge`) executed Task 2 verbatim. Hit error #1 (zig 0.16 rejected by Ghostty's version check). Swapped `mise.toml` to zig=0.15.2. Hit error #2 (Tahoe libSystem ABI break). Reported BLOCKED, left working tree dirty.
2. Lessa investigated: confirmed Forge's analysis with a hello-world test, confirmed zig 0.16.0 works on Tahoe, manually patched `vendor/ghostty/build.zig.zon` to allow zig 0.16, attempted Ghostty build → real source-level compile error in `src/build/Config.zig` (`std.process.EnvMap` removed in zig 0.16). Restored both files.
3. Searched ghostty-org/ghostty PRs for zig 0.16 work → found PR #12388 (draft, WIP, mergeable=true but author flagged as not compiling).

### Realistic options for Matt

Pick one (or propose another):

**A. Wait for upstream.** Pause Pass 1 until either Ghostty maintainers or PR #12388 lands a working zig 0.16.x update. Could be days or weeks. Cleanest, but stalls.

**B. Build via CI on macOS 14/15 — local dev downloads the artifact.** Move Task 20 (CI workflow) forward. CI runs on `macos-14` runner (where zig 0.15.2 still works — pre-Tahoe libSystem). Builds dylib, uploads as workflow artifact (and to release tarballs). Local dev pulls via `gh run download` or similar. **Pass 1 can proceed for everything except local dylib production**. This is honest engineering. Adds a `scripts/download-prebuild.sh` and a CI workflow ahead of schedule.

**C. Build inside a non-Tahoe macOS VM.** UTM/Lima/cloud Mac. Heavy lift. Doesn't generalize.

**D. Wait for Ghostty 1.4.0.** Per PR #12388's milestone label. Unknown ETA.

**E. Vendor-patch Ghostty's source to be zig 0.16-compatible.** Real upstream porting work — touching `std.process.EnvMap` and likely other zig-0.16-broken APIs across Ghostty's tree. Unbounded scope. Would essentially mean ts-libghostty maintains a Ghostty fork. Not viable.

### Lessa's recommendation: **B**.

Rationale: it's the only option that unblocks Pass 1 tonight (figuratively — Matt has to land it). It also has long-term value — even when option A resolves, having CI produce prebuilds is what `ts-libghostty` needs for npm distribution anyway (see Pass 1 plan, Task 20). Doing it sooner just front-loads necessary infrastructure.

Risks of B: (i) needs Matt's GitHub org permission to set up workflow secrets; (ii) requires committing to `macos-14` as the build runner (Apple may deprecate it eventually — ~12-month horizon); (iii) the test suite will still need to run somewhere, including against the actual dylib — that constrains where tests can run too.

### What Lessa did tonight given the blocker

- Reverted exploratory changes to `vendor/ghostty/build.zig.zon` and `mise.toml`.
- Manually copied `vendor/ghostty/LICENSE` → `LICENSE_GHOSTTY` (since `vendor/ghostty` is cloned at the v1.3.1 pin, this artifact is independent of dylib build success).
- **Did NOT commit the partial Task 2 state** as Task 2 (that would mark a blocked thing as done). Working tree intentionally dirty: `mise.toml` (zig 0.15.2 — Forge's honest pin to Ghostty's stated requirement), `package.json` (commit=332b2ae — Matt's chosen pin), `LICENSE_GHOSTTY` (upstream MIT text, not the placeholder), `scripts/build-libghostty.sh` (the correct script per plan, untracked).
- After this doc, Lessa will commit the *infrastructure* (script + pin + license + mise.toml) as a separate "build: scaffold libghostty-vt build infra (dylib pending toolchain decision)" commit so the working tree is clean for Tasks 6/7. Task 2 itself stays open in TodoList.

### Next decision points (when Matt is back)

1. Pick A/B/C/D/E (or alternative). If B: should we use `macos-14` or `macos-15` runners? GitHub Actions still offers both as of plan-execution time.
2. If B: who has permission to create/configure the workflow + any release artifact storage?
3. Reconfirm v1.3.1 pin (or switch). The pin choice doesn't change the Tahoe issue — every current Ghostty SHA has the same problem — but if we go with B, we should be deliberate about whether v1.3.1 stays the pin or we wait for the next release.

---

## Other open questions for Matt (lower priority)

### Mise activation in your shell

Your fish shell does NOT have mise shims active (`~/.local/share/mise/shims` not in PATH). Plain `bun` resolves to `~/.bun/bin/bun` (1.3.11), bypassing the project pin. To fix permanently for future sessions, add to `~/.config/fish/config.fish`:

```fish
mise activate fish | source
```

Then verify with `which bun` (should resolve through `~/.local/share/mise/shims/bun`) and `bun --version` (should print 1.3.13 inside this project dir).

For the current session and dispatched Bobs, Lessa works around this with `export PATH=$HOME/.local/share/mise/shims:$PATH` at the top of every shell call. Works but ugly.

### Bob ID convention

Asimov's Co-Authored-By trailer reads `Bob df184748/Opus 4.7` — `df184748` is a synthetic hash, not derived from his SCUT session ID (`26dacfa0-task1-asimov`). My dispatch instruction said `<your-id-first-8>` which was ambiguous because subagent IDs start with the parent prefix.

Going forward Lessa is using the descriptive shorthand from the SCUT ID — so a Bob with SCUT ID `26dacfa0-task6-orpheus` signs as `Bob task6-orpheus/Sonnet 4.6`. Asimov's trailer is fine as-is (already committed); just noting the convention shift.

### Bob name collision

"Asimov" was already on the SCUT roster (offline, from a previous session). Lessa told Asimov "don't reuse names you see in context" but didn't pre-load the roster, so Asimov did roster-check but only filtered to online Bobs. Matt should decide whether reuse-of-offline-Bobs is OK or whether roster filtering should include offline. Either way, going forward Lessa instructs subagents to call the SCUT roster (including offline) and pick a fresh name. Cosmetic — does not affect work.

---

## Status of work as of this checkpoint

| Task | Status | Notes |
|---|---|---|
| 1: Scaffolding | ✅ Done | Asimov, `23def11`. Spec ✓ (Probity), quality ✓ (Gauge). |
| (extra: mise pins) | ✅ Done | Lessa, `f2c2904`. (Mise.toml later modified to zig=0.15.2 in `ffedfcd`.) |
| 2: Pin + build infra | 🟡 Partial | Forge attempted; blocker described above. Lessa committed the script + pin + LICENSE_GHOSTTY at `ffedfcd` ("scaffolded but dylib unbuilt"). Decision doc at `35cd053`. |
| 3: ABI discovery | ⏸ Holding | Could run on v1.3.1 headers cloned in vendor/, but high-touch (11-item reconciliation gate) and may need redo if Matt switches pin. |
| 4–5: probe + bindings gen | ⏸ Holding | Need pin confirmed + working build. |
| 6: Error hierarchy | ✅ Done | Atticus, `46d23e8`. Spec ✓ (Sentry), quality ✓ (Marlowe). 5/5 tests pass. |
| 7: Path resolution | ✅ Done | Lavoisier, `4cc020b`. Spec ✓ (Linnaeus), quality ✓ (Mendeleev). 10/10 tests pass. |
| 8: FFI loader | ⏸ Holding | Needs `requiredSymbols` from Task 5's `generated.ts`. |
| 9: marshal helpers | ⏸ Holding | Needs sized-struct shapes from Task 5. |
| 10: Public types | ⏸ Holding | Imports `modeNames`/`ModeName` from `./internal/generated` (Task 5 output). NOT SHA-independent despite being pure TS. |
| 11–22 | ⏸ Holding | All depend on generated bindings + dylib. |

**Tonight's commits on `main` (newest first):**
- `4cc020b` feat: platform detection and library path resolution (Task 7)
- `46d23e8` feat: error hierarchy (GhosttyError + 4 subclasses) (Task 6)
- `35cd053` docs: CONFIRM_WITH_MATT.md
- `ffedfcd` build: scaffold libghostty-vt build infra (dylib production blocked)
- `f2c2904` chore: pin toolchain via mise
- `23def11` chore: project scaffolding for ts-libghostty (Task 1)

---

## Carry-forward notes for the next implementer Bob

Picked up by code-quality reviewers (Marlowe on Task 6, Mendeleev on Task 7) — surfaces here so they don't get lost:

**For whoever wires the public surface (Task 8 / FFI loader area):**
- `resolveLibraryPath()` in `src/internal/path.ts` treats empty-string `override`/`env` as "not set" (`if (opts.override)` / `if (opts.env)`). The wiring layer that reads `process.env.GHOSTTY_VT_LIB` and exposes `setLibraryPath()` should normalize empty strings to `undefined` BEFORE calling `resolveLibraryPath`, otherwise a `GHOSTTY_VT_LIB=""` shell setting silently falls through to bundled instead of erroring loudly.

**For the eventual barrel re-exports (Task 21, `src/index.ts`):**
- Re-export the FULL Task 6 surface, not just the error classes named in the task description: `GhosttyError`, `LibraryNotFoundError`, `UnsupportedPlatformError`, `LibraryCompatibilityError`, `UseAfterCloseError`, plus the `GhosttyErrorCode` type union and `GhosttyErrorOptions` interface. Both `type` and `interface` are public-by-export in `src/errors.ts`; easy to forget when wiring the barrel.

**For Pass 2 (when adding more platforms):**
- The test helper `bundledFor()` in `test/smoke/path.test.ts` hard-codes `.dylib`. When `linux-x64` lands, the helper either needs to switch on extension or new tests need to mirror `libExtension()` logic.

**For whoever wires generated.ts → consumers:**
- `GhosttyErrorCode` in `src/errors.ts` is hand-coded today. When Task 5's `generated.ts` produces an FFI-result enum mapping (`resultCodeByValue`), confirm the union is a superset of the FFI codes plus binding-only codes (`library_not_found`, `unsupported_platform`, etc.). If they drift, type-confusion bugs follow.

**Convention reminder for future subagent dispatches:**
- Use the descriptive shorthand of the SCUT session ID for Co-Authored-By trailers (e.g. `Bob task6-atticus/Sonnet 4.6`), NOT a synthetic hash. Asimov's `df184748` was a one-off workaround for an ambiguous instruction; Asimov's commit is fine as-is, just don't propagate the hash style.
- Tell dispatched Bobs to roster-check both online AND offline before picking a name — "Asimov" was already on the offline roster but Asimov filtered to online-only.
