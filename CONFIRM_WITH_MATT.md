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
| 1: Scaffolding | ✅ Done | Asimov, commit `23def11`. Spec ✓ (Probity), quality ✓ (Gauge — terse). |
| (extra: mise pins) | ✅ Done | Lessa, commit `f2c2904`. (Mise.toml now modified to zig=0.15.2 in working tree.) |
| 2: Pin + build | 🚧 Blocked | Forge attempted, blocker described above. Build infra to be committed by Lessa as a separate "scaffold-but-blocked" commit. |
| 3: ABI discovery | ⏸ Holding | Could run on v1.3.1 headers we have cloned, but high-touch (11-item reconciliation gate). Holding until Matt confirms pin. |
| 4–5: probe + bindings gen | ⏸ Holding | Need pin + headers. |
| **6: Error hierarchy** | 🟢 Up next | Pure TS, no Ghostty dep. SHA-independent. Lessa to dispatch tonight. |
| **7: Path resolution** | 🟢 Up next | Pure TS, depends only on platform string mapping. SHA-independent. Lessa to dispatch tonight. |
| 8–22 | ⏸ Holding | All depend on the dylib + bindings. |

Tonight Lessa is landing Tasks 6 and 7 (genuinely SHA-independent), then signing off. This advances real Pass 1 work without making any decisions that get invalidated by Matt's pick on the toolchain.
