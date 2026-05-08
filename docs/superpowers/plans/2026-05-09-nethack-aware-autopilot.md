# NetHack-aware autopilot — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> `superpowers:subagent-driven-development` (recommended) or
> `superpowers:executing-plans` to implement this plan
> task-by-task. Steps use checkbox (`- [ ]`) syntax for
> tracking.

**Goal:** Implement the design at
`docs/superpowers/specs/2026-05-09-nethack-aware-autopilot.md`.
Replace the bobbihack autopilot's terrain-only classifier with
a `(terrain, monster, item)` tuple, extend the route planner to
weight by danger and predict tile-induced modal prompts, and add
detectors for the rendering quirks (`I`, `1`-`5`, colored `#`,
extended modal patterns).

**Architecture (4 layers, see spec §"v2 design"):**
1. New `ClassifiedCell` type produced by a v2 `classifyCell` in
   `parsers.ts` consuming a FrameSnapshot CellStyle. Replaces
   the parallel `classifyGlyph` + `classifyCell` (in
   `glyph-class.ts`) split.
2. `game-map.ts:pathfind` consumes the classified grid for a
   v2 cost function (danger-class, generic-hostile, pet,
   warning-digit multipliers).
3. `tools/autopilot.ts` adds `willStepFireModal` predict-and-
   avoid before each step; uses `m`-prefix for safe-displace
   and skip-pickup cases.
4. New rendering-quirk detectors and interrupts:
   `detectUnseenMonsterMarker`, `detectWarningDigit`,
   `detectColoredCorridor`; new interrupts
   `unseen_monster_visible`, `warning_high`.

**Tech stack:** Bun 1.3.13, TypeScript 5.x. No native or
release-pipeline changes. All work inside
`packages/blinkyterm/examples/bobbihack/`.

**Phases:**
- **Phase 1 (Tasks 1.1–1.6):** Classifier rewrite. Self-contained;
  ships behind the existing `classifyGlyph`/`classifyCell`
  consumers as a parallel layer until Phase 2 cuts over.
- **Phase 2 (Tasks 2.1–2.5):** GameMap + pathfind cost model
  upgrade. Depends on Phase 1.
- **Phase 3 (Tasks 3.1–3.6):** Autopilot predict-and-avoid +
  new detectors + new interrupts. Depends on Phase 2.
- **Phase 4 (Tasks 4.1–4.3):** Test fixtures, regression
  coverage, end-to-end smoke.

Each phase ships a green `bun test test/smoke` before the next
starts. The order is hard — later phases depend on the earlier
artifacts.

**Reference:**
- Spec: `docs/superpowers/specs/2026-05-09-nethack-aware-autopilot.md`.
- Slip-box: `packages/blinkyterm/examples/bobbihack/notes/`.
- Beliefs invoking this work:
  `notes/beliefs/ap-monster-classification-must-be-tuple-not-letter.md`,
  `notes/beliefs/ap-routing-must-predict-modals-not-just-react-to-them.md`,
  `notes/beliefs/ap-conservatism-on-unknown-letters-is-the-correct-default.md`,
  `notes/beliefs/ap-design-must-treat-rendering-quirks-as-first-class-input.md`.
- NetHack 5.0 source data:
  `https://github.com/NetHack/NetHack/blob/NetHack-5.0/include/defsym.h`
  (MONSYM enum) and
  `https://github.com/NetHack/NetHack/blob/NetHack-5.0/include/color.h`
  (CLR_*).

**Worktree:** Recommended — branch from `main` into
`.worktrees/nethack-aware-autopilot` per
`superpowers:using-git-worktrees`. Phase 1 alone is shippable
as a no-op refactor; later phases change AP behavior visibly.

**Reporting checkpoints to Matt:** end of Phase 2 (cost model
in place; pathfinding now danger-aware), end of Phase 3 (full
predict-and-avoid live; ready for production smoke).

---

## File map

**New files:**
```
packages/blinkyterm/examples/bobbihack/cell-classifier.ts
packages/blinkyterm/examples/bobbihack/danger-classes.ts
packages/blinkyterm/examples/bobbihack/modal-prediction.ts
```

