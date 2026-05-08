---
title: "vi-key prefixes (m, F, g, G, _) modify bump-into-tile semantics"
source: "../sources/nethack-5-guidebook.md"
created: 2026-05-08
schema_version: 1
links: [f-prefix-forces-attack-on-empty-air, m-prefix-disables-attack-and-pickup]
---

# vi-key prefixes (m, F, g, G, _) modify bump-into-tile semantics

NetHack's eight movement keys (`yuhjklbn`) have several prefix
modifiers that change what happens when the chosen direction
ends in a non-empty tile. From §4 of the Guidebook:

- **No prefix.** Step one tile. If a visible monster is there,
  attack. If a closed door, autoopen-and-step. If an item pile,
  trigger autopickup (unless `autopickup` is off).
- **`m` prefix** (`m` then a direction). Step one tile *without*
  attacking and without pickup. Useful for stepping onto a
  peaceful or pet's spot. Also bypasses the `paranoid:trap` and
  `paranoid:swim` confirmations when adjacent to a known trap or
  water/lava.
- **`F` prefix** (`F` then a direction). Force attack into the
  direction, even if no visible monster is there — for stabbing
  at a remembered or guessed unseen monster.
- **`g` prefix** (`g` then a direction). Run until something
  interesting is encountered. Forks of corridors are
  "interesting".
- **`G` prefix** (`G` then a direction, or `Ctrl+`direction).
  Run, but corridor forks are not "interesting" — keep going
  through branches.
- **Uppercase direction letter** (`Y`, `K`, etc.) is equivalent
  to `g` + lowercase.
- **`_`** (travel command). The engine plans a shortest-path
  walk over already-discovered tiles to a chosen point, stopping
  on G-prefix conditions.

For an autopilot:

- The bobbihack AP only sends lowercase direction keys (no
  prefix). This means the AP attacks on bump (correct, defensive
  default) and triggers autopickup (correct for the game's
  conventions, but means stepping onto an item pile silently
  changes inventory).
- The AP could productively use `m` to swap with peacefuls or
  walk through pet tiles without prompts. The cost is one extra
  keystroke; the benefit is collapsing several modal-prompt
  branches into a deterministic move.
- The AP must NOT use `F` — that's the agent-as-aggressor case,
  which the AP is not authorized to commit to without an LLM
  decision.
- The AP must NOT use `g`/`G`/`_` — these compress many turns
  into one keystroke, which defeats the AP's per-step interrupt
  loop.

Source: NetHack Guidebook 5.0.0 §4 lines 717–818.
