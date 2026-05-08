---
title: "The m-prefix on a movement key suppresses attack-on-bump and item-pickup"
source: "../sources/nethack-5-guidebook.md"
created: 2026-05-08
schema_version: 1
links: [ap-must-refuse-to-step-rather-than-halt-on-known-modal-tiles, bumping-a-monster-tile-is-the-attack-contract, paranoid-trap-prompt-blocks-known-trap-step, vi-key-prefixes-modify-bump-semantics]
---

# The m-prefix on a movement key suppresses attack-on-bump and item-pickup

The `m` prefix turns a movement key into "move without picking
up objects or fighting (even if you remember a monster there)"
(Guidebook §4 line 747). It is the dedicated keystroke for the
case where the player wants to *occupy* a tile that contains
something interactive without triggering the interaction.

The cases this is the right keystroke for:

- Stepping onto a peaceful monster's spot to swap with them
  (§5.5 line 2627: "The confirm and safe_pet options control
  what happens when you try to move onto a peaceful monster's
  spot or a tame one's spot"). Without `m`, the bump is treated
  as an attack and the engine prompts.
- Stepping onto a tile with a remembered-but-unseen monster
  marker `I` without committing to attack-into-empty-air.
- Stepping onto a known trap when `paranoid:trap` is enabled —
  the prefix bypasses the confirmation prompt (§options table:
  "confirmation can be skipped by using the `m` movement
  prefix").
- Stepping onto a water/lava tile when `paranoid:swim` is
  enabled and the agent has decided the immersion is intended
  (e.g. with levitation).
- Crossing a tile with a large item pile to leave inventory
  alone.

For autopilot use, `m` is the missing tool that converts several
"modal prompts the AP halts on" into "no prompt, deterministic
step". The current AP doesn't use `m` and pays the modal-prompt
cost every time. Adopting `m` for swap-with-pet, swap-with-
peaceful, and walk-onto-known-trap would eliminate those modal
halts.

The mode-keys behavior of `m` is two characters per move (the
prefix plus the direction), which roughly doubles the AP's
keystroke budget per stepped tile. This is acceptable.

Source: NetHack Guidebook 5.0.0 §4 lines 746–769; §options
paranoid_confirmation table line 4937.