**Modified files:**
```
packages/blinkyterm/examples/bobbihack/parsers.ts
packages/blinkyterm/examples/bobbihack/glyph-class.ts
packages/blinkyterm/examples/bobbihack/game-map.ts
packages/blinkyterm/examples/bobbihack/interrupts.ts
packages/blinkyterm/examples/bobbihack/tools/autopilot.ts
packages/blinkyterm/examples/bobbihack/tool-context.ts
packages/blinkyterm/test/smoke/bobbihack.autopilot-nav.test.ts
```

---

## Phase 1 — Cell classifier rewrite (no behavior change)

The goal is to produce the new `ClassifiedCell` tuple and have
it computable from a FrameSnapshot. This phase does NOT change
any AP behavior; it only adds the new shape alongside the
existing `classifyGlyph` + `classifyCell`.

### Task 1.1: Add the MonsterClass union and letter table

**Files:**
- Create: `packages/blinkyterm/examples/bobbihack/cell-classifier.ts`

- [ ] **Step 1: Define `MonsterClass`** as a string-literal
  union of all 60 entries from the MONSYM enum in
  `include/defsym.h`. Source:
  `https://raw.githubusercontent.com/NetHack/NetHack/NetHack-5.0/include/defsym.h`.

- [ ] **Step 2: Define `LETTER_TO_CLASS`**: `Record<string,
  MonsterClass>` keyed by the ASCII char. 60 entries: 26
  lowercase + 25 uppercase (skipping `I`) + `@` + `&` + `'`
  + `:` + `;` + `~` + `]`.

- [ ] **Step 3: Unit test** that all 60 keys present and all
  values are unique. Add to a new test file
  `packages/blinkyterm/test/smoke/bobbihack.classifier.test.ts`.

### Task 1.2: Define ClassifiedCell

**Files:**
- Modified: `packages/blinkyterm/examples/bobbihack/cell-classifier.ts`

- [ ] **Step 1: Define `ClassifiedCell`** per spec §"Layer 1".
  Re-use `TileKind` from `parsers.ts`.

- [ ] **Step 2: Define `colorFromStyle`**: maps the SGR
  foreground color (CellStyle → number) to the CLR_* range
  0–15. Use the standard 16-color terminal palette.

- [ ] **Step 3: Unit test** that a sample CellStyle with
  `inverse: true` and `foreground: 7` produces the expected
  classified output for various letters.

### Task 1.3: Implement classifyCell (the new one)

**Files:**
- Modified: `packages/blinkyterm/examples/bobbihack/cell-classifier.ts`

- [ ] **Step 1: Write `classifyCell(text, style):
  ClassifiedCell`** that computes terrain + foreground in one
  pass.
- Terrain is delegated to a refactored
  `parsers.ts:classifyTerrain` that handles the `}` lava-vs-
  water and `#` corridor-vs-tree disambiguation by color.
- Foreground is computed from the letter (via
  `LETTER_TO_CLASS`), the inverse attribute (pet),
  and item-glyph regex (the existing `[?!()=*$%/"\[\]]` set).
- The `I` glyph produces `kind: 'unseen-monster'`.
- Digits `1`-`5` produce `kind: 'warning'`.
- The `@` at the player's position produces `kind: 'player'`.

- [ ] **Step 2: Unit tests** for each foreground kind, with
  varied colors and inverse flags.

### Task 1.4: Refactor parsers.ts terrain classification

**Files:**
- Modified: `packages/blinkyterm/examples/bobbihack/parsers.ts`

- [ ] **Step 1: Add `classifyTerrain(text, style)`** that
  takes the cell style for the color signal. Distinguishes:
  - `}` red → lava, `}` blue → water, default water.
  - `#` green → tree, `#` cyan → iron_bars, default corridor.
  - `_` default altar (rare iron-chain misclassification
    accepted in v2).

- [ ] **Step 2: Keep `classifyGlyph(text)`** for backward
  compat; delegate to `classifyTerrain(text, undefined)`. Mark
  with a `@deprecated` JSDoc.

- [ ] **Step 3: Unit test** the new color-driven behavior.

### Task 1.5: Wire FrameSnapshot → ClassifiedCell grid

**Files:**
- Modified: `packages/blinkyterm/examples/bobbihack/cell-classifier.ts`

