---
title: "paranoid_confirmation:swim (default-on) refuses water/lava step without m-prefix"
source: "../sources/nethack-5-guidebook.md"
created: 2026-05-08
schema_version: 1
links: [paranoid-trap-prompt-blocks-known-trap-step, silent-no-move-means-engine-refused]
---

# paranoid_confirmation:swim (default-on) refuses water/lava step without m-prefix

The `paranoid_confirmation:swim` option is on by default. It
prevents walking into water `}` or lava tiles unless the player
explicitly uses the `m` movement prefix. The Guidebook (line
4938): "swim - prevent walking into water or lava; on by
default; (to deliberately step onto/into such terrain when this
is set, use the `m' movement prefix when adjacent)."

Unlike most paranoid_confirmation options that produce a `[yn]`
prompt, this one *blocks* the keystroke entirely without a
prompt. The engine refuses the move silently (or with a brief
"You stop." or terrain-hover message). This means the
"engine refused" signal — player position unchanged — is the
detection mechanism, not a modal prompt.

For an autopilot:

1. Water `}` and lava (also `}` but red) are already
   non-walkable in the bobbihack GameMap, sidestepping the
   issue. The AP never plans through them.
2. If the AP ever needed to traverse water (with intrinsic
   swimming, levitation, or amphibious polymorph), the `m`
   prefix is required.
3. The default-on swim option is *protective* of the AP — even
   if the AP's classifier misclassifies a `}` as floor, the
   engine refuses the step.

Source: NetHack Guidebook 5.0.0 §options table line 4938–4940.
