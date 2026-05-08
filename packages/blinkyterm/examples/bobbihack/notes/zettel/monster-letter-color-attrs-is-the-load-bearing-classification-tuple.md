---
title: "A useful monster classification needs the (letter, color, attrs) triple, not the letter alone"
source: "../sources/nethack-5-guidebook.md"
created: 2026-05-08
schema_version: 1
links: [ap-glyph-classifier-must-expose-letter-color-attrs-as-tuple, ap-monster-classification-must-be-tuple-not-letter, letter-glyphs-are-classes-not-species, terrain-glyph-overloading-requires-color-disambiguation]
---

# A useful monster classification needs the (letter, color, attrs) triple, not the letter alone

A NetHack monster cell carries information across three
dimensions:

1. **Letter (class)** — the ASCII character. Maps to one of 60
   monster classes via `defsym.h`'s MONSYM enum.
2. **Color** — one of 16 CLR_* values from `include/color.h`
   (BLACK, RED, GREEN, BROWN, BLUE, MAGENTA, CYAN, GRAY, ORANGE,
   BRIGHT_GREEN, YELLOW, BRIGHT_BLUE, BRIGHT_MAGENTA,
   BRIGHT_CYAN, WHITE, MAX). Color disambiguates *species*
   within a class: red `D` is a red dragon, green `D` is a
   green dragon. Color also flags peaceful vs. hostile in some
   classes (a peaceful elf renders in a different color from a
   hostile elf, though the encoding is per-port).
3. **Attributes** — terminal SGR attributes carried by the
   cell. The relevant ones for AP design are:
   - `inverse: true` — pet (NetHack 5.0.0 with `hilite_pet` /
     `petattr:inverse`).
   - `bold` — sometimes uniques (Croesus, Wizard of Yendor,
     etc.) render with bold; not standard.
   - `blink` — used for some hitpoint-bar warnings; not for
     monsters.

The Guidebook describes each dimension separately but does not
present them as a tuple. The MONSYM enum gives the letters
without per-species color; `monst.c` (not in Guidebook scope)
has the per-species color. The `hilite_pet` / `petattr` options
introduce the attribute layer.

For autopilot design, the load-bearing claim is: classification
on letter alone is *underdetermined*. A `D` is dangerous; the
AP should know that. But the AP also needs to know color, both
because color disambiguates pet from hostile and because color
is the only "peaceful" hint NetHack 5.0.0 exposes.

The bobbihack v1 classifier (`classifyGlyph` in `parsers.ts`)
returns `TileKind` for terrain only, returning `null` for any
letter glyph. The pet-detection layer (`glyph-class.ts`) adds
the inverse-attribute check but only as a binary `pet` /
`normal` distinction. Neither layer captures color.

The recommended v2 shape:

```ts
interface CellClassification {
  terrain: TileKind | null;
  monster: {
    letter: string;
    class: MonsterClass;     // 'dog', 'dragon', etc.
    color: number;           // CLR_* value
    pet: boolean;            // from inverse attr
  } | null;
  // Item glyphs intentionally not modeled here yet.
}
```

This is the tuple every load-bearing AP decision (route around,
swap with, refuse to step) reads.

Source: NetHack Guidebook 5.0.0 §3.3, §6 (monsters);
`include/defsym.h` MONSYM enum; `include/color.h` CLR_*
constants; `include/options` (hilite_pet/petattr);
bobbihack `glyph-class.ts:classifyCell`.
