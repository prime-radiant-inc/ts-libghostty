---
title: "The s (search) command is the only way for an autopilot to reveal secret doors and corridors"
source: "../sources/nethack-5-guidebook.md"
created: 2026-05-08
schema_version: 1
links: [unknown-traps-render-as-floor]
---

# The s (search) command is the only way for an autopilot to reveal secret doors and corridors

NetHack hides several map features by default:
- **Secret corridors** appear as solid rock until found
  (Guidebook §5 line 2324).
- **Secret doors** appear as ordinary wall (from inside a room)
  or solid rock (from outside) until found (§5.1 line 2385).
- **Hidden traps** appear as floor until triggered or found
  (§5.2 line 2396).

The `s` (search) command, used while adjacent to the hidden
feature, has a chance of revealing it. Multiple attempts may be
needed; luck-modified.

For an autopilot:

- Without searching, the AP cannot find secret corridors or
  doors. It will treat dead-ends as truly dead and never
  explore beyond them.
- Searching costs turns. A run that "explores everything by
  searching at every wall" is impractical.
- The right tradeoff: a v1 AP that does no searching is
  acceptable — it can only navigate the visible portion of the
  map, but the visible portion is usually enough for the
  game's main path.
- A v2 AP that searches at dead-ends (after `explored entire
  known map` would otherwise fire) is more aggressive but
  rarely necessary in early-mid game.

The Guidebook's `s` command can also be repeated as a count:
`10s` searches 10 times in one input. For an autopilot, the
multi-search version is more efficient (one command-input
cycle, not 10).

Source: NetHack Guidebook 5.0.0 §5 line 2324, §5.1 line 2385,
§5.2 line 2396.
