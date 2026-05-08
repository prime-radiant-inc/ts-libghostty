---
title: "Bumping a locked door consumes a turn and prints \"The door is locked.\""
source: "../sources/nethack-5-guidebook.md"
created: 2026-05-08
schema_version: 1
links: [booby-trapped-doors-detonate-on-open-attempt, closed-doors-auto-open-on-bump-but-not-when-confused, silent-no-move-means-engine-refused]
---

# Bumping a locked door consumes a turn and prints "The door is locked."

A locked door (a closed `+` tile that is also locked) does not
auto-open on bump. The engine refuses the step, consumes a game
turn, and prints `"The door is locked."` (or in the autounlock-
prompt case, a `[yn]` to use a carried unlocking tool). See §5.1
lines 2347–2354.

The visible behavior to a polling observer is:
1. Send a movement key toward the locked door tile.
2. Player position does not change.
3. Message line shows the lock message.
4. The status line still updates (turn advanced).

The AP's prior bug (production run `bbh-20260508-203614` per
commit `9e0944e`) was that BFS-to-frontier kept routing through
the locked door tile, sending the same key 148+ times against
the same locked door, because the "visited" set was the AP's
only memory of "the engine refused this tile" — and BFS happily
expands through visited tiles. The fix introduced a separate
`blockedTiles` set, distinct from `visited`, that is checked in
both BFS expansion and frontier-target validity.

For the AP's design forward: "engine refused this tile this run"
is a first-class signal that pathfinding must respect, not a
side-effect of the visited set. The signal is detected by the
position-unchanged observation, not by parsing the message line
(though the message line is captured as a stop-reason detail
for legibility, per `withMessage` in `autopilot.ts`).

Booby-trapped doors are a related case: the bump-into-locked-
trapped-door can detonate the explosion. That's covered in a
separate zettel.

Source: NetHack Guidebook 5.0.0 §5.1 lines 2347–2360;
bobbihack `tools/autopilot.ts` `blockedTiles` rationale comment;
git commit `9e0944e`.
