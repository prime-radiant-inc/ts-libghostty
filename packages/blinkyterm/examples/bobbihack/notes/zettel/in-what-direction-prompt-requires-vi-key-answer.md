---
title: "\"In what direction?\" prompts require a single vi-key as the answer"
source: "../sources/nethack-5-guidebook.md"
created: 2026-05-08
schema_version: 1
links: [modal-prompt-grammar-has-a-finite-shape-catalog]
---

# "In what direction?" prompts require a single vi-key as the answer

Several NetHack commands ask for a direction after invocation:
zap a wand, throw an item, kick, and others. The prompt shape
is `"In what direction?"` and the answer is a single vi-key
(`y`, `u`, `h`, `j`, `k`, `l`, `b`, `n`), with `.` for "self"
in some contexts and ESC to cancel.

The prompt is a *modal* — it blocks all other input until
answered, including movement. An autopilot that sends a
movement key into an "In what direction?" state will have its
key consumed as the direction answer to whatever command
preceded it, with potentially destructive effects (zapping a
wand of death at yourself, throwing a precious item into a
wall, kicking a sleeping shopkeeper).

The bobbihack AP currently has no path that opens this prompt
— it never sends `z`, `t`, `^D`, or other direction-soliciting
commands. But if a *prior* user-issued or LLM-issued command
opened the prompt and the AP starts mid-prompt, the AP must
detect this state before sending any movement.

Detection: the regex `/In what direction\?/i` is in
`MODAL_PATTERNS`, so the modal_prompt interrupt fires. The AP
halts and surfaces to the LLM, which must answer (or send ESC
to cancel) before re-arming the AP.

Source: NetHack Guidebook 5.0.0 §4 (zap, throw, kick command
descriptions); bobbihack `interrupts.ts:MODAL_PATTERNS`.
