---
title: "The HP:n(m) token on the bottom status row uniquely identifies a NetHack frame"
source: "../sources/nethack-5-guidebook.md"
created: 2026-05-08
schema_version: 1
links: [dlvl-plus-branch-is-the-floor-identity]
---

# The HP:n(m) token on the bottom status row uniquely identifies a NetHack frame

The bottom status line of every NetHack frame contains an
`HP:current(max)` token (e.g. `HP:9(12)`), where `current` may be
negative and `max` is non-negative. Adjacent tokens on the same
row include `Pw:`, `AC:`, `Dlvl:`, `Exp:`, and `T:`. The presence
of an `HP:N(M)` token, where the regex `HP:-?\d+\(\d+\)` matches,
is a near-perfect fingerprint that the buffered terminal output
*is* a NetHack screen rather than a `--More--` overlay, an Apple
splash, or a corrupted draw.

This is what `parsers.ts:parseHpField` already exploits: its
sentinel return for "this isn't a parseable status line" is
gated on whether the HP regex matches at all. The bobbihack
project relies on this — the status line is the canonical
"the engine is in a stable game state, ready for input" signal,
distinguished from "midway through a multi-frame redraw" or
"in a menu" or "showing a splash screen".

For an autopilot, this is the readiness gate. Before issuing
a movement key, confirm `parseStatusLine(rows[22], rows[23])`
returns a non-sentinel result. Without it, you can mistake a
modal/menu frame for a stable game state and send keystrokes
the engine doesn't expect (e.g. `j` while a menu has focus
selects the menu's `j` letter, not "move south").

Source: NetHack Guidebook 5.0.0 §3.1 (status line layout, lines
343–497); bobbihack `parsers.ts:parseHpField`.

## Misreading to watch for

| Excuse | Reality |
|---|---|
| "Any 80×24 frame with letters at the right positions is a game state" | Menus and `--More--` paginations also fill 80×24 buffers. Without HP, the AP cannot distinguish "ready for movement" from "ready for menu input". |
