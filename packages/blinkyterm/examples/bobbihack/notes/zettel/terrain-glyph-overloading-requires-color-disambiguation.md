---
title: "Default ASCII glyphs are overloaded; disambiguation requires color or context"
source: "../sources/nethack-5-guidebook.md"
created: 2026-05-08
schema_version: 1
links: [ap-glyph-classifier-must-expose-letter-color-attrs-as-tuple, corridor-pound-glyph-overloads-trees-iron-bars-engravings, monster-letter-color-attrs-is-the-load-bearing-classification-tuple, transient-glyphs-do-not-erase-recorded-terrain]
---

# Default ASCII glyphs are overloaded; disambiguation requires color or context

The default monochrome NetHack tileset reuses single ASCII characters
for multiple semantically distinct things. From the symbol table in
§3.3 of the Guidebook:

- `-` is a horizontal wall, an east-west open door, *or* the corner
  of a room.
- `|` is a vertical wall, a north-south open door, *or* a grave.
- `.` is room floor, ice, a doorless doorway, *or* the span of an
  open drawbridge.
- `#` is a corridor, iron bars, a tree, a closed-drawbridge
  portcullis, *or* a colored engraving.
- `{` is a fountain *or* a sink.
- `}` is a pool of water, a moat, a wall of water, a pool of lava,
  *or* a wall of lava.
- `_` is an altar *or* an iron chain.

Disambiguation requires color (lava is red `}`, water is blue `}`)
or spatial context (a `.` flanked by walls in a 3×3 cell is room
floor; a `.` between two `|` glyphs is a doorless doorway). The
Guidebook does not commit to specific color values; the source
file `include/color.h` enumerates the 16 CLR_* constants but the
actual mapping (lava → CLR_RED) lives in symbol-class metadata.

For an autopilot, the load-bearing case is `}` lava-vs-water:
both are non-walkable in the existing GameMap, so the
overloading is benign there. The dangerous case is `_` altar
(walkable, valuable) versus iron chain (rare; ignore). The
trivial case is `-`/`|` wall versus open-door, where context
(adjacency to a `+` or `'`) resolves it.

Source: NetHack Guidebook 5.0.0 §3.3, lines 519–605.

## Misreading to watch for

| Excuse | Reality |
|---|---|
| "I'll just use a single TileKind per glyph; the table fits" | The table has known overloads. A `}` classified as `water` is correct only because both meanings are non-walkable; for `_` the AP needs the altar/chain distinction the moment it tries to use altar features. |
| "Color is a presentation concern, not part of classification" | For NetHack, color is the only way to recover the disambiguating bit for `}` and `^` and several monster letters. It must enter the classifier. |
