---
title: "Open and closed doors block all diagonal movement to/from their tile"
source: "../sources/nethack-5-guidebook.md"
created: 2026-05-08
schema_version: 1
links: [closed-doors-auto-open-on-bump-but-not-when-confused]
---

# Open and closed doors block all diagonal movement to/from their tile

A door tile (open `'`, closed `+`, or in the special east-west
`-` / north-south `|` open-door rendering) refuses diagonal
entry and diagonal exit. The Guidebook §5.1 lines 2342–2345:
"Open doors cannot be entered diagonally; you must approach them
straight on, horizontally or vertically. Doorways without doors
are not restricted in this fashion except on one particular
level (described by '#overview' as 'a primitive area')."

The "primitive area" exception is the Rogue level (§5.6), where
all doorways are doorless and so are not subject to the
restriction.

For the bobbihack AP, this rule is already enforced in
`game-map.ts:diagonalAllowed` and the autopilot's
`diagonalAllowed` mirror in `tools/autopilot.ts`. The rule is
symmetric (no diagonal IN, no diagonal OUT) and applies to *both*
endpoints of a candidate diagonal step — if either the origin
or the target is a door tile, the diagonal is refused.

The closed-door case combines with autoopen: a diagonal step
into a closed door tile is refused even though a cardinal step
into the same closed-door tile would auto-open and step. The AP
must plan around this — pathfinding cannot use a diagonal step
to "open" a door.

Source: NetHack Guidebook 5.0.0 §5.1 lines 2342–2345.
