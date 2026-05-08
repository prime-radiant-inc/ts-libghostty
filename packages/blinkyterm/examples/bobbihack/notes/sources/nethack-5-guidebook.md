---
title: NetHack 5.0.0 Guidebook — analytical read for autopilot design
source: https://raw.githubusercontent.com/NetHack/NetHack/NetHack-5.0/doc/Guidebook.txt
created: 2026-05-08
links: []
---

# NetHack 5.0.0 Guidebook — per-source note

Read for the bobbihack autopilot design spec. Scope is deliberately
narrow: terrain rendering, monster glyphs, prompt grammar, movement
rules, and engine-imposed behaviors that an autopilot must understand
to avoid false steps. Out-of-scope strands (spells, religion, item
identification, classes, ascension, the Quest, alchemy, conduct) are
not extracted as zettels.

Supplementary sources: NetHack 5.0 source files `include/defsym.h`
(monster letter → class table, fetched via `gh api`) and
`include/color.h` (CLR_* enum). The Guidebook itself does **not**
enumerate which letter maps to which class — it defers to the in-game
`/` (whatis) command. This is a load-bearing gap for an autopilot,
documented in §G below.

## A. Classification

Practical reference manual / game documentation. Tells the reader what
the screen will show and what the keyboard will do. Genre-mixed: the
prose chapters are practical-instructional; the symbol tables (§3.3)
and command reference (§4) are pure reference. Sections 7+ on objects
and classes cross into descriptive game-design exposition that is
out-of-scope for autopilot work.

## B. Unity

The Guidebook tells a sighted human player how NetHack maps from
keyboard to engine to screen, with enough rules-detail to make
movement, fighting, and prompt-handling self-explanatory. Its
organizing principle is the *interface contract* — what each screen
position means, what each keystroke does, when the engine asks back.

## C. Outline of major parts

1. §1 Introduction — flavor; AP-irrelevant.
2. §2 What is going on here? — character roles + races. AP-irrelevant
   except that Tourists/Healers/etc start with different equipment
   and HP, which the AP can read from the status line directly.
3. §3 The screen (§3.1 status, §3.2 message line, §3.3 map) —
   **load-bearing**. The full glyph→meaning vocabulary lives here.
4. §4 Commands — **load-bearing for prompts and movement
   prefixes**. Covers vi-keys, the `m`-prefix (move-without-attack),
   `F`-prefix (fight even if no monster seen), `_` (travel), and the
   menu-driven prompt grammar.
5. §5 Rooms and corridors (§5.1 doorways, §5.2 traps, §5.3 stairs,
   §5.4 shops, §5.5 movement feedback, §5.6 Rogue level) —
   **load-bearing**. The diagonal-doorway rule, locked-door
   semantics, trap-detection rules, and the Rogue/Sokoban refusals
   all live here.
6. §6 Monsters (§6.1 Fighting, §6.2 Pet, §6.3 Steeds, §6.4 Bones,
   §6.5 Persistence) — **load-bearing**. Fighting-by-bumping,
   peaceful-confirmation, pet-displacement, and the "remembered
   monster" `I` glyph rule live here.
7. §7+ Objects, classes, religion, options, etc. — out of scope.

## D. Author's central problems

The Guidebook is answering, for a sighted player:
1. What is on my screen and what does each character mean?
2. What keystroke do I press to do X?
3. When the engine asks me a question, how do I read the prompt?
4. What rules constrain movement (diagonals, doors, traps, stairs)?
5. What rules constrain combat (the bump-to-attack contract,
   peaceful confirmation, fight-prefix)?

For an autopilot, problems (1) and (3)–(5) are central. Problem (2)
matters only as far as the AP needs to know which keys it sends and
which keys are reserved for dangerous actions it must not send.

## E. Key terms

- **vi-keys / `[yuhjklbn]`** (§4): the eight compass directions.
  Lowercase = step one tile; uppercase = run until something stops
  you; `m`-prefix suppresses pickup and combat; `F`-prefix forces an
  attack into the chosen direction even if no visible monster.
