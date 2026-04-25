# Cell-grid rectangle renderer for `libghostty-vt`

**Date:** 2026-04-25
**Author:** Sancho (Bob 811efc4e)
**Status:** Design — awaiting review
**Target release:** `libghostty-vt@0.4.0`

## Summary

Add a primitive that renders a parsed terminal screen into a rectangular
sub-region of a host terminal, suitable for tmux-class composition.
Output is ANSI bytes a consumer can splice directly into its own
rendering stream. The embedded program's own escape sequences never
reach the host — the renderer walks the libghostty cell grid and emits
its own cursor positioning and SGR.

This unblocks every consumer that wants to embed a TUI program inside
its own UI: bobbihack (its current rendering bug is the motivating
example), robohack, and any future multiplexer.

## Why

`Formatter.toAnsi()` is a screen-replay surface — designed to reproduce
a screen on a fresh terminal. It preserves the program's residual
cursor positioning, erase-line sequences, alt-screen toggles, etc.
That's correct for archival and LLM consumption; it is **not** safe to
splice into the middle of another rendering pass. NetHack's trailing
`\x1b[20;10H` reaches the host terminal and clobbers whatever the
calling program had at host row 20.

The libghostty `RenderState` already exposes the parsed cell grid that a
proper composer needs. What's missing is the converter from that grid
into ANSI bytes that paint into a destination rectangle. This spec adds
that converter.

## Scope

**In:**
- New methods on `Terminal` (convenience) and `RenderState` (primitive)
- New cursor-translation helper on `RenderState`
- Pure ANSI-emission engine in a new file
- Strict source-vs-dest size check; clear error on mismatch
- `colorDepth` option: `"preserve"` (default) and `"none"`
- Unit, integration, and tarball-smoke test coverage
- `libghostty-vt@0.4.0` release: CHANGELOG, version bump, tarball repack

**Out:**
- Diff rendering (only paint changed cells); deferred to a future pass
- Color downsampling (truecolor → 256 → 16); add when a real consumer
  demands it
- Permissive size handling (clip / pad on dimension mismatch)
- Hyperlink (OSC 8) round-tripping; cell-spanning lifecycle is fiddly
- DECSCA "protected" attribute (visual no-op in modern terminals)
- Underline styles beyond plain on/off
- `toHtmlRect` / `toVtRect` parallels — straightforward additions later
- Switching bobbihack itself to use the new API (separate Pass 2 spec)

## 1. Architecture

```
packages/libghostty-vt/src/
  terminal.ts         + renderToAnsiRect(dest, opts)
  render-state.ts     + toAnsiRect(dest, opts)
                      + cursorInRect(dest)
  render-rect.ts      NEW — pure ANSI emission engine
  errors.ts           + RectSizeMismatch
  index.ts            + export new types
  types.ts            + RenderRect, RectRenderOptions, RectCursor
```

**Boundary for `render-rect.ts`:**

A pure module that consumes a `RenderState` (no FFI calls of its own —
walks the cached `CachedRow`/`CachedCell` data already inside
`RenderState`) plus a destination `RenderRect` plus options, and
returns an ANSI string. The methods on `Terminal` and `RenderState` are
thin wrappers; all logic lives in `render-rect.ts` and is independently
testable.

- `terminal.renderToAnsiRect(dest, opts)`: lazily allocates a per-Terminal
  cached `RenderState` (held on the Terminal handle), calls
  `update(this)`, then delegates to `render-rect`.
- `state.toAnsiRect(dest, opts)`: delegates directly to `render-rect`
  using the data already in `this`.
- `state.cursorInRect(dest)`: trivial coordinate translation; doesn't
  invoke the emission engine.

**Cached `RenderState` on Terminal:** the convenience method's first
call allocates a `RenderState`; subsequent calls reuse it. The cache
is disposed when the Terminal is closed. This avoids re-allocating per
paint and re-doing the FFI cell-walk when nothing's changed.

**No native code changes.** This release is purely additive at the
binding/TypeScript layer. Same prebuild dylib; tarball repacks for the
new version.

## 2. API surface

**New types (`types.ts`):**

