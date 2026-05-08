# NetHack-aware autopilot — design spec

Author: Hraefn (Bob hraefn-2026-05-08, Opus 4.7 1M).
Date: 2026-05-08.
Source corpus: `packages/blinkyterm/examples/bobbihack/notes/`
(per-source note + 41 atomic zettels + 4 first-person beliefs,
extracted from NetHack 5.0.0 Guidebook).

## Summary

The bobbihack autopilot (`autopilot_to`, `autopilot_explore` in
`packages/blinkyterm/examples/bobbihack/tools/autopilot.ts`)
compresses many NetHack turns into a single LLM call. Each
production bug we've fixed traced to a piece of NetHack
rendering or rule the autopilot didn't understand as a special
case: locked doors looping BFS through them, engulfment
detector false-firing on plain walls, pet-step-as-hostile,
peaceful-attack prompts halting on the `y` collision. This
spec is the *content* fix: it makes the autopilot NetHack-aware
by surfacing the engine knowledge the existing patches each
discovered ad hoc.

The unifying claim: **the autopilot's per-cell classification
must expose `(terrain, monster-class, color, attrs)` as a
tuple, the route planner must consume the tuple to predict
tile-induced modal prompts and avoid them rather than halt
after, and a small library of NetHack-specific recognition
rubrics governs the load-bearing AP decisions.** The AP's
existing safety net (interrupts, modal-halt, refuse-to-step on
trap_known) becomes defense-in-depth; the primary protection
moves upstream into classification and routing.

## Context: where the existing AP succeeds and fails

What works in v1:
- Terrain classification via `parsers.ts:classifyGlyph` covers
  the ~20 terrain `TileKind`s the Guidebook §3.3 enumerates.
- 8-connectivity A* with the diagonal-doorway rule is correct
  and well-tested by the fixture-driven harness.
- `monster_visible` interrupt with the inverse-attribute pet
  filter (commits `1269049`, `0b31893`) catches hostiles
  without false-firing on pets.
- `blockedTiles` separation from `visited` prevents the locked-
  door-loop bug (commit `9e0944e`).
- Modal-prompt detection (`MODAL_PATTERNS` regex array) halts
  the AP for LLM resolution.
- Refusal of Sokoban / Rogue / walkability-suspect floors is
  correct.

What v1 is missing — the gaps this spec closes:

1. The classifier collapses dimensions. `classifyGlyph` returns
   `null` for any letter; `classifyCell` returns binary
   `pet`/`normal`. Color and class-letter information sits in
   the FrameSnapshot but the AP never reads it.
2. The pathfinder's tile cost is binary walkability + a 1.5×
   cost for closed doors. Adjacency to a `D` (dragon) costs the
   same as adjacency to floor.
3. The AP routes through unidentified letters by refusing them
   wholesale, but has no concept of "step onto a known peaceful
   safely with `m` prefix" or "step onto a pet to displace".
4. Several rendering quirks are not detectors yet: `I` unseen-
   monster marker, `1`–`5` Warning digits, `^X` (named trap)
   variation, and the corridor-`#` overload (tree, iron bars).
5. The trap and swim `paranoid_confirmation` prompts are caught
   reactively as modal halts; both are predictable from the
   target-tile classification.

Each gap is one of the named beliefs in
`packages/blinkyterm/examples/bobbihack/notes/beliefs/`.

## v2 design

### Layer 1: per-cell classification (replaces `classifyGlyph` + `classifyCell`)

A new `classifyCell` in `parsers.ts` (or a new
`cell-classifier.ts`) consumes a single FrameSnapshot cell and
its `(x, y)` and produces:

