# Bobbihack — Stateful Agentic Loop Design

**Author:** Dirk (Bob `1dffecf5`), with NetHack research by Glyph (Bob-21), and review by Bob-Croesus + Bob-Tycho (NetHack lens) and Bob-Hexley + Bob-Tycho (generalist lens)
**Date:** 2026-04-26
**Status:** draft — ready to plan against (revision 4)
**Scope:** `packages/blinkyterm/examples/bobbihack/` — the smart-agent path
**Replaces:** the current per-turn one-shot Anthropic invocation

---

## Goals

1. **Coherent long-running play.** The agent maintains strategy and identifications across hundreds of NetHack turns without re-deriving everything from the screen each time.
2. **Token economy.** Use prompt caching, a structured tool result, and on-demand queries (`query_map`) so per-turn cost stays roughly flat as the game gets longer.
3. **Compaction resistance.** A persisted journal carries the agent's interpretive state (plans, identifications, hypotheses) across model context resets and across runs.
4. **Lower cognitive load via autopilot tools.** Repetitive movement (corridor-walking, point-to-point travel) is handled by binding-side functions that the agent invokes, returning structured results instead of a per-step LLM trace.
5. **Stable under transient API errors.** Recoverable Anthropic-API failures (5xx, 429, network) retry with backoff; everything else fails loudly. Cross-process resumption (NetHack save files, etc.) is out of scope.

## Non-goals

- Multiple LLM agents (we have **one** smart agent driving; autopilots are tools, not agents).
- ML training, RLHF, or learned exploration policies — autopilot policies are hand-coded.
- Multi-game generalization — this is NetHack-specific.
- Keeping the existing per-turn `Agent` interface for the smart path. We delete it and rebuild as a conductor. `MockAgent` becomes a mock of the Anthropic SDK stream, not a separate code path (see below).
- Cross-process resumption (NetHack-save-file integration). If the bobbihack process dies, the next run starts a new game.

---

## Architectural shift

**Today (stateless, agent-per-turn):** one Anthropic API call per game turn. No message history. Each turn the model re-reads the screen and decides one action. `Agent.decide()` returns a fresh `AsyncIterable<AgentEvent>` per turn.

**Proposed (stateful, conductor):** one long-running `messages.stream()` call lasts the game. Tool calls (`move`, `autopilot_*`, `journal_*`, `query_map`) execute their handlers, append `tool_use` + `tool_result` to the running messages array, and the model sees the result as input to its next response. Standard tool-use semantics.

```
[ One API call, lasting the whole game ]

  system:  <system-prompt.txt>
  user:    "You're playing nethack. <initial tool_result-shaped payload>"
  ─────────────────────────────────────────────────────────────────────
  assistant: "Open room. Heading east."
             tool_use(move, "east")
  ─────────────────────────────────────────────────────────────────────
  user:    tool_result: <summary + standing + status + screen>
  ─────────────────────────────────────────────────────────────────────
  assistant: "Long corridor. Autopiloting until something interrupts."
             tool_use(autopilot_explore, {})
  ─────────────────────────────────────────────────────────────────────
  user:    tool_result: <summary + standing + status + screen>
  ─────────────────────────────────────────────────────────────────────
  ... continues for the whole game ...
```

The bobbihack process owns:
- the running `messages` array
- a `GameMap` (per-floor tile graph) maintained automatically each turn
- a `Journal` (six markdown files, one per section, persisted to disk)
- the `Runner` (nethack pty)
- the `AbortController` for user-initiated cancellation

There is no per-turn `Agent` interface anymore. The conductor is a single long-running async function. **`MockAgent` is refactored to be a mock of the Anthropic SDK stream** (yields scripted `text_delta` + `tool_use` events on demand) rather than a separate Agent. Production and test/smoke paths run the same conductor code; only the SDK client is swapped. One code path, one set of behaviors to verify.

---

## Tool surface

NetHack's command set is large. The agent needs verbs for movement, item interaction, modal-prompt response, autopilot, journal, and map. The system prompt teaches when to use each.

### Movement & exploration

