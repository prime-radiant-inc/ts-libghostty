---
title: "\"What do you want to <verb>?\" prompts need a single inventory letter or ESC"
source: "../sources/nethack-5-guidebook.md"
created: 2026-05-08
schema_version: 1
links: [modal-prompt-grammar-has-a-finite-shape-catalog]
---

# "What do you want to <verb>?" prompts need a single inventory letter or ESC

A whole family of NetHack commands prompts for an inventory
choice with the shape "What do you want to <verb>? [letters
?*]". The Guidebook §4 lines 642–652 worked example uses "use",
but the same shape applies to: eat, drink, read, wear, put on,
take off, remove, wield, drop, throw, apply, zap.

The prompt is modal — answers must be one of:
- A single letter from the offered set (`a-zA-Z`).
- `?` to show inventory list before answering.
- `*` to choose an unlisted item.
- `ESC` to abort the command.

Any other keystroke is rejected (or in some interfaces, queued
as the response, with bad effects).

For an autopilot:

- The AP must NOT have any path that emits a verb-of-this-shape
  command (eat, drink, etc.) — those are LLM-scoped.
- If a previous LLM action opened this prompt, the AP must
  detect it before any movement keystroke — sending `j` would
  be interpreted as "use inventory letter `j`".
- The bobbihack `MODAL_PATTERNS` regex catches the most common
  prompts via `What do you want to (eat|drink|...)?`. Other
  variations (`What do you want to wear?`, etc.) are caught by
  the same regex. The catalog in `interrupts.ts` is partial;
  for completeness it should include all 12 verbs.

Source: NetHack Guidebook 5.0.0 §4 lines 642–652;
bobbihack `interrupts.ts:MODAL_PATTERNS`.
