---
title: "Bumping a closed door auto-opens it unless the player is Conf, Stun, or Fumble"
source: "../sources/nethack-5-guidebook.md"
created: 2026-05-08
schema_version: 1
links: [locked-doors-consume-a-turn-and-print-engine-message, open-doors-block-diagonal-movement]
---

# Bumping a closed door auto-opens it unless the player is Conf, Stun, or Fumble

The `autoopen` option (default-on) makes a movement keystroke
into a closed-door tile (`+`) attempt to open the door without
needing the explicit `o` (open) command. The Guidebook §5.1
line 2336: "By default the autoopen option is enabled, so simply
attempting to walk onto a closed door's location will attempt to
open it without needing `o`."

But — line 2339: "Opening via autoopen will not work if you are
confused or stunned or suffer from the fumbling attribute."

Under any of those three conditions, the bump-into-closed-door
keystroke is consumed as a no-op (or possibly a different
unintended action — confusion can cause the engine to randomize
the direction). The AP's `monster_visible`-style detector for
the *condition transition* (Conf/Stun onset) catches the
*moment* the condition appeared, but the AP's planner does not
re-validate that a bump-into-door step is still safe to attempt
once a Conf/Stun condition is set.

For the AP's design: when the player has any of `Conf`, `Stun`,
or `Fumble` in the conditions list (parsed by `parseStatusLine`),
treat closed-door tiles as non-walkable for that step and replan
around them or halt. The AP already halts on Conf/Stun *onset*
via the interrupts; the additional rule is "a stable Conf/Stun
state should re-classify closed doors as a navigation obstacle".

Source: NetHack Guidebook 5.0.0 §5.1 lines 2336–2340.
