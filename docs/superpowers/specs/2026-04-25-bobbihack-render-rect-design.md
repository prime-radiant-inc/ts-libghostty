# bobbihack switches NetHack pane to render-rect

**Date:** 2026-04-25
**Author:** Sancho (Bob 811efc4e)
**Status:** Design — awaiting review
**Depends on:** `libghostty-vt@0.5.0` (this branch)

## Summary

Switch bobbihack's NetHack pane from `frame.snapshot.toAnsi()` (which
required defensive `\r` and CSI stripping to prevent the program's
escape sequences from clobbering the host) to the new
`Terminal.renderToAnsiRect()` API, which walks the parsed cell grid
and emits ANSI bytes that paint cleanly into a destination rectangle.

This is the consumer-side companion to Pass 5 (the render-rect API
itself). It deletes ~80 lines of defensive sanitization, simplifies
the data flow, and makes bobbihack work correctly for any TUI program
— not just programs whose escape vocabulary the previous regex
happened to cover.

## Why

Pass 4 of bobbihack shipped a working NetHack-watcher, but it landed
two regressions in production smoke that required defensive fixes:

1. Trailing `\r` in `toAnsi()` rows clobbered the left pane border.
2. NetHack's trailing `\x1b[20;10H` cursor-positioning escape jumped
   the host cursor and clobbered the right pane border.

Both were patched by stripping characters from the formatter's output
in `render.ts`. That works for NetHack but is fundamentally fragile —
any other TUI's vocabulary (`\x1b[?1049h`, `\x1b[K`, OSC 8, etc.)
would resurface the same class of bug, and we'd be playing
whack-a-mole forever. Pass 5's `renderToAnsiRect` is the principled
fix: walk the parsed cell grid, emit our own ANSI, never let the
program's escape bytes touch the host.

## Scope

**In:**
- Replace `drawNethackContent`'s parsing path in `render.ts` with a
  splice of pre-rendered content from `Terminal.renderToAnsiRect()`.
- Add `nethackContent` parameter to `render(state, nethackContent)`.
- Drop `state.nethack.screenAnsi` (no longer needed).
- Drop `sanitizeForInline()` and the `\r` / non-SGR-CSI defensive
  strips in `render.ts`.
- Update / remove tests that asserted on the now-deleted code paths.
- Wire `runner.terminal.renderToAnsiRect` into the paint loop in
  `main.ts` with a defensive try/catch for teardown races.

**Out:**
- Switching `agent.decide()`'s input — that still uses
  `frame.snapshot.toAnsi()` (LLM-friendly flat text). Two consumers,
  two formatters, same screen state (see §2).
- Diff rendering / dirty-cell-only emit (deferred).
- Showing NetHack's cursor in the host (the `@` glyph already shows
  player position; cursor visibility stays off).
- Layout geometry — pane stays at 84×26 outer with 1-cell horizontal
  padding around 80×24 NetHack content.
- Anything in `libghostty-vt` itself (Pass 5 already shipped 0.5.0).

## 1. Architecture & files

```
packages/blinkyterm/examples/bobbihack/
  main.ts                                  MODIFIED — call runner.terminal.renderToAnsiRect per paint
  render.ts                                MODIFIED — accept nethackContent param; drop sanitization
  state.ts                                 MODIFIED — drop nethack.screenAnsi field

packages/blinkyterm/test/smoke/
  bobbihack.render.test.ts                 MODIFIED — drop \r / CSI tests; update content placement test for new render signature
  bobbihack.state.test.ts                  MODIFIED — drop the test that asserted screenAnsi update on onChildFrame
```

**Untouched:** `agent.ts`, `agents/mock.ts`, `agents/anthropic.ts`,
`events.ts`, `layout.ts`, `bobbihack.layout.test.ts`,
`bobbihack.mock.test.ts`, `bobbihack.events.test.ts`,
`bobbihack.anthropic.test.ts`. The agent's input still flows through
`frame.snapshot.toAnsi()` (see §2 for the naming-collision warning).

No new files. ~150 LOC removed, ~30 added, 4 tests deleted, 2 adapted.

## 2. Two consumers of screen state

The same Terminal feeds two different formatters depending on consumer:

```
runner.frames()
   ├──→ frame.snapshot.toAnsi()  →  agent.decide({ ..., screenAnsi })
   │       Frozen snapshot. Flat text with inline SGR. No cursor moves
   │       or erases. Designed for LLM consumption.
   │
   └──→ runner.terminal.renderToAnsiRect(dest)  →  spliced into render output
           Live terminal. Positioned ANSI (gotos + reset-prefixed SGR
           per row) ready to splice into a sub-rectangle. Designed for
           tmux-style composition.
```