```ts
type MonsterClass =
  | 'ant' | 'blob' | 'cockatrice' | 'dog' | 'eye' | 'feline'
  | 'gremlin' | 'humanoid' | 'imp' | 'jelly' | 'kobold'
  | 'leprechaun' | 'mimic' | 'nymph' | 'orc' | 'piercer'
  | 'quadruped' | 'rodent' | 'spider' | 'trapper' | 'unicorn'
  | 'vortex' | 'worm' | 'xan' | 'light' | 'zruty'
  | 'angel' | 'bat' | 'centaur' | 'dragon' | 'elemental'
  | 'fungus' | 'gnome' | 'giant' | 'jabberwock' | 'kop'
  | 'lich' | 'mummy' | 'naga' | 'ogre' | 'pudding'
  | 'quantmech' | 'rustmonst' | 'snake' | 'troll' | 'umber'
  | 'vampire' | 'wraith' | 'xorn' | 'yeti' | 'zombie'
  | 'human' | 'ghost' | 'golem' | 'demon' | 'eel' | 'lizard'
  | 'worm-tail' | 'mimic-def';

interface ClassifiedCell {
  // Terrain layer (always populated for a known cell).
  terrain: TileKind | null;
  // Foreground glyph layer (null when no transient there).
  foreground:
    | { kind: 'player'; }
    | { kind: 'monster'; letter: string; class: MonsterClass;
        color: number; pet: boolean; bold: boolean; }
    | { kind: 'item'; letter: string; color: number; }
    | { kind: 'unseen-monster'; }     // 'I'
    | { kind: 'warning'; tier: 1|2|3|4|5; }
    | null;
}
```

The `MonsterClass` union enumerates the 60 classes from
`include/defsym.h`'s `MONSYM(idx, ch, basename, sym, desc)`
table. Specific NetHack-source-derived data:

```ts
const LETTER_TO_CLASS: Record<string, MonsterClass> = {
  'a': 'ant', 'b': 'blob', 'c': 'cockatrice', 'd': 'dog',
  // … 60 entries
};
```

Color is the 0–15 CLR_* value from `include/color.h`. The cell
classifier reads it from the FrameSnapshot's CellStyle:

```ts
function colorFromStyle(style: CellStyle | undefined): number {
  // Map the 8/16-color SGR to CLR_*.
}
```

The pet detection stays as it is — `style.inverse === true` per
`hilite_pet`.

**Why a single tuple, not parallel grids:** atomic update,
co-located reasoning, future-proof. See zettel
`ap-glyph-classifier-must-expose-letter-color-attrs-as-tuple`.

The classifier handles overloaded glyphs:
- `}` water vs lava: distinguish by color (red = lava, blue =
  water). Both stay non-walkable for v2.
- `#` corridor vs tree vs iron bars: distinguish by color
  (default = corridor, green = tree, cyan = iron bars).
- `_` altar vs iron chain: rare; default to altar (the more
  common case) and accept misclassification of iron chain.
- `-`/`|` wall vs open-door: distinguish by adjacency context
  (a `-` between two `|` glyphs is open-door east-west; a `-`
  between two `-` glyphs is wall). The existing GameMap state
  machine handles this; the cell classifier consults it.

### Layer 2: route-cost model (replaces binary walkability)

`game-map.ts:pathfind` extends to consume the classified cell
and compute a richer cost:

```ts
function tileCost(cell: ClassifiedCell, neighbor: ClassifiedCell): number {
  const base = isDiagonal ? Math.SQRT2 : 1;
  let multiplier = 1.0;
  if (cell.terrain === 'door_closed') multiplier *= 1.5;
  if (cell.foreground?.kind === 'monster') {
    if (cell.foreground.pet) multiplier *= 1.0;       // displace, free
    else if (DANGER_CLASS_FLAGS.has(cell.foreground.class)) multiplier *= 20;
    else multiplier *= 5;                              // generic hostile
  }
  if (cell.foreground?.kind === 'unseen-monster') multiplier *= 10;
  if (cell.foreground?.kind === 'warning') multiplier *= cell.foreground.tier * 4;
  return base * multiplier;
}
```

The `DANGER_CLASS_FLAGS` set: `dragon`, `lich`, `vampire`,
`wraith`, `demon` (per zettel
`dragons-and-demons-are-class-level-danger-flags`).

The new costs make the planner *prefer* detours over routing
through dangerous cells. A 5× cost increase is roughly "willing
to take 5 detour steps to avoid this neighbor" — a reasonable
default for a low-level character.

For `autopilot_explore`, the BFS-to-frontier already operates
on walkability; extend it to skip cells whose cost multiplier
exceeds a threshold (e.g. 10×). This means the explorer
naturally avoids high-danger areas without explicit halt.

### Layer 3: predict-and-avoid for tile-induced modals

The AP's per-step planning loop adds a *predicted-modal* check
*before* sending a key:

