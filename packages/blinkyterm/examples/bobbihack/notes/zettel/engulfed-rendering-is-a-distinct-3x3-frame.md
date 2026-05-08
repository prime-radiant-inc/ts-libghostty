---
title: "An engulfed player is rendered as a 3x3 box of slashes, dashes, and pipes around the @"
source: "../sources/nethack-5-guidebook.md"
created: 2026-05-08
schema_version: 1
links: [ap-design-must-treat-rendering-quirks-as-first-class-input, fighting-by-bumping-makes-letter-classification-safety-critical]
---

# An engulfed player is rendered as a 3x3 box of slashes, dashes, and pipes around the @

When the player is swallowed by an engulfing monster (a
trapper, lurker above, dragon, purple worm, or similar), the
on-map rendering changes to a distinctive 3×3 frame around the
player's `@`:

```
/-\
|@|
\-/
```

The diagonal corner glyphs `/` and `\` are the diagnostic — they
do not appear in regular dungeon wall rendering, so requiring
them at all four corners of the 3×3 cleanly distinguishes the
engulfed state from "@ adjacent to a horizontal wall on top".

This is not documented in the Guidebook; it had to be
reverse-engineered. The bobbihack `interrupts.ts:detectEngulfed`
implementation requires *all four* corner slashes (`/` at top-
left and bottom-right, `\` at top-right and bottom-left), plus
the cardinal `-` and `|` glyphs in the right positions, before
firing the `engulfed` interrupt. An earlier looser variant
(corners + cardinals) false-fired on plain walls per commit
`0b31893`.

For an autopilot:

- The engulfed state is non-trivial; the player can attack from
  inside (most monsters die in a few turns), pray (resurrects
  out of digestion), or use a teleport scroll. None of these
  are autopilot decisions — engulfment halts via the `engulfed`
  interrupt and the LLM takes over.
- The engulfed renderer overrides the entire visible map. The
  AP must NOT update the GameMap from an engulfed frame — the
  3×3 frame would corrupt the recorded terrain around the
  player.
- The detection is purely by glyph shape. No engine message is
  required; it works even if the player is blind.

Source: bobbihack `interrupts.ts:detectEngulfed`; commit
`0b31893` rationale comment; reverse-engineered from production
runs (Guidebook does not document engulfment rendering).
