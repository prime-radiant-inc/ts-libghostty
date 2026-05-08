---
title: "A monster or item glyph above a tile must not overwrite the cached terrain underneath"
source: "../sources/nethack-5-guidebook.md"
created: 2026-05-08
schema_version: 1
links: [line-of-sight-determines-monster-rendering, terrain-glyph-overloading-requires-color-disambiguation]
---

# A monster or item glyph above a tile must not overwrite the cached terrain underneath

NetHack renders only the *topmost* layer of a cell. A monster
on a floor renders as the monster letter; an item on a floor
renders as the item glyph; an item beneath a monster renders
as the monster letter. The terrain below is the cell's
underlying type, which the engine remembers but does not
display while a transient (monster, item, player) is on top.

For a stateful map representation, this means: *do not
overwrite recorded terrain when the rendered glyph is a
transient*. If the AP saw a `.` (floor) at (5,7) on turn 100
and now (turn 105) sees a `d` at (5,7), the underlying terrain
is still floor — the dog is standing on it. Overwriting with
`unknown` or with the dog's class would lose the floor record
and force re-exploration to recover it.

The bobbihack `game-map.ts:updateFromFrame` already handles
this correctly: when `classifyGlyph(ch)` returns `null`
(transient glyph), the existing terrain entry is preserved and
only `lastSeenTurn` is updated. New transients on previously-
unseen tiles record a placeholder `kind: "unknown"`.

The corollary: when a monster moves off a tile, the next frame
shows the underlying terrain again. The AP does NOT need to
"re-confirm" the terrain on each frame; it stays cached until
the engine paints over it (level change, polymorph,
trap-revealed-as-`^`, drawbridge state change).

Source: NetHack Guidebook 5.0.0 §6.5 (Persistence of Monsters,
lines 2793–2807) — the engine drops monsters from the rendered
map but the underlying terrain persists; bobbihack
`game-map.ts:updateFromFrame` rationale.