```ts
function willStepFireModal(cell: ClassifiedCell, options: ParanoidConfig): ModalPrediction | null {
  if (cell.terrain === 'trap_known' && options.paranoidTrap) {
    return { kind: 'paranoid-trap', resolveWith: 'm-prefix' };
  }
  if ((cell.terrain === 'water' || cell.terrain === 'lava') && options.paranoidSwim) {
    return { kind: 'paranoid-swim', resolveWith: 'refuse' };
  }
  if (cell.foreground?.kind === 'monster' && cell.foreground.pet) {
    return { kind: 'pet-displace', resolveWith: 'step' };  // safe
  }
  if (cell.foreground?.kind === 'monster' && !cell.foreground.pet) {
    return { kind: 'attack-or-peaceful', resolveWith: 'refuse' };
  }
  if (cell.foreground?.kind === 'item') {
    return { kind: 'pickup-prompt', resolveWith: 'm-prefix' };
  }
  return null;
}
```

The AP consumes the prediction:
- `resolveWith: 'm-prefix'` — the AP sends `m` + direction
  instead of bare direction. Bypasses the prompt.
- `resolveWith: 'step'` — the AP sends bare direction; engine
  silently displaces.
- `resolveWith: 'refuse'` — the AP marks the tile blocked and
  replans.

This makes peaceful tiles (refuse), pet tiles (step-through),
known traps (refuse, since the v1 default is don't-cross-
known-trap), water/lava (refuse, already non-walkable), and
item piles (m-prefix to skip pickup) deterministically handled
without the LLM round-trip.

The `ParanoidConfig` defaults: `paranoidTrap: true`,
`paranoidSwim: true`, `paranoidAttack: false` (the standard
NetHack 5.0.0 defaults). v2 leaves these hardcoded; a future
extension could parse `.nethackrc`.

### Layer 4: rendering-quirk detectors

Each quirk gets an explicit detector function and an AP rule:

| Detector | Source | AP rule |
|---|---|---|
| `detectEngulfed` | already in `interrupts.ts` | halt; do NOT update GameMap from this frame |
| `detectUnseenMonsterMarker` (`I`) | new | refuse to route adjacent; halt if `I` newly appeared |
| `detectWarningDigit` (`1`–`5`) | new | refuse to route into the cell; halt if tier ≥ 4 newly appeared |
| `detectRogueLevel` | already in `parsers.ts` | refuse autopilot on this floor |
| `detectSokoban` | already via `BRANCH_PATTERNS` | refuse autopilot on this floor |
| `detectColoredCorridor` | new | tree/iron-bars → non-walkable; engraving `#` → walkable |

The detectors live alongside `interrupts.ts` and the
`parsers.ts` glyph-classification helpers. New interrupts:
- `unseen_monster_visible` (priority ~245, just below
  `monster_visible`).
- `warning_high` (priority ~243, fires on a tier-4 or tier-5
  digit appearing).

### Layer 5: recognition rubrics

Inline recognition rubrics for the 7 highest-leverage AP
decision points. These follow the format from
`recognition-rubric-format` (Klein RPD knowledge audit). They
go in the AP code as comment blocks above the relevant
function and in this spec for the design discussion.

#### Rubric 1: should I attack-swap with this adjacent letter?

The AP is at position `(px, py)`. A letter glyph occupies
`(px + dx, py + dy)`, on the planned path. Should the AP step?

##### Cues that indicate "yes, step (it's safe)"
- The cell's `foreground.pet === true` (inverse attribute set
  by `hilite_pet`).
- Color matches a known shopkeeper / priest / Oracle pattern
  *and* the AP only intends to displace, not attack — but this
  v2 rubric does not yet support shopkeeper classification.

##### Cues that indicate "no, refuse"
- `foreground.pet === false` and `foreground.class ∈
  DANGER_CLASS_FLAGS`. Hard refuse.
- `foreground.pet === false`, class not in danger set, but
  `foreground.color` not yet matched to a known peaceful
  pattern. Default-conservative: refuse.
- `foreground.kind === 'unseen-monster'` (`I` glyph). Refuse.
- `foreground.kind === 'warning'` and `tier >= 3`. Refuse.

##### Atypical / surprising versions
- A `@` adjacent to the player. Could be the player's pet
  human (rare; some role allows), a peaceful elf, a hostile
  shopkeeper (if the player upset them). Treat as
  unidentified-letter and refuse.
