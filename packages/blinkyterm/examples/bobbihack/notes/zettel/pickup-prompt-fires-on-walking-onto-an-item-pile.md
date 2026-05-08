---
title: "Walking onto an item pile (with autopickup or otherwise) fires the pickup prompt"
source: "../sources/nethack-5-guidebook.md"
created: 2026-05-08
schema_version: 1
links: [modal-prompt-grammar-has-a-finite-shape-catalog]
---

# Walking onto an item pile (with autopickup or otherwise) fires the pickup prompt

The Guidebook §7 (Objects, line 2811) and §5.5 (movement
feedback, lines 2589–2602) describe the autopickup behavior:
walking onto a tile containing items (when `autopickup` is
on, the default) attempts to pick them up. If the pile has
multiple items and the engine cannot decide all-or-nothing,
it prompts: "Pick up?" or "Pick what?"-style prompts.

Two prompt shapes the AP must handle:
- `Pick up <item>? [yn]` — single-item pickup confirmation.
- `Pick up?` followed by a multi-item menu.

The Guidebook (§5.5) provides the `m` movement prefix to
bypass autopickup: "The 'nopickup' command prefix (default `m')
can be used before a movement direction to step on objects
without attempting auto-pickup and without giving feedback
about them." This is the same `m` prefix as no-attack and
no-trap-prompt.

For an autopilot:

1. The AP currently does NOT use `m` to prevent autopickup.
   This means stepping onto an item pile triggers the pickup
   prompt, which the AP halts on as a `modal_prompt` interrupt.
2. The AP could use `m` for every step, which would prevent
   pickup prompts entirely. The cost is an extra keystroke per
   step; the benefit is avoiding the modal halt.
3. The `new_item_visible` interrupt fires when items appear in
   sight, which usually precedes the pickup prompt by several
   turns (the agent sees the item before stepping onto it).
   The LLM can then decide whether to pick up.

Source: NetHack Guidebook 5.0.0 §5.5 lines 2589–2602; §7 line
2811.