Pass 6 changes only the second arrow. The agent's input is unchanged.

The semantic distinction is clean:

- The agent gets a *snapshot* — frozen across `await` points, designed
  for LLMs to read.
- The spectator UI reads the *live* Terminal — refreshed every paint,
  composed into a rectangular host region.

**⚠ Naming-collision warning for implementers.** Two fields are named
`screenAnsi`, and Pass 6 removes one but keeps the other:

| Field | Source | Pass 6 action |
|---|---|---|
| `state.nethack.screenAnsi` | `state.ts` (NethackPane) | **DELETE** |
| `AgentInput.screenAnsi` | `agent.ts` | **KEEP** — agents still receive this |

A naive global rename or "drop all `screenAnsi`" sweep will break the
agent loop. Specifically: `main.ts` line ~125 passes
`screenAnsi: frame.snapshot.toAnsi()` into `agent.decide(...)`. That
call site stays. `agents/anthropic.ts` reads `input.screenAnsi`.
That stays. The only `screenAnsi` removed is the one on
`NethackPane`.

## 3. Data flow change

**Before (Pass 4-era):**

```
runner.frames() yields frame
   ↓
state.nethack.screenAnsi = frame.snapshot.toAnsi()   (in main.ts onChildFrame)
   ↓
render(state) walks state.nethack.screenAnsi line-by-line, strips \r
and non-SGR CSI, emits per-row goto + reset + content
   ↓
host stdout
```

**After:**

```
runner.frames() yields frame   (frame.snapshot still used for prompt
                                 detection and as agent.decide input;
                                 not stored in ViewState anymore)
   ↓
main.ts requestPaint() builds nethackContent:
  nethackContent = runner.terminal.renderToAnsiRect({
    row: nethackBox.row + 1,
    col: nethackBox.col + 2,
    cols: 80,
    rows: 24,
  })
   ↓
render(state, nethackContent) draws borders + padding cells, splices
nethackContent (which carries its own per-row gotos)
   ↓
host stdout
```

The dest rectangle: top-left at the cell *inside* the top border and
left padding column; size locked to NetHack's pty geometry (80×24,
matching the pinned `Runner.spawn` options).

## 4. `render.ts` changes

**Signature:**

```ts
// Before
export function render(state: ViewState): string;

// After
export function render(state: ViewState, nethackContent: string): string;
```

**`drawNethackContent` becomes `drawNethackPane`:**

```ts
function drawNethackPane(
  parts: string[],
  box: Box,
  pid: number,
  nethackContent: string,
): void {
  // 1. Border + title (drawBox is unchanged)
  drawBox(parts, box, ` NetHack — pid=${pid} `);

  // 2. Clear the 1-cell padding columns inside the pane each frame.
  //    renderToAnsiRect doesn't touch them (it only paints the 80×24
  //    content area). Without this, stale content could persist across
  //    repaints in the unlikely event something writes there.
  const innerRows = box.rows - 2;
  for (let i = 0; i < innerRows; i++) {
    parts.push(goto(box.row + 1 + i, box.col + 1));
    parts.push(" ");                                  // left padding
    parts.push(goto(box.row + 1 + i, box.col + box.cols - 2));
    parts.push(" ");                                  // right padding
  }

  // 3. Splice the pre-rendered content. Its embedded gotos place each
  //    row at the right host coordinates already.
  parts.push(nethackContent);
}
```

**Deletions:**
- `sanitizeForInline()` helper.
- `stripAnsi()` helper (was only used by `sanitizeForInline` and the
  per-cell length math; both go away).
- The line-by-line content loop in the old `drawNethackContent`.

The `goto()` helper at the top of `render.ts` is unchanged — it's
shared with the agent pane drawing.

`renderToAnsiRect` output is parser-clean per Verity's integration
tests in libghostty-vt; bobbihack doesn't need belt-and-suspenders.

## 5. `main.ts` changes

The paint coalescer becomes:

```ts
const requestPaint = (): void => {
  if (writePending !== null) return;
  writePending = setImmediate(() => {
    writePending = null;
    let nethackContent = "";
    if (state.layout.kind !== "tooSmall") {
      const box = state.layout.nethack;
      try {
        nethackContent = runner.terminal.renderToAnsiRect({
          row: box.row + 1,
          col: box.col + 2,
          cols: 80,
          rows: 24,
        });
      } catch {
        // Runner disposed mid-paint, or strict size match failed
        // because of a resize race. Render with empty pane; next
        // paint will catch up.
      }
    }
    process.stdout.write(render(state, nethackContent));
  });
};
```

