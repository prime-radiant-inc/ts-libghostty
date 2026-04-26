# RenderState cache invalidation — root cause and disposition

**Author:** Dirk (Bob `1dffecf5`)
**Date:** 2026-04-25
**Followup it resolves:** `docs/superpowers/followups/2026-04-25-renderstate-cache-bug.md`
**Status:** investigation complete; awaiting direction on which option to ship

---

## TL;DR

The bug is real but it's a **multi-`RenderState` collision**, not a single-`RenderState` cache invalidation. libghostty's `RenderState.update()` consumes the Terminal's per-row dirty bits as a single-consumer marker. When two or more `RenderState`s update against the same `Terminal`, only the first one each cycle gets fresh cell data; the rest see "no dirty rows" and skip the copy.

The current workaround (commit `44ee3cd`, allocate-fresh-per-paint in `Terminal.renderToAnsiRect`) is **structurally correct**. The followup's "good fix" criterion — single cached `RenderState` per `Terminal` — is **incompatible with libghostty's current design** when other `RenderState`s exist on the same `Terminal` (which is the common case: `Runner` keeps its own).

We have three options for what to ship; my recommendation is Option 2.

---

## Empirical confirmation

Probe at `packages/libghostty-vt/.tmp/probe-cache.ts` (uncommitted, diagnostic-only):

| Probe | Setup | Distinct renders / 8 writes | Verdict |
| --- | --- | --- | --- |
| A | 1 `RenderState`, sequential writes | **8** | Fresh — no bug |
| B | 2 `RenderState`s, both update each cycle, hash second updater | **1** | **STALE — bug reproduced** |
| C | 2 `RenderState`s, swap update order | **8** | Fresh (the second updater always loses) |

The "second updater always loses" result is the smoking gun: the bug is not about RS instances going stale, it's about the **order** in which they call `update()`. Whoever calls first wins.

## Root cause (Zig-side)

`vendor/ghostty/src/terminal/render.zig`:

1. **Lines 270-304** — `RenderState.update()` decides `redraw: bool` based on Terminal-level dirty flags (`t.flags.dirty`, `s.dirty`), screen-key match, dimensions, and viewport pin. If none indicate change, `redraw=false`.
2. **Lines 434-454** — when `redraw=false`, the per-row scan only copies rows whose `page_rac.row.dirty` is true. Non-dirty rows are skipped.
3. **Lines 460-461** — when a row IS copied, its dirty bit on the **Terminal page** is cleared: `page_rac.row.dirty = false`. This is the consumption marker.
4. **Lines 646-648** — at the end of `update()`, the global `t.flags.dirty` and `s.dirty` are zeroed too.

The doc comment at line 261-262 makes the design explicit:

> /// This will reset the terminal dirty state since it is consumed
> /// by this render state update.

libghostty was designed for **one consumer per Terminal**. The dirty bits are a Terminal-side single-consumer queue: writes set them, `update()` consumes and clears them. Two consumers race and the second one starves.

## Why the current workaround works

A fresh `RenderState` has `self.screen` unset (or default) which doesn't match `t.screens.active_key` — so the redraw-decision branch at line 273 fires, `redraw=true`, and the per-row scan ignores `page_rac.row.dirty` (line 436: `if (redraw) break :dirty;` — every row counts as dirty). All rows get copied unconditionally.

Cost: one `ghostty_render_state_new` + one `ghostty_render_state_free` per paint. At human cadence (≤60Hz), negligible. At tmux-class repaint frequencies, real but probably still acceptable.

## Why no purely JS-side fix is possible

To make a cached `RenderState` see fresh cells when alongside another consumer, we'd have to force `redraw=true` on every `update()`. Of the five conditions that trigger `redraw=true`:

- **Screen key mismatch** — no FFI setter for `self.screen`.
- **Terminal/screen dirty bits** — no FFI setter for `t.flags.dirty`.
- **Dimension mismatch** — no FFI setter for `self.rows`/`self.cols`.
- **Viewport pin mismatch** — no FFI setter for `self.viewport_pin`.
- **Different RenderState** (i.e., a fresh one) — yes, this is the workaround.

`ghostty_render_state_set(OPTION_DIRTY, FULL)` sets the **RenderState's own dirty mirror** (consumed by JS via `dirty()`), not anything that affects the redraw decision.

Hiding the per-paint allocation inside `RenderState.update()` itself (close + reopen native handle each call) would make the JS-level reference stable but doesn't reduce cost — same one alloc per paint, just relocated. And it's a misleading method semantics: "update" silently rebuilding the underlying handle.