- [ ] **Step 1: Implement `buildClassifiedGrid(snapshot, rows,
  playerXY): ClassifiedCell[][]`** that walks the rows and
  produces the 2D grid. Mirrors the shape of
  `glyph-class.ts:buildGlyphClass` but returns the full tuple.

- [ ] **Step 2: Decide on map-row restriction**: only rows 1
  through `rows.length - 3` are map rows; rows 0, 22, 23 are
  message/status. The classifier returns `terrain: null,
  foreground: null` for non-map rows (same logic as
  `interrupts.ts:isMapRow`).

- [ ] **Step 3: Unit test** with a representative 80×24
  fixture.

### Task 1.6: Phase 1 gate

- [ ] **Step 1:** Run `bun test test/smoke` — all existing
  tests must pass. The new types and functions are added;
  none of the existing AP/GameMap/interrupts code consumes
  them yet, so behavior is unchanged.

- [ ] **Step 2:** Commit with `feat(bobbihack): add v2 cell
  classifier (no behavior change)`.

---

## Phase 2 — GameMap + pathfind cost model

The goal is to consume the classified grid in pathfinding,
producing danger-aware paths. This phase changes AP routing
behavior.

### Task 2.1: Extend FrameAwaitResult with classified grid

**Files:**
- Modified: `packages/blinkyterm/examples/bobbihack/tool-context.ts`

- [ ] **Step 1: Add `classified: ClassifiedCell[][]`** to
  `FrameAwaitResult`. Optional during the migration so existing
  tests don't immediately break.

- [ ] **Step 2: Update the conductor / sendKeysAndWait
  implementation** (search for where FrameAwaitResult is
  populated) to call `buildClassifiedGrid` after each frame
  and attach the result.

- [ ] **Step 3: Run** `bun test test/smoke` — the change is
  backward compatible if `classified` is optional.

### Task 2.2: Add danger-classes table

**Files:**
- Create: `packages/blinkyterm/examples/bobbihack/danger-classes.ts`

- [ ] **Step 1: Define `DANGER_CLASS_FLAGS: ReadonlySet<MonsterClass>`**
  per spec §"Layer 2": `dragon`, `lich`, `vampire`, `wraith`,
  `demon`. v0 set; expandable.

- [ ] **Step 2: Export a `dangerWeight(cell): number`** helper
  that returns the cost multiplier per spec.

### Task 2.3: Pathfinder cost upgrade

**Files:**
- Modified: `packages/blinkyterm/examples/bobbihack/game-map.ts`

- [ ] **Step 1: Extend `pathfind` signature** to optionally
  accept a `classifiedGrid: ClassifiedCell[][]` parameter. When
  provided, consult it for cost.

- [ ] **Step 2: Replace the `tileCost = closed-door ? 1.5 :
  1`** logic with the v2 `dangerWeight`-aware cost from
  Task 2.2.

- [ ] **Step 3: Cap multipliers** so a single danger-class
  monster doesn't make the whole grid impassable when no
  alternate path exists. The cost is *additive* (longer path),
  not blocking.

- [ ] **Step 4: Existing test** for pathfind without classified
  grid should still pass — the function behaves as before when
  the grid arg is omitted.

### Task 2.4: Update GameMap.updateFromFrame

**Files:**
- Modified: `packages/blinkyterm/examples/bobbihack/game-map.ts`

- [ ] **Step 1: Cache the latest classified grid** on
  `GameMap` (or pass it through to `pathfind` from each call
  site). Decision: cache on the GameMap to keep the consumer
  surface narrow.

- [ ] **Step 2: Verify** transient-glyphs-don't-erase-terrain
  invariant still holds. The classified grid is per-frame; the
  terrain layer in `floor.tiles` persists across frames. The
  pathfinder consults *both*.

### Task 2.5: Phase 2 gate

- [ ] **Step 1:** Run `bun test test/smoke` — all existing
  tests pass; new path-cost behavior is dormant in tests that
  don't construct a classified grid.

- [ ] **Step 2:** Commit `feat(bobbihack): danger-aware
  pathfind cost model`.

---

## Phase 3 — Autopilot predict-and-avoid + detectors

The goal is to wire the classifier and the cost model into the
AP's per-step decision, add the new detectors and interrupts,
and update `tool-context.ts` for the m-prefix path.

