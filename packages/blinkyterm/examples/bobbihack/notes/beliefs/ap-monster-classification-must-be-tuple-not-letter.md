---
title: "I commit to designing the autopilot's monster classification as a (letter, color, attrs, pet) tuple, not a letter-only mapping"
scope: personal
status: live
created: 2026-05-08
last_reviewed: 2026-05-08
falsifier: "A NetHack 5.0.0 production run where letter-only classification produces zero AP-relevant misclassifications across 100+ runs against varied floor types"
links: [ap-glyph-classifier-must-expose-letter-color-attrs-as-tuple, letter-glyphs-are-classes-not-species, monster-letter-color-attrs-is-the-load-bearing-classification-tuple]
schema_version: 1
---

# Why I hold this

I hold this because the Guidebook documents three distinct
classifying dimensions for monster glyphs — letter (class),
color (species and often peaceful/hostile), and SGR attributes
(pet via inverse) — and the bobbihack v1 classifier collapses
all three to either "letter null" (parsers.ts) or "pet binary"
(glyph-class.ts). Each collapse discards a load-bearing
signal that the autopilot's own decisions depend on.

The asymmetric cost makes the case sharper. Bumping a tile
that turns out to be hostile commits to combat without LLM
oversight; a misclassified peaceful is at best a modal halt
(if the AP catches the prompt before answering with the
collision-prone `y` key) and at worst a fatal alignment hit.
Carrying all three dimensions in the classification doesn't
require new engine knowledge — both color and attributes are
already in the FrameSnapshot's CellStyle, just unpicked.

What would change my mind: if a measurement run on the v1
letter-only classifier showed zero AP-relevant
misclassifications across enough varied floor exposure that the
remaining cases are negligible. Concretely, 100+ production
runs touching Mines:Town, the main dungeon early game, and
Sokoban-adjacent floors, with no class confusion that
materially altered AP decisions. I expect that measurement
will fail (will surface real misclassifications) — but if it
doesn't, the tuple-classifier is overengineering.

The opposite position — "letter alone is sufficient because
the conservative-treat-everything-as-hostile default already
prevents the dangerous case" — is coherent but doesn't survive
the modal-cost analysis. Conservative-on-letter still treats
pets as hostile until the inverse-attribute layer is consulted;
pretending color and attributes can stay outside the classifier
just relocates the work to ad-hoc post-processing in each
consumer.

# Revision log
## 2026-05-08 — created
After Spawned from NetHack Guidebook source extraction (2026-05-08). The Guidebook documents letter, color, and attribute as distinct dimensions; collapsing to letter alone discards the load-bearing pet/peaceful/species signal.: initial belief.
