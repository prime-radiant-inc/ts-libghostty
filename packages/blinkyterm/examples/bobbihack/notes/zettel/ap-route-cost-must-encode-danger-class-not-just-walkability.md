---
title: "A* tile cost must reflect adjacency danger, not just walkable/unwalkable"
source: "../sources/nethack-5-guidebook.md"
created: 2026-05-08
schema_version: 1
links: [ap-glyph-classifier-must-expose-letter-color-attrs-as-tuple, dragons-and-demons-are-class-level-danger-flags, fighting-by-bumping-makes-letter-classification-safety-critical]
---

# A* tile cost must reflect adjacency danger, not just walkable/unwalkable

The bobbihack v1 pathfinder (`game-map.ts:pathfind`) uses a
binary walkability model: a tile is `yes`, `no`, or
`by_inference`. Within "yes", the only cost variation is
`tileCost = tile.kind === "door_closed" ? 1.5 : 1` — a small
preference for already-open doors. There is no concept of
*danger* in the cost.

This produces correct shortest paths but routes the player
adjacent to dangerous monsters when adjacency is on the
shortest path. A `D` two tiles north of the player and one
tile east of the goal is treated as if it weren't there.

For an AP that's aware of monster classification, route cost
should reflect adjacency danger:

- A tile adjacent to a high-danger monster (`D`, `L`, `V`,
  `&`, `W`) should have a high cost, e.g. +20.
- A tile adjacent to a generic hostile monster letter should
  have a moderate cost, e.g. +5.
- A tile adjacent to a peaceful (when classified) should have
  a small cost, e.g. +2 (might step onto, prefer not to).
- The player's *current* tile is excluded from these
  calculations — danger is about *future* tiles in the path.

This makes the pathfinder do *partial threat avoidance* — a
detour costs N extra steps; if the danger penalty exceeds N,
the detour wins. The AP gets paths that are slightly longer but
preserve safety margins.

Implementation note: this requires the pathfinder to consult
the classified-cell tuple (per the
`ap-glyph-classifier-must-expose-letter-color-attrs-as-tuple`
zettel) for monster positions in the current frame, not just
the GameMap's terrain layer. Monsters move, so the cost is
"current frame" not "stored from earlier".

Source: bobbihack `game-map.ts:pathfind`; the recommendation is
new — not in the existing code or in the Guidebook; derived
from the bump-to-attack contract (§6.1) plus the danger-class
flags (zettel `dragons-and-demons-are-class-level-danger-flags`).
