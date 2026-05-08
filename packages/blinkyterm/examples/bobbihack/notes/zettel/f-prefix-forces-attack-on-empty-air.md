---
title: "The F-prefix forces an attack into the named direction even with no visible target"
source: "../sources/nethack-5-guidebook.md"
created: 2026-05-08
schema_version: 1
links: [bumping-a-monster-tile-is-the-attack-contract, vi-key-prefixes-modify-bump-semantics]
---

# The F-prefix forces an attack into the named direction even with no visible target

The `F` prefix forces the next directional key to be a melee
attack, regardless of whether there is a visible monster in the
target tile. The Guidebook (§4 line 774): "Prefix: fight a
monster (even if you only guess one is there)."

This is the *attack* counterpart to `m`'s *don't-attack*. It
exists for the case where the player remembers a monster was
there or suspects an invisible monster is there, and wants to
spend a turn swinging into the cell.

For an autopilot, `F` is a dangerous prefix. It commits the
agent to a turn of combat against an unidentified target. The
AP is not authorized to make this commitment without an LLM
decision; combat decisions are LLM-scoped, not policy-scoped.

The bobbihack AP correctly never sends `F`. The AP *also* must
ensure it never sends a sequence of keystrokes that the engine
could parse as `F`+direction — i.e., never send a literal `F`
character to the PTY, even if the AP thinks it's idempotent.
This is currently not a concern because the AP only sends lower-
case direction keys, but a future "agent invokes capital-letter
commands" expansion needs a guard.

Source: NetHack Guidebook 5.0.0 §4 lines 774–775.
