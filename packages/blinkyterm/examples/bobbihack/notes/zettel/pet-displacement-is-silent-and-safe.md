---
title: "Walking into a pet's tile silently swaps positions; default MSGTYPE hides the message"
source: "../sources/nethack-5-guidebook.md"
created: 2026-05-08
schema_version: 1
links: [bumping-a-monster-tile-is-the-attack-contract]
---

# Walking into a pet's tile silently swaps positions; default MSGTYPE hides the message

When `safe_pet` is on (the default), walking into a pet's tile
swaps the player and pet positions rather than attacking the
pet. The Guidebook §6.2 covers pets generally; the displacement
behavior is documented at §5.5 line 2627: "The confirm and
safe_pet options control what happens when you try to move onto
a peaceful monster's spot or a tame one's spot."

The default config also includes `MSGTYPE=hide "You displaced
*."` (Guidebook example config line 6215), which suppresses the
"You displaced X" message from the message line. The result is
that pet swap is *silent*: no message line update, no prompt,
just the pet ending up where the player was and vice versa.

For an autopilot, this matters in two ways:

1. **Stepping onto a pet tile is safe.** The AP can route
   *through* a pet without halting. The current bobbihack
   pathfinder treats pet tiles as occupied (the pet's letter
   is in the rendered grid; the underlying terrain is recorded
   but the cell isn't walkable until the pet moves). To use
   pet-swap, the AP would need to treat pet-occupied tiles as
   walkable (with a small extra cost) and rely on the engine's
   silent swap.

2. **Detecting a pet vs. hostile is critical.** The
   `glyph-class.ts` classifier uses the `inverse: true`
   attribute (set by NetHack when `hilite_pet` is on) to
   distinguish pets from hostiles. Without the hilite, pets
   are indistinguishable from hostile dogs/cats — and stepping
   onto an unrecognized pet would mean the AP hits a `[yn]`
   confirm if the engine treats it as a peaceful, or a fight
   if hostile. The bobbihack `MSGTYPE=hide` rule does not
   apply to "Really attack?" prompts; only to silent
   displacement.

Implication: pet swap is the rare AP-positive case where the
right thing is to *not* refuse to step. The current AP refuses
because pets aren't tracked in the GameMap as walkable. The
spec's recommendation is to add a "pet tile" kind, plan
through it, and trust the engine's silent swap.

Source: NetHack Guidebook 5.0.0 §5.5 line 2627; §6.2 lines
2724–2746; example config line 6215.