- **autoopen** (§5.1): default-on. Walking into a closed door (`+`)
  attempts to open it instead of bumping. **Disabled while confused,
  stunned, or fumbling** — meaning the AP cannot assume bump-to-open
  works under those status effects.
- **autounlock** (§5.1): default-on. If the agent carries an
  unlocking tool, attempting to open a locked door prompts to use
  the tool. **Will trigger a modal `[yn]` mid-autopilot.**
- **paranoid_confirmation** (§options): a space-separated list of
  prompt-style toggles. Defaults: `pray swim trap`. `attack`
  upgrades the peaceful-attack confirm from `y` to typing `yes`.
  The `swim` setting prevents walking into water/lava unless
  `m`-prefixed; `trap` requires `y`-confirmation to step onto a
  known trap. Each is an AP-relevant prompt the agent must either
  recognize or avoid triggering.
- **Peaceful** (§6.1): a non-hostile monster. Bumping it triggers
  `"Really attack the X? [yn]"`. Default `y` is fatal-easy because
  `y` is also NW movement. The Guidebook explicitly warns about
  this.
- **Tame / pet** (§6.2): displaceable, not attackable. `safe_pet`
  option (default-on) prevents pet attacks. Pets *displace* with the
  player when the AP bumps into them — this is silent and produces
  an `MSGTYPE=hide "You displaced *."` message by default.
- **`I`** (§3.3, §6.1): "remembered, unseen monster" marker. NOT a
  monster-class letter. Persists at last-known location until the
  player proves the spot empty. Stepping into `I` triggers a fight
  attempt against (possibly) empty air.
- **`1`–`5`** (§3.3): unseen monsters sensed via Warning. Higher =
  more dangerous. Persistent map markers, not transient.
- **Engulfed** (not in Guidebook by name; cross-ref §6 monster list):
  the player is rendered surrounded by `/-\\` `|@|` `\\-/` corner
  glyphs when swallowed. The AP detects this shape directly; see
  zettel `engulfed-rendering-is-a-distinct-3x3-frame`.
- **`--More--`** (§3.2): "I have another message; press space".
  Modal; blocks all other input. Always row 0 (message line) and
  ends a paginated message.
- **statuslines:2 / :3** (§3.1): controls whether status is two or
  three lines. Default 2 in 80×24. The bottom row carries HP, Pw,
  AC, Dlvl, T, hunger, conditions; the upper row carries name,
  attrs, alignment.
- **mention_walls / mention_decor** (§5.5): options that cause the
  engine to print a message on bumping a wall or stepping onto
  decor — usually off, but if on they push messages onto the
  message line that can confuse a message-keyed interrupt.
- **Rogue level** (§5.6): a single dungeon level in the mid-late
  teens that uses different glyphs (`*` for gold, `%` for stairs,
  no doors). The AP refuses to pathfind on this floor.
- **Sokoban** (§5.2): a multi-level branch where boulders must be
  pushed into pits. Diagonal movement is allowed *except* when it
  would let you slip past two adjacent boulders. The AP refuses to
  pathfind on Sokoban floors.

## F. Main propositions and arguments

This is a manual; "propositions" here are interface contracts. The
ones the AP must obey or compensate for:

1. **§3.3: every map cell is one of (terrain, transient
   monster/item, player, special marker)**. Terrain is the lookup
   table starting at line 519: `-` and `|` are walls *or* horizontal
   open doors *or* vertical open doors *or* a grave; `.` is floor
   *or* ice *or* doorless doorway *or* drawbridge span; `#` is
   corridor *or* iron bars *or* tree *or* drawbridge portcullis
   *or* a colored engraving. **One glyph, multiple meanings, only
   distinguishable by color or context.** The autopilot's existing
   `classifyGlyph` collapses all these to a single `TileKind`,
   silently dropping the ambiguity.

2. **§3.3 + `defsym.h`: each lowercase letter is a *class*, not a
   specific monster.** `d` is "dog or other canine" — could be
   the player's pet kitten's allied dog, a peaceful jackal, or a
   hostile warg. Distinguishing requires color, hilite_pet
   (inverse), or the in-game `;` command. The Guidebook explicitly
   shows the class spread (line 608: `a-z` and `A-HJ-Z`); the
   actual class names are in the source's `MONSYM(idx, ch, basename,
   sym, desc)` enum in `include/defsym.h`. The 26 lowercase letters
   plus 25 uppercase (skipping `I`, which is reserved for unseen),
   plus `@`, `&`, `'`, `:`, `;`, `~`, `]`, give 60 classes.

