---
title: "Booby-trapped doors detonate on open/unlock/kick attempts"
source: "../sources/nethack-5-guidebook.md"
created: 2026-05-08
schema_version: 1
links: [locked-doors-consume-a-turn-and-print-engine-message]
---

# Booby-trapped doors detonate on open/unlock/kick attempts

Some closed doors in the dungeon are booby-trapped. The
Guidebook §5.1 lines 2357–2360: "Some closed doors are booby-
trapped and will explode if an attempt is made to open (when
unlocked) or unlock (when locked) or kick down."

Trigger conditions:
- Bump-via-autoopen on an unlocked-but-trapped door.
- Apply unlocking tool to a locked-and-trapped door.
- Kick (`^D`) on any closed-and-trapped door.

The trap is invisible until the door is interacted with; the
engine offers `#untrap` (multi-attempt) to discover and disarm
before the interaction commits.

Booby-trapped doors are rare and primarily a late-game concern.
For the bobbihack AP, the practical implication is small: the
AP only bumps doors (autoopen path), and the trap detonates
*on bump*, doing damage to the player. There is no
pre-detonation signal — the door's tile rendering is identical
to a normal closed door.

Mitigation:
- The AP's `hp_drop` interrupt fires when HP decreases between
  frames, which catches the post-detonation HP loss.
- The AP cannot prevent the first detonation. The right design
  choice is: accept that the AP can detonate one trap per run,
  halt on `hp_drop`, and surface to the LLM agent.
- A more conservative AP could apply `#untrap` to every closed
  door before bumping, but that adds many turns per door for a
  rare case; not worth it.

Source: NetHack Guidebook 5.0.0 §5.1 lines 2357–2365.
