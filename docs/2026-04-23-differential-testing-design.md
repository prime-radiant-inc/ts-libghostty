# Differential Testing Harness — v0 Design

**Status:** proposed (Garak, 2026-04-23). Awaiting Matt's review before implementation.
**Branch:** `feat/differential-testing` (worktree at `.worktrees/differential-testing/`).

## What this is

The Pass 1 smoke tests prove the binding *runs*. They don't prove it produces the *right state*. v0.1.0 + Passes 2–5 will keep adding FFI surface; without a regression net we'll find out about semantic divergence the hard way (downstream user reports, or worse, silently wrong output).

The harness: feed the same VT byte stream through (a) a C oracle linked directly against `libghostty-vt`, and (b) our TS binding. Diff the formatted output. Any divergence is a binding bug — ABI marshalling wrong, struct layout drift, options not matching, etc.

## Open design calls — picks and rationale

### 1. Oracle: adapt `vendor/ghostty/example/c-vt-formatter`

Not writing one from scratch. The Ghostty repo ships `example/c-vt-formatter/src/main.c` (63 lines, pure C, `#include <ghostty/vt.h>`). It already does the canonical pattern: `terminal_new` → `vt_write` → `formatter_terminal_new(..., PLAIN, trim=true)` → `format_alloc` → dump. The only adaptations needed:

- Read input bytes from a file path (`argv[1]`) instead of a hardcoded string array
- Take grid size + format from CLI flags so the harness controls them
- Dump to stdout

