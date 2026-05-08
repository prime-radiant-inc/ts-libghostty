---
title: "Because all melee is bump-driven, a wrong monster classification produces a fatal-easy step"
source: "../sources/nethack-5-guidebook.md"
created: 2026-05-08
schema_version: 1
links: [ap-conservatism-on-unknown-letters-is-the-correct-default, ap-route-cost-must-encode-danger-class-not-just-walkability, bumping-a-monster-tile-is-the-attack-contract, engulfed-rendering-is-a-distinct-3x3-frame, letter-glyphs-are-classes-not-species]
---

# Because all melee is bump-driven, a wrong monster classification produces a fatal-easy step

The interaction model NetHack uses for melee combat is
extraordinarily tight: a single keystroke (any of `yuhjklbn`)
into a tile occupied by a visible monster is the attack. There
is no separate "draw weapon" or "engage" phase; the engine
treats movement-into-occupied as combat-into-occupied.

This makes monster classification *safety-critical* for an
autopilot. A misclassification — any letter glyph that the
classifier thinks is "safe to step onto" but is actually
hostile — produces a step that *commits* the player to combat
without the LLM agent's input.

The asymmetry of error costs:

- **False positive (think hostile, actually peaceful)**: AP
  refuses to step. Cost: replan, possibly suboptimal route. No
  damage.
- **False negative (think safe, actually hostile)**: AP steps
  in, attacks. Cost: turn lost, possibly fatal HP loss, peaceful
  status of the world possibly changed (alignment hits if the
  attacked monster was a coaligned one).

The asymmetry argues for a *conservative classifier*: when in
doubt, classify as hostile and refuse to step. The bobbihack v1
already implements this — the `monster_visible` interrupt
treats every non-pet letter as hostile.

The cost of conservatism: every peaceful (shopkeeper, priest,
Oracle, generic peaceful elf/dwarf) becomes a hard halt with
LLM intervention required. If peacefuls are common (early-game
Mines, towns), this is many halts per run.

The right design balance: stay conservative on letter alone,
but allow specific *patterns* (color-flagged shopkeepers, color-
flagged priests, the `@` Oracle) to be classified as
known-peaceful and safe-to-route-around (not safe-to-step-onto).

Source: NetHack Guidebook 5.0.0 §6.1 lines 2691–2701.

## Misreading to watch for

| Excuse | Reality |
|---|---|
| "I'll route through any letter glyph since most are peaceful early-game" | False negatives are fatal. The cost asymmetry says: refuse first, classify second. |
| "The modal-prompt halt is sufficient protection" | The peaceful-attack prompt's `y` answer collides with the NW movement key; the agent has reached the prompt only after committing to a step. The right mitigation is to never take the step. |
