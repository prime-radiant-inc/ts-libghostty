---
title: "Map digits 1-5 are Warning-attribute hints of unseen monster severity"
source: "../sources/nethack-5-guidebook.md"
created: 2026-05-08
schema_version: 1
links: [letter-glyphs-are-classes-not-species]
---

# Map digits 1-5 are Warning-attribute hints of unseen monster severity

NetHack renders the digits `1` through `5` on map cells when the
player has the Warning intrinsic and a monster is present at that
cell but not visible. The digit's value encodes the monster's
threat tier — `1` is a minor unseen creature, `5` is a serious
threat. The Guidebook (§3.3) is explicit: "The digits 1 through
5 may be displayed, marking unseen monsters sensed via the
Warning attribute. Less dangerous monsters are indicated by
lower values, more dangerous by higher values."

These digits are *hostile-monster proximity hints* the engine
has rendered directly. They are not terrain. They are not
items. They are not part of the monster-class letter space. A
naive "digit on the map" classifier might miss this and treat
the cell as floor.

For an autopilot:

- A digit on the map should produce the same halt-or-detour
  signal as a visible monster letter — and possibly a stronger
  one for `4`–`5`, since those are explicitly higher-tier.
- The digit reveals the *cell* the monster occupies; the AP
  should not route adjacent to it (the unseen-but-warned monster
  may have a missile attack, breath weapon, or area effect).
- The digit's *cell location* is reliable — unlike `I`, which is
  a stale marker, the digit is the engine telling you "right now,
  there is an unseen creature in this exact cell". Warning
  refreshes per turn.

Source: NetHack Guidebook 5.0.0 §3.3 lines 622–625.