## Options

### Option 1 — Status quo, document only

Keep `Terminal.renderToAnsiRect` allocate-per-paint. Update its JSDoc to explain the multi-`RenderState` collision accurately (current comment misattributes the cause). Add a CLAUDE.md gotcha (#12).

- ✅ Zero code change; no risk.
- ✅ Honest about what's happening.
- ❌ Doesn't satisfy the followup's "single cached RenderState" criterion.
- ❌ Followup remains "open" in spirit.

### Option 2 — Document + add a multi-RS contract test (RECOMMENDED)

All of Option 1, plus a regression test in `test/smoke/render-state.test.ts` that **asserts** the multi-`RenderState` collision semantics:

```ts
test("RenderState — multi-RS update: second updater each cycle sees stale cells (libghostty design)", () => {
  // libghostty's RenderState.update() consumes Terminal-side per-row dirty
  // bits as a single-consumer marker. When two RenderStates update against
  // the same Terminal, only the first one each cycle gets fresh data.
  // This test documents that constraint — see specs/2026-04-25-renderstate-cache-fix-design.md.
  const term = new Terminal({ cols: 4, rows: 2 });
  using rs1 = new RenderState();
  using rs2 = new RenderState();
  // ... assert rs2 (second updater) is stale relative to rs1
});
```

The test is a "constraint canary": if libghostty changes consumption semantics in a future pin, this test starts passing-the-old-way and fails — surfacing the change before consumers depend on a behavior that's not in our control.

- ✅ Minimal code; no API change.
- ✅ Documents the constraint executably.
- ✅ Closes the followup honestly.
- ❌ Still doesn't satisfy "single cached RS" criterion (impossible without libghostty changes).

**Version:** patch — `0.5.1` with a CHANGELOG entry under `Fixed`/`Documentation` noting the collision constraint.

### Option 3 — Upstream Ghostty patch + pin a fork

Propose a libghostty change: independent dirty tracking per `RenderState`. Two flavors:

- **Epoch counter:** Terminal increments an epoch on every write. Each `RenderState` tracks `last_synced_epoch`. `update()` does a full rebuild when `terminal.epoch > self.last_synced_epoch`. No shared mutable state. Per-row dirty bits stay on the Terminal as long as needed.
- **Per-RenderState dirty mask:** `RenderState` keeps its own copy of "what rows are dirty FROM MY PERSPECTIVE" — bumped by Terminal on writes via a registration mechanism.

Either path is a non-trivial Ghostty change. Until merged, `ts-libghostty-vt` would have to pin a fork (violating CLAUDE.md gotcha #2 spirit). Significantly more work; not justified by the cost of the current workaround.

- ❌ Out of scope for a binding bug-fix.
- ✅ Cleanest if Ghostty wants to support multi-consumer use.
- ⏭️ Track as a separate ticket if pursued.

## Recommendation

**Ship Option 2.** Update the JSDoc on `Terminal.renderToAnsiRect` and `RenderState.update()` to accurately describe the multi-RS collision. Add the contract test. Bump to `0.5.1` with a CHANGELOG entry. Close the followup with the disposition "design constraint, not a binding bug, workaround correct."

Optionally file an issue with Ghostty linking this analysis if Matt wants to push for upstream resolution. Don't gate the patch release on that.

## API impact

None. Public surface unchanged. `Terminal.renderToAnsiRect` keeps its current contract.

## Versioning

- Option 1 / 2 → `0.5.1` (patch — docs + test only)
- Option 3 → `0.6.0` if libghostty change requires API surface adjustment, else `0.5.1`

## Followup disposition

If we ship Option 2:

- `docs/superpowers/followups/2026-04-25-renderstate-cache-bug.md` → moved to `docs/superpowers/followups/resolved/` (or kept with a "RESOLVED" header — convention TBD)
- B1 (probe scripts) — answered: probes were demand-recreated this session; the diagnostic one at `.tmp/probe-cache.ts` can be promoted under `scripts/` or deleted.
- B2 (augment Pass 5 test) — partially answered: the existing 8-sequential-writes test stays as the `Terminal.renderToAnsiRect` contract test; Option 2's new multi-RS test is the constraint canary.
- B3 (close() cache disposal) — moot: `Terminal.renderToAnsiRect` no longer caches an RS, so there's no disposal logic to maintain.
- B4 (other RenderState consumers) — answered: the Runner is the "first updater" in production, so its `frame.snapshot.text` is always fresh. Anything else querying second loses.
