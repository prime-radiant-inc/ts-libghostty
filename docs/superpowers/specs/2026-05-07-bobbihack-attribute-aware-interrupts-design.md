# Bobbihack — Attribute-Aware Autopilot Interrupts

**Author:** Breq (Bob `0f89d5a7`/Opus 4.7), with probe findings by Trout (Bob `0f89d5a7`/Opus 4.7)
**Date:** 2026-05-07
**Status:** implemented (revision 3 — smoke test debugged end-to-end). Pet path landed in commits 1269049 and the follow-up rewriting `bobbihack.autopilot-pet.test.ts` as a real end-to-end test against `handleAutopilotExplore` (the original test passed vacuously because NetHack's third startup prompt — "Do you want a tutorial?" — is a yn query that won't dismiss on space, and the splash loop had no handler for it; subsequent keystrokes were silently swallowed and frames came back as 5s heartbeats, masking the fact that the autopilot was never exercised).
**Scope:** `packages/blinkyterm/examples/bobbihack/` — interrupt detector + frame snapshot pipeline

## Probe results (2026-05-07)

Trout ran the probe against the brew NetHack 5.0.0 binary. Findings:

- **Pet attribute confirmed:** the player's adjacent pet (kitten in one run, small dog in another) renders with `style.inverse === true`. The player `@` renders with `style.inverse === false`. No other dungeon cells were `inverse: true`. **`pet ⇔ inverse: true` holds for this build.**
- **`hilite_peaceful` is rejected by NetHack 5.0.0.** Setting it produces a startup error: `* Unknown option 'hilite_peaceful'. 1 error in NETHACKOPTIONS. Hit return to continue:` — every game would start with a modal the autopilot would have to dismiss. Not a no-op, actively harmful.

**Decision:** ship pet-only classification. Drop the peaceful branch entirely — `GlyphClass` is two-state (`pet | normal`), not three. Peacefuls (shopkeepers, priests, the Oracle, watchmen, peaceful humans/monsters) are treated as `normal` and will trip `monster_visible` like a hostile would. This is a known limitation, documented in "Risks and fallbacks" #4. Revisit when it actually bites in a Mines Town / Quest / Oracle run.

`nethackEnv()` adds **only** `hilite_pet`, not `hilite_peaceful`.

The probe script lives at `packages/blinkyterm/examples/bobbihack/scripts/probe-hilite.ts` — the implementation Bob can reuse its helpers (`describeCell`, `findPlayer`, dungeon-frame await loop) and delete it after step 8.

---

## Problem

`autopilot_to` and `autopilot_explore` abort on every step when a pet is on the
screen. The pet moves each game turn (and swaps with `@` when the player walks
into it), so its glyph appears in a position it didn't occupy in the previous
frame, and `detectMonsterAppeared` (`interrupts.ts:43-63`) flags that as the
`monster_visible` interrupt. The autopilot's loop terminates immediately.

This is not a pathfinding bug. Pets don't block movement — NetHack auto-swaps
pet ↔ player when the player walks into a pet's tile. The bug is purely in
**glyph classification**: the detector treats every non-`@` letter as hostile.

Today we have no way to tell pet from kobold from shopkeeper. Plain `rows:
string[]` carries glyphs but not the rendering attributes NetHack uses to
distinguish them.

## Goals

1. Autopilot does not abort on pet movement.
2. ~~Autopilot does not abort on peaceful NPCs.~~ **Deferred** — see Probe
   results. Peacefuls are treated as hostile in this revision; autopilot
   will stop on them. Documented limitation, not a regression from the
   pre-fix behavior.
3. Autopilot continues to abort on hostile monsters.
4. The detector defaults to "treat as hostile" when classification is uncertain
   — safety bias.
5. The change is local: extend the existing frame pipeline, do not invent a new
   one.

## Non-goals

- Solving NetHack's full peaceful-vs-hostile model. Some tricky cases (a
  peaceful that turns hostile after you steal from a shopkeeper, a tame pet
  going feral from a stale pet-feeding) are handled correctly *as a side
  effect* of the attribute flipping mid-frame, but we don't add bespoke logic
  for them.
- Pet pathfinding awareness. Pets still aren't tile occupants in `GameMap`. We
  only need to recognize them for the interrupt decision, not plan around
  them.
- Tile-mode rendering. NetHack tile mode uses graphical tiles; this design
  assumes default text mode (which is what bobbihack runs).