3. **§4 vi-key semantics: lowercase steps, uppercase runs, prefixes
   modify**. The AP only sends lowercase keys, which is correct
   (no accidental run-into-monster). The AP does NOT use `m`-prefix
   today; it could, to cross known-safe-but-trap-suspect tiles
   without prompts.

4. **§5.1 doorways: open doors block diagonals**. The AP already
   honors this (`diagonalAllowed` rejects diagonals through
   `door_open` / `door_closed`). The Guidebook also says the
   restriction lifts in "a primitive area" (the Rogue level), which
   is consistent with the AP's blanket refusal of Rogue.

5. **§5.1 closed-door bump semantics**: walking into `+` invokes
   autoopen, which opens-and-steps. **But if the door is locked**,
   the engine prints `"The door is locked."` and consumes a turn.
   **And if the door is booby-trapped**, the bump can detonate the
   explosion. The AP's existing locked-door detection (engine
   refuses move, AP marks `blocked`) handles the locked case but
   has no guard against booby-trapped doors — though those are
   rare.

6. **§5.1 autoopen disabled under Conf/Stun/Fumbling**: `y`
   keystroke against `+` from a confused player is a no-op. The
   AP's interrupt list catches `Conf`/`Stun` onset but the AP does
   not abort an in-progress walk-into-closed-door under those
   states; it'll just bump-and-fail.

7. **§5.2 traps**: only known traps render as `^`. *Unknown* traps
   are rendered as floor — the AP cannot avoid them without
   `s`-search. The AP correctly refuses to pathfind through
   `trap_known`. The `paranoid_confirmation:trap` default-on means
   the engine prompts before the player walks onto a known trap;
   this is a `[yn]` modal. The AP currently classifies `trap_known`
   as non-walkable, sidestepping the prompt — but if the AP ever
   decides to traverse a known trap deliberately (e.g. to escape),
   the prompt fires.

8. **§5.5 `m`-prefix is move-without-attack**: prevents bumping a
   visible-monster spot from being treated as an attack. Useful for
   the AP if it wants to swap with a peaceful or step around a
   stationary creature.

9. **§5.6 Rogue level: glyphs change** — `<>` become `%`, `$`
   becomes `*`, doors disappear. The AP correctly refuses this
   floor when it auto-detects via the message
   `"You enter what seems to be an older, more primitive world."`.

10. **§6.1 fighting-by-bumping is the universal melee contract**:
    moving into any visible monster spot is treated as an attack.
    Peacefuls trigger a confirm; tames trigger a swap (with
    `safe_pet`). The bump→attack rule is what makes it dangerous to
    autopilot through unidentified `letter` glyphs without
    classifying them first.

11. **§6.1 peaceful confirmation prompt**: `"Really attack the X?
    [yn]"`. With `paranoid_confirmation:attack`, requires `yes`.
    The `[yn]` modal is in our existing modal-prompt detector, so
    the AP halts. But the failure shape is "AP halted, agent gets
    a modal" — which costs a model call to resolve when ideally the
    AP would have refused to step in the first place.

12. **§6.2 pet displacement is silent by default**: the message
    `"You displaced X."` is hidden by default `MSGTYPE=hide`
    (line 6215). Pets don't trigger a confirm. So the *correct* AP
    behavior is to walk into a pet tile and absorb the swap; the
    *current* AP treats the pet's letter as a `monster_visible`
    interrupt and aborts. (This is partly fixed: the
    `hilite_pet`-driven `inverse: true` classifier in
    `glyph-class.ts` recognizes pets and skips them in the
    monster_visible detector. But the AP planner still doesn't
    *route through* a pet tile — pets aren't represented in the
    GameMap as steppable.)

