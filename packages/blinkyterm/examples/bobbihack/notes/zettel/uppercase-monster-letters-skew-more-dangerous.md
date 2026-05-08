---
title: "Uppercase monster letters (A-Z minus I) are biased toward higher danger than lowercase"
source: "../sources/nethack-5-guidebook.md"
created: 2026-05-08
schema_version: 1
links: [letter-glyphs-are-classes-not-species]
---

# Uppercase monster letters (A-Z minus I) are biased toward higher danger than lowercase

There is a soft (not absolute) correlation in NetHack between
uppercase monster letters and higher difficulty / depth of
generation:

- Lowercase letters tend to encode small or "lower-tier"
  classes: ant `a`, dog `d`, kobold `k`, rodent `r`, jelly
  `j`, leprechaun `l`, imp `i`.
- Uppercase tends to encode larger or higher-tier: dragon `D`,
  giant `H`, lich `L`, troll `T`, demon `&` (not a letter,
  but distinctive), Vampire `V`, Wraith `W`.

The correlation is documented obliquely in the Guidebook (§3.3
shows the `a-z` and `A-HJ-Z` ranges as both "monster letters"
without a difficulty label) and operationalized in
`MONSYM`/the per-species data as a per-class hit-die spread —
classes like `D` and `L` start their species at higher levels
than classes like `a` and `r`.

Counterexamples exist:
- `f` (cat/feline) lowercase but includes tiger and jaguar
  (mid-tier).
- `M` (mummy) uppercase but kobold mummies are weak.
- `q` (quadruped) lowercase but includes high-level
  rothes/triceratops.
- The Quest nemesis uses `@` (lowercase ASCII semantically),
  not an uppercase letter.

For an autopilot, the value of uppercase-as-heuristic is
limited but useful as a tie-breaker when full
letter→species→difficulty data is unavailable. A v1 danger
score: `is_uppercase ? 2 : 1`, refined by class-specific
adjustments (D, L, V, W, & all bump to a higher tier
regardless of case).

Source: NetHack Guidebook 5.0.0 §3.3; MONSYM enum
(`include/defsym.h`).
