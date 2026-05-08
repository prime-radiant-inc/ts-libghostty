---
title: "The Rogue level uses % for stairs and * for gold; map parsers must refuse it"
source: "../sources/nethack-5-guidebook.md"
created: 2026-05-08
schema_version: 1
links: [ap-design-must-treat-rendering-quirks-as-first-class-input, dlvl-plus-branch-is-the-floor-identity, sokoban-restricts-boulder-pushes-to-cardinals]
---

# The Rogue level uses % for stairs and * for gold; map parsers must refuse it

One dungeon level (Guidebook §5.6, "occurring in mid to late
teens of the main dungeon") is the Rogue level, a tribute to
the original Rogue. Its glyph rendering deviates from the
standard NetHack mapping in several ways:

- Stairs `<` and `>` are rendered as `%`.
- Gold `$` is rendered as `*`.
- Doorways do not have doors (so the diagonal-doorway
  restriction does not apply).
- Optionally rendered without line-drawing wall characters.
- A scroll/wand/spell of light lights the whole room rather
  than a radius.
- Lower-case letters are not randomly generated as monsters.

The level is auto-detected via the message "You enter what
seems to be an older, more primitive world." (Guidebook §5.6
line 2666; bobbihack `parsers.ts:detectRogueLevel`).

The bobbihack AP refuses to plan on the Rogue level
(`floorRefusalReason` in `tools/autopilot.ts`). This is
correct: the standard glyph table doesn't apply, and the AP's
classifier would misclassify `%` as food (an item-class
glyph) and `*` as a gem.

The right design choice for an AP-aware system is *not* to
build a parallel Rogue-glyph classifier; the level is a one-
off and the LLM can navigate it manually. The AP's job is to
refuse-and-flag.

Source: NetHack Guidebook 5.0.0 §5.6 lines 2653–2667;
bobbihack `parsers.ts:detectRogueLevel`.
