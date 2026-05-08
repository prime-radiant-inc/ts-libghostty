---
title: "Sokoban allows diagonal player movement but only cardinal boulder pushes"
source: "../sources/nethack-5-guidebook.md"
created: 2026-05-08
schema_version: 1
links: [dlvl-plus-branch-is-the-floor-identity, rogue-level-uses-different-glyphs]
---

# Sokoban allows diagonal player movement but only cardinal boulder pushes

Sokoban is a multi-level branch of the dungeon that contains
pre-mapped levels based on the box-pushing puzzle game. The
Guidebook §5.2 lines 2431–2468 describe the rules:

- The player can move diagonally (in NetHack, unlike the
  original Sokoban game).
- The player can push boulders in only the four cardinal
  directions.
- Diagonal player movement that would let you slip past two
  adjacent boulders is forbidden.
- Pushing a boulder into a pit or hole removes both the boulder
  and the trap.
- Non-Sokoban-conforming actions (destroying boulders, dropping
  inventory to squeeze past, creating new boulders) silently
  reduce luck.

For an autopilot, Sokoban requires planning that:
- Treats boulder positions as part of the puzzle state.
- Solves the puzzle (which is NP-hard in general).
- Does not produce luck-degrading actions.

The bobbihack AP refuses Sokoban floors entirely
(`floorRefusalReason` checks `floor.id.includes("Sokoban")`).
This is correct — Sokoban-solving is out of scope for v1.

Sokoban detection uses the entry message "Welcome to Sokoban!"
which the parsers.ts `BRANCH_PATTERNS` table catches.

Source: NetHack Guidebook 5.0.0 §5.2 lines 2431–2468;
bobbihack `parsers.ts:detectBranch`,
`tools/autopilot.ts:floorRefusalReason`.