- An item glyph (`?`/`!`/etc.) adjacent — not a letter, but
  the AP is *also* deciding whether to step onto an item pile.
  Use `m`-prefix to step without picking up.

##### Common novice errors
- Treating a non-pet `d` as safe because "early-game `d` is
  probably the kitten that escaped". The kitten retains its
  inverse attribute even when not adjacent; a non-inverse `d`
  is not the pet.
- Sending `y` (NW) into a peaceful's spot, hitting the
  `[yn]` modal, and the LLM's resumed `y` answer becoming
  "yes, attack". The fix is upstream: refuse the step.

##### Expert shortcuts
- If the cell's monster class is in `DANGER_CLASS_FLAGS`,
  abort the entire AP loop, not just refuse this step. The
  planner can't generate a safe path adjacent to a `D`.

#### Rubric 2: is this open tile safe to step onto?

The AP is about to step onto `(tx, ty)`. The terrain there is
walkable per the classifier. Is the step safe?

##### Cues for "yes, safe"
- `terrain ∈ {floor, corridor, door_open}` AND `foreground === null`
  AND no adjacent monster glyph in any of the 8 surrounding
  cells.
- `terrain === 'door_closed'` AND no Conf/Stun/Fumble in
  status conditions (autoopen-and-step works).

##### Cues for "no, refuse"
- `terrain === 'trap_known'` (always refuse; `paranoid:trap`
  fires).
- `terrain ∈ {water, lava}` (always refuse; `paranoid:swim`
  fires).
- Adjacent (8-conn) cell contains a danger-class monster
  (`D`/`L`/`V`/`W`/`&`).
- Adjacent cell contains the `I` unseen-monster marker.
- Adjacent cell contains a digit `4` or `5` Warning.
- Status conditions include Conf/Stun and the target is
  `door_closed` (autoopen disabled).

##### Atypical
- Step onto stairs (`<` or `>`): walkable but the AP's
  policy is "never auto-traverse stairs"; the AP can step
  *onto* the stairs but never traverse them.
- Step onto a fountain/altar/throne/grave: walkable; safe;
  but the AP doesn't auto-interact (those are LLM-scoped
  decisions).

##### Common novice errors
- Treating any `.` as safe. A `.` with an adjacent unseen
  monster glyph is a step into a known trap — not the tile
  trap, but the engagement trap.
- Treating `door_closed` as universally walkable. Confused
  player can't autoopen.

##### Expert shortcuts
- A path that requires entering a room with `>=3` letter
  glyphs visible should be aborted at the room entrance, not
  step-by-step. Multiple monsters in one room is a fight, not
  a navigation.

#### Rubric 3: should this prompt cause an AP halt?

A frame arrives with text on the message line. Is it a modal
the AP must halt on?

##### Cues for "yes, halt"
- Message matches `--More--`, `[yn]`, `[ynaq]`, `[a-z]` letter
  menu, "In what direction?", "What do you want to <verb>?",
  "Pick up?", "Pick what?", "Really attack?", or the
  paranoid:* prompts.
- Message contains "[yes]" or "[no]" (paranoid_confirmation
  full-word mode).

##### Cues for "no, ordinary message"
- Message line is empty or contains a one-line description
  ("You see here a long sword.") that doesn't end in a `[`
  or `?`.
- Message is the engine's "movement feedback" output (from
  `mention_walls` or `mention_decor`).

##### Atypical
- Multi-line message that paginates: the first frame ends
  with `--More--` at the message line's end, even if the
  visible text is benign. Halt anyway — the next page may
  contain critical info.
- A bell sound (frame reason 'bell'): not a textual modal but
  a halt-worthy interrupt regardless.

##### Common novice errors
- Auto-dismissing `--More--` because the visible text looks
  benign. The pagination might hide an HP-critical message.
- Treating the absence of `?` or `[` as "no prompt". Some
  prompts don't have those characters (the special direction
  prompt may render as plain text in some interfaces).

##### Expert shortcuts
- The set of halt-worthy patterns is closed; matching any one
  pattern is sufficient. No need to check all of them.

#### Rubric 4: is the engine in a stable game state ready for movement?

Before sending any movement key.

##### Cues for "yes, ready"
- `parseStatusLine(rows[22], rows[23])` returns a non-sentinel
  result (HP token matched).
- Message line is empty or contains only a non-modal
  description.
