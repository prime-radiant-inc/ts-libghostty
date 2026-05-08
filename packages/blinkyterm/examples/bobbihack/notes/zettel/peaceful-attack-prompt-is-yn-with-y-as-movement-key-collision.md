---
title: "Attack-peaceful prompt is [yn] and the y answer collides with NW-movement key"
source: "../sources/nethack-5-guidebook.md"
created: 2026-05-08
schema_version: 1
links: [ap-must-refuse-to-step-rather-than-halt-on-known-modal-tiles, bumping-a-monster-tile-is-the-attack-contract, modal-prompt-grammar-has-a-finite-shape-catalog]
---

# Attack-peaceful prompt is [yn] and the y answer collides with NW-movement key

When the player bumps into a peaceful (non-hostile, non-pet)
monster, the engine prompts: "Really attack the X? [yn]"
(or with `paranoid_confirmation:attack` set, requires typing
`yes` rather than just `y`).

The Guidebook §6.1 lines 2696–2701 explicitly warns about the
`y` collision: "By default an answer of `y' acknowledges that
intent, which can be error prone if you're using `y' to move.
You can set the paranoid_confirmation:attack option to require
a response of 'yes' instead."

The `y` collision is the load-bearing failure mode for an
autopilot:
- The AP's vi-key keymap uses `y` for NW-direction movement.
- If the AP issues `y` (NW) and a peaceful was diagonally
  northwest, the engine prompts "Really attack? [yn]" — which
  the AP halts on.
- If the AP, on resumption, sends another `y` to retry the
  movement, it answers `yes` to the prompt and the player
  attacks the peaceful, going hostile, often fatally.

The AP avoids this in two ways:
1. The `modal_prompt` interrupt halts on detection, surfacing
   the prompt to the LLM. As long as the LLM is aware of the
   `y`/yes collision, it sends a non-y response.
2. Better: refuse to step onto a peaceful tile in the first
   place. This requires *classifying* peacefuls — which
   NetHack 5.0.0 does not currently expose via a hilite (the
   `hilite_peaceful` option is rejected). Color is the only
   signal: peaceful humans render in a different color from
   hostile humans (and shopkeepers/priests have unique colors).

For an AP-aware design, the right shape is: detect
shopkeeper/priest/Oracle tiles via color and refuse routing
through them. For generic peacefuls, the AP will continue to
hit the modal-prompt halt, which is acceptable.

Source: NetHack Guidebook 5.0.0 §6.1 lines 2696–2713;
§options paranoid_confirmation:attack line 4920.
