# Differential testing harness — v0

Regression net for the ts-libghostty-vt FFI surface. Same input bytes → C
oracle (linked directly against `libghostty-vt`) **and** the TS binding;
diff the formatted output.

Design rationale: [`docs/2026-04-23-differential-testing-design.md`](../../docs/2026-04-23-differential-testing-design.md).

## Run it

From the repo root:

```sh
bun test/differential/run.ts
```

The driver builds the C oracle on first run (or if the source is newer) by
invoking `cc` against `vendor/ghostty/include` and the bundled dylib. Output
binary lives at `.tmp/diff-oracle` (gitignored).

Exit codes:

- `0` — all corpus files agree
- `1` — at least one divergence (per-file diff printed to stdout)
- `2` — harness failure (oracle didn't build, corpus empty, etc.)

## When to run it

- Before bumping the Ghostty pin (`package.json` → `ghostty.commit`)
- Before merging Pass 2+ FFI surface (anything that touches `src/ffi.ts`,
  `src/internal/generated.ts`, `src/terminal.ts`, or `src/formatter.ts`)
- After any struct-marshalling change in `src/internal/sized-struct.ts` or
  `src/internal/marshal.ts`

`bun run verify:generated` is the cheap trip-wire (regenerates bindings,
fails on diff). This harness is the deep one — slower, runs through the
whole pipeline.

Not currently in CI. See design memo §"CI wiring: deferred".

## What it covers (v0)

- All three formatter formats — `plain`, `vt`, and `html` — run against each
  corpus file. `plain` catches cell-content and position divergence; `vt`
  catches control-sequence emission divergence; `html` catches attribute
  (color, bold, underline, hyperlink) divergence.
- 20 corpus files × 3 formats = 60 per-file comparisons.
- Corpus:
  - **`0X-*`** — handcrafted smoke cases (empty, hello, scroll, cursor ops)
  - **`1X-*`** — named seeds curated from Ghostty's own libghostty-vt fuzz
    corpus (`vendor/ghostty/test/fuzz-libghostty/corpus/parser-initial/`)
  - **`2X-*`** — real-application captures recorded under a PTY
    (bash prompt, vim plain edit, vim with syntax highlighting, less,
    tmux splits, top). Captured by `scripts/capture-fixtures.ts` via
    `Bun.Terminal` + `Bun.spawn({ terminal })` — no external runtime
    dependencies beyond Bun itself.
- Fixed 80×24 terminal geometry on both sides.

## What it does not cover (yet)

- Per-fixture geometry overrides
- Full fuzz corpus runs (parser-cmin: 616 files; stream-cmin: 3271 files)
- esctest / vttest integration
- `script(1)` recordings of real programs
- Cross-version oracle (would catch Ghostty-side regressions across pin bumps)
- CI wiring

## Adding a fixture

Drop a raw VT byte sequence into `corpus/` with a `.vt` extension. Numeric
prefix sorts it into a category:

- `0X-*` — handcrafted smoke cases
- `1X-*` — curated from `parser-initial`
- `2X-*` — real-application PTY captures (regenerate via
  `bun scripts/capture-fixtures.ts`)
- (future) `3X-*` — curated from `parser-cmin` / `stream-cmin`

Re-run the harness; new fixture should pass on day one. If it doesn't, you
either found a binding bug or wrote a fixture that depends on geometry the
harness doesn't yet support — investigate before normalizing.

### Regenerating real-app captures

The `2X-*` fixtures are not byte-reproducible across re-runs (output depends
on tool version, process list, time). Regenerate them when:

- a tool's output format changes materially (e.g., new vim version)
- the Ghostty pin bumps and you want fresh examples for the new VT interpreter
- you want different content (e.g., longer file, different language)

```sh
bun scripts/capture-fixtures.ts
bun test/differential/run.ts   # confirm new captures still pass
```

Captures use `Bun.Terminal` + `Bun.spawn({ terminal })` — no external
runtime dependencies beyond Bun. `script(1)` doesn't work from Claude
Code agent shells (no controlling TTY); `Bun.Terminal` allocates a pty
itself.

Vim, less, and tmux captures intentionally do not send a quit command.
Quitting emits the alt-screen-exit sequence (`ESC [ ? 1049 l`) which
restores an empty main screen and erases all the rendered content. We
let the timeout fire instead. The capture function sets a `frozen` flag
right before `proc.kill`, so any cleanup bytes that programs emit in
response to their PTY closing (tmux in particular runs a SIGHUP handler
that clears the screen + exits alt-screen) are dropped — what we save
is exactly the state that was displayed at the moment we decided to
stop.

## Architecture

```
test/differential/
  run.ts              ← Bun harness (build oracle, iterate corpus, diff)
  corpus/             ← VT byte fixtures (each file = one input)
  README.md
scripts/
  diff-oracle.c       ← C oracle source (cc'd to .tmp/diff-oracle)
.tmp/
  diff-oracle         ← built oracle binary (gitignored)
  diff-oracle-out.bin ← scratch output for diff -u (gitignored)
  diff-binding-out.bin
```

The oracle and binding both link the same `prebuilds/darwin-arm64/libghostty-vt.dylib`,
so this tests *binding marshalling*, not Ghostty correctness. To test
Ghostty correctness across pin bumps, add a cross-version oracle (deferred).
