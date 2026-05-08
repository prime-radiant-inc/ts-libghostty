---
title: "Unknown traps render as floor; only triggered or searched traps appear as ^"
source: "../sources/nethack-5-guidebook.md"
created: 2026-05-08
schema_version: 1
links: [paranoid-trap-prompt-blocks-known-trap-step, search-command-is-the-only-way-to-reveal-secret-features]
---

# Unknown traps render as floor; only triggered or searched traps appear as ^

The `^` glyph appears on the map only after the player has
discovered a trap by triggering it, watching another creature
trigger it, finding it via the `s` (search) command, or
revealing it via wand of secret-door-detection or
detect-unseen. The Guidebook §5.2 lines 2396–2403:

> A trap usually won't appear on your map until you trigger it
> by moving onto it, you see someone else trigger it, or you
> discover it with the `s' (search) command (multiple attempts
> are often needed; if your luck is poor, many attempts might be
> needed). Wands of secret door detection and spell of detect
> unseen also reveal traps within a modest radius but only if
> the trap is also within line-of-sight.

The corollary the Guidebook does not state explicitly: an
*undiscovered* trap is rendered as the underlying terrain
(floor `.` or corridor `#`), not as a special "trap may be
here" hint. The map gives no warning. The player walks onto
the trap, the engine prints "There is a NN trap here.", and
the trap fires.

For an autopilot:

1. The AP cannot avoid undiscovered traps. Routing across `.`
   tiles in unexplored corridors is inherently risky; the AP's
   choice is between risk-of-trap (cheap, fast) and search-every-
   step (slow, conservative).
2. Once a trap is discovered (`^` rendered), the AP correctly
   classifies it as `trap_known` and refuses to route through.
   The `entered_trap_tile` interrupt fires if the player ends
   up on a `trap_known` tile (e.g. after polymorph, teleport,
   or the trap was just discovered by stepping onto it).
3. A trap that is discovered mid-traversal — i.e. the AP steps
   onto an unknown trap, the engine reveals it as `^`, and the
   AP detects this on the next frame — should produce a halt,
   not "well, we triggered it, keep going". The current AP
   handles this via the trap-protection check in
   `tools/autopilot.ts` lines 215–220.

Source: NetHack Guidebook 5.0.0 §5.2 lines 2392–2403.
