---
title: "The autopilot should refuse to step into tiles that would fire a known modal, not halt afterwards"
source: "../sources/nethack-5-guidebook.md"
created: 2026-05-08
schema_version: 1
links: [ap-routing-must-predict-modals-not-just-react-to-them, m-prefix-disables-attack-and-pickup, modal-prompt-grammar-has-a-finite-shape-catalog, paranoid-trap-prompt-blocks-known-trap-step, peaceful-attack-prompt-is-yn-with-y-as-movement-key-collision]
---

# The autopilot should refuse to step into tiles that would fire a known modal, not halt afterwards

The bobbihack autopilot's existing approach to most modals is
*reactive*: step, observe the modal in the resulting frame,
halt via `modal_prompt`, surface to the LLM. This is cheap when
the modal arises unpredictably but expensive when the modal is
*predictable from the target tile*.

The predictable-modal cases:

- Stepping onto a peaceful: predictable from monster
  classification.
- Stepping onto a known trap: predictable from `trap_known`
  classification (`paranoid:trap` always fires).
- Stepping into water/lava: predictable from terrain
  classification (`paranoid:swim` blocks silently).
- Walking onto an item pile: predictable from item-glyph
  presence at the tile.
- Walking through a doorway diagonally: predictable from
  `door_open`/`door_closed` classification.

In each case, the AP knows from the rendered frame *before
moving* that the next step will produce a halt or a refused
move. The right design is: classify the target tile, predict
the prompt, decide:
- If the AP can avoid the prompt by routing differently, do so.
- If the AP can bypass the prompt with `m`-prefix (and the
  agent's intent allows), use the prefix.
- If the AP cannot avoid the prompt and the prompt requires
  LLM input, halt *before* the step rather than after.

The cost saved is the model call: each modal-halt currently
costs one round-trip (LLM sees prompt, decides answer, sends
keystroke, AP resumes). Predicting the modal saves the round-
trip when the AP can route around.

This generalizes: the AP's halt-on-modal behavior is correct
defense-in-depth, but the AP's *primary* protection should be
predict-and-avoid. The stop-after-step is the catch for the
modals the AP can't predict (`--More--` from arbitrary game
events, paranoid_confirmation:pray, hp-critical alerts, and
others).

Source: aggregated from NetHack Guidebook 5.0.0 §5.2 (trap
prompt), §6.1 (peaceful prompt), §options table
(paranoid_confirmation); bobbihack `interrupts.ts:MODAL_PATTERNS`.

## Misreading to watch for

| Excuse | Reality |
|---|---|
| "Halting on the modal is enough; the LLM resolves it" | Modal halts cost a model round-trip each. On floors with many peacefuls or known traps, the LLM call costs dominate the run cost. |
| "Predicting the modal duplicates the engine's logic" | The prediction is shallow: classify the tile, look up the predictable-modal table. Not a full engine emulation; just the cases the AP regularly hits. |
