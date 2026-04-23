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

- Plain-format formatter output (cell content + position + trim behavior)
- 14 corpus files: 4 handcrafted smoke cases + 10 named seeds curated from
  Ghostty's own libghostty-vt fuzz corpus (`vendor/ghostty/test/fuzz-libghostty/corpus/parser-initial/`)
- Fixed 80×24 terminal geometry on both sides

## What it does not cover (yet)

- Attribute divergence: colors, bold, underline, hyperlinks. (`vt` and `html`
  formatters are stretch goals; see design memo §3.)
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
- (future) `2X-*` — handcrafted attribute-coverage cases for vt/html
- (future) `3X-*` — curated from `parser-cmin` / `stream-cmin`

Re-run the harness; new fixture should pass on day one. If it doesn't, you
either found a binding bug or wrote a fixture that depends on geometry the
harness doesn't yet support — investigate before normalizing.

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