- No `--More--` at message-line end.
- No active menu in rows 1-21 (heuristic: row 0 doesn't start
  with a typical menu prefix like `Pick which`).

##### Cues for "no, not ready"
- HP token doesn't match → the buffer is mid-redraw, in a
  menu, or showing a non-game screen.
- Message line ends with a modal prompt pattern.
- Game over (`runState.gameOver === true`).

##### Common novice errors
- Sending a key during a menu state because the bottom rows
  still look like a status line (some menus preserve the
  status bar visually).
- Assuming a non-empty message line means a prompt; many
  benign descriptions don't fire halts.

##### Expert shortcut
- The HP-token check is a single regex match per frame. Run
  it before every keystroke; the cost is negligible.

#### Rubric 5: should the AP attempt to displace through this pet?

Adjacent cell on the path is a classified pet
(`foreground.kind === 'monster' && foreground.pet === true`).

##### Cues for "yes, displace"
- The pet's class is `dog`, `feline`, or `unicorn` (the
  starting-pet classes). These are docile and reliably swap.
- The pet has been visible for ≥ 1 frame already; it's not a
  freshly-spawned wild creature whose pet-ness is uncertain.

##### Cues for "no, refuse"
- The pet's class is unusual (`dragon`, `demon` — those would
  be tamed via spell or scroll; rare but possible).
- The player is at low HP and routing requires the pet to
  swap into a more dangerous tile (the pet displacement might
  put it adjacent to a hostile that then attacks it).

##### Atypical
- Two pets adjacent in a line: stepping onto pet #1
  displaces it onto pet #2, which the engine handles
  (chain-displacement) but only if both are pets. This is
  rare; falls within the safe-displace policy.

##### Common novice errors
- Refusing to displace through pets at all (the v1 behavior).
  The cost is unnecessary detours and missed opportunities.
- Routing through a pet that's about to be attacked. The pet
  ends up in the player's prior position; if the AP's prior
  position is adjacent to a hostile, the swap puts the pet at
  risk.

##### Expert shortcut
- For starting pets at low experience level, displace-through
  is unconditionally safe. The pet retains all its hit points;
  it just changes position.

#### Rubric 6: should the AP refuse this entire floor?

When entering a new floor or starting a new AP call.

##### Cues for "yes, refuse"
- `floor.id.includes('Sokoban')` (boulder-puzzle, AP
  out-of-scope).
- `floor.isRogueLevel === true` (different glyphs).
- `floor.walkabilitySuspect === true` (polymorphed; current
  walkability inferences may be wrong).
- (New v2): `floor.id.includes('Quest')` (Quest mechanics
  beyond AP scope).

##### Cues for "no, proceed"
- Default for any other floor ID, including
  `D1`–`D45`, `Mines:N`, `Mines:Town`, `Bigroom`, `Oracle`,
  `Castle`.

##### Atypical
- The Castle (`Castle` floor ID): the AP can navigate it, but
  the drawbridge mechanic introduces dynamic terrain. This is
  AP-tractable but worth a per-floor refusal in v2.
- Bones levels (Guidebook §6.4): same as a regular floor
  visually but cursed-likely items. Not an AP issue;
  pickup is LLM-scoped.

##### Common novice errors
- Treating "the AP refused" as the LLM's problem to override.
  The refusal is a hard floor-level rule; the LLM should not
  re-issue the AP call.

##### Expert shortcut
- The refusal table is small; check once at AP entry and
  again at any floor transition.

#### Rubric 7: when has the AP successfully met its goal vs. when has it stopped on an interrupt?

`autopilot_to` and `autopilot_explore` need to distinguish
"arrived" / "explored" from "halted on interrupt".

##### Cues for "arrived" (autopilot_to)
- `currentPlayerXY === goal` after a step.
- `path.length === 0` and `currentPlayerXY === goal`.

##### Cues for "explored" (autopilot_explore)
- `pickAdjacentUnvisited === null` AND `bfsToFrontier ===
  null`. No reachable unvisited tiles.

##### Cues for "halted on interrupt"
- Any of the named interrupts fired: `monster_visible`,
  `low_hp`, `hp_drop`, `modal_prompt`, `engulfed`,
  `entered_trap_tile`, `paralyzed`, `unseen_monster_visible`
  (new), `warning_high` (new), and others.

