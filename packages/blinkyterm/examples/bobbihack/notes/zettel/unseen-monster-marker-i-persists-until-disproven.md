---
title: "The I marker persists at last-known unseen-monster location until the spot is proven empty"
source: "../sources/nethack-5-guidebook.md"
created: 2026-05-08
schema_version: 1
links: [ap-design-must-treat-rendering-quirks-as-first-class-input, i-glyph-is-unseen-monster-marker-not-a-class, line-of-sight-determines-monster-rendering]
---

# The I marker persists at last-known unseen-monster location until the spot is proven empty

The `I` map marker is the engine's way of preserving the memory
of an unseen monster's last-known position across frames. The
Guidebook §6.5 lines 2801–2807 is explicit:

> However, if you encounter a monster which you can't see or
> sense--perhaps it is invisible and has just tapped you on the
> noggin--a special "remembered, unseen monster" marker will be
> displayed at the location where you think it is. That will
> persist until you have proven that there is no monster there,
> even if the unseen monster moves to another location or you
> move to a spot where the marker's location ordinarily wouldn't
> be seen any more.

Two AP-relevant facts:

1. **Persistence-without-truth.** The `I` marker stays even if
   the actual monster has moved. So "where the `I` is" is *not*
   "where the threat is" after any number of turns. It's "where
   the threat *was*."
2. **Disproof requires an action.** The cell stops showing `I`
   only when something proves it empty: stepping in (committing
   to a fight against air or the still-there monster), or
   line-of-sight from a vantage that shows no monster there.

The AP's `monster_visible` interrupt fires on letter glyphs
that are not `I` and not the player. It does *not* fire on
`I` because `I` is excluded from the `[a-zA-Z]` regex's
hostile-letter set (and even if included, would always be
"already there" not "newly appeared"). This means the AP
silently ignores `I` markers — a behavior that is
under-protective: stepping into an `I` initiates a fight.

The recommended AP behavior: treat `I` cells as non-walkable
in the planner, same as `trap_known`. Add an interrupt
`unseen_monster_marker` that fires when an `I` first appears
on a frame.

Source: NetHack Guidebook 5.0.0 §3.3 lines 617–620; §6.5 lines
2793–2807.
