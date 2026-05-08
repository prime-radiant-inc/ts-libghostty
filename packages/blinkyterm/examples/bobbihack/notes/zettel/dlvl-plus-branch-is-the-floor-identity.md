---
title: "A floor's identity is its (branch, dlvl) pair; branch transitions are message-driven"
source: "../sources/nethack-5-guidebook.md"
created: 2026-05-08
schema_version: 1
links: [rogue-level-uses-different-glyphs, sokoban-restricts-boulder-pushes-to-cardinals, status-line-bottom-row-hp-token-is-the-nethack-fingerprint]
---

# A floor's identity is its (branch, dlvl) pair; branch transitions are message-driven

A NetHack floor has identity `(branch, dungeon-level)`. The
branch is one of: main dungeon (default), Mines (Gnomish Mines),
Sokoban, Quest, plus single-floor branches like Bigroom,
Oracle, Castle, and Mines:Town. The dungeon-level (Dlvl) is
shown on the bottom status line as `Dlvl:N`.

Branch *transition* is detected by the engine printing a
distinctive entry message when the player descends into the
new branch. The Guidebook §5.3 line 2476: "fairly early in the
dungeon you will find a level with two down staircases, one
continuing into the dungeon and the other branching into an
area known as the Gnomish Mines." The transition message is
"You enter the Gnomish Mines." (parsed by `parsers.ts:detectBranch`).

For autopilot purposes:

- Floor identity is the (branch, Dlvl) pair, computed in
  `game-map.ts:#computeFloorId`. Same Dlvl in different
  branches is *different floors* (e.g. main D:3 ≠ Mines:3).
- The AP's per-floor terrain cache is keyed by floor identity,
  so re-visiting Mines:3 after exploring D:3 does not collide.
- Branch detection on entry is one-shot — the entry message
  appears once. The persistent state lives in
  `GameMap.#activeBranch`.
- The single-floor branches (Bigroom, Oracle, Castle, Mines:Town)
  use the branch label directly as the floor ID, since they
  exist at exactly one Dlvl.

The AP refuses to autopilot across floor boundaries (the floor
arg to `autopilot_to` must equal `map.current`). Crossing
floors is a deliberate `move(up)` or `move(down)` on stairs;
the AP doesn't compose that with general pathfinding.

Source: NetHack Guidebook 5.0.0 §5.3 lines 2470–2502;
bobbihack `parsers.ts:detectBranch`,
`game-map.ts:#computeFloorId`.
