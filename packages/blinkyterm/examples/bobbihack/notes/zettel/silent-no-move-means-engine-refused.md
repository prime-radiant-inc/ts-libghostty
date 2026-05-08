---
title: "Player position unchanged after a movement keystroke means the engine refused"
source: "../sources/nethack-5-guidebook.md"
created: 2026-05-08
schema_version: 1
links: [locked-doors-consume-a-turn-and-print-engine-message, paranoid-swim-prevents-water-lava-step-without-m-prefix]
---

# Player position unchanged after a movement keystroke means the engine refused

When the autopilot sends a movement keystroke and the player's
`@` does not appear at a new position in the resulting frame,
the engine has refused the move. The Guidebook does not
formalize this as a single rule, but it is the observable
behavior whenever the engine encounters: a wall, a closed
booby-trapped door (pre-detonation phase), a locked door
without an unlocking tool (no autounlock prompt), a peaceful
monster the player declined to attack, the
`paranoid_confirmation:swim` block, a corner-squeeze refusal
("It's hard to squeeze through that gap."), a diagonal-into-
doorway refusal, and several other engine-side validations.

The detection is positional: compare `map.currentPlayerXY`
before and after the keystroke. If unchanged, the engine
refused.

The accompanying message line *usually* explains why ("The door
is locked.", "It's hard to squeeze through that gap.", "There
is a fountain here."), and the AP captures this as
`lastBlockMessage` for legible stop reasons. But the message
is a side-channel; the *primary* signal is the position
unchanged.

This is the design choice that lets the AP work even when:
- The engine adds a new refusal class in a future version.
- A custom `MSGTYPE` config has muted the explanation message.
- The refusal is silent (some boulder-pushing situations).

The bobbihack AP uses this in two places:
1. `autopilot_to`: a position-unchanged step adds the target
   tile to `blockedTiles` and replans.
2. `autopilot_explore`: a position-unchanged step marks the
   target tile as both `visited` and `blocked` so BFS doesn't
   re-route through it.

Source: bobbihack `tools/autopilot.ts` "Engine ignored the
move" rationale comment (lines ~305 and ~735); commits
`9e0944e`, `0b31893`, `4462656`.