```ts
export interface RenderRect {
  readonly row: number;   // 1-based host row of top-left
  readonly col: number;   // 1-based host col of top-left
  readonly cols: number;
  readonly rows: number;
}

export interface RectRenderOptions {
  /** SGR color depth. Default: "preserve". */
  colorDepth?: "preserve" | "none";
}

export interface RectCursor {
  readonly row: number;       // 1-based host row
  readonly col: number;       // 1-based host col
  readonly wideTail: boolean; // cursor sits on the right half of a wide char
}
```

**`Terminal` (additive):**

```ts
renderToAnsiRect(dest: RenderRect, opts?: RectRenderOptions): string;
```

Convenience method. Internally manages a cached `RenderState` per
Terminal. First call allocates and `update()`s; subsequent calls
`update()` and render.

**`RenderState` (additive):**

```ts
toAnsiRect(dest: RenderRect, opts?: RectRenderOptions): string;
cursorInRect(dest: RenderRect): RectCursor | null;
```

`toAnsiRect` is the primitive. Operates on whatever the RenderState's
most recent `update()` cached. The caller controls when `update()` runs.

`cursorInRect` adds the dest origin to the RenderState's viewport
cursor (which is 0-based and source-local) and returns 1-based host
coordinates. Returns `null` when:
- The viewport cursor is `undefined` (cursor offscreen / hidden)
- `RenderState` was never `update()`'d
- (Defensive) the cursor's source-local coords exceed the source
  extent — shouldn't happen in practice but null-rather-than-throw

**Validation (strict for v1):**

`dest.cols` and `dest.rows` MUST equal the source's cols/rows
(`RenderState`'s last-snapshot dimensions, or `Terminal.snapshot().cols/rows`
for the convenience method). Mismatch throws `RectSizeMismatch`:

```
RectSizeMismatch: source is 80×24, dest is 80×25.
Resize the source program (terminal.resize) or the destination box.
```

The strict check makes dimension drift loud rather than silently
mis-rendering. Permissive `fit: "exact" | "clip" | "pad"` is a thinkable
future option; nothing in v1 needs it.

## 3. ANSI emission rules

**Per-row algorithm (in `render-rect.ts`):**

```
for each row y in 0..source.rows-1:
  emit ESC[<dest.row+y>;<dest.col>H            // goto
  emit ESC[0m                                   // row-start reset
  let lastSgr = ""

  for each cell in row.cells:
    if cell.isWideContinuation: continue        // ghost half of CJK char
    sgr = computeSgr(cell.style, opts.colorDepth)
    if sgr != lastSgr:
      emit (sgr || ESC[0m)
      lastSgr = sgr
    emit (cell.text || " ")                     // space for empty cells
```

Returns the joined string.

**Row-start reset:** defensive `\x1b[0m` so a bug in one row's SGR
diffing can't bleed into the next. ~5 bytes per row, negligible.

**SGR diffing:** emit a new SGR sequence only when the computed style
differs from the last emitted one within the row. For typical content,
attribute changes happen at semantic boundaries (text vs blank padding)
so byte-rate stays sane. Worst case (every cell different) is ~25 bytes
per cell vs ~5 with diffing.

**Empty cells (`text === ""`):** emit one space character. A blank cell
with non-default bg still has visible meaning (status-bar background);
the SGR-with-space approach paints it correctly.

**Wide characters:** primary cell carries the glyph + `wide: true`;
continuation cell carries `isWideContinuation: true`. The renderer
skips continuation cells — when the terminal renders the wide glyph,
the cursor advances by 2 cells, so dropping the ghost is correct.

**`computeSgr(style, colorDepth)`:**

- Returns `""` for default style (no fg, no bg, no attributes).
- Otherwise builds one CSI sequence: `\x1b[<params>m` with attributes
  in this order: bold (1), faint (2), italic (3), underline (4), blink
  (5), inverse (7), invisible (8), strikethrough (9). Then fg, then bg.
- **Foreground (`colorDepth: "preserve"`):**
  - RGB → `38;2;R;G;B`
  - palette index → `38;5;N`
  - basic 16-color (when libghostty represents it as 0–15) → `30–37` /
    `90–97`
  - default fg → `39` (only emitted as part of a transition; if the
    only difference from prior cell is "now default", emit `\x1b[0m`
    instead of `39` to also clear attributes)
