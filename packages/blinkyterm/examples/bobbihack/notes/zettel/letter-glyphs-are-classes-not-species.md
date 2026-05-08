---
title: "A monster letter denotes a class of ~5-15 species, not one specific monster"
source: "../sources/nethack-5-guidebook.md"
created: 2026-05-08
schema_version: 1
links: [ap-glyph-classifier-must-expose-letter-color-attrs-as-tuple, ap-monster-classification-must-be-tuple-not-letter, digits-1-5-are-warning-signals-of-unseen-danger, dragons-and-demons-are-class-level-danger-flags, fighting-by-bumping-makes-letter-classification-safety-critical, i-glyph-is-unseen-monster-marker-not-a-class, monster-letter-color-attrs-is-the-load-bearing-classification-tuple, uppercase-monster-letters-skew-more-dangerous]
---

# A monster letter denotes a class of ~5-15 species, not one specific monster

Each ASCII letter in NetHack maps to a *class* of monsters with
shared shape and broadly shared attack pattern, not to one species.
The canonical class table is the `MONSYM(idx, ch, basename, sym,
desc)` enum in `include/defsym.h`:

- `a` ant or other insect
- `d` dog or other canine — pet starting dog, hostile jackal,
  warg, hellhound; eight species share this letter
- `D` dragon — five chromatic + five metallic, plus baby variants
- `f` cat or other feline — pet kitten, housecat, large cat,
  panther, tiger, jaguar
- `&` major demon
- `@` human or elf — including the player, shopkeepers, priests,
  the Oracle
- `;` sea monster (eel)
- `'` golem
- `~` long worm tail (special: a long worm renders as `w` head +
  `~` tail segments)

The full table covers 60 classes (52 letters minus `I` reserved,
plus `@`, `&`, `'`, `:`, `;`, `~`, `]`). Within a class, the
species can range from harmless (a `d` jackal at low XP) to
lethal (a `d` warg at higher XP); the class is the *shape* hint,
color is the *species* hint, and the player's experience level
determines what the encounter actually means.

For an autopilot, the practical consequence is that a letter
alone is insufficient classification. A `d` adjacent to the
player could be the starting pet (trivially safe — `inverse`
attribute confirms), a peaceful jackal (safe to step around,
fatal-easy to bump), or a hostile warg (combat-level decision).
The agent's existing `monster_visible` interrupt fires on any
non-pet letter, which is correct for the conservative case but
discards the class-level danger signal that `D`/`L`/`&` carry.

Source: NetHack Guidebook 5.0.0 §3.3 line 608 ("a-z and A-HJ-Z
and @&':;"); MONSYM enum in
`include/defsym.h` from the NetHack 5.0 source tree.
