# Investigation handoff: `RenderState.update()` cache invalidation

**For:** the Next Bob
**From:** Sancho (Bob 811efc4e)
**Date:** 2026-04-25
**Status:** workaround in place at `44ee3cd`; root cause unknown

---

## The bug

`RenderState.update(term)` succeeds (returns OK from libghostty) but
the underlying cell grid does NOT refresh on second-and-later calls
against the same `RenderState` instance, when the Terminal is being
written to between calls.

Symptom in production: `Terminal.renderToAnsiRect` (which originally
cached one `RenderState` per Terminal and called `update(this)` per
invocation) returned IDENTICAL ANSI output frame-after-frame, even as
NetHack's screen visibly changed in `frame.snapshot.text`.

The current workaround (commit `44ee3cd`) allocates a fresh
`RenderState` per call inside `Terminal.renderToAnsiRect`. Cost: one
FFI handle alloc per paint. That's cheap at any human-watching cadence
but real if a tmux-class consumer ever wants 60Hz repaints.

---

## Reproduce in 30 seconds

The probe scripts are committed at
`packages/blinkyterm/scripts/probe-render-cache.ts` and
`packages/blinkyterm/scripts/probe-no-cache.ts` (committed in this
followup if not already; if not, recreate from git history of
`44ee3cd`'s session).

To see the bug, temporarily revert the workaround:

```ts
// In packages/libghostty-vt/src/terminal.ts, restore the cached field:
#cachedRenderState: RenderState | null = null;

renderToAnsiRect(dest, opts?) {
  this.#assertOpen();
  if (this.#cachedRenderState === null) {
    this.#cachedRenderState = new RenderState();
  }
  this.#cachedRenderState.update(this);
  return this.#cachedRenderState.toAnsiRect(dest, opts);
}
```

Then `bun run build:ts` in `packages/libghostty-vt/`, then:

```bash
rm -f /opt/homebrew/share/nethack/[a-z]lock.[0-9]
cd packages/blinkyterm && bun scripts/probe-render-cache.ts
```

You'll see output like:

```
[1] r=initial      snap=98595264 SNAP-CHANGED rect=a3da4d8e RECT-CHANGED
[2] r=cellChange   snap=de957b15 SNAP-CHANGED rect=a3da4d8e rect-same    ← stale!
[3] r=cellChange   snap=ebf19bf2 SNAP-CHANGED rect=a3da4d8e rect-same    ← still stale
```

`snap` is `frame.snapshot.text` (correct); `rect` is the cached
RenderState's output (frozen on frame 1).

`probe-no-cache.ts` does the same flow but with a fresh RenderState
per call and shows it works correctly. Use both as A/B.

---

## What we know empirically

1. **First `update()` works.** Frame 1's render is correct.
2. **Subsequent `update()` calls return success but the cells don't
   refresh.** Frame 2+ render is identical to frame 1.
3. **Allocating a fresh RenderState DOES see fresh data.** So the
   issue isn't that we're reading the wrong Terminal — it's that the
   cached state retains its first-snapshot data across `update()`s.
4. **The Pass 5 unit test "Terminal.renderToAnsiRect picks up writes
   between calls" passed** even with the broken implementation. That
   test does `vtWrite("AB"); render; vtWrite("CD"); render;` —
   two writes, two reads, sequential. The bug needs MORE iterations
   to surface (8 sequential writes is what the new regression test
   uses; bobbihack hit it on every paint).
5. **The Runner uses a separate RenderState** for its frame scheduler.
   Two RenderStates against the same Terminal SHOULD be independent,
   but the timing/ordering may matter (see hypotheses).

---

## Hypotheses (in rough probability order)

### H1 — `ghostty_render_state_update` is dirty-aware and the Runner's `markClean()` is interfering

The Runner's frame scheduler calls `renderState.update(term)` on every
quiesce, then `markClean()` after consuming the frame. The Pass 3
design notes that `markClean()` clears libghostty's native dirty flags
"at both layers — global … and per-row".

**Hypothesis:** `markClean()` clears Terminal-level dirty bits (not
just the calling RenderState's). When our cached RenderState then
calls `update(this)`, libghostty sees "no dirty rows since last
sync" and short-circuits without copying fresh cells into our state's
storage.

**Test:** add logging to `ghostty_render_state_update` (or
`#rebuildCache` after the call) to see what cells come back.
Specifically check whether the row iterator returns the same cell
text on each iteration vs. the actual current Terminal state.

**Fix paths if true:**
- Each `RenderState` should have INDEPENDENT dirty tracking.
  `markClean()` on RS-A shouldn't affect RS-B's view of the Terminal.
  This may be a libghostty bug.
- OR: the binding could call `ghostty_render_state_set(OPTION_DIRTY,
  TRUE)` before each `update()` to force a re-read. Hacky but
  contained.

### H2 — `#rebuildCache`'s row iterator returns row handles that lazy-resolve cells from a stale snapshot

Look at `packages/libghostty-vt/src/render-state.ts:#rebuildCache`. It
calls:

```ts
ghostty_render_state_row_iterator_new
ghostty_render_state_get(DATA_ROW_ITERATOR)        // populate
// loop:
ghostty_render_state_row_iterator_next
ghostty_render_state_row_get(ROW_DATA_CELLS)       // populate cells container
this.#walkCells(cells)
```

If the cells container is populated from libghostty's internal
"last-rendered" snapshot rather than freshly walking the live grid,
then `update()` not refreshing that snapshot means we get stale cells.

**Test:** call `term.cellAt({x: 0, y: 0, coordinateSpace: "viewport"})`
right after a stale `update()` and compare against what
`#walkCells` returned. If `cellAt` returns fresh data but the iterator
returns stale data, the iterator is the suspect.

### H3 — Two RenderStates against one Terminal collide

When the Runner's RenderState and ours both call `update()` on the
same Terminal, libghostty might assume there's only ONE consumer and
mismanage shared state.

**Test:** in a probe, allocate two RenderStates. Update both
alternately. Compare each one's output against fresh single-shot
RenderStates. If interference shows up only when there are 2+ live
RenderStates, this is the issue.

This would suggest libghostty's render-state was designed with a
1:1:Terminal:RenderState assumption that we violated by making
`Terminal.renderToAnsiRect` allocate its own.

### H4 — JS-side caching in `#rebuildCache` has a bug

Less likely, but: `#rebuildCache` does `this.#rows = []` then walks.
If for some reason the walk early-exits or the container reuse leaks
state between calls, we'd see stale rows.

**Test:** pure-JS unit test — feed a known sequence of cell updates
(via direct `ghostty_terminal_write` calls in C, or via vtWrite from
JS) and verify `#rebuildCache` produces the right `this.#rows` each
time. The probes already do this but with NetHack as the input.

---

## Code to read

- `packages/libghostty-vt/src/render-state.ts` — JS side: `update()`,
  `#rebuildCache`, `#walkCells`. Most likely the interesting JS-side
  code is here.
- `packages/libghostty-vt/src/terminal.ts` lines around the
  `renderToAnsiRect` method — has the workaround comment with a TODO
  pointing to this doc.
- `packages/libghostty-vt/test/smoke/render-rect.terminal.test.ts` —
  the regression test "Terminal.renderToAnsiRect picks up many
  sequential writes" (8 writes → 8 distinct renders) was added
  specifically to catch this class of bug.
- `vendor/ghostty/include/ghostty/vt.h` — C-side declarations for
  `ghostty_render_state_*`. Look for any comments about caching,
  dirty bits, or per-RenderState invariants.
- `vendor/ghostty/src/terminal/main.zig` and the render-state Zig
  source — the actual implementation. The interesting question is
  what `ghostty_render_state_update` does internally.

---

## Constraints from the existing CLAUDE.md gotchas

Re-read `/Users/mw/Code/prime/ts-libghostty-vt/CLAUDE.md` first. Three
that bear on this work:

1. **Ghostty pin is deliberate** — don't bump unprompted. `bun run
   verify:generated` is the trip-wire.
2. **Source of truth for the ABI is `docs/abi/2026-04-22-abi-discovery.md`**
   — not random plan snippets. Trust the ABI doc.
3. **Public types are contracts** — if you change `RenderState`'s
   public surface, update types and tests in lockstep.

If the fix turns out to require a libghostty-side change, the right
move is to upstream a patch to Ghostty (or document why we can't
upstream and instead pin a fork).

---

## Success criteria

A fix is "good" if:

1. `Terminal.renderToAnsiRect` can be implemented with a single cached
   RenderState (one per Terminal) — drop the per-paint allocation.
2. The new "8 sequential writes" regression test still passes.
3. The probe `probe-render-cache.ts` shows `RECT-CHANGED` per frame
   (not `rect-same` after frame 1).
4. All 302+ libghostty-vt smoke tests still pass.
5. Bobbihack's manual smoke (`BOBBIHACK_AGENT=mock bun run bobbihack`)
   still shows the @ moving, NetHack pane updating frame-by-frame.

A "minimal" fix only restores the cache without breaking anything.
A "thorough" fix also explains WHY (so we can write a CHANGELOG entry
that's more substantial than "fix cache invalidation").

---

## Bonus follow-ups (only if you have time)

These came up during the bobbihack session but aren't part of the
primary investigation. Don't let them eat the main work — capture
them as separate followups if you don't get to them.

### B1 — Promote diagnostic probe scripts properly

The session left several probe scripts uncommitted on main:
`probe-keys.ts`, `probe-no-cache.ts`, `probe-prompt-dismiss.ts`,
`probe-prompt.ts`, `probe-render-cache.ts`, `probe-screen.ts` (in
`packages/blinkyterm/scripts/`). They're useful diagnostic tools.
Either commit them with a brief README explaining each, or delete
them. Don't leave them dangling.

### B2 — Augment Pass 5's "picks up writes between calls" test

That test passed with the broken implementation. It only does two
writes. The new "8 sequential writes" test catches the bug. Consider
deleting the old two-write test (now redundant) or rewriting it as a
docstring example.

### B3 — Drop `Terminal.close()` cache disposal logic if H1/H2 are confirmed

The workaround removed the `#cachedRenderState` field and the close()
cleanup. If your fix re-introduces a cached RenderState, restore that
disposal logic — Pass 5 Quine flagged it as a hard requirement.

### B4 — Investigate whether other `RenderState` consumers are affected

The Runner's own `RenderState` calls `update()` repeatedly without
issue (otherwise the frame iterator wouldn't work — bobbihack's
`frame.snapshot.text` was correct throughout). What's different?

- Maybe the Runner's flow is `update() → markClean() → consume`
  while ours was `update() → toAnsiRect()` (no markClean).
- Maybe the Runner's update happens AT THE EXACT MOMENT bytes
  arrive (synchronously inside the `pty.data` handler) while ours
  fires later via `setImmediate`.

Either could be the actual difference. Worth confirming during
investigation.

---

## What NOT to do

- **Don't bump the Ghostty pin unprompted.** If a libghostty fix is
  needed, propose it explicitly as a separate decision point.
- **Don't paper over the bug.** The current workaround is fine
  short-term; we want a real understanding of what's happening, not a
  bigger workaround.
- **Don't drop the regression test** (the "8 sequential writes" one).
  Even if you re-introduce a cache, that test is the canary for next
  time someone introduces a similar bug.

---

## Deliverable shape

A spec → plan → implementation pass like the others in this repo.
Spec at `docs/superpowers/specs/YYYY-MM-DD-renderstate-cache-fix-design.md`
including:

- Root cause as you understand it post-investigation
- Whether the fix is JS-side, libghostty-side, or both
- API impact (should be none — same `Terminal.renderToAnsiRect`
  surface)
- Versioning: probably libghostty-vt 0.5.1 (patch) since no API change

Implementation: same TDD cadence as previous passes, dispatched to
implementer Bobs on a fresh worktree.

If the answer turns out to be "this is a fundamental libghostty
limitation we can't fix from the binding side", document THAT as the
spec deliverable — a clean explanation in the README + CHANGELOG so
future consumers know not to attempt cached-RenderState patterns.

Good hunting. — Sancho