- **Background:** parallel logic (`48;2/48;5/40–47/100–107` and `49`).
- **`colorDepth: "none"`:** skip color and attribute SGR entirely
  (plain text only). Useful for tests / snapshots / minimal hosts.

**Trailing state:** renderer does NOT move or hide the cursor at the
end. The caller composes into its own ANSI stream and handles cursor
visibility via its own logic + `cursorInRect()`.

## 4. Errors

| Error | Thrown by | When |
|---|---|---|
| `RectSizeMismatch` | `toAnsiRect`, `renderToAnsiRect` | dest dims ≠ source dims |
| `UseAfterCloseError` | all three methods | RenderState / Terminal closed |

`RectSizeMismatch` is new. Extends `GhosttyError` with code
`"rect_size_mismatch"`; message includes both dimension pairs and a
hint to call `terminal.resize` or adjust the destination.

## 5. Testing

**Unit** (`test/smoke/render-rect.test.ts`) — hand-construct
`RenderState`-shaped inputs (or use a real RenderState fed via `vtWrite`
to a Terminal then `update`'d) and assert structure of the returned
string:

- Empty terminal: all spaces, no SGR, default style
- Single styled cell: one SGR transition; cells before/after default
- Whole-row uniform style: one SGR at row start, no per-cell repeats
- Alternating styles: SGR transition on each change
- Wide character: glyph emitted once at primary cell; continuation
  cell skipped; no double-render
- Empty cell with non-default bg: space emitted with bg SGR
- Size mismatch: throws `RectSizeMismatch` with both dim pairs in message
- `colorDepth: "none"`: no `\x1b[` sequences in output
- Goto-per-row: each row begins with `\x1b[<row>;<col>H`

**Cursor helper** (`test/smoke/cursor-in-rect.test.ts`):
- Cursor visible inside source: returns translated host coords
- Cursor unset: returns `null`
- RenderState never updated: returns `null`
- Cursor at edge cells: correct translation
- `wideTail: true` propagates

**Integration** (`test/smoke/render-rect.integration.test.ts`) — drive a
real Terminal via `vtWrite` with synthetic input that includes
cursor-positioning, erase, alt-screen toggles. Confirm:
- None of those control sequences appear in `toAnsiRect()` output
- SGR styling is preserved
- The convenience method on Terminal returns the same output as
  manually constructing + updating a RenderState and calling
  `toAnsiRect()` on it

**Tarball smoke** — extend `scripts/run-tarball-smoke.sh` to import
the new methods, render a small rect from a hand-fed Terminal, assert
non-empty output. One added stanza; guards against export-list
regressions.

**Not tested in v1:**
- Real bobbihack integration (lives in Pass 2)
- 256-color downsampling (deferred)
- Performance benchmarks (no concrete perf target yet)

## 6. Release packaging

- Bump `packages/libghostty-vt/package.json` from `0.3.0` to `0.4.0`.
- Add CHANGELOG entry under `[0.4.0]` with `Added` section listing the
  three new methods, the cursor helper, and `RectSizeMismatch`.
- No native rebuild required.
- Tag `libghostty-vt@0.4.0` after the implementation lands.
- Tarball smoke must pass before tagging.

## 7. Non-goals (deferred, acknowledged)

1. Diff / dirty-only rendering. Future pass once a real perf target shows up.
2. Color downsampling between depths.
3. Permissive size handling (clip / pad).
4. Hyperlink (OSC 8) round-tripping.
5. `toHtmlRect` / `toVtRect` parallel formatters.
6. Switching bobbihack to the new API (Pass 2 — separate spec).

## 8. Open questions

1. **Cached RenderState ownership on Terminal.** Implementation detail:
   does `Terminal.close()` need to dispose the cached RenderState
   explicitly, or does GC handle it? The libghostty handle is a Pointer
   so explicit close is the safer choice. The implementation plan must
   wire `terminal.close()` → `cachedRenderState?.close()`.

2. **Default color depth.** `"preserve"` is the obvious default. If
   later we add downsampling, `"preserve"` stays the default and the
   new depths are opt-in.

3. **API discoverability.** Both `terminal.renderToAnsiRect` and
   `state.toAnsiRect` exist. The convenience method should reference
   the primitive in its TSDoc so consumers learn about the cache layer
   when they need control.