**Why the bare `try/catch`:** the only condition that can fire on
bobbihack as wired today is `UseAfterCloseError` during teardown — a
paint that's already debounced when `runner[Symbol.asyncDispose]()`
runs in the `finally` block. Bobbihack does NOT call
`runner.resize()` on SIGWINCH (it only updates the host-side layout;
NetHack's pty stays at 80×24 for the lifetime of the run), so the
strict-size-match `RectSizeMismatch` cannot fire in practice. The
`try/catch` is belt-and-suspenders that also guards future code that
might add a `runner.resize()` call. Worst case: one frame of empty
NetHack pane immediately before bobbihack restores the host terminal
and exits.

## 6. `state.ts` changes

Remove `screenAnsi` from `NethackPane` and the `onChildFrame` reducer
no longer needs it:

```ts
// Before
export interface NethackPane {
  readonly screenAnsi: string;
  readonly pid: number;
  readonly bellsCumulative: number;
  readonly title: string;
}

// After
export interface NethackPane {
  readonly pid: number;
  readonly bellsCumulative: number;
  readonly title: string;
}
```

`onChildFrame` keeps updating `bellsCumulative` and `title` (those
are derived from frame events, not the screen content) but drops
the `screenAnsi` write.

## 7. Tests

**`packages/blinkyterm/test/smoke/bobbihack.render.test.ts` updates:**
- All `render(s)` calls (single-arg) → `render(s, "")` (two-arg) for
  tests that don't care about the NetHack content.
- The "render places NetHack content row by row at the right offsets"
  test currently calls `onChildFrame(s, frame("ABCDEFG\nHIJKLMN"))`
  to populate `state.nethack.screenAnsi`. With Pass 6, that field
  doesn't exist; instead, pass a synthetic `nethackContent` directly:
  `render(s, "\x1b[2;3HABCDEFG\x1b[3;3HHIJKLMN")` and assert those
  substrings appear verbatim in the output. The cursor-position
  assertion (`\x1b[2;2H`) becomes "the test passes through whatever
  positioned content we give it."
- **Delete** the two regression tests at the end of the file
  (`render strips CR…` and `render strips non-SGR CSI sequences…`,
  added in commits `c434481` and `1f4fd06`) — they guard a defense
  that no longer exists.

**`packages/blinkyterm/test/smoke/bobbihack.state.test.ts` updates:**
- **Delete** the `onChildFrame updates the NetHack pane content` test.
  Other state tests (initial state, turn lifecycle, history ring,
  onResize, onChildExited, the sticky-currentTurn behavior added
  earlier) are unaffected.

**No new tests for `renderToAnsiRect` itself** — Pass 5's
`render-rect.terminal.test.ts` and `render-rect.integration.test.ts`
already cover that surface comprehensively.

**Manual smoke is the acceptance gate.** `BOBBIHACK_AGENT=mock bun
run bobbihack`: run for a minute, verify NetHack renders cleanly with
all four borders intact, no col-0 / row-N artifacts, agent pane
streams normally, `q` quits cleanly.

## 8. Errors / lifecycle

**One new error path** the user might observe in practice: a paint
that fires during runner disposal hits `UseAfterCloseError` from
`renderToAnsiRect`. The defensive try/catch absorbs it and renders
an empty pane. Worst case: one frame of empty NetHack pane immediately
before bobbihack restores the host terminal and exits.

**No change to existing error surfaces.** All the bobbihack-side
errors (`q` quit, NetHack child exit, SIGWINCH too-small) keep their
current behavior.

## 9. Out-of-scope cleanup ideas (acknowledged, deferred)

1. **Manual `RenderState` instead of the convenience method.** Would
   give bobbihack control for diff rendering. Not justified at
   bobbihack's 1Hz cadence.
2. **Showing NetHack's cursor.** Decided: no — `@` glyph is the
   visual indicator, and a blinking host cursor next to a static map
   is more distracting than helpful.
3. **Promoting the bobbihack-shaped padding helper into a reusable
   utility.** No second consumer exists yet to justify the lift.
4. **Switching `agent.decide`'s input format.** Could pass cell-grid
   data structurally instead of ANSI text. Bigger design question
   (what shape does the LLM want?), separate spec.

## 10. Open questions

None substantive. The `try/catch` shape in §5 is the only debatable
detail and the call-out there explains the trade.