### Task 3.1: Add modal-prediction module

**Files:**
- Create: `packages/blinkyterm/examples/bobbihack/modal-prediction.ts`

- [ ] **Step 1: Implement `willStepFireModal(targetCell,
  options): ModalPrediction | null`** per spec §"Layer 3".
  The function is pure; takes the classified target cell and
  returns the predicted modal class and resolution.

- [ ] **Step 2: Define `ParanoidConfig`** with v2 hardcoded
  defaults: `{ paranoidTrap: true, paranoidSwim: true,
  paranoidAttack: false }`.

- [ ] **Step 3: Unit test** each of the predicted modal
  classes with representative classified cells.

### Task 3.2: Update interrupts.ts with new detectors

**Files:**
- Modified: `packages/blinkyterm/examples/bobbihack/interrupts.ts`

- [ ] **Step 1: Add `detectUnseenMonsterMarker(rows): { x: number, y: number } | false`**.
  Searches map rows for the `I` glyph (single character, not
  inside a word).

- [ ] **Step 2: Add `detectWarningDigit(rows): { tier: number, x: number, y: number } | false`**.
  Searches map rows for digits `1`-`5` that are isolated
  (surrounded by non-digit/non-letter context to avoid
  matching numeric content in the message line — though the
  `isMapRow` filter handles the message-line case already).