##### Atypical
- Step-cap reached. This is neither arrived nor halted —
  it's "ran out of budget". The AP returns "step_cap" as the
  stop reason.
- Game-over signal mid-loop. The runner exited; the AP halts
  with `runner_exited` or the run-state's end reason.

##### Common novice errors
- Treating "step_cap" as a successful arrival. It's not.
- Treating "blocked_unreachable" as "no path exists"; it
  means "no path exists *given the engine's runtime
  refusals*". The map-time path was valid; the engine vetoed
  some tile.

##### Expert shortcut
- Stop-reason taxonomy is finite and stable; the parser
  consumer can switch on the prefix word.

## Concrete diff against existing AP

### `parsers.ts`

- **Add** `LETTER_TO_CLASS: Record<string, MonsterClass>` from
  `defsym.h` MONSYM enum.
- **Add** `colorFromStyle(style: CellStyle | undefined):
  number` (CLR_* mapping).
- **Replace** `classifyGlyph(char: string): TileKind | null`
  with `classifyCell(text: string, style: CellStyle |
  undefined): ClassifiedCell` returning the tuple.
- **Keep** `classifyGlyph` as a deprecated thin wrapper
  delegating to `classifyCell` for backward compatibility.

### `glyph-class.ts`

- **Deprecate** `GlyphClass` union and `classifyCell` —
  superseded by `parsers.ts:classifyCell`.
- **Keep** `buildGlyphClass` semantics during the migration;
  the consumer migrates to a new `buildClassifiedGrid` that
  produces a `ClassifiedCell[][]`.

### `game-map.ts`

- **Extend** `Tile` with `classified?: ClassifiedCell` (the
  per-frame foreground; resets each frame).
- **Replace** `pathfind`'s `tileCost` calculation with the
  v2 cost function consuming the classified cell.
- **Add** `excluded` set support to `pathfind` (already there
  per commit `0b31893`).
- **Add** a `classifiedAt(x, y, frame): ClassifiedCell` helper
  that consults the current frame's classified grid.

### `interrupts.ts`

- **Add** `detectUnseenMonsterMarker(rows): boolean` and
  interrupt `unseen_monster_visible` (priority 245).
- **Add** `detectWarningDigit(rows): { tier: number, x: number,
  y: number } | false` and interrupt `warning_high` (priority
  243; fires on tier ≥ 4).
- **Update** `MODAL_PATTERNS` to cover the full
  `What do you want to (eat|drink|read|wear|put on|take off|
  remove|wield|drop|throw|apply|zap)?` set (currently partial).
- **Add** `[yes]` / `[no]` patterns for
  `paranoid_confirmation:Confirm` mode.

### `tools/autopilot.ts`

- **Add** the `willStepFireModal` predict-and-avoid check
  before each step. Use `m`-prefix when the prediction returns
  `resolveWith: 'm-prefix'`.
- **Extend** the per-step keystroke from a single bare key to
  `[m-prefix?, direction-key]` based on prediction.
- **Update** `EXPLORE_FORBIDDEN_KINDS` to include the v2-aware
  classification: skip cells with high cost-multiplier in
  addition to the existing terrain refusal.
- **Add** floor refusal for `Quest` and `Castle` (per
  rubric 6).
- **Add** halt-on-interrupt for the new interrupts (no code
  change to handler; the existing `runInterruptChecks` walks
  the new entries).

### `tool-context.ts`

- **Extend** `FrameAwaitResult` with the per-frame classified
  grid: `classified: ClassifiedCell[][]`.

## Open questions (Guidebook silent or unclear)

Matt's decisions (2026-05-09) are inline below; the rest stand.

1. **Color → species mapping for monster classes.** *Decision:
   skip in v2; defer to v3.* The classifier still extracts and
   carries `color` per cell, but the danger-grading and
   pet/peaceful logic in v2 keys off the glyph letter and the
   `inverse` attribute alone. v3 picks up color→species when
   we know what we want from it (most likely after live-run
   traces show a class of misclassification that color would
   resolve).
2. **`paranoid_confirmation` parsing from `.nethackrc`.**
   *Decision: hardcode NetHack 5.0 defaults.* bobbihack invokes
   NetHack via `nethack-setup.ts`, which sets `NETHACKOPTIONS`
   directly — there is no user-supplied `.nethackrc` to
   consult. The hardcoded modal patterns assume the defaults
   bobbihack ships.
