---
title: "The classes D (dragon), L (lich), V (vampire), &  (demon), W (wraith) are class-level danger flags"
source: "../sources/nethack-5-guidebook.md"
created: 2026-05-08
schema_version: 1
links: [ap-route-cost-must-encode-danger-class-not-just-walkability, letter-glyphs-are-classes-not-species]
---

# The classes D (dragon), L (lich), V (vampire), &  (demon), W (wraith) are class-level danger flags

A small subset of monster classes encode a class-level danger
signal that warrants a hard-stop AP halt regardless of
character experience level:

- **`D` dragon** (MONSYM 30). Five chromatic + five metallic +
  baby variants. All have breath weapons. Adult dragons hit
  hard in melee and a single breath attack can erase a low-
  level character.
- **`L` lich** (MONSYM 38). Spellcasters with cold/death magic.
  Master/arch-liches use level-drain.
- **`V` vampire** (MONSYM 48). Level-drain in melee.
- **`&` major demon** (MONSYM 56, special character not
  letter). Includes balrogs, Asmodeus, Demogorgon, etc. Often
  spell-resistant; some have summoning attacks.
- **`W` wraith** (MONSYM 49). Level-drain in melee. A wraith
  hit from a mid-game player is recoverable; a barrow wight
  on a low-level character can chain-drain to negative XP.
- **`H` giant** (MONSYM 34). Hill giants and up are mostly a
  HP-bag concern; the danger is concentrated in stone giants
  and storm giants (boulder-throwing).
- **`Z` zombie** (MONSYM 52) — mostly low-tier but ghouls and
  some zombie variants are nasty.
- **`T` troll** (MONSYM 46). Regenerates HP including from
  death — leaving a troll corpse near you means it gets up.

These flags exist *across colors* — every `D` is dangerous, no
matter the color (the color tells you *which* dragon). A v1 AP
danger model should treat the class itself as the dominant
factor and color as a tie-breaker.

For the AP design: when the classifier returns `monster.class
∈ {dragon, lich, vampire, demon, wraith}` and the monster is
within 2 tiles, halt the autopilot. Adjacency to a `D` should
be a higher-priority interrupt than adjacency to a `d`.

Source: NetHack Guidebook 5.0.0 §3.3 (letters represent
monsters); MONSYM enum (`include/defsym.h`); per-species
attack data in `monst.c` (out-of-Guidebook).