- Other interrupts (`pet_attacking_you`, `low_hp`, `hp_drop`, etc.). They keep
  working as-is.

## Today's pipeline (load-bearing details)

`packages/blinkyterm/examples/bobbihack/main.ts:576-614` — `sendKeysAndWait`:

1. Sends keystrokes to `runner.sendText`.
2. Awaits the next frame from `runner.frames()`.
3. Builds `rows = frame.snapshot.text.split("\n")`.
4. Returns `FrameAwaitResult { rows, status, message, frameReason, screenAnsi }`.

`packages/blinkyterm/src/internal/snapshot.ts` — `buildFrameSnapshot`:

- Already iterates `renderState.rows()` and freezes per-cell `CellInfo`
  including `style?: CellStyle`.
- Exposes `frame.snapshot.cellAt(x, y) → CellInfo | null`.
- `CellStyle.inverse: boolean` and `CellStyle.foreground?: RGB` are already
  populated from libghostty for every cell. **The attribute data is in the
  pipeline. We just don't read it.**

`packages/blinkyterm/examples/bobbihack/interrupts.ts:43-63` — `detectMonsterAppeared`:

- Walks `prevRows` × `curRows` looking for cells where the current glyph is
  `[a-zA-Z]`, isn't `@`, and differs from `prev[x]`.
- Returns `${ch} at (${x},${y})` on first hit; that becomes the `monster_visible`
  interrupt's `detail`.

## NetHack rendering of pets and peacefuls

NetHack default text mode supports two relevant options:

- **`hilite_pet`** — pets render with `ATR_INVERSE` (terminal SGR 7, inverse
  video). Off by default.
- **`hilite_peaceful`** — peacefuls render with a distinguishing color, and/or
  the cyan `~` highlight on some builds. Off by default. Newer NetHack builds
  expose this; the exact attribute differs across `nethack` (vanilla) builds
  and varies with the user's color/no-color compile flags.

`bobbihack` launches NetHack via `shared/nethack-setup.ts:nethackEnv()`, which
today sets only `NETHACKOPTIONS="name:agent,role:valkyrie,race:human,gender:female,align:lawful"`.
**Neither hilite is enabled.** Without them NetHack has nothing to emit; any
attribute-based detector has no signal to read.

`NETHACKOPTIONS` accepts comma-separated boolean flags, so we extend the
string with `,hilite_pet,hilite_peaceful`.

## Design

### Two-class glyph classification

Each cell in the frame is classified into one of:

- **`pet`** — letter glyph with `style.inverse === true`. Confirmed by the probe.
- **`normal`** — letter glyph or `@` (other than the player's) without `inverse`. *Treated as hostile* by the detector.

Non-letters (`.`, `#`, `|`, items, etc.) and the player's own `@` are not
classified — they're irrelevant to monster-visibility.

Peacefuls (shopkeepers, priests, etc.) end up classified `normal` because
NetHack 5.0.0 doesn't expose a hilite for them. This is a known limitation
(see Probe results). The `GlyphClass` union has room to add `peaceful`
later; until then, no path produces it.

### `FrameAwaitResult.glyphClass`

Add a parallel grid to `FrameAwaitResult`:

```ts
export type GlyphClass = "pet" | "normal";

export interface FrameAwaitResult {
  rows: string[];
  // glyphClass[y][x] is the classification of the letter glyph at (x, y),
  // or undefined if rows[y][x] is not a letter or is the player's `@`.
  // Length matches rows; each entry has length === rows[y].length.
  glyphClass: ReadonlyArray<ReadonlyArray<GlyphClass | undefined>>;
  status: StatusLine;
  message: string;
  frameReason: string;
  screenAnsi: string;
}
```

`undefined` entries (terrain, items, cursor) cost no memory — the inner array
can be a sparse `(GlyphClass | undefined)[]` and `JSON.stringify` is irrelevant
because this is in-memory only.

### Building `glyphClass` in `sendKeysAndWait`

Walk the frame once after the existing `rows` split:

```ts
const glyphClass = buildGlyphClass(frame.snapshot, rows);
```

`buildGlyphClass` uses `frame.snapshot.cellAt(x, y)` (or iterates
`runner.renderState.rows()` directly for slightly better perf — implementer's
call) and applies:

```ts
function classifyCell(text: string, style: CellStyle | undefined): GlyphClass | undefined {
  if (text.length !== 1) return undefined;
  const isLetter = /[a-zA-Z]/.test(text);
  const isAt = text === "@";
  if (!isLetter && !isAt) return undefined;
  return style?.inverse === true ? "pet" : "normal";
}
```

The player's `@` is excluded by checking `(x, y) === map.currentPlayerXY` at
the call site, not inside `classifyCell` — that keeps the classifier pure and
testable. (The probe confirmed the player's `@` does not get `inverse: true`,
so even if we forgot the position check it wouldn't misclassify the player as
a pet — but the position check is still the correct guard.)

### `InterruptFrame.glyphClass`

`InterruptFrame` (in `interrupts.ts`) gets the same field so `frameFromResult`
in `autopilot.ts:53-60` can pass it through:

```ts
export interface InterruptFrame {
  rows: string[];
  glyphClass: ReadonlyArray<ReadonlyArray<GlyphClass | undefined>>;
  status: StatusLine;
  message: string;
  frameReason?: string;
}
```

### Replace `detectMonsterAppeared` with `detectHostileAppeared`

```ts
function detectHostileAppeared(prev: InterruptFrame | undefined, cur: InterruptFrame): string | false {
  if (prev === undefined) return false;
  for (let y = 0; y < cur.rows.length; y++) {
    const curRow = cur.rows[y]!;
    const prevRow = prev.rows[y] ?? "";
    const curClass = cur.glyphClass[y] ?? [];
    for (let x = 0; x < curRow.length; x++) {
      const ch = curRow[x]!;
      if (!/[a-zA-Z]/.test(ch) || ch === "@") {
        // (player's @ is filtered upstream by position; remaining @s are
        // human glyphs handled below)
      }
      // Letter or @ — letter check first to mirror current behavior; @
      // handling is done via class only.
      const klass = curClass[x];
      if (klass === undefined) continue;          // not a glyph we track
      if (klass === "pet") continue;              // ignore pets
      // klass === "normal" — treat as hostile (peacefuls also land here; deferred).
      if (prevRow[x] !== ch) {
        return `${ch} at (${x},${y})`;
      }
    }
  }
  return false;
}
```

The interrupt name stays `monster_visible` for stability of the existing
log/test schema; the *meaning* tightens to "hostile or unclassifiable monster
appeared." Update its comment in the `INTERRUPTS` array to match.

### Peaceful policy (deferred)

Peacefuls are not distinguishable in NetHack 5.0.0 (see Probe results). They
land in the `normal` class and trip `monster_visible` like a hostile would.
This is the same behavior as pre-fix for peacefuls; the only thing that
changes is pets stop tripping it.

If shopkeeper/priest/Oracle interactions become a problem in real play,
revisit with a follow-up doc that uses message-tracking (e.g., parse "Hello
agent, welcome to Izchak's general store!" to flag the @ inside the shop
radius as peaceful). Out of scope here.

### NetHack configuration

Update `packages/blinkyterm/examples/shared/nethack-setup.ts:nethackEnv`:

```ts
export function nethackEnv(): Record<string, string> {
  return {
    NETHACKOPTIONS:
      "name:agent,role:valkyrie,race:human,gender:female,align:lawful," +
      "hilite_pet",
  };
}
```

Document the dependency in a comment immediately above the string: removing
`hilite_pet` silently breaks pet classification (every pet step would trip
`monster_visible`). **Do not add `hilite_peaceful`** — it's rejected by the
NetHack 5.0.0 binary and produces a startup error modal.

## Probe step (DONE — see Probe results above)

Before locking the classifier, run a one-shot probe to confirm what bobbihack's
NetHack build actually emits. The probe lives at
`packages/blinkyterm/examples/bobbihack/scripts/probe-hilite.ts` (delete it
after the design is verified — no need to ship).

The probe:

1. Spawns NetHack with `NETHACKOPTIONS=...,hilite_pet,hilite_peaceful`.
2. Waits for the first frame (the valkyrie starts adjacent to a pet — small
   dog or kitten, depending on build).
3. Locates the player's `@`.
4. For every cell within ±2 of `@` whose text is a letter, prints
   `(x, y, char, style.inverse, style.foreground, style.background)`.
5. Prints the same for any other letter glyphs on screen.
6. Exits.

Expected: the pet shows `inverse: true`. Peacefuls won't typically be visible
on D1, so we may need a second probe in Mines Town or via the wizard-mode
`#wizgenesis` (if the NetHack binary was compiled with wizard mode — most
distro binaries are not).

**Outputs of the probe gate the next step:**

- If pets are `inverse: true` as expected → proceed.
- If pets show a different attribute (some color, some background flip) →
  update `classifyCell` accordingly before writing tests.
- If `hilite_pet` doesn't seem to do anything in this build → fall back to the
  message-tracking heuristic (track `Your <petname>` from the first turn's
  message, treat that monster name's letter as pet for the lifetime of the
  game). Document the fallback in this spec; don't ship without one of the two
  signals working.

For peacefuls: defer the probe until we have a way to put one on screen
reliably. If the binary supports wizard mode, the probe can use `#wizgenesis`.
Otherwise we capture peaceful classification from a real game session and
finalize that part of `classifyCell` after first encounter (low-risk: the
`normal` default is correct conservatively until we observe a peaceful).

## Tests

### Unit

`packages/blinkyterm/examples/bobbihack/test/unit/glyph-class.test.ts` (new):
- Pure-function tests for `classifyCell`.
- Cases: letter + inverse → pet. Letter + no style → normal. `@` + inverse →
  pet. `@` + no style → normal. Non-letter → undefined. Multi-char text →
  undefined.

`packages/blinkyterm/examples/bobbihack/test/unit/interrupts.test.ts`
(extend if exists, create otherwise):
- `monster_visible` does NOT fire when only pet glyphs moved.
- `monster_visible` DOES fire when a `normal`-class glyph appears at a new
  position.
- `monster_visible` DOES fire when a `normal`-class glyph appears in a frame
  that also moved a pet (mixed scene — pet-and-hostile both moving).

### Smoke

`packages/blinkyterm/examples/bobbihack/test/smoke/autopilot-pet.test.ts`
(new):
- Spawn a real NetHack with the new env.
- Drive `autopilot_explore` for 20 steps in the starting room.
- Assert the run did not abort with `monster_visible`.
- Assert at least one frame contained a pet glyph (so we're not just lucky).

The existing `scripted-plan-autopilot.json` fixture probably already encodes
"pet on screen" frames. Audit it; either retire it (it was tracking the
buggy behavior) or update its expectations.

## Risks and fallbacks

1. **`hilite_pet` works in NetHack 5.0.0** (probe confirmed). If a future
   binary upgrade breaks it, the smoke test (autopilot-walks-past-pet) will
   fail loudly. Fallback if that ever happens: extract the pet's monster
   letter from the first turn's message (`Your <petname> ...`), look up
   `petname` → letter in a small table, and treat any instance of that letter
   as pet. Loses correctness for "wild monster of the same letter" — accept
   as a known limitation.

2. **The pet attribute classification spuriously fires on a non-pet
   inverse-rendered cell.** NetHack uses inverse for some highlights (e.g.,
   detected monsters via clairvoyance). Document this as a known
   false-negative ("we won't stop on detected hostiles in this corner
   case") — clairvoyance is rare and the player will notice the screen
   change visually anyway.

3. **Peacefuls trip `monster_visible`** — known limitation per Probe
   results. Same as pre-fix for peacefuls; only pets improve in this rev.

## Implementation plan (ordered)

1. ~~Probe.~~ DONE.
2. Add `GlyphClass` type (`"pet" | "normal"`), `classifyCell` helper, unit
   tests for the helper.
3. Extend `FrameAwaitResult` and `InterruptFrame` with `glyphClass`.
4. Wire `glyphClass` through `sendKeysAndWait` and `frameFromResult`.
5. Replace `detectMonsterAppeared` with `detectHostileAppeared`. Keep the
   interrupt name `monster_visible`.
6. Update `nethackEnv()` to add `hilite_pet` (only — not `hilite_peaceful`).
   Add the load-bearing comment.
7. Add the smoke test (autopilot-walks-past-pet doesn't abort). Run the
   existing test suite — fix any fixture drift.
8. Delete the probe script (`packages/blinkyterm/examples/bobbihack/scripts/probe-hilite.ts`). Commit. Sign with Bob name + session.

## Open questions

- ~~Peaceful attribute exact form.~~ Closed: NetHack 5.0.0 doesn't support
  it. Deferred.
- **Whether to add a `pet_visible` interrupt at all** (i.e. surface "you
  walked past your kitten" in `also[]`). Current design: no. Trivially added
  later if useful.
- **Whether to track pet position in `GameMap` for other purposes** (e.g.
  not stepping into a pet during `move(direction)` to avoid the swap when
  unwanted). Out of scope here; could justify a follow-up doc.
