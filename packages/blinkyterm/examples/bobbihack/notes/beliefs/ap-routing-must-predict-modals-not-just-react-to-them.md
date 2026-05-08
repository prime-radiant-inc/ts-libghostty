---
title: "I commit to making the autopilot predict tile-induced modal prompts and refuse-to-step before the prompt fires, not just halt afterwards"
scope: personal
status: live
created: 2026-05-08
last_reviewed: 2026-05-08
falsifier: "A run-cost analysis showing that the predict-and-avoid approach saves <10% of LLM round-trips compared to the halt-and-resolve baseline"
links: [ap-must-refuse-to-step-rather-than-halt-on-known-modal-tiles, modal-prompt-grammar-has-a-finite-shape-catalog]
schema_version: 1
---

# Why I hold this

I hold this because the autopilot's economic model is "compress
many turns into one LLM call". Every modal halt breaks that
contract: the AP halts, surfaces the prompt, the LLM round-
trips, the AP resumes. On floors with several known traps and
peacefuls, the halt-per-tile rate can climb high enough that
the AP saves nothing over per-step LLM control. The only way
to preserve the AP's value is to anticipate prompts that are
*predictable from rendered state* and route around them — or
in narrow cases (e.g. routing through a pet), to use the `m`
prefix that bypasses the prompt class entirely.

The Guidebook makes this anticipation cheap. The
paranoid_confirmation table specifies which tile-types fire
prompts under default settings (trap, swim); the §6.1 rules
give the peaceful-bump prompt; the autoopen and autounlock
options give the door-prompt cases. Each is one classification
check away from being predictable.

The opposite position — "halt-and-resolve is good enough; the
LLM is cheap" — is defensible on a fast cheap model, but the
production target is Anthropic Sonnet/Opus where each round-
trip is materially more expensive and slower than a regex
check. The cost asymmetry argues for prediction wherever it's
free.

What would change my mind: a run-cost measurement showing
predict-and-avoid saves <10% of round-trips on representative
floors. I'd interpret that as "modals don't dominate" and
collapse the design back to halt-only. I doubt that
measurement will go that way, but the test is concrete.

# Revision log
## 2026-05-08 — created
After Spawned from NetHack Guidebook source extraction. Each modal halt is a model round-trip; predictable modals (peaceful, known trap, water/lava) account for the bulk of halts on populated floors.: initial belief.
