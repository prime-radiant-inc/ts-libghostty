---
title: "Walking into a visible monster tile is treated as a melee attack by the engine"
source: "../sources/nethack-5-guidebook.md"
created: 2026-05-08
schema_version: 1
links: [ap-conservatism-on-unknown-letters-is-the-correct-default, f-prefix-forces-attack-on-empty-air, fighting-by-bumping-makes-letter-classification-safety-critical, m-prefix-disables-attack-and-pickup, peaceful-attack-prompt-is-yn-with-y-as-movement-key-collision, pet-displacement-is-silent-and-safe]
---

# Walking into a visible monster tile is treated as a melee attack by the engine

The Guidebook §6.1 line 2691: "If you see a monster and you
wish to fight it, just attempt to walk into it." This is the
universal melee-attack contract. There is no separate "attack"
keystroke for visible adjacent monsters — the standard
direction key, when it would step into a tile occupied by a
visible hostile, is the attack.

Three exceptions to "bump = attack":
- Peaceful monsters: bump triggers a confirmation prompt
  (§6.1, paranoid_confirmation:attack option).
- Tame monsters (pets): bump *displaces* (swaps positions)
  rather than attacking, when `safe_pet` option is on (default).
- The `m`-prefix on the same direction key suppresses the
  attack and *attempts to step* onto the tile (which fails for
  hostiles — they don't displace — but succeeds for pets and
  peacefuls without the confirm).

Implications for an autopilot:

1. Routing through a tile occupied by an *unidentified* letter
   glyph is unsafe — if it's hostile, the AP commits to combat
   without an LLM decision. This is the load-bearing reason the
   AP must classify monster glyphs (pet via inverse, peaceful
   via... currently nothing reliable, hostile by default).
2. The AP *cannot* simply route around all letter glyphs —
   pets must be displaced through, since the player's path may
   include a pet's position (the engine swaps).
3. The conservative AP (current bobbihack) treats every non-
   pet letter as hostile and aborts. This is correct-default
   but produces unnecessary modal halts on peacefuls.

Source: NetHack Guidebook 5.0.0 §6.1 lines 2689–2723.
