---
title: "paranoid_confirmation:trap (default-on) requires y to step onto a known trap"
source: "../sources/nethack-5-guidebook.md"
created: 2026-05-08
schema_version: 1
links: [ap-must-refuse-to-step-rather-than-halt-on-known-modal-tiles, m-prefix-disables-attack-and-pickup, modal-prompt-grammar-has-a-finite-shape-catalog, paranoid-swim-prevents-water-lava-step-without-m-prefix, unknown-traps-render-as-floor]
---

# paranoid_confirmation:trap (default-on) requires y to step onto a known trap

The `paranoid_confirmation:trap` option (Guidebook §options
table) is on by default. It causes the engine to prompt with a
`[yn]`-style confirmation ("Step into the NN trap? [yn]")
whenever the player tries to move onto a known-trap tile,
unless the trap is harmless or the player uses the `m` prefix to
explicitly request the step.

The Guidebook (line 4931): "trap - require `y' to confirm an
attempt to move into or onto a known trap, unless doing so is
considered to be harmless; when enabled, this confirmation is
also used for moving into visible gas cloud regions; (to require
'yes' rather than just `y', set Confirm too); confirmation can
be skipped by using the `m' movement prefix."

Three implications for an autopilot:

1. The default of "paranoid_confirmation:pray swim trap" means
   the AP can rely on the trap-prompt firing whenever it
   accidentally tries to step onto a known trap. This is a
   safety net, but only if the AP's modal-prompt detector
   recognizes the prompt shape.
2. The AP can use `m`+direction to bypass the prompt when it
   *intends* to step onto a known trap (e.g. teleporter trap
   used as a level-skip). This is rare but worth supporting.
3. The "harmless trap" exception (e.g. squeaky board) means the
   prompt does not fire universally. The AP cannot rely on
   "every step toward `^` is preceded by a prompt".

The bobbihack AP currently classifies `trap_known` as
non-walkable, sidestepping the prompt entirely. This is the
correct conservative default; the `m`-prefix bypass only
matters once an LLM-driven plan has decided to traverse a
specific trap deliberately.

Source: NetHack Guidebook 5.0.0 §options table line 4931.
