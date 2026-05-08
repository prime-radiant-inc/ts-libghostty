---
title: "The 'I' glyph marks last-known location of an unseen monster, not a monster class"
source: "../sources/nethack-5-guidebook.md"
created: 2026-05-08
schema_version: 1
links: [letter-glyphs-are-classes-not-species, unseen-monster-marker-i-persists-until-disproven]
---

# The 'I' glyph marks last-known location of an unseen monster, not a monster class

The capital `I` is the one letter excluded from the monster-class
range (`A-HJ-Z`). It is a *marker* the engine writes to the map
at the last-known location of an invisible or otherwise unseen
monster — a creature the player heard, was bitten by, or sensed
without seeing. The marker persists at that grid cell until the
player proves the cell is now empty, which happens by stepping
onto it (the engine fights into empty air if the monster has
moved, or fights the still-there monster if it hasn't), or by
seeing the cell from a vantage and observing it bare.

Two AP-relevant consequences:

1. **`I` is not a member of the monster-class space.** A
   classifier that maps every letter to a class will misclassify
   `I` as "an `I`-class monster", but no such class exists. The
   correct upstream filter is `letter ∈ a-zA-HJ-Z`.

2. **`I` is a soft "danger nearby" signal.** The engine emits
   `I` only when the player learned about the monster
   non-visually. The monster is still on the level, possibly
   adjacent, possibly dangerous — and crucially, *invisible to
   the AP's classifier*. Routing past an `I` tile is acceptable;
   routing *onto* one initiates a fight against (the same
   monster, or empty air, or a different monster that wandered
   onto the spot).

For autopilot purposes, `I` should produce a halt-or-detour
decision distinct from both `monster_visible` and
`new_item_visible`. A reasonable v1 rule: treat `I` as if it were
a hostile monster glyph for routing (don't step adjacent), but
do not classify it via the letter→class map.

Source: NetHack Guidebook 5.0.0 §3.3 lines 617–620 and §6.5
"Persistence of Monsters" lines 2793–2807.