3. **Castle floor refusal vs. attempted navigation.**
   *Decision: deferred — Matt unsure, bobbihack runs are not
   reaching Castle in practice.* Plan Task 3.4 ships the
   refusal as the conservative move; flip to attempt when a
   real run reaches Castle and the drawbridge mechanic becomes
   load-bearing.
4. **Peaceful classification (shopkeeper / priest / Oracle by
   color).** *Decision: defer to v3.* v2 lumps peacefuls with
   hostiles for the `monster_visible` halt — strictly safer
   than the current "treat all non-pet letters as hostile" but
   not better. v3 adds peaceful disambiguation when (a) live
   traces show repeated halts in shops/temples and (b) the
   color→species mapping from open question #1 is in.
5. **Is `hilite_peaceful` ever supported in NetHack 5.0.0?**
   The bobbihack design doc (2026-05-07) says it's a rejected
   option. If a future NetHack version reintroduces it, the
   peaceful classifier becomes trivial. (v3 follow-up.)
6. **Does the engine emit a distinguishable signal when an
   item pile is mixed (some safe, some cursed)?** The pickup
   prompt is the same shape; the AP can't tell from prompt
   alone whether to skip. (v3 follow-up.)
7. **`paranoid_confirmation:trap` with the `Confirm` modifier
   requires `yes`/`no` — does this affect the regex pattern?**
   v2 should add the full-word case to be safe.
8. **The `:` (lizard) and `;` (sea monster) classes — these
   are class letters but not in `[a-zA-Z]`.** The classifier
   needs to handle them, but the existing
   `monster_visible`-style detector restricts to letters. v2
   should extend the regex.

## How v3 acquires its knowledge