- [ ] **Step 3: Add interrupts**:
  - `unseen_monster_visible` (priority 245).
  - `warning_high` (priority 243; fires when the detected
    digit's tier is ≥ 4 and was not present in `prev` frame).

- [ ] **Step 4: Update `MODAL_PATTERNS`** to cover the full
  `What do you want to (eat|drink|read|wear|put on|take off|
  remove|wield|drop|throw|apply|zap)?` set, plus `[yes]`/`[no]`
  for paranoid-Confirm mode.

### Task 3.3: Wire predict-and-avoid into autopilot.ts

**Files:**
- Modified: `packages/blinkyterm/examples/bobbihack/tools/autopilot.ts`

- [ ] **Step 1: Pull the classified grid** from
  `FrameAwaitResult.classified` after each step. Hand it to
  `pathfind` for the next replan.

- [ ] **Step 2: Before sending each direction key**, look up
  the target cell in the classified grid and call
  `willStepFireModal`.

- [ ] **Step 3: Branch on the prediction**:
  - `null` (no predicted modal): send bare direction.
  - `resolveWith: 'm-prefix'`: send `m` + direction.
  - `resolveWith: 'step'` (pet displace): send bare direction.
  - `resolveWith: 'refuse'`: add target to `blockedTiles` and
    replan. (This is the same handler as the position-unchanged
    fallback from §"silent-no-move-means-engine-refused".)

- [ ] **Step 4: Update `EXPLORE_FORBIDDEN_KINDS`** to also
  consider the classified-cell danger weight: skip cells with
  multiplier > 10× in `pickAdjacentUnvisited` and
  `bfsToFrontier`.

### Task 3.4: Add Quest and Castle floor refusals

**Files:**
- Modified: `packages/blinkyterm/examples/bobbihack/tools/autopilot.ts`

- [ ] **Step 1: Update `floorRefusalReason`** to include
  Quest (`floor.id.includes("Quest")`) and optionally Castle
  (`floor.id === "Castle"`). Decision: include both per
  spec rubric 6.

### Task 3.5: Sendkeys path for m-prefix

**Files:**
- Modified: `packages/blinkyterm/examples/bobbihack/tools/autopilot.ts`
- Modified: `packages/blinkyterm/examples/bobbihack/tool-context.ts`

- [ ] **Step 1:** The AP's existing `sendKeysAndWait` accepts
  a single key. Verify the underlying conductor accepts a
  string of arbitrary length so `sendKeysAndWait("ml")` (m +
  l) sends both keys without an intervening frame await. If
  not, add a `sendKeysSequenceAndWait(keys: string)` helper
  that sends the full sequence and awaits one frame.

- [ ] **Step 2:** Update the per-step trace in
  `logAutopilotStep` to record the actual keystroke sent
  (with or without prefix).

### Task 3.6: Phase 3 gate

- [ ] **Step 1:** Run `bun test test/smoke` — existing tests
  must still pass. New behaviors will fail any test that
  expects the old reactive-modal-halt; update those expectations
  in Phase 4.

- [ ] **Step 2:** Manual smoke run with `BOBBIHACK_AGENT=mock`
  on a saved-game seed if available; otherwise visual
  inspection of a live run.

- [ ] **Step 3:** Commit `feat(bobbihack): predict-and-avoid
  modal prompts; danger-aware autopilot routing`.

---

## Phase 4 — Test fixtures and regression coverage

The goal is to lock in the v2 behavior with fixtures so future
regressions surface in CI rather than in production.

### Task 4.1: Add the 14 fixture cases from spec §"Test plan"

**Files:**
- Modified: `packages/blinkyterm/test/smoke/bobbihack.autopilot-nav.test.ts`

For each of the 14 cases listed in the spec's test plan, add a
fixture and an assertion. Group as:

- [ ] **Step 1:** Pet-displacement fixtures (cases 1, 5).
- [ ] **Step 2:** Danger-class detour fixtures (cases 2, 3).
- [ ] **Step 3:** Marker-refusal fixtures (cases 4, 5).
- [ ] **Step 4:** Modal-prediction fixtures (cases 6, 7, 8).
- [ ] **Step 5:** Classifier unit tests (cases 11, 12, 13).
- [ ] **Step 6:** Floor-refusal unit test (case 14).
- [ ] **Step 7:** Engulfed regression (case 10).

The fixture harness's `parseFixture` already parses
`@`/`*`/locked-doors. Extend it with:
- A `petPositions` field for marking inverse-styled letters.
- A `monsterColors` map for setting per-cell colors.
- A `playerStatus` field for setting `Conf` / `Stun` /
  `levitating` etc.

### Task 4.2: Update existing tests that now exhibit changed behavior

- [ ] **Step 1:** Identify tests in
  `bobbihack.autopilot-nav.test.ts` whose expected
  `stopReason` was `monster_visible` and now becomes a
  predict-and-avoid refusal. Rewrite expectations.

- [ ] **Step 2:** Run with `--update-snapshots` if any
  snapshot tests exist (none today, but check).

### Task 4.3: End-to-end smoke

- [ ] **Step 1:** Run `bun run test` (smoke + tarball). All
  tests pass.
- [ ] **Step 2:** Run a brief live NetHack session with
  `BOBBIHACK_AGENT=mock` and the v2 AP enabled; verify no
  regressions in basic exploration.
- [ ] **Step 3:** Commit `test(bobbihack): v2 autopilot
  fixtures`.

---

## Out of scope for v2 (future work)

These are mentioned in the spec's "Open questions" and are not
in this plan's tasks:

- Color-to-species mapping for monster classes (would let the
  AP know "red dragon" vs "green dragon" specifically).
- Peaceful classification beyond "color-tagged shopkeeper /
  priest / Oracle". Generic peacefuls remain conservative-
  refused.
- Searching for secret doors / corridors (AP does not search;
  v2 still treats dead-ends as truly dead).
- `paranoid_confirmation` parsing from `.nethackrc`. v2 uses
  hardcoded NetHack 5.0 defaults.
- Sokoban solving, Quest navigation, Castle drawbridge —
  refused at floor level per rubric 6.

---

## How to verify each phase

After each phase, run:

```bash
cd packages/blinkyterm
bun test test/smoke/bobbihack
```

Phase 1: tests pass with no behavior change.
Phase 2: tests pass; pathfind paths may differ but stop-reasons
unchanged.
Phase 3: some existing tests will need expectations updated to
reflect predict-and-avoid; new fixtures cover the new
behaviors.
Phase 4: full coverage; production-ready.

## Reporting back

When complete, report to Matt:

1. The 14 fixtures' pass/fail status.
2. The diff in stop-reasons for the existing fixture suite
   (which were re-classified from reactive-halt to predict-
   refuse).
3. Any open questions from spec §"Open questions" that
   surfaced as concrete blockers during implementation.
4. Estimated production cost reduction (if measurable from
   the mock-agent run): rough count of avoided modal halts
   across a typical exploration of 50+ tiles.
