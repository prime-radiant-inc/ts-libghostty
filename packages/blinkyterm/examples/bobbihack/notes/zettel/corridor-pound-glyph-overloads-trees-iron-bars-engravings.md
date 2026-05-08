---
title: "The # glyph means corridor, tree, iron bars, drawbridge portcullis, or engraving"
source: "../sources/nethack-5-guidebook.md"
created: 2026-05-08
schema_version: 1
links: [terrain-glyph-overloading-requires-color-disambiguation]
---

# The # glyph means corridor, tree, iron bars, drawbridge portcullis, or engraving

From the Guidebook §3.3 lines 541–545:

> # A corridor, or iron bars, or a tree, or the portcullis of a
>   closed drawbridge.
>
>   Note: engravings in corridors also appear as # but are shown
>   in a different color from normal corridor locations.

Five distinct meanings for one ASCII character. The AP-relevant
distinctions:

- **Corridor (default)** — walkable, low-danger.
- **Tree** — non-walkable. Color often green.
- **Iron bars** — non-walkable, may be passable for incorporeal
  forms. Color often cyan.
- **Drawbridge portcullis** — non-walkable when the drawbridge
  is closed; transitions to walkable when opened. Rare; only
  in the Castle and Mines:Town.
- **Engraving in corridor** — walkable; the underlying tile is
  corridor. Distinguished by a different color (typically more
  yellowish or saturated).

The bobbihack v1 collapses all `#` to `corridor`, walkable.
This is wrong for tree and iron bars — but in practice, those
appear primarily in special floors (Castle, some Mines variants)
that the AP either avoids or where the player is unlikely to
trip on the misclassification.

The right v2 behavior:

- Use color as the disambiguating signal (`CLR_GREEN` →
  tree, `CLR_CYAN` → iron bars, default → corridor).
- Add `tree` and `iron_bars` to the `TileKind` union (already
  partially there: `tree` exists).
- Treat both as non-walkable.
- Continue to treat colored engravings as walkable corridors.

Source: NetHack Guidebook 5.0.0 §3.3 lines 541–545.
