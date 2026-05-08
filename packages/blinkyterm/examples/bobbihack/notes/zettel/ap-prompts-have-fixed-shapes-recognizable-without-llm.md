---
title: "The autopilot can recognize all halt-worthy modal prompts without invoking an LLM"
source: "../sources/nethack-5-guidebook.md"
created: 2026-05-08
schema_version: 1
links: [modal-prompt-grammar-has-a-finite-shape-catalog, more-marker-is-the-paginated-message-modal]
---

# The autopilot can recognize all halt-worthy modal prompts without invoking an LLM

NetHack's modal prompt grammar (the catalog enumerated in the
`modal-prompt-grammar-has-a-finite-shape-catalog` zettel) is
small, fixed, and regex-recognizable. This means the
autopilot's *detection* of "should I halt for input?" can be
done deterministically without LLM involvement.

The current bobbihack `MODAL_PATTERNS` array in
`interrupts.ts` already does this for the common cases:
`--More--`, `[yn]`, `[a-z]` letter menus, "In what direction?",
"What do you want to (eat|drink|...)?", and pickup prompts.
The detection latency is one regex match per frame.

What requires LLM involvement is *answering* the prompt — the
right answer depends on the agent's plan, the inventory state,
the current goal. But identifying the prompt's existence does
not.

This has a design implication: the AP's modal-detection logic
can be unit-tested against fixture frames without any LLM in
the loop. The bobbihack test harness (`bobbihack.autopilot-nav.
test.ts`) already does this for movement; the same approach
extends to modal-detection by adding a fixture row whose
content is a literal prompt and asserting `runInterruptChecks`
returns the correct `modal_prompt` hit.

For the AP design spec: the modal-detection layer is
deterministic. The catalog is the contract. New verbs added in
future NetHack versions get a new regex; the architecture
stays the same.

Source: bobbihack `interrupts.ts:MODAL_PATTERNS,
runInterruptChecks`; NetHack Guidebook 5.0.0 §3.2, §4
(commands), §6.1, §options table.
