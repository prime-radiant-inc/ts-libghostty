---
title: "Monsters not in line-of-sight do not render; map memory is the agent's responsibility"
source: "../sources/nethack-5-guidebook.md"
created: 2026-05-08
schema_version: 1
links: [transient-glyphs-do-not-erase-recorded-terrain, unseen-monster-marker-i-persists-until-disproven]
---

# Monsters not in line-of-sight do not render; map memory is the agent's responsibility

The Guidebook §6 line 2671: "Monsters you cannot see are not
displayed on the screen." Combined with §6.5 (Persistence)
lines 2796–2799: "Monsters (a generic reference which also
includes humans and pets) are only shown while they can be seen
or otherwise sensed. Moving to a location where you can't see
or sense a monster any more will result in it disappearing from
your map, similarly if it is the one who moved rather than
you."

This means: a monster the player saw three turns ago at
position (X, Y) and that has since moved out of LOS is
*invisible* on the rendered grid this turn. The grid does not
preserve "I saw a monster here" — the only persistent marker is
the `I` glyph for unseen-but-known monsters (which fires only
in specific circumstances, not as a general "I saw it once").

For an autopilot:

- The AP cannot rely on the rendered grid to remember monster
  positions across turns. Each frame is fresh.
- The AP's stateful map (GameMap) records terrain only;
  monster positions are not retained.
- Monster appearance / disappearance is tracked frame-to-frame
  (the `monster_visible` interrupt fires on a letter at a
  position that didn't have one last frame).
- Disappearance is silent: a monster going out-of-sight does
  not raise an interrupt. The AP just sees fewer letters next
  frame.

Implication for danger-aware routing: the AP cannot route
"avoid the position where I saw a `d` two turns ago" — the
information is gone. The pathfinder consults the *current
frame's* monster positions only. This is consistent with
bobbihack's design.

A higher-fidelity AP could maintain a parallel "monster memory"
layer keyed by (last-seen-position, last-seen-turn) and decay
it over time, but the value is small for navigation — monsters
move, and stale positions are stale.

Source: NetHack Guidebook 5.0.0 §6 line 2671, §6.5 lines
2793–2807.