Build command mirrors `scripts/probe-layout.c` precedent: `cc -I vendor/ghostty/include -L prebuilds/darwin-arm64 -lghostty-vt -o .tmp/diff-oracle scripts/diff-oracle.c`. No Zig required (the example uses Zig's build system, but for a single-target binary `cc` suffices and keeps the harness in the same toolchain we already use).

**Why not Zig + build.zig.zon?** Adds a Zig dep for ~50 lines of C. The probe-layout.c precedent already uses cc; this is symmetry, not novelty.

**Why not reuse Ghostty's Zig test blocks directly?** Different runtime, different language, different binary. Our oracle must link the *same dylib our binding loads* so we're comparing layouts, not implementations.

### 2. Corpus: handcrafted seeds + curated fuzz subset

Three sources for v0:

- **3 handcrafted "smoke" cases** — `hello.vt`, `scroll.vt`, `cursor-positioning.vt`. Confidence cases: if these diverge, something is catastrophically wrong, and the failure is human-readable.
- **~10 files curated from `vendor/ghostty/test/fuzz-libghostty/corpus/parser-cmin/`** — production AFL-minimized fuzz inputs. Each file is a raw byte sequence designed to exercise parser edge cases (CSI intermediates, incomplete escapes, DA2, OSC, etc.). 616 files total in that corpus; we pick ~10 with varied opcodes for v0.

**Deferred:**
- Full parser-cmin corpus (616) + stream-cmin (3271) + osc-cmin — runs slowly, would catch more, but we don't need it to prove the harness works
- esctest, vttest — external suites, large integration effort, defer until v0 demonstrates value
- script(1) recordings (vim, htop, tmux) — high signal but high curation cost; nice stretch
- Property-based fuzzing (generate random sequences and diff) — separate project

**Why curate from the existing fuzz corpus rather than start with vttest?** The fuzz corpus is already minimized, license-compatible (in our vendored repo), zero curation overhead, and known to exercise parser edge cases. vttest is a UI-driven program designed for humans to eyeball results — wrong shape for byte-in/byte-out diffing.

### 3. Diff strategy: plain only for v0

Plain formatter output, bytewise comparison. On mismatch, run `diff -u` and print to stderr; exit non-zero.

**What this catches:** cell-content divergence, position errors, wraparound bugs, trim divergence, anything that affects the visible character grid.

**What it misses:** attribute divergence (colors, bold, underline). A cell that's "X" on both sides but red on one and green on the other passes plain diff. Adding `vt` and `html` format runs catches this; deferred to stretch.

**Why not all three from day one?** Plain alone is the highest signal-per-effort source. If plain agrees, the state machine is mostly converging. Attribute coverage is real but additive — we can layer it on once the harness is proven.

### 4. Where it lives

```
scripts/
  diff-oracle.c              ← C oracle source (mirrors probe-layout.c convention)
test/
  differential/
    corpus/                  ← VT byte fixtures (handcrafted + curated)
      hello.vt
      scroll.vt
      …
      parser-cmin-XXXX.vt    ← curated subset, renamed for readability
    run.ts                   ← Bun-based harness driver
    README.md                ← what / how / when to run
```

Single entry point: `bun test/differential/run.ts` (no package.json wiring for v0; can add `test:differential` script later).

**Why split scripts/ + test/?** Mirrors the existing convention: `scripts/probe-layout.c` is build tooling, lives alongside `scripts/gen-bindings.ts`. The corpus and driver are test artifacts — they belong under `test/`. The oracle binary is built into `.tmp/diff-oracle` (already gitignored via `.tmp/`).

**Why not under `test/smoke/`?** `test/smoke/` is the fast lane — `bun test test/smoke` must stay quick (currently 418ms, 67 tests). Differential needs a C compile step on first run and runs every corpus file through both pipelines. It's a separate test family.

### 5. CI wiring: deferred

Not wiring into the macOS workflow for v0. Reasons:
- Adds a C compile step + dylib link to CI; should be a deliberate decision once the harness is proven valuable
- The harness is most useful at *human* checkpoints: before bumping the Ghostty pin (existing `verify:generated` is the cheap trip-wire; differential is the deep one), and before merging Pass 2+ FFI surface
- Opt-in invocation matches `bun run test:tarball` (also slow, also opt-in)

CI wiring is a follow-up decision after v0 lands.

## Scope

### v0 (this branch)

- `scripts/diff-oracle.c` — C oracle binary
- `test/differential/corpus/` — 3 handcrafted + ~10 curated VT inputs
- `test/differential/run.ts` — driver: build oracle if missing, iterate corpus, run both pipelines (TS + C), diff plain output, fail loudly on mismatch
- `test/differential/README.md` — usage doc
- Manual invocation. No CI. No package.json script (intentional — keeps the slow path explicit).

### Stretch (this branch if time permits)

- `vt` and `html` format runs alongside `plain`
- Expand corpus to 25–50 cases
- `test:differential` package.json script

### Deferred (future passes / separate work)

- Full fuzz corpus runs (parser-cmin 616, stream-cmin 3271)
- esctest / vttest integration
- script(1) recordings of real programs
- Property-based input generation
- CI wiring decision
- Cross-version oracle (run the same input against an *older* libghostty-vt build to detect Ghostty-side regressions, not just binding regressions)
- Cross-platform (only relevant when binding becomes cross-platform; CLAUDE.md gotcha #1)

## Risks & known limitations

1. **Same-dylib design ≠ implementation comparison.** Both sides link the same `libghostty-vt.dylib`. We're testing the binding's *marshalling*, not Ghostty's *correctness*. That's the goal — Ghostty has its own test suite for the latter — but worth being explicit. To catch Ghostty regressions across pin bumps you'd want a *cross-version* oracle (deferred).
2. **Plain trims** (CLAUDE.md gotcha #6). Both oracle and binding must use `trim=true` (the c-vt-formatter example already does). Driver enforces option parity by passing identical `GhosttyFormatterTerminalOptions` semantics on both sides.
3. **Grid size matters.** Output depends on cols/rows. Driver must use the same dimensions on both sides; current plan is `80x24` for all corpus files. Future: per-fixture metadata to vary geometry.
4. **Locale / TextEncoder.** TS side uses `TextEncoder` to convert string fixtures to bytes; the corpus files are already raw bytes so this only matters for handcrafted inputs. Driver reads corpus as `Uint8Array` directly — no string round-trip.
5. **The oracle doesn't exercise the binding's struct marshalling.** It exercises the C ABI. So a binding bug that incorrectly *constructs* a `GhosttyFormatterTerminalOptions` struct can pass differential testing if the resulting struct happens to be valid. The smoke tests still need to cover that surface; differential is complementary, not a replacement.

## Decision log (Matt-decisions to confirm)

None blocking. The scope choices above are mine to make. If any of these feel wrong, override before I implement:

- C oracle (cc) vs Zig oracle (build.zig.zon)
- Plain-only diff vs plain+vt+html from day one
- `test/differential/` location vs `scripts/differential/`
- ~13 corpus cases for v0 vs more

If you don't push back, I'll proceed with the picks above.

## Implementation plan (next session, after sign-off)

1. Write `scripts/diff-oracle.c` (adapt c-vt-formatter, add file-arg + flags)
2. Add build step to driver (cc command + check `.tmp/diff-oracle` is current)
3. Curate corpus (3 handcrafted + ~10 from parser-cmin)
4. Write `test/differential/run.ts` (load corpus → run TS → run oracle → diff plain → report)
5. README + manual smoke test
6. Commit, push, document in `CONFIRM_WITH_MATT.md` if anything turned out to need a Matt-decision
