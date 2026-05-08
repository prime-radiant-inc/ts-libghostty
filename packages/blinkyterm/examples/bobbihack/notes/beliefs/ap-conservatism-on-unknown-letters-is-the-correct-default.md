---
title: "I commit to refusing to step onto any unclassified letter glyph by default, accepting modal-halt cost over fatal-step risk"
scope: personal
status: live
created: 2026-05-08
last_reviewed: 2026-05-08
falsifier: "A measured run where the modal-halt cost on peacefuls dominates total session cost AND a peaceful-classifier reaches >95% precision on the same data"
links: [bumping-a-monster-tile-is-the-attack-contract, fighting-by-bumping-makes-letter-classification-safety-critical]
schema_version: 1
---

# Why I hold this

I hold this because the cost asymmetry between false-positive
and false-negative monster classification is large. A false
negative (think safe, actually hostile) commits the player to
combat without LLM oversight, possibly fatally; a false
positive (think hostile, actually peaceful) costs at most a
replan and an LLM call.

Asymmetric error costs have a standard response: optimize for
the side where the cheap error lives. For monster
classification, that means: refuse-to-step is the safe
default, classification *upgrades* are positive evidence that
overrides the default. A pet (inverse attribute) is a positive
signal: step through. A specific colored shopkeeper at a
specific position type is a positive signal: step around but
don't bump. Without a positive signal, every letter is hostile.

The opposite position — "treat letters as safe-by-default,
trust modal halts to catch peacefuls" — fails because the `y`
collision (NW direction = `y` = "yes attack") makes the modal
recovery dangerous. The AP can't naively retry a movement key
after a modal-halt without potentially answering "yes" to the
attack prompt. The right protection is upstream: don't step in.

What would change my mind: a measurement showing that on
representative floors, the modal-halt cost from peacefuls
dominates session cost (so the conservatism is actively
hurting), AND a peaceful-classifier exists that reaches >95%
precision (so it's safe to relax the default for that
classified subset). Both halves are required — relaxing
without the classifier is unsafe; the classifier without the
cost evidence is over-engineering.

# Revision log
## 2026-05-08 — created
After Spawned from NetHack Guidebook §6.1 (bumping = attack). The asymmetric cost (false negative is fatal; false positive is a replan) makes conservative-default correct until peaceful classification matures.: initial belief.