v2 ships and runs. The places where the AP gets surprised
(modals not in `MODAL_PATTERNS`, monsters that should detour
that don't, terrain we misread) are recorded in `run.jsonl`
via the `autopilot_step` event (commit `8c534ba`). Those
traces are the curriculum for v3:

- Per-step trace shows exactly which keystroke surprised the
  AP and what the engine said. Example: the 148-step locked-
  door loop was diagnosable from logs in 30 seconds.
- When a class of surprise repeats, it becomes a new zettel +
  belief in the slip-box and a delta on this spec.
- For NetHack ground-truth that the Guidebook punted on
  (monster speed, hostility, color), the source tree
  (`include/monst.c`, `include/permonst.h`) is more
  authoritative than the wiki and is locally fetchable.
- Targeted wiki pages (one specific question, one page) are
  the third-line source — sparingly, since the agent currently
  hits 403 on the wiki.

The principle: v2 is a hypothesis. Live runs falsify it.
Don't read more Guidebook in a vacuum; let the traces tell us
what to study next.

## Test plan

Add fixtures to
`packages/blinkyterm/test/smoke/bobbihack.autopilot-nav.test.ts`
covering:

1. **Pet displacement**: a fixture with a pet (inverse-styled)
   on the planned path between `@` and `*`. Assert the AP
   steps through, the pet ends up at the player's prior
   position, no `monster_visible` interrupt fires.
2. **Hostile-letter refusal**: a fixture with a non-pet `d`
   between start and goal. Assert `autopilot_to` halts with
   `monster_visible` and the player did not bump.
3. **Danger-class detour**: a fixture with a `D` (dragon)
   adjacent to the shortest path; an alternate path exists 5+
   tiles longer. Assert the AP routes the longer path.
4. **`I` marker refusal**: fixture with an `I` glyph on the
   planned path. Assert the AP refuses to route through and
   halts with `unseen_monster_visible`.
5. **Warning-digit refusal**: fixture with `4` glyph
   adjacent. Assert `warning_high` interrupt fires and AP
   halts.
6. **Pickup prompt avoidance**: fixture with item `?` on the
   path, AP intends only to traverse. Assert AP sends `m`-
   prefix + direction and no pickup prompt fires.
7. **Trap predict-and-refuse**: fixture with `^` known trap on
   the path. Assert AP refuses to route through (existing
   behavior), and the prompt doesn't fire because the AP
   didn't step.
8. **Confused-state door refusal**: fixture with `Conf` in
   status, closed door on path. Assert AP refuses to route
   through (autoopen disabled).
9. **`m`-prefix for water-step (advanced)**: fixture with
   levitation status, water on the path, AP allowed to
   traverse. Assert AP sends `m`-prefix and crosses without
   the swim refusal. (Stretch goal; likely deferred to v3.)
10. **Engulfed false-positive on plain wall**: regression
    fixture with `@` adjacent to a plain horizontal wall but
    NOT engulfed. Assert no `engulfed` interrupt fires.
    (Already tested per commit `0b31893`; spec expands
    coverage.)
11. **Classifier round-trip**: unit test that
    `classifyCell('d', { inverse: true, foreground: 7 })`
    returns a `ClassifiedCell` with `foreground.kind ===
    'monster' && pet === true && class === 'dog'`.
12. **Color-disambiguated `}`**: unit test that a red `}`
    classifies as lava and a blue `}` as water; both
    non-walkable.
13. **MonsterClass coverage**: unit test asserting all 60
    `MONSYM` entries map to a unique class name.
14. **Floor refusal table**: unit test asserting Sokoban,
    Rogue, Quest, walkability-suspect floors are refused;
    main dungeon and Mines are accepted.

## Referenced beliefs

This spec enacts these committed first-person beliefs:

- `ap-monster-classification-must-be-tuple-not-letter` —
  Layer 1.
- `ap-routing-must-predict-modals-not-just-react-to-them` —
  Layer 3.
- `ap-conservatism-on-unknown-letters-is-the-correct-default`
  — recognition rubric 1.
- `ap-design-must-treat-rendering-quirks-as-first-class-input`
  — Layer 4.

## Referenced zettels (cluster index)

The slip-box at `packages/blinkyterm/examples/bobbihack/notes/`
holds 41 zettels in 4 main clusters:

- **Glyph classification** — `terrain-glyph-overloading-…`,
  `letter-glyphs-are-classes-not-species`, `i-glyph-is-…`,
  `digits-1-5-are-…`, `monster-letter-color-attrs-is-…`,
  `corridor-pound-glyph-overloads-…`,
  `transient-glyphs-do-not-erase-recorded-terrain`,
  `uppercase-monster-letters-…`, `dragons-and-demons-are-…`.
- **Movement & combat semantics** — `vi-key-prefixes-…`,
  `m-prefix-disables-…`, `f-prefix-forces-attack-…`,
  `bumping-a-monster-tile-is-the-attack-contract`,
  `peaceful-attack-prompt-is-yn-…`,
  `pet-displacement-is-silent-and-safe`,
  `fighting-by-bumping-makes-letter-classification-safety-critical`.
- **Doors, traps, and refused steps** —
  `open-doors-block-diagonal-movement`,
  `closed-doors-auto-open-on-bump-…`,
  `locked-doors-consume-a-turn-…`,
  `booby-trapped-doors-detonate-…`,
  `unknown-traps-render-as-floor`,
  `paranoid-trap-prompt-blocks-…`,
  `paranoid-swim-prevents-water-lava-…`,
  `silent-no-move-means-engine-refused`,
  `search-command-is-the-only-way-…`.
- **Modals, frames, and floor identity** —
  `modal-prompt-grammar-has-a-finite-shape-catalog`,
  `more-marker-is-the-paginated-message-modal`,
  `in-what-direction-prompt-…`,
  `what-do-you-want-prompts-…`,
  `pickup-prompt-fires-on-walking-…`,
  `status-line-bottom-row-hp-token-is-the-nethack-fingerprint`,
  `dlvl-plus-branch-is-the-floor-identity`,
  `line-of-sight-determines-monster-rendering`,
  `unseen-monster-marker-i-persists-until-disproven`,
  `engulfed-rendering-is-a-distinct-3x3-frame`,
  `rogue-level-uses-different-glyphs`,
  `sokoban-restricts-boulder-pushes-to-cardinals`.
- **AP-design synthesis** —
  `ap-glyph-classifier-must-expose-letter-color-attrs-as-tuple`,
  `ap-must-refuse-to-step-rather-than-halt-on-known-modal-tiles`,
  `ap-route-cost-must-encode-danger-class-not-just-walkability`,
  `ap-prompts-have-fixed-shapes-recognizable-without-llm`.

Run `slipbox show <slug>` from
`packages/blinkyterm/examples/bobbihack/` to surface any
zettel's body and its forward + back-references.
