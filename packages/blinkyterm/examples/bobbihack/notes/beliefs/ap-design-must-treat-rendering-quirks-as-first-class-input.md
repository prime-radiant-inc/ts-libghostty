---
title: "I commit to treating engine rendering quirks (engulfed 3x3, I markers, digit warnings, Rogue level glyphs) as first-class signals the AP must recognize, not edge cases to bolt on"
scope: personal
status: live
created: 2026-05-08
last_reviewed: 2026-05-08
falsifier: "An AP design that handles a representative sample of NetHack runs without explicit detectors for engulfed/I/Rogue and matches survival rates of an AP that does have them"
links: [engulfed-rendering-is-a-distinct-3x3-frame, rogue-level-uses-different-glyphs, unseen-monster-marker-i-persists-until-disproven]
schema_version: 1
---

# Why I hold this

I hold this because every "AP bug we've shipped" traces back
to a piece of NetHack rendering that the AP did not understand
as a special case. The engulfed-detection false-positive on
plain walls (commit `0b31893`); the BFS-routes-through-locked-
doors loop (commit `9e0944e`); the pet-bump-as-monster-visible
(addressed by commit `1269049`'s attribute-aware classifier).
Each was a missing-knowledge bug, not a coding bug. Each got
fixed by adding a specific detector for the specific
rendering.

The pattern argues for a design that *expects* there to be
rendering-quirk detectors and treats them as a first-class
layer of the AP architecture, not a sequence of patches. The
relevant catalog from the Guidebook + production logs:

- Engulfed 3×3 (not in Guidebook).
- `I` unseen-monster marker (Guidebook §3.3, §6.5).
- Digit `1`-`5` Warning glyphs (Guidebook §3.3).
- Rogue-level glyph swap (Guidebook §5.6).
- Sokoban diagonal restriction on neighboring boulders
  (Guidebook §5.2).
- Drawbridge state (open span = `.`, portcullis = `#`)
  (Guidebook §3.3).

Each needs an explicit detector + an AP rule for "what to do".
The architectural commitment is: future rendering quirks
encountered in production go in the same layer, not as ad-hoc
patches in autopilot.ts.

What would change my mind: an AP design that handles a
representative sample of runs (varied floors, varied
encounters) *without* explicit detectors for these quirks and
matches the survival rate of one that does. I expect that's
not achievable — the quirks are common enough that an AP
without them produces measurable bug-runs.

The opposite position — "patch on demand; engineering effort
is wasted on rare-case detectors" — is defensible if the rare
cases are truly rare. They aren't: engulfed, peaceful
shopkeepers, locked doors, and item piles all show up
multiple times per session on average.

# Revision log
## 2026-05-08 — created
After Spawned from NetHack Guidebook source extraction. Several production bugs traced to specific rendering quirks (false-positive engulfed on plain walls, missing I-marker handling).: initial belief.
