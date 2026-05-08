---
title: "The autopilot's per-cell classifier must expose (terrain, letter-class, color, inverse) as a tuple"
source: "../sources/nethack-5-guidebook.md"
created: 2026-05-08
schema_version: 1
links: [ap-monster-classification-must-be-tuple-not-letter, ap-route-cost-must-encode-danger-class-not-just-walkability, letter-glyphs-are-classes-not-species, monster-letter-color-attrs-is-the-load-bearing-classification-tuple, terrain-glyph-overloading-requires-color-disambiguation]
---

# The autopilot's per-cell classifier must expose (terrain, letter-class, color, inverse) as a tuple

The bobbihack v1 cell classification splits across two
functions:

- `parsers.ts:classifyGlyph(char): TileKind | null` — terrain
  only. Returns `null` for any letter, item, or transient
  glyph.
- `glyph-class.ts:classifyCell(text, style): GlyphClass |
  undefined` — pet-vs-normal binary, only for letter and `@`
  glyphs.

Neither captures the full information the AP needs to make
routing decisions. A v2 classifier should expose a single tuple
per cell:

```ts
interface ClassifiedCell {
  // Terrain layer (always populated for a known cell).
  terrain: TileKind | null;
  // Foreground glyph layer (null when no transient there).
  foreground: {
    glyph: string;             // 'd', '@', '?', '!'…
    kind: 'monster' | 'item' | 'player' | 'unseen' | 'warning';
    monsterClass?: MonsterClass;   // populated when kind='monster'
    color: number;             // 0-15 from CLR_*
    inverse: boolean;          // pet hint (when kind='monster')
    bold?: boolean;
  } | null;
}
```

The classifier consumes a `FrameSnapshot` cell — which gives
both the text and the SGR style — and produces this tuple per
position. The pathfinder consumes the tuple to decide
walkability and danger weight; the interrupt detector consumes
the tuple to decide halt-or-not on monster appearance.

Why a single tuple rather than parallel grids:

- Atomic update — the classifier walks the screen once.
- Co-located reasoning — pet-detection, danger-class, peaceful-
  inference, and item-presence all need the same cell context;
  splitting them into parallel grids forces the consumer to
  re-correlate by (x, y).
- Future-proof — adding new fields (e.g. `peaceful: boolean`
  once we figure out a reliable signal) doesn't require new
  parallel grids.

Implementation note: the existing `glyph-class.ts:buildGlyphClass`
already walks the rows and consults `snapshot.cellAt(x, y)` for
the style. The v2 work is to broaden the return type, fold in
the terrain layer, and surface the classified tuple to GameMap
and to the interrupt detectors.

Source: bobbihack `parsers.ts:classifyGlyph`,
`glyph-class.ts:classifyCell`, `game-map.ts:updateFromFrame`.