13. **§6.5 persistence: monsters not in line-of-sight disappear
    from the map**. Memory of "where the goblin was 4 turns ago"
    lives only in the agent's head, not in the rendered grid (the
    `I` marker is the *only* persisted form). This means the AP's
    `monster_visible` interrupt fires only on *appearance*, not on
    "still visible from earlier". A monster that was visible last
    frame and is still visible this frame doesn't re-fire.

14. **§3.2 `--More--`** (line 503): blocks input. We catch it as
    `modal_prompt`, which is right.

15. **§3.1 status line is structured** (lines 343–497): name + St
    + Dx + Co + In + Wi + Ch + alignment on row 22; Dlvl + $ + HP
    + Pw + AC + Exp + T + hunger + conditions on row 23. Our
    `parseStatusLine` parses all of this; the bottom-row HP token
    is the diagnostic for "is this even a NetHack status line".

## G. Critique

### Where the Guidebook is uninformed (for AP purposes)

- **It says nothing about which color signals which monster
  variant.** The phrase "a color character interface" appears once
  (line 223); nowhere does the Guidebook document that, e.g., a
  red `D` is a red dragon and a green `D` is a green dragon. For
  autopilot danger assessment, color is essential — but the
  Guidebook expects the player to learn this by experience.
  *Implication:* the AP design must source the
  letter-color→monster-name mapping from the source files
  (`include/monst.c` carries the actual table) or from the wiki,
  not from the Guidebook.

### Where the Guidebook is incomplete

- **The `I` glyph and `1`–`5` warning glyphs (§3.3) are documented
  but the Guidebook doesn't say what to *do* about them.** An AP
  that treats `I` as a monster-class letter will route into it;
  the Guidebook only says "the monster could have moved." For an
  AP, `I` should be a hard halt — it's the engine telling you
  something dangerous nearby is blind to you.
- **Engulfed rendering is not described.** The Guidebook lists
  monsters that swallow you (§7+ implicitly) but never shows the
  3×3 corner-glyph rendering. Our `detectEngulfed` had to be
  reverse-engineered from production logs.
- **No section enumerates the modal-prompt grammar.** Prompts are
  scattered across §4 and §5 ("In what direction?", "What do you
  want to use?", "[yn]", `--More--`). Building a robust modal
  detector requires walking the prose and listing them.
- **No discussion of what happens when the engine refuses a
  step.** The "The door is locked." case is mentioned in §5.1 but
  the broader category — engine ate a key but didn't move the
  player — has no canonical name in the Guidebook. Our AP had to
  infer "engine refused" from "player position unchanged after
  keystroke", which is correct but undocumented.

### Where the Guidebook is misleading for an AP

- **§3.3 says letters represent "various inhabitants"** without
  noting that the same letter can be hostile, peaceful, tame, or
  even a (color-changed) shopkeeper. The Guidebook treats this as
  obvious; an AP designed only from the Guidebook would treat
  every letter as identical.
- **§5.1 says doors auto-open "by default"**. True for keypress;
  but the AP doesn't see the user's `.nethackrc`. Production
  bobbihack uses default options, but a more general AP needs to
  detect autoopen status from behavior.

### What the Guidebook gets right (so far)

- The vi-key directions and prefixes are exhaustive and correct.
- The status-line grammar is fully specified.
- The diagonal-doorway rule is stated with the right
  side-conditions (open doors block; doorless doorways don't,
  except on the primitive area).
- The Sokoban / Rogue level refusals are clear enough to ground
  the AP's blanket refusal.

## H. What of it?

For the bobbihack autopilot:

1. **The Guidebook is sufficient for terrain rendering and prompt
   grammar but insufficient for monster classification.** The AP
   needs a glyph classifier that combines: the letter (class), the
   color (variant + danger), and the inverse attribute (pet vs
   non-pet). The Guidebook covers the letter; `defsym.h` covers
   class names; `monst.c` covers per-species color; the inverse
   attribute is the existing pet detection.

2. **Several "bugs" the AP has hit are really missing knowledge
   from the Guidebook**:
   - Locked doors (§5.1) — the Guidebook says they print "The door
     is locked." but the AP wasn't propagating that into BFS; the
     fix in commit `9e0944e` separates `blockedTiles` from
     `visited`.
   - Peaceful confirmation (§6.1) — the AP halts on the modal but
     would be cheaper to never step into the peaceful tile.
   - Pet swap (§6.2) — the AP's planner doesn't route *through*
     pet tiles even though stepping in is safe.
   - Engulfed rendering (§6) — wasn't documented; was
     reverse-engineered.
   - `I` and `1`–`5` markers (§3.3) — not currently treated
     specially.

3. **The right shape for the AP design spec is**:
   - A glyph classifier richer than `classifyGlyph` (terrain only)
     that exposes `(class, color, attrs, pet, peaceful?)` per cell.
   - A prompt-pattern recognizer that handles the catalog of
     `paranoid_confirmation` modals and the standard `[yn]`,
     `[yes]`, `--More--`, "In what direction?", "What do you want
     to..." families, with named outcomes (auto-dismiss safe
     prompts, halt-on-dangerous).
   - A path-planning policy that *uses* the classification —
     routes through pet tiles, refuses peaceful tiles, never
     routes adjacent to a `D`/`L`/`&` glyph (high-danger classes),
     and avoids `I`/`1`-`5` neighborhoods entirely.
   - Recognition rubrics for the load-bearing decision points.