#### `move({ direction, count? })`
One step (default) or up to `count` steps in the same direction (NetHack's count-prefix semantics — sends `<count><viKey>`, e.g. `5l` for "east 5 times" — and stops at the first obstruction or interesting event).

`direction` ∈ `{ north, northeast, east, southeast, south, southwest, west, northwest, up, down }`.

`count` is optional; default 1; max 50.

**Notes:**
- All eight compass directions are supported. Diagonals are required for NetHack — fighting in corners, traversing diagonal doorways, Sokoban solutions all depend on them.
- `up` and `down` are *travel up/down stairs* (`<` / `>` keys when standing on stairs). They are explicit — `move(down)` will not fire just because you're walking past a `>`. Walking onto stairs is `move(<dir>)` to land there; descending is a separate `move(down)`.
- Walking into a wall is *truly free* (no game turn consumed) per NetHack 3.6 — but it consumes one of our LLM cycles, so prefer not to.

#### `search({})`
Search adjacent walls and floor for hidden passages and traps. Sends `s`. Single-turn.

#### `pickup({})`
Pick up whatever is on the current tile. Sends `,`. May surface a multi-item selection prompt — handled by `respond_prompt`.

### Item & inventory actions

Every item-action tool either takes an inventory slot letter directly (e.g. `eat({ slot: "c" })` sends `e` then `c`), takes a follow-up direction where applicable (`zap`, `throw`), or sends the action and yields to the prompt loop if NetHack's response is ambiguous.

| Tool | NetHack key | Args | Notes |
|---|---|---|---|
| `inventory({})` | `i` | none | Read-only view of current carry. Free action; bobbihack captures the inventory screen, parses it, sends `<esc>` or space to dismiss, returns `{ items: [{slot, appearance, count, BUC, enchant, charges}] }`. Does not consume a game turn. |
| `eat({ slot? })` | `e` | optional slot | If `slot` given, eats from inventory; if omitted, sends `e` and yields (NetHack may prompt for slot or try ground). |
| `quaff({ slot? })` | `q` | optional slot | Drink potion. Same yielding semantics. May trigger fountain prompt. |
| `read({ slot })` | `r` | slot | Read scroll or spellbook. |
| `zap({ slot, direction? })` | `z` | slot + optional direction | Direction handled by follow-up `respond_prompt` if NetHack asks. |
| `wear({ slot })` | `W` | slot | Wear armor. |
| `puton({ slot })` | `P` | slot | Put on accessory (ring, amulet). |
| `takeoff({ slot? })` | `T` | optional | Take off armor. May surface menu if multiple. |
| `remove({ slot? })` | `R` | optional | Remove accessory. |
| `wield({ slot })` | `w` | slot | Wield weapon. `slot: "-"` for bare hands. |
| `drop({ slot })` | `d` | slot | Drop one item. |
| `throw({ slot, direction })` | `t` | slot + direction | Throw item in direction. |
| `apply({ slot })` | `a` | slot | Apply tool (whistle, horn, key, etc.). |
| `kick({ direction })` | `^d` | direction | Kick — door, sink, monster. |
| `pray({})` | `#pray` | none | Pray to deity. Has cooldowns and alignment requirements; agent learns timing. |
| `force_fight({ direction })` | `F<dir>` | direction (same enum as `move`, excluding `up`/`down`) | Attack into a tile that may or may not have a monster. |
| `extended_command({ name, args? })` | `#<name>` | string | Generic `#`-prefixed extended commands: `#chat`, `#dip`, `#loot`, `#offer`, `#sit`, `#turn`, `#name`, `#conduct`, `#enhance`, `#quit`, etc. The handler sends `#<name>\r`. `args`, when given, is a literal string sent after the command (≤16 chars). If NetHack opens a sub-prompt mid-command (multi-step menus like `#name`), the next agent turn is expected to answer via `respond_prompt`. **Quit:** the agent issues `extended_command({name: "quit"})` to initiate the #quit dance; bobbihack does NOT auto-confirm the y/n prompts — the agent's next turn (an interrupt-stop on `modal_prompt`) responds with `respond_prompt({keys: "y"})` etc. |
| `command({ keys })` | literal | string | Last-resort low-level escape hatch. `keys` is a literal NetHack key sequence (≤16 chars). The tool sends them verbatim. Use only when no higher-level tool fits. |

`slot` is always a single character (`a`-`z`, `A`-`Z`, `*`, `$`, `#`, `?`, `-`).

### Modal prompts

#### `respond_prompt({ keys })`
Send a literal short key sequence (≤8 chars) to NetHack — used to answer modal prompts (More--, [yn], menus, direction queries, item-letter selection). bobbihack does not validate `keys` against the prompt content; the agent is expected to read the screen and pick appropriate responses.

**Why a separate tool?** Modal prompts are a distinct mode (the screen shows a question, not a dungeon view). Bundling prompt-response into `move` or per-action tools confuses the agent. Modal-prompt detection is on the autopilot interrupt list; when an autopilot stops on a prompt, the next agent turn is expected to be `respond_prompt`.

### Autopilot

#### `autopilot_to({ floor, x, y })`
Pathfind from current tile to the named tile, sending one keystroke per step, interruptible.

**Handler:** runs A* over the recorded Map (8-connectivity). Returns `{ error: "no path" | "unknown floor" | "unknown tile" }` if planning fails. Otherwise loops: send keystroke → await frame → check interrupt list → continue or break. On finish, returns standard tool_result with `summary: "autopilot_to(D1,29,7): arrived after 12 steps"` or `"...stopped after 4 steps. interrupt: monster_visible"`.

**Diagonal-movement rules** (NetHack 3.6, applied during pathfinding and step execution):
- Cannot move diagonally through a doorway (open or closed). If the path between (x,y) and (x±1,y±1) requires passing through a `door_*` tile, that diagonal edge is removed from the graph.
- Cannot move diagonally into or out of a shop entrance.
- Cannot squeeze diagonally past a boulder (Sokoban relevance — autopilot already refuses Sokoban).
- All other 8-connectivity is allowed.

**Trap protection:** never plans a path through a tile classified as `trap_known`; if a previously-clear tile reveals a trap mid-traversal, halts via the `entered_trap_tile` interrupt before stepping in.

**Stairs protection:** treats `<` and `>` as terminal frontier nodes — pathfinding can land on stairs but never *descends* them. Going down requires explicit `move(down)`.

#### `autopilot_explore({})`
Walk an exploration policy until an interrupt fires.

**Handler:** picks the next move from a frontier policy (§Exploration policy). Loop: send keystroke → await frame → update Map → check interrupt list. On finish, returns standard tool_result with `summary: "autopilot_explore: 23 steps. stopped: monster_visible (k at (8,12))"`.

### Journal

#### `journal_read({ section })`
Returns the named section's current content. `section` ∈ `{Character, Inventory, Knowledge, Dungeon, Goals, Hypotheses}`.

**Handler:** reads `.bobbihack/<run-id>/journal/<section>.md` and returns `{ section, content }`. Missing file returns `{ section, content: "" }`. Unknown section name returns `{ error: "unknown section 'X'. Valid: Character, Inventory, ..." }`. See §Journal.

#### `journal_write({ section, content })`
Replace the named section's content. Same enum.

**Handler:** writes the markdown file atomically (temp + rename). Validates `section` against the enum (rejects unknown names) and content size (rejects content > 64KB; returns `{ error: "section content exceeds 64KB" }`). Returns `{ ok: true }`.

### Map query

#### `query_terrain({ floor? })`
Returns the recorded **plain ASCII** terrain map of a floor + a feature list. (Renamed from `query_map` to reinforce that it returns terrain only, not the live view.)

`floor` is optional. When omitted, returns a list of visited floors instead of map content.

**Handler:** reads from the GameMap. If `floor` is omitted, returns `{ floors: [{ id, firstTurn, lastTurn, tileCount }] }`. Otherwise returns `{ floor, ascii: "<rendered terrain>", features: [{glyph, x, y, kind}] }`. Returns `{ error: "no map recorded for floor 'D5'" }` for unvisited floors.

**No color in the rendered ASCII.** Terrain glyphs are unambiguous on their own (closed/open is in the glyph; locked is invisible until you bump; altar alignment is only known after stepping on it and is recorded in `Dungeon.md`). Color matters for monsters and items on the **live screen** (yellow vs red dragon, etc.) — but the live screen is sent unchanged with full color in every tool_result. `query_terrain` is for terrain recall; the structured info that matters (altar alignment, trap types, fountain state) belongs in the Dungeon journal section.

### Tool count summary

Movement: `move` + `search` + `pickup` (3)
Item actions: `inventory`, `eat`, `quaff`, `read`, `zap`, `wear`, `puton`, `takeoff`, `remove`, `wield`, `drop`, `throw`, `apply`, `kick`, `pray`, `force_fight`, `extended_command`, `command` (18)
Modal response: `respond_prompt` (1)
Autopilot: `autopilot_to`, `autopilot_explore` (2)
Journal: `journal_read`, `journal_write` (2)
Map: `query_terrain` (1)

**27 tools total.** That's a lot but each is single-purpose with a tight contract. The model's context will hold the schema once (cached); after that the cost is zero.

---

## Tool result format

Every game-advancing tool result has the same structure with a stable header so the model can disambiguate live tool_results from compacted stubs and from non-screen tools:

```
== bobbihack tool_result v1 ==
<summary line — what just happened, tool-specific>
Floor: D2. Visited: D1, D2. Turn: 142.
HP 14/14   Pw 5/5   AC 7   Hunger: ok   Cond: -

<80×24 ANSI screen — frame.snapshot.toAnsi()>
```

Layered by source:
- **Header line** — `== bobbihack tool_result v1 ==`. Stable. Lets the model recognize a live tool_result and distinguish it from compacted stubs (which start with `<turn N — ...>`).
- **Summary line** — bobbihack-constructed, derived from message-line parse + screen diff. One short line. Tool-specific format.
- **Standing-state line** — current floor + floors visited (from GameMap) + turn count.
- **Status block** — parsed from the bottom status line: HP, Pw, AC, hunger, conditions. Always exactly one line.
- **Screen** — the live ANSI rendering. Nethack already handled visibility (rooms, corridors, blindness, dark squares); we don't crop or filter it.

**Non-screen tools** return their own shape:
- `journal_read` → `{ section, content }` (or `{ error }`).
- `journal_write` → `{ ok: true }` (or `{ error }`).
- `query_terrain` → `{ floor, ascii, features }` (or `{ error }`).
- `inventory` → `{ items: [...] }`.

These are JSON objects in the tool_result content; bobbihack's tool runner serializes accordingly. The header line above is *only* on game-advancing tool results that include a screen.

**Game-end tool result** (`#quit` confirmed, character died, ascended): returns
```
== bobbihack tool_result v1 ==
GAME OVER: <reason>. Final turn: <N>. Final HP: <h/m>.
<final 80×24 screen>
```
The conductor's outer loop sees `gameOver: true` flagged in the runtime state and exits cleanly after this tool_result is appended.

---

## GameMap data structure

```ts
type FloorId = string;  // "D1", "D2", "Mines:1", "Sokoban:1", "Quest:Home", "Rogue", ...

type TileKind =
  | "floor" | "corridor" | "wall"
  | "door_closed" | "door_open" | "door_broken"
  | "stairs_up" | "stairs_down" | "trapdoor"
  | "altar" | "fountain" | "sink" | "throne" | "grave" | "tree"
  | "boulder"               // pushable; transient
  | "trap_known"            // any trap once revealed
  | "ice" | "water" | "lava"
  | "unknown";

interface Tile {
  glyph: string;            // last-seen glyph
  kind: TileKind;
  walkable: "yes" | "no" | "by_inference";  // see below
  lastSeenTurn: number;
}

interface FloorMap {
  id: FloorId;
  firstSeenTurn: number;
  lastSeenTurn: number;
  tiles: Map<string, Tile>; // key = "x,y"
  isRogueLevel: boolean;    // glyph charset alternates on this level — see Floor identity
  walkabilitySuspect: boolean;  // set when polymorph or magic-mapping invalidates assumptions
}

class GameMap {
  floors: Map<FloorId, FloorMap>;
  current: FloorId | null;
  currentPlayerXY: { x: number; y: number } | null;

  updateFromFrame(frame, statusLine, messageLine): void;
  pathfind(from, to): Step[] | null;        // 8-connectivity A* with diagonal-doorway rule
  renderAscii(floorId): string;
  features(floorId): FeatureList;
  visitedFloors(): { floor: FloorId; firstTurn: number; lastTurn: number }[];
}
```

### Walkability tri-state

- **`yes`** — we directly observed an empty walkable tile here (`.`, `#`, `<`, `>`, open door, etc.).
- **`no`** — we observed a wall, closed door, lava, or other obstruction.
- **`by_inference`** — the player's `@` was on this tile; we have not seen what's *underneath* but we know it's walkable (we were standing there). Distinct from `yes` so we can refine when the player moves off.

Without `by_inference`, autopilot pathfinding incorrectly treats the player's current tile as unknown after a stairs-arrival or magic-mapping case where the floor was never seen empty.

### Transient glyphs

The player (`@`), monsters (letter glyphs), and items (`?`, `!`, `(`, `[`, etc.) are recognized in `updateFromFrame` but **not persisted as `Tile.kind`** — we record what's underneath them. If we have no prior state for a tile and a transient occupies it, the kind stays `unknown` until we see it cleared (with `walkable: by_inference` if the player is the occupant).

### Boulders are special

Boulders (`` ` ``) are *terrain-like* (block movement) but *transient* (move when pushed in Sokoban). Recorded with `kind: "boulder"` and `walkable: "no"`. Updated *every frame* — if a boulder is no longer at its prior location, that tile reverts to whatever was underneath. Sokoban play needs this fidelity.

### Door states

`+` is `door_closed`, `'` is `door_open`, broken doors revert to `floor` or `corridor`. Pathfinding treats closed doors as walkable (the engine auto-opens on bump) but with an additional cost so autopilot prefers known-open paths when available.

### Rogue level

NetHack ~D:14-19 randomly contains **the Rogue level**, which uses a different glyph charset (e.g., `+` is a door, but rooms render with `#` and `:` for floor/door pairs differently). bobbihack detects this by the message `"You enter what seems to be an older, more primitive world."` and tags the FloorMap as `isRogueLevel: true`. The exploration policy and autopilot tools refuse to operate on Rogue-level FloorMaps in v0 (return `{ error: "rogue level — manual play required" }`); a follow-up spec can add Rogue-level glyph tables.

### Magic mapping

`updateFromFrame` records *any* visible tile, not just adjacent ones. A scroll of magic mapping reveals the entire floor at once; those tiles are recorded normally with `walkable` set per the kind.

### Polymorph / passwall

When the agent polymorphs into a wall-passing form (xorn, etc.) or gains levitation, walkability assumptions break. `updateFromFrame` watches for the polymorph message (`"You suddenly turn into a..."`) and sets `walkabilitySuspect: true` on the current FloorMap. Autopilot tools refuse to operate on a suspect floor (`{ error: "walkability suspect — polymorph or similar; clear by re-walking" }`); the flag clears after the agent returns to its original form (detected by the unpolymorph message).

### Use

GameMap is updated **before** every conductor iteration (and inside autopilot tool handlers between keystrokes). Used internally by `autopilot_to` and `autopilot_explore` for pathfinding. Exposed to the model via `query_terrain`.

---

## Journal

Per-run directory layout:

```
.bobbihack/<run-id>/
  journal/
    Character.md      # static-ish identity: race/class/alignment/patron/conduct/starting inv
    Inventory.md      # current carry: slot letter → known appearance + ID state (BUC, +N, charges)
    Knowledge.md      # accumulated identifications game-wide: scroll FOOBIE = identify, etc.
    Dungeon.md        # per-level log mirroring NetHack's #overview: altars/fountains/shops/traps/stairs
    Goals.md          # current top-goal + ordered sub-goals + abandoned-with-reason
    Hypotheses.md     # open questions and predictions: "untested kicking sink for ring", etc.
  run.jsonl           # append-only conductor log: {turn, ts, tool, args, summary, screenHash}
  map.json            # serialized GameMap (for in-process restart)
  messages/
    NNNN.json         # rotated message-array snapshots (cheap replay if conductor crashes)
```

**Six markdown sections, one file each.** `journal_read({section})` reads one file; `journal_write({section, content})` replaces it atomically (temp + rename). Markdown over JSON because (a) the model writes prose, (b) writes feel cleaner without JSON-escape gymnastics, (c) human inspection in a debugger is trivial.

**Section purposes** (informed by NetHack `#overview` / `#annotate` conventions per Glyph's research):

| Section      | Purpose                                                                                          | Update cadence |
|--------------|--------------------------------------------------------------------------------------------------|----------------|
| Character    | Race, class, alignment, deity, conduct vows, starting equipment, role-specific quirks.           | Game start; level-up; alignment shift; polymorph; quest milestones |
| Inventory    | Current carry only — slot letter → known appearance + identification state.                      | Each turn that picks up / drops / IDs items |
| Knowledge    | Accumulated identifications divorced from current carry: scroll/potion/wand IDs, monster behaviors learned, price-ID notes, wishes used. Pays for itself across compactions. | Whenever something is identified |
| Dungeon      | Per-level log keyed by floor ID: altars (alignment if known), fountains (used/dry), shops (type, visited), vaults, trap locations + types, oracle, branch entrances. Mirrors `#overview`. | On entering a level; on confirming a feature |
| Goals        | Current top-goal + ordered sub-goals + abandoned-with-reason. Short.                             | When plan changes |
| Hypotheses   | Open questions and predictions — explicitly "things to test or remember." Working memory of unresolved.| Whenever a hypothesis is formed or resolved |

The fixed list keeps the surface bounded and prevents agent-side sprawl ("Notes2", "Misc", "Stuff"). The system prompt teaches the model when to write to which section; if these sections prove insufficient in practice, we'll evolve them deliberately rather than letting the agent invent its own.

**Why "Quest" is renamed to "Goals":** "Quest" is overloaded in NetHack (the alignment quest, the Quest artifact, quest portal, quest leader). A model with NetHack knowledge will conflate them. "Goals" is unambiguous.

---

## Floor identity

Two signals, combined:
1. **`Dlvl:` from the status line** — gives the depth in the main dungeon.
2. **Branch / sub-level messages** — bobbihack watches the message line for canonical NetHack strings to label the current branch and special level.

Combined floor ID: `<branch>:<sublabel>` where `<sublabel>` is either a positive integer or a named subkey. Grammar: `<branch>(:<int>|:<named>)?`. The bare-branch form (e.g. `Castle`, `Bigroom`) is used for single-level branches. Examples:

| ID                  | Source signal |
|---------------------|---------------|
| `D1`, `D2`, ...     | Main dungeon, generic Dlvl |
| `Oracle`            | Main dungeon level containing the Oracle (typically D5–9). Detected by `"You enter the Oracle's lair."` or seeing the Oracle (`@`) on a Dlvl with the Delphi room shape. |
| `Bigroom`           | Single-room main-dungeon level (typically D:10). Detected by message `"You arrive in a vast, open room."` |
| `Rogue`             | Detected by `"You enter what seems to be an older, more primitive world."` |
| `Mines:N`           | After `"You enter the Gnomish Mines."`, label as `Mines:<dlvl>` |
| `Mines:Town`        | Mines dlvl with Minetown — detected by Town-shape and message |
| `Mines:End`         | Mines End — detected by entering the bottom of the Mines branch |
| `Sokoban:1..4`      | After `"Welcome to Sokoban!"`. Sokoban is entered via *upstairs* from D5 or D9 (note: ascending direction, contrary to the usual descend-deeper assumption). |
| `Quest:Home`        | After `"You feel a strange mental acuity."` (quest-portal use) |
| `Quest:Filler1..N`  | Intermediate quest levels |
| `Quest:Goal`        | Final quest level (detected by quest-leader and Q-artifact presence) |
| `Castle`            | Detected by Castle message and structure |
| `Vlad`              | Vlad's Tower — `"You sense the presence of evil"` + structure |
| `Plane:Earth`, `Plane:Air`, `Plane:Fire`, `Plane:Water`, `Plane:Astral` | Endgame planes |

**Stairway transitions** are detected by `<` / `>` movement + a Dlvl change in the status line. The Map allocates a new FloorMap when a transition lands on a Dlvl + branch combo not yet seen.

**Sokoban-up gotcha:** the standard "descend = deeper" intuition fails for Sokoban. The exploration policy should not assume `>` is always the right "going deeper" direction; in Sokoban, `<` leads further into the branch. The branch label (`Sokoban:N`) and the message `"Welcome to Sokoban!"` are the authoritative signal.

**Trapdoors and holes** drop the player to a deeper floor without using stairs. Detected by Dlvl change without a corresponding `move(up)` / `move(down)`. The new FloorMap is allocated normally; the agent's autopilot is interrupted by the `entered_trap_tile` condition (see §Interrupt conditions) before the descent if the trap was known, or by the `level_changed_unexpectedly` interrupt after the fact.

---

## Exploration policy (autopilot_explore)

Hand-coded, deterministic. Goal: visit unvisited tiles efficiently without LLM reasoning.

```
1. From current tile, identify adjacent walkable tiles (8-connectivity), excluding:
   - tiles classified `trap_known`
   - boulders (kind: "boulder")
   - lava / water (without levitation/swimming)
2. If any adjacent walkable tile is unvisited, step into it. Preferences:
   - prefer corridors over rooms
   - prefer continuing in the current direction
   - never prefer stairs (don't *exit* the floor on autopilot)
3. Else: BFS from current tile to the nearest unvisited known-frontier tile
   (a tile adjacent to known walkable that is itself unknown); step toward it
   along the BFS path.
4. If no unvisited frontier exists on this floor, return with
   `summary: "autopilot_explore: <N> steps. stopped: floor_fully_explored"`.
   Do NOT auto-descend stairs — that's a deliberate decision for the agent.
5. Refuse to operate on:
   - Sokoban floors (boulder-pushing puzzles need real reasoning)
   - The Rogue level (`isRogueLevel: true`)
   - Floors flagged `walkabilitySuspect`
   In these cases return `{ error: "<reason>" }` immediately without stepping.
```

Each step is checked against the **interrupt list** before continuing. The step cap (default 50) prevents runaway loops; large floors that need 200+ steps will require multiple `autopilot_explore` calls (the agent sees the interim screen and decides whether to continue).

---

## Interrupt conditions for autopilot

Both `autopilot_to` and `autopilot_explore` halt and return when any of:

### Modal & prompt
- **`modal_prompt`** — top message line matches `--More--`, `[yn]`, `[a-zA-Z $#?*]`, `In what direction?`, or any prompt the existing `detectPrompt` helper recognizes. The agent's next turn is expected to be `respond_prompt`.

### Combat & danger
- **`monster_visible`** — a letter glyph appears that wasn't on the previous frame, or a known glyph moved into line-of-sight. **Note:** this will fire on peaceful pets (your dog, cat, etc.) entering line-of-sight; that's intentional first-pass behavior — the agent decides whether to ignore. A future refinement could filter known-peaceful glyphs (NetHack's `Hilite_pet` option renders them differently when set).
- **`hp_drop`** — HP decreased between frames (any amount).
- **`low_hp`** — HP fell below `max(1, hpMax / 3)`. NetHack's conventional panic threshold.
- **`pet_attacking_you`** — confused/hostile pet attacking; detected by message line.
- **`engulfed`** — `@` is inside a swallower (purple worm, trapper, etc.). Detected by screen-shape change: most of the visible screen is the engulfer's "interior" walls.

### Status changes (onset)
- **`paralyzed`** — message `"You can't move yourself!"` or similar.
- **`stunned`** / **`confused`** / **`hallucinating`** / **`blind`** — message-line patterns and status-line condition flags.
- **`polymorphed`** — message `"You suddenly turn into..."`. Sets GameMap `walkabilitySuspect`.
- **`level_changed_unexpectedly`** — Dlvl changed without a corresponding `move(up)`/`move(down)` (trapdoor, hole, level teleport, magic trap).
- **`xp_levelup`** — message `"Welcome to experience level N."` Useful for the agent to journal abilities gained.
- **`weapon_cursed_welded`** / **`armor_cursed_stuck`** — `"...welds itself to your hand!"` etc.
- **`hunger_transition`** — hunger state change (e.g. `Hungry` → `Weak`). Status-line condition delta.

### Game state
- **`new_item_visible`** — item glyph (`?`, `!`, `(`, `[`, `=`, `*`, `$`, `%`, `/`, `"`) appears that wasn't on the previous frame.
- **`entered_trap_tile`** — current tile is now classified `trap_known` (revealed mid-step).
- **`bell`** — `frameReason === "bell"`. Often signals an action failed.
- **`you_die`** — message `"You die..."` or `"DYWYPI?"` prompt. Game ended.
- **`you_ascend`** — endgame ascension. Game ended.

### Operational
- **`step_cap`** — configurable maximum (default 50) to avoid runaway loops.
- **`abort_signal`** — user pressed `q`; `signal.aborted === true`.
- **`path_exhausted`** (`autopilot_to` only) — arrived at target.
- **`policy_terminated`** (`autopilot_explore` only) — frontier exhausted, see §Exploration policy.

### Detection mechanism

Most interrupts are detected by:
1. **Message-line patterns** — bobbihack maintains a small library of NetHack canonical strings (e.g., `"You die"`, `"You feel"`, `"It's a wall"`, `"Welcome to experience level"`, `"You suddenly turn into"`). Each pattern → an interrupt name.
2. **Status-line diffs** — HP, hunger, conditions parsed from the bottom row each frame; deltas trigger named interrupts.
3. **Frame-reason** — `frameReason: "bell"` from the Runner.
4. **Map state** — `entered_trap_tile`, `level_changed_unexpectedly`.

The `summary` line in the tool_result names the specific interrupt: `"autopilot_explore: 23 steps. stopped: monster_visible (k at (8,12))"`.

**Ordering & dedup:** if multiple interrupt conditions match the same frame, the autopilot stops on the *first* matching interrupt in the order listed above (modal/combat/status/game-state/operational). Subsequent matches in the same frame are listed in the summary as `also: [low_hp, hunger_transition]` so the agent doesn't lose information. The order is chosen so safety-critical interrupts (modal prompts that block input, low HP, you-die) are surfaced first.

The interrupt library lives in `packages/blinkyterm/examples/bobbihack/interrupts.ts` (new file). Each interrupt is a `{ name, priority: number, detect(prevFrame, curFrame, prevStatus, curStatus): boolean | string }` — `string` return is an extra detail line for the summary; `priority` is used for ordering.

---

## Conductor implementation sketch

The pattern: stream the assistant's full response (including any number of tool_use blocks + interleaved text), drain to `message_stop`, run all tool_use blocks, append the assistant message + a single user message containing all tool_results, then start the next stream. This is the documented Anthropic SDK tool-use loop and the pattern shown in their cookbook.

```ts
async function conductor(opts: ConductorOpts): Promise<void> {
  const { client, runner, map, journal, ac, ui, runState } = opts;
  const messages: Message[] = await loadMessagesOrInit(opts.messagesPath);

  while (!ac.signal.aborted && !runner.exited && !runState.gameOver) {
    let stream;
    try {
      stream = client.messages.stream(buildStreamArgs(messages));
      // The SDK exposes `finalMessage()` which awaits message_stop and returns
      // the fully-assembled assistant response — preferred over manual delta
      // accumulation. We still subscribe to text deltas for the live UI.
      stream.on("text", (delta: string) => ui.appendThinking(delta));
      const finalMsg = await stream.finalMessage();

      // Append the assistant response verbatim.
      messages.push({ role: "assistant", content: finalMsg.content });

      const toolUses = finalMsg.content.filter((b) => b.type === "tool_use");

      if (toolUses.length === 0) {
        // Model emitted only text and chose to stop. Treat as graceful end-of-run.
        runState.gameOver = true;
        runState.endReason = "model_stopped_without_tool_use";
        break;
      }

      // Execute every tool_use in order, accumulate tool_results.
      // INVARIANT: every tool_use in the assistant message MUST have a
      // matching tool_result in the next user message (Anthropic API
      // schema requirement). If we abort or the game ends mid-batch,
      // synthesize stub tool_results for the unexecuted tools so the
      // persisted log stays well-formed.
      const toolResults: ToolResultBlock[] = [];
      let stopBatchEarly = false;
      for (const tu of toolUses) {
        if (stopBatchEarly) {
          toolResults.push({
            type: "tool_result",
            tool_use_id: tu.id,
            content: "[skipped: prior tool ended the run or aborted]",
            is_error: true,
          });
          continue;
        }
        if (ac.signal.aborted) {
          toolResults.push({
            type: "tool_result",
            tool_use_id: tu.id,
            content: "[skipped: user aborted]",
            is_error: true,
          });
          stopBatchEarly = true;
          continue;
        }
        const args = tu.input ?? {};  // SDK gives parsed input; no manual JSON.parse
        const content = await runTool(tu.name, args, { runner, map, journal, ac, runState });
        toolResults.push({
          type: "tool_result",
          tool_use_id: tu.id,
          content,
        });
        ui.commitTurn(tu.name, content);
        if (runState.gameOver) stopBatchEarly = true;
      }

      // Single user message containing all tool_results — well-formed
      // even if some are stubs.
      messages.push({ role: "user", content: toolResults });
      await persistMessages(messages);

      // Compaction check happens between iterations (see §Compaction).
      await maybeCompact(messages, runState);
    } catch (err) {
      if (!isRecoverableApiError(err)) throw err;
      const delaySec = nextBackoffSec(runState);  // 1, 2, 4, 8, 16; cap 5 attempts
      if (delaySec === null) {
        ui.error(`anthropic API unavailable after retries; aborting`);
        throw err;
      }
      ui.note(`anthropic API error (${err.status ?? err.name}); retry in ${delaySec}s`);
      await sleep(delaySec * 1000);
      // Loop continues; messages array is unchanged; next iteration retries.
    }
  }
}

function buildStreamArgs(messages: Message[]): StreamArgs {
  return {
    model: chosenModel(),
    max_tokens: 1024,
    system: [
      { type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral", ttl: "1h" } },
    ],
    tools: TOOLS,
    messages,
  };
}
```

Notes on the pattern:

- **`stream.finalMessage()`** awaits `message_stop` and returns the assembled response. Avoids manual JSON-parsing of `input_json_delta` chunks and the bug of breaking on first `content_block_stop` (which would truncate multi-tool turns).
- **All tool_use blocks in one assistant turn** are executed in order; their tool_results are batched into one user message. This matches the SDK's expected schema and supports the model issuing multiple tool calls per turn (e.g. `journal_read(Goals)` + `query_terrain(D1)` + `move(north)` in one response).
- **Empty `toolUses`** means the model emitted text only — typically because it thinks the run is over. Treat as graceful termination.
- **`isRecoverableApiError`** matches HTTP 5xx, HTTP 429, fetch network errors, `ECONNRESET`/`ETIMEDOUT`. 4xx other than 429 fail immediately.
- **`nextBackoffSec`** returns `1, 2, 4, 8, 16` then `null` (give up) on the 6th call. Resets on a successful stream.
- **Cancellation:** `ac.signal.aborted` is checked between tool executions and on each backoff sleep; the SDK stream itself is canceled on next stream construction (the in-flight call is abandoned by abandoning the Promise).

### Tool runner

```ts
async function runTool(name: string, args: any, ctx: ToolCtx): Promise<string | object> {
  switch (name) {
    case "move":              return await handleMove(args, ctx);
    case "search":            return await handleSearch(args, ctx);
    case "pickup":            return await handlePickup(args, ctx);
    case "inventory":         return await handleInventory(args, ctx);
    case "eat":               return await handleEat(args, ctx);
    case "quaff":             return await handleQuaff(args, ctx);
    case "read":              return await handleRead(args, ctx);
    case "zap":               return await handleZap(args, ctx);
    case "wear":              return await handleWear(args, ctx);
    case "puton":             return await handlePuton(args, ctx);
    case "takeoff":           return await handleTakeoff(args, ctx);
    case "remove":            return await handleRemove(args, ctx);
    case "wield":             return await handleWield(args, ctx);
    case "drop":              return await handleDrop(args, ctx);
    case "throw":             return await handleThrow(args, ctx);
    case "apply":             return await handleApply(args, ctx);
    case "kick":              return await handleKick(args, ctx);
    case "pray":              return await handlePray(args, ctx);
    case "force_fight":       return await handleForceFight(args, ctx);
    case "extended_command":  return await handleExtendedCommand(args, ctx);
    case "command":           return await handleCommand(args, ctx);
    case "respond_prompt":    return await handleRespondPrompt(args, ctx);
    case "autopilot_to":      return await handleAutopilotTo(args, ctx);
    case "autopilot_explore": return await handleAutopilotExplore(args, ctx);
    case "journal_read":      return await handleJournalRead(args, ctx);
    case "journal_write":     return await handleJournalWrite(args, ctx);
    case "query_terrain":     return await handleQueryTerrain(args, ctx);
    default:
      return { error: `unknown tool: ${name}` };
  }
}
```

Each handler honors `ctx.ac.signal` so a user `q` aborts mid-tool. Game-advancing handlers return a string (the formatted screen-bearing tool_result with the `== bobbihack tool_result v1 ==` header); non-screen handlers return a JSON-shaped object. The string vs object distinction is how the SDK encodes the tool_result content; both work.

---

## Compaction strategy

The journal and the GameMap together carry the durable state of the run, which means we can compact aggressively without losing what matters. The compaction loop is the primary token-economy mechanism — it's what keeps a 500-turn game runnable.

### Layered defense

1. **Prompt caching** at two breakpoints, both with `cache_control: { type: "ephemeral", ttl: "1h" }`:
   - **B1** (always-cached): `system` prompt only. Stable for the entire run. The 1-hour TTL covers most realistic stalls (long autopilots, brief user pauses) without re-paying cache creation.
   - **B2** (rolling, post-compaction): placed at the **first message that was *not* rewritten by the most recent compaction**. Cache prefix matching is byte-exact, so any compacted message invalidates the cache from that message forward; B2 sits at the boundary so the live tail is cacheable for the next request.

   Anthropic's prompt-cache mechanism: a `cache_control` marker creates a cache point covering the prefix up to that block. Hits cut input cost on the cached prefix substantially (~10× for cache_read vs base input). The 5-minute default TTL is too short for our cadence; explicit `ttl: "1h"` is required and within Anthropic's supported ttl range.

2. **Live tail of K turns kept verbatim.** The most recent K (default: 20) `tool_use`/`tool_result` pairs are preserved with their full screen ANSI. The model has high-fidelity recent context.

3. **Compacted history.** Older pairs have their `tool_result.content` replaced with a one-line stub: `"<turn 73 — autopilot_to(D1,29,7) arrived; HP 14→14; see Dungeon.md + query_terrain(D1)>"`. The `tool_use` stays so the message structure is intact and the model can still see *what it did*; the bulky screen is gone. A single line per old turn keeps the pre-tail prefix small.

4. **Compaction marker.** When compaction runs, bobbihack injects a synthetic `user` message at the boundary: `"NOTE: turns 1–N have been compacted. Their summaries remain inline. For full state, call journal_read(...) and query_terrain(...). Recent K turns are intact below."`

5. **Model-driven recovery.** The system prompt teaches the model to call `journal_read({section: "Goals"})`, `journal_read({section: "Knowledge"})`, and `query_terrain({floor: <currentFloor>})` after a compaction marker — so the model recovers its plans, identifications, and terrain memory deliberately rather than guessing.

### Triggers

- **Periodic:** every 50 game-turns since the last compaction. Cheap and predictable.
- **Token budget:** if the running input-token estimate exceeds 80% of the model's context window, compact immediately regardless of turn count.
- **Hard fail-safe:** if Anthropic returns a `400 invalid_request_error` for context length, compact aggressively (live tail K=5) and retry once. If it fails again, fail loudly.

### Why this works for our shape

The model's *interpretive* state — plans, identifications, character info, dungeon notes — is in markdown files it owns. The model's *terrain memory* is in the GameMap (queryable). The compacted message log only needs to carry: what tools were called, what their summaries said, and the recent live tail. Everything else is recoverable on demand.

This is fundamentally why we designed the journal + map the way we did. Compaction isn't a side concern; it's the load-bearing mechanism that makes long-running play tractable, and the rest of the architecture exists in part to support it.

---

## Cancellation

`ac: AbortController` lives at the conductor scope. User pressing `q` calls `ac.abort()` (existing wiring in `main.ts:108`). Threads:

- Inside the streaming loop: `if (ac.signal.aborted) break` ends the for-await; the SDK aborts the HTTP call.
- Inside `runTool` handlers: `ac.signal` is checked at each iteration of any loop; on abort, the handler returns a partial result (`{ stopped: "user_aborted", at: ... }`).
- The conductor's outer `while` exits when `ac.signal.aborted`.
- `runner.sendText` and `runner.frames()` are not interrupted directly — but since the conductor exits, no further reads happen. The Runner is disposed in main.ts's `finally` block.

---

## Resumption (in-process retry only)

We handle one failure mode: **transient Anthropic API errors during a live conductor run**. Anything else is out of scope for this version.

When `messages.stream()` (or any subsequent retrieve/raw-stream call) fails:

- **Recoverable:** HTTP 5xx, HTTP 429 (rate limit), `ECONNRESET`, `ETIMEDOUT`, fetch network errors.
  Retry with exponential backoff: 1s, 2s, 4s, 8s, 16s (cap), max 5 attempts. Surface a `[bobbihack] anthropic api unavailable, retrying in Ns…` line in the agent pane between attempts. On final failure, fail loudly (exit non-zero with a clear message).
- **Unrecoverable:** HTTP 4xx (other than 429), invalid API key, model-not-found, schema violations, etc. Fail immediately. No retry.

The messages array is held in memory only during a run. We persist `messages/NNNN.json` as **full message-array snapshots** at compaction events (one snapshot per compaction; `NNNN` is the compaction sequence number). They are forensic, not load-bearing — a process restart *could* in principle replay from one, but the matching nethack process is gone, so cross-process resumption is **not a goal**. Older snapshots may be GC'd via `BOBBIHACK_KEEP_SNAPSHOTS=N` (default: keep all; set to a positive integer to limit retention).

If you want serious long-running play across machine restarts, that's a future spec — it'd need NetHack save-file integration plus a way to verify the saved game matches the saved messages. Not solving that now.

---

## Migration from current architecture

| Today                                          | After                                          |
|------------------------------------------------|------------------------------------------------|
| `AnthropicAgent.decide()` — fresh per turn      | Conductor — one long call                       |
| `pickAgent()` returns one of three Agents       | `pickClient()` returns real or mock SDK; conductor is universal |
| `for await (frame of runner.frames())` in main  | conductor owns frame-awaiting via tool handlers |
| `streamToAgentEvents` translator                | replaced by `stream.finalMessage()` + structured tool-use loop |
| `MOVE_TOOL` only                                | 27 tools (movement + items + autopilot + journal + map + escape hatches) |
| `Agent.AgentInput` / `AgentEvent`               | conductor reads frames directly; UI events still emitted |
| `MockAgent` is its own code path                | `MockAgent` becomes a `MockAnthropicClient` — yields scripted SDK events. Same conductor runs in production and tests. |

The existing `state.ts` / `render.ts` / pane plumbing stays — they consume events emitted by the conductor (regardless of whether the SDK behind it is real or mock). The event shape needs a small expansion (e.g., a `tool_executing` event so the UI can show "running: autopilot_explore").

**`agents/anthropic.ts` and `agents/mock.ts` get rewritten or replaced.** What was an `Agent` interface becomes a thin SDK adapter; the bulk of behavior moves into the conductor.

---

## UI considerations

The agent pane (top 1/3 thinking, bottom 2/3 history) keeps its current shape. Three signals to surface that don't exist today:

1. **Currently executing tool** — title-bar suffix during a long handler: `Agent (anthropic claude-haiku-4-5) — running autopilot_explore (step 12)`.
2. **Tool result summary** — each turn's history line shows the summary line: `"#142 move(east): bumped a door"`.
3. **Streaming model text** — unchanged from today; appears in the live region as the model thinks between tool calls. During long autopilots, the live region shows the autopilot's progress narration (step count, current tile) instead of going dark.

---

## Observability

Every run writes a single append-only log file `.bobbihack/<run-id>/run.jsonl`. One JSON object per line:

```json
{"event": "run_start", "ts": "2026-04-26T18:00:00Z", "runId": "...", "model": "claude-haiku-4-5", "systemPromptHash": "sha256:abc...", "specVersion": "v3"}
{"event": "turn", "turn": 142, "ts": "...", "tool": "move", "args": {"direction":"east"}, "summary": "moved to (12,8). bumped a door.", "screenHash": "sha256:...",
 "usage": {"input_tokens": 1234, "output_tokens": 56, "cache_read_input_tokens": 8000, "cache_creation_input_tokens": 0}}
{"event": "compaction", "ts": "...", "compactedThroughTurn": 100, "liveTailSize": 20, "messagesBefore": 200, "messagesAfter": 122}
{"event": "retry", "ts": "...", "attempt": 1, "delaySec": 1, "errorClass": "rate_limit"}
{"event": "interrupt", "ts": "...", "tool": "autopilot_explore", "kind": "monster_visible", "detail": "k at (8,12)"}
{"event": "run_end", "ts": "...", "reason": "model_stopped_without_tool_use", "totalTurns": 487}
```

Required event kinds: `run_start`, `run_end`, `turn`, `retry`, `compaction`, `interrupt`, `error` (unrecoverable). Other kinds may be added.

This makes runs grep-able, replayable as a timeline, and gives Matt a forensic record of what happened. `screenHash` lets you detect that turn-N's screen was identical to turn-M's without storing both.

The system-prompt hash + spec version stamped at `run_start` are the trip-wires for "did this run use the prompt I think it did" — important when iterating prompt content.

---

## Cost monitoring

A long-running stream burning tokens for hours is real money. Three mitigations:

1. **Per-turn usage logged to `run.jsonl`** (input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens). Easy to sum and graph.
2. **Per-turn cost line in the agent pane status:** small text `tokens: in 1.2k (cache 8.0k) / out 56 — turn cost ~$0.003`. Updates each turn.
3. **Hard budget kill switch via env var:** `BOBBIHACK_MAX_USD=2.50` exits cleanly when the running total exceeds the cap. Prevents accidental runaway spending. Default: unset (no limit).

Cost calculation uses Anthropic's posted per-token rates for the chosen model; bobbihack hard-codes the rates table at build time and warns if the model selected isn't in the table.

**`BOBBIHACK_DRY_RUN=1`** swaps the real Anthropic SDK for `MockAnthropicClient` with a scripted plan loaded from `BOBBIHACK_DRY_RUN_PLAN=<path-to-yaml-or-json>`. Useful for local smoke testing without burning API tokens. The same mechanism the test suite uses; here it's exposed as a CLI escape hatch.

---

## Concurrency & locking

Two bobbihack processes pointing at the same `.bobbihack/` directory will collide on the journal, message log, and Runner spawn. Single-instance enforcement via flock:

- On startup, bobbihack acquires an exclusive lock on `.bobbihack/run.lock` (`flock(LOCK_EX | LOCK_NB)`).
- If the lock is held: exit 1 with `"another bobbihack is running (lock held by PID N); refusing to start"`.
- The lock file contains the PID and run-id of the holder for debugging.
- The lock is automatically released on process exit (kernel cleanup).

The `<run-id>` in the directory layout is `bbh-YYYYMMDD-HHMMSS-<6-hex-rand>` — wall-clock-prefixed for human grep, randomized for collision-free re-runs in the same second. Generated at startup, never reused.

---

## Security model

The journal stores LLM-written content that bobbihack reads back and feeds to the LLM. Practical implications:

- **Trust scope:** journal contents are trusted only because runs are local + single-user. There is no scenario in v0 where another user's journal feeds into your run.
- **Prompt injection vector (theoretical):** if a journal file from a previous run is loaded into a fresh run (which we don't do — `<run-id>` is fresh per process), it could carry adversarial instructions. Mitigated by per-run journal directories.
- **Size caps:** `journal_write` rejects content > 64 KB. `messages.json` snapshots are not bounded by us — Anthropic's context window is the natural cap, and it's also the reason compaction exists.
- **Section enum validation:** `journal_write({section: "X"})` rejects unknown section names rather than silently writing `X.md`. Prevents the agent inventing `Notes2.md`, etc.
- **The `command` and `extended_command` escape hatches** can send arbitrary keystrokes to nethack. Nethack itself is the trust boundary — there is no escape from the pty into the host shell. Length-bounded (≤16 chars) as a defense against runaway commands but the security bound is nethack's parser.

If you ever want to share a run's journal between users (debug exchange, reproducing bugs), treat the markdown files as untrusted input and at minimum sanitize them with the same care you'd apply to user-supplied prompt content.

---

## Testing

- **Mock the SDK at the boundary.** `MockAnthropicClient` yields scripted events (`text_delta` then `tool_use` then `content_block_stop`). Wire it into the conductor in tests; assert the conductor calls the right tool handler, appends the right messages, and emits the right UI events. This is the *same* conductor that runs in production.
- **Snapshot tool_result formatting.** Given a synthetic frame + map state, assert the constructed `summary + standing + status + screen` payload is byte-stable.
- **Map building.** Replay a sequence of fake frames (rendered ASCII strings) and assert the final FloorMap state.
- **Pathfinding.** A* over hand-built FloorMaps. Verify edge cases: no path, unknown target, target on different floor.
- **Autopilot interrupts.** Drive the autopilot handler with synthetic frames that trigger each interrupt condition; assert the right `summary` is returned.
- **Compaction round-trip.** Build a long synthetic message log; trigger compaction; assert the compacted prefix is byte-stable, the live tail is preserved, and the synthetic compaction-marker message is injected at the boundary.
- **Backoff retry.** Inject `MockAnthropicClient` failures (5xx, 429, network) and assert the conductor retries with the documented schedule, then succeeds on the next attempt.

The existing `bobbihack.mock.test.ts` is replaced by tests that drive the conductor with `MockAnthropicClient` — covering the same end-to-end behaviors but at the new layer.

---

## Sequencing

Build in dependency order, with checkpoints:

**Phase 1 — GameMap + tool_result format (no new tools).** Build the Map data structure (with all tile kinds, walkability tri-state, boulder/door-state/trap modeling, Rogue-level detection, polymorph awareness), the message-line + status-line parsers, and the tool_result formatter (header + summary + standing + status + screen). Wire them into the **existing per-turn AnthropicAgent path** so the smart agent already gets richer context. No architectural change yet. Watch whether the model's spatial reasoning improves.

> **Phase 1 wiring is intentionally throwaway.** Phase 2 deletes the per-turn agent path entirely and rebuilds the SDK adapter. Don't over-invest in the integration layer — the GameMap, parsers, and formatter survive; the wiring doesn't.

**Phase 2 — Conductor refactor + backoff.** Move the smart agent to the long-running `messages.stream` pattern using `stream.finalMessage()`. Tools: `move` (with all eight directions and count) + `search` + `pickup` (split out from move). Persist messages. Add `cache_control` with 1h TTL on system prompt. **Wrap stream consumption in try/catch with the documented retry/backoff schedule** (1s/2s/4s/8s/16s, max 5 attempts). This is the load-bearing architectural step; everything else builds on it.

**Phase 3 — Item & inventory tools.** All the action verbs (`eat`, `quaff`, `read`, `zap`, `wear`, `puton`, `takeoff`, `remove`, `wield`, `drop`, `throw`, `apply`, `kick`, `pray`, `force_fight`, `extended_command`, `command`) plus `inventory` (read-only) and `respond_prompt` (modal answer). Each is a small handler that sends the right keystrokes and awaits the next frame. The system prompt grows substantially to teach when to use each.

**Phase 4 — Journal (`journal_read`, `journal_write`).** Trivial tools, but high value for compaction-resistance. Update system prompt to teach the model when to write to which section.

**Phase 5 — `query_terrain`.** Exposes the GameMap from Phase 1 as a tool. The renderAscii method already exists from Phase 1; this just wires it as a tool.

**Phase 6 — `autopilot_to`.** A* (8-connectivity, diagonal-doorway-aware, trap-avoiding, stairs-non-descending) + the keystroke loop + interrupt list.

**Phase 7 — `autopilot_explore`.** Frontier policy + interrupts. Refusal on Sokoban / Rogue / walkability-suspect floors. The hardest tool because of policy design.

**Phase 8 — Compaction.** The layered compaction strategy (cache breakpoints + live-tail + summarized history + compaction marker). The least testable in isolation — it's where everything has to actually work together at long runtimes.

Each phase is independently demonstrable. Stop at any phase if it's not pulling weight; the architecture is the same shape.

---

## Open questions

1. **Model choice.** `claude-haiku-4-5` is current default. Sonnet 4.6 will likely be better at long-horizon reasoning + tool orchestration; haiku is cheaper. Recommend running both in parallel for a few sessions before committing.
2. **Live-tail size K.** Default 20 in this spec; could be 10 or 30. Right answer depends on observed behavior.
3. **`Inventory.md` update cadence.** Croesus's review flagged that this could become very-write-heavy. Should bobbihack auto-maintain it from `inventory({})` parses, or should the model be explicitly responsible? First pass: model-responsible; revisit if we see thrash.
4. **Conduct tracking refresh.** No tool currently surfaces `#conduct`. Add as `extended_command({name: "conduct"})` and let the model read it on demand? Probably yes; defer the decision to Phase 3.
5. **Travel command (`_`) as fast-path.** NetHack's own travel can replace `autopilot_to` in some cases. Worth investigating after Phase 6.

Resolved by Glyph's research, the rev-1 reviews, and Croesus/Hexley's rev-2 reviews:
- ~~Journal section list~~ — fixed at six (`Character`, `Inventory`, `Knowledge`, `Dungeon`, `Goals`, `Hypotheses`).
- ~~Color in `query_terrain`~~ — plain ASCII; structured info goes in `Dungeon.md`.
- ~~MockAgent disposition~~ — refactored to mock SDK, not separate Agent.
- ~~Cross-process resumption~~ — out of scope.
- ~~Trim cadence~~ — periodic (50 turns) + token-budget (80%) + hard fail-safe.
- ~~Cache breakpoint policy~~ — two breakpoints, both 1h TTL; B2 placed at the post-compaction boundary.
- ~~Tool surface scope~~ — expanded from 6 to 27 tools; full NetHack action coverage + escape hatches.
- ~~Modal prompt response~~ — `respond_prompt({keys})` tool.
- ~~Diagonals~~ — included; eight compass directions for `move`.
- ~~`move(quit)` vs game-over~~ — `quit` extracted from `move`; the conductor checks `runState.gameOver` after each tool.
- ~~Conductor stream pattern~~ — uses `stream.finalMessage()` to drain to message_stop; supports parallel tool_use.
- ~~Run-id derivation~~ — `bbh-YYYYMMDD-HHMMSS-<6-hex>`.
- ~~Concurrency~~ — flock on `.bobbihack/run.lock`.
- ~~Cost monitoring~~ — per-turn usage logged; `BOBBIHACK_MAX_USD` kill switch.
- ~~Trapdoor protection~~ — `trap_known` tile kind + `entered_trap_tile` interrupt; autopilot avoids known traps and never auto-descends stairs.
- ~~Rogue level / Sokoban / suspect-walkability~~ — autopilots refuse with explicit error.

---

## Out of scope

- Multi-character runs (each game has one character).
- Custom NetHack patches or save-file manipulation.
- Voice / non-text I/O.
- A learned exploration policy — autopilots are deterministic hand-coded.
- Replacing the existing `Runner` / `Terminal` / `RenderState` plumbing — the conductor uses them as-is.

---

## What this spec doesn't decide

This spec is the **architecture and tool surface**. It does not commit to:
- Specific TypeScript class names beyond what's already there.
- Exact wire format for every tool's JSON args (will be set by tool schemas in Phase 2+).
- Specific A* implementation, BFS order, etc. — those are details for the implementing Bob to choose, with this spec as the contract.

When Phase 1 is ready to start, that Bob writes the Phase 1 plan against this spec.
