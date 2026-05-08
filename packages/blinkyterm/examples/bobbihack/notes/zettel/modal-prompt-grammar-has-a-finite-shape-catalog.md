---
title: "NetHack modal prompts conform to a finite catalog of regex-recognizable shapes"
source: "../sources/nethack-5-guidebook.md"
created: 2026-05-08
schema_version: 1
links: [ap-must-refuse-to-step-rather-than-halt-on-known-modal-tiles, ap-prompts-have-fixed-shapes-recognizable-without-llm, ap-routing-must-predict-modals-not-just-react-to-them, in-what-direction-prompt-requires-vi-key-answer, more-marker-is-the-paginated-message-modal, paranoid-trap-prompt-blocks-known-trap-step, peaceful-attack-prompt-is-yn-with-y-as-movement-key-collision, pickup-prompt-fires-on-walking-onto-an-item-pile, what-do-you-want-prompts-need-an-inventory-letter]
---

# NetHack modal prompts conform to a finite catalog of regex-recognizable shapes

Across the Guidebook, every modal prompt the engine throws at
the player conforms to a small set of structural shapes. The
catalog is small enough to enumerate exhaustively and detect
via regex on the message line:

- `--More--` — pagination, blocks input until space/return
  (§3.2 line 503).
- `[yn]` or `[ynaq]` style — y/n/all/quit single-character
  answer (§4 menustyle, ubiquitous).
- `[yes/no]` style — when paranoid_confirmation requires the
  full word (§options table line 4910).
- `[a-zA-Z ?*]` style — pick an inventory letter (§4 line
  642).
- `In what direction?` — needs a vi-key (§ many places).
- `What do you want to <verb>?` where verb ∈ {eat, drink,
  read, wear, put on, take off, remove, wield, drop, throw,
  apply, zap} — pick an inventory letter (§4 various commands).
- `Pick up?` / `Pick an item?` — autopickup or `,` command.

The shapes are stable across NetHack versions because the
prompts are produced by ports of a small set of engine
functions (`yn`, `yn_function`, `getobj`, `getdir`, etc.). New
features may add new prompt verbs but rarely new prompt shapes.

For an autopilot:

- The bobbihack `MODAL_PATTERNS` regex array in `interrupts.ts`
  catches all of these except some edge cases (the `[a-zA-Z]`
  pattern only weakly matches letter-selection menus).
- Every modal prompt must produce a halt — the AP cannot
  resolve them without LLM input, because the answer depends on
  the agent's intent.
- The detail string returned with the modal interrupt should
  include the prompt text, so the LLM sees *which* prompt
  fired without inspecting the screen separately. The current
  `modal_prompt` interrupt does this (commit `d30e47a`).

Source: NetHack Guidebook 5.0.0 §3.2, §4 (commands), §6.1
(fight prompts), §options table; bobbihack
`interrupts.ts:MODAL_PATTERNS`.