4. **Out of scope for the spec**: Sokoban solving, polymorph
   handling beyond refuse-floor, item identification, prayer,
   shopping. These would expand the AP's surface 5×; the brief is
   explicit that the v1 of the AP does navigation and danger
   avoidance only.

## Permanent notes extracted from this source

Per §3 (the screen):
- `terrain-glyph-overloading-requires-color-disambiguation` —
  multiple meanings per glyph in the default ASCII set
- `letter-glyphs-are-classes-not-species`
- `i-glyph-is-unseen-monster-marker-not-a-class`
- `digits-1-5-are-warning-signals-of-unseen-danger`
- `status-line-bottom-row-hp-token-is-the-nethack-fingerprint`

Per §4 (commands):
- `vi-key-prefixes-modify-bump-semantics`
- `m-prefix-disables-attack-and-pickup`
- `f-prefix-forces-attack-on-empty-air`

Per §5.1 (doorways):
- `open-doors-block-diagonal-movement`
- `closed-doors-auto-open-on-bump-but-not-when-confused`
- `locked-doors-consume-a-turn-and-print-engine-message`
- `booby-trapped-doors-detonate-on-open-attempt`

Per §5.2 (traps):
- `unknown-traps-render-as-floor`
- `paranoid-trap-prompt-blocks-known-trap-step`

Per §5.5 (movement feedback):
- `paranoid-swim-prevents-water-lava-step-without-m-prefix`
- `silent-no-move-means-engine-refused`

Per §5.6 / §5.2:
- `rogue-level-uses-different-glyphs`
- `sokoban-restricts-boulder-pushes-to-cardinals`

Per §6 (monsters):
- `bumping-a-monster-tile-is-the-attack-contract`
- `peaceful-attack-prompt-is-yn-with-y-as-movement-key-collision`
- `pet-displacement-is-silent-and-safe`
- `unseen-monster-marker-i-persists-until-disproven`
- `engulfed-rendering-is-a-distinct-3x3-frame`

First-person belief candidates (per `learning-beliefs` Moment 5):
- `ap-glyph-classifier-must-expose-letter-color-attrs-as-tuple`
- `ap-must-refuse-to-step-rather-than-halt-on-known-modal-tiles`
- `ap-route-cost-must-encode-danger-class-not-just-walkability`
- `ap-prompts-have-fixed-shapes-recognizable-without-llm`

Out-of-scope, intentionally not extracted: object-class glyphs
(`?`/`!`/`/`/`=`/`*`/`(`/`[`/`)`/`%`/`"`) beyond the autopilot's
existing item-visible interrupt; spell mechanics; shopping; alchemy;
classes; alignment effects on monster reactions (§3.1 mentions but
there is no AP-tractable signal); religion; conduct; Quest; bones
levels (§6.4); Sokoban puzzle-solving (§5.2 — refused).
