# Bobbihack — Stateful Agentic Loop Design

**Author:** Dirk (Bob `1dffecf5`), with NetHack research by Glyph (Bob-21)
**Date:** 2026-04-26
**Status:** draft — for review (revision 2)
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

Six tools. The system prompt teaches when to use each.

### `move({ direction })`
Single-step movement. `direction` ∈ `{north, south, east, west, search, pickup, quit}`.

**Handler:** sends the vi-key keystroke, awaits next quiesced frame, updates Map from the new screen, returns the standard tool_result payload (see "Tool result format" below). `quit` triggers the `#quit\r y\r y\r` sequence and ends the game.

### `autopilot_to({ floor, x, y })`
Pathfind from current tile to the named tile, sending one keystroke per step, interruptible.

**Handler:** runs A* over the recorded Map. Returns `{ error: "no path" | "unknown floor" | "unknown tile" }` if planning fails. Otherwise loops: send keystroke → await frame → check interrupt list → continue or break. On finish, returns standard tool_result with `summary: "autopilot_to(D1,29,7): arrived after 12 steps"` (or `"...stopped after 4 steps. interrupt: monster_visible"`).

### `autopilot_explore({})`
Walk an exploration policy until something interesting happens.

**Handler:** picks the next move from a frontier policy (depth-first toward nearest unvisited adjacent tile, with corridor-following bias; specific algorithm in §"Exploration policy"). Loop: send keystroke → await frame → update Map → check interrupt list. On finish, returns standard tool_result with `summary: "autopilot_explore: 23 steps. stopped: monster_visible (k at (8,12))"`.

### `journal_read({ section })`
Returns the named section's current content. `section` ∈ `{Character, Inventory, Knowledge, Dungeon, Goals, Hypotheses}`.

**Handler:** reads `.bobbihack/<run-id>/journal/<section>.md` and returns `{ section, content }` (content is the file as a string). Missing file returns `{ section, content: "" }` — never an error. See §Journal for what each section is for.

### `journal_write({ section, content })`
Replace the named section's content. Same enum.

**Handler:** writes the markdown file atomically (temp + rename), returns `{ ok: true }`. No partial writes. The agent can include arbitrary markdown — bobbihack doesn't validate structure inside a section.

### `query_map({ floor })`
Returns the recorded **plain ASCII** map of a floor + a feature list.

**Handler:** reads from the GameMap. If `floor` is omitted, returns a list of all visited floors with turn ranges. Otherwise returns `{ floor, ascii: "<rendered terrain>", features: [{glyph, x, y, kind}] }`. Returns `{ error: "no map recorded for floor 'D5'" }` for unvisited floors.

**No color in the rendered ASCII.** Per Glyph's research: terrain glyphs are unambiguous on their own (closed/open is in the glyph; locked is invisible until you bump; altar alignment is only known after stepping on it — and it's recorded in `Dungeon.md` anyway). Color matters for **monsters and items on the live screen** (yellow vs red dragon, etc.) — but the live screen is sent unchanged with full color in every tool_result. `query_map` is for terrain recall; the structured info that matters (altar alignment, trap types, fountain state) belongs in the Dungeon journal section, not in the rendered map.

---

## Tool result format

Every tool result has the same structure (string content, model parses by convention):

```
<summary line — what just happened, tool-specific>
Floor: D2. Visited: D1, D2. Turn: 142.
HP 14/14   Pw 5/5   AC 7   Hunger: ok   Cond: -

<80×24 ANSI screen — frame.snapshot.toAnsi()>
```

Layered by source:
- **Summary line** — bobbihack-constructed, derived from message-line parse + screen diff. One short line. Tool-specific format.
- **Standing-state line** — current floor + floors visited (from GameMap) + turn count.
- **Status block** — parsed from the bottom status line: HP, Pw, AC, hunger, conditions. Always exactly one line.
- **Screen** — the live ANSI rendering. Nethack already handled visibility (rooms, corridors, blindness, dark squares); we don't crop or filter it.

For tools that don't advance game state (`journal_*`, `query_map`), the screen + status + standing-state are still included — they're free to compute (no keystrokes sent), and keep the model's situational awareness fresh.

---

## GameMap data structure

```ts
type FloorId = string;  // "D1", "D2", "Mines:1", "Sokoban:1", "Quest:Home", ...

interface Tile {
  glyph: string;           // last-seen glyph at this tile
  walkable: boolean;       // floor, corridor, open door, stairs
  kind?: "stairs_up" | "stairs_down" | "altar" | "fountain" | "door" | "wall" | "floor" | "corridor";
  lastSeenTurn: number;
}

interface FloorMap {
  id: FloorId;
  firstSeenTurn: number;
  lastSeenTurn: number;
  tiles: Map<string, Tile>;   // key = "x,y"
}

class GameMap {
  floors: Map<FloorId, FloorMap>;
  current: FloorId | null;
  currentPlayerXY: { x: number; y: number } | null;

  updateFromFrame(frame, statusLine): void;
  pathfind(from, to): Step[] | null;          // A* over walkable graph
  renderAscii(floorId): string;
  features(floorId): FeatureList;
  visitedFloors(): { floor: FloorId; firstTurn: number; lastTurn: number }[];
}
```

Updated **before** every conductor iteration. Built from each frame's snapshot — every tile painted on the screen is recorded with its glyph + classification. Transient glyphs (monsters, items, the player `@`) are *recognized but not stored as terrain* — we record what was *underneath* them by remembering the prior state of that tile, or marking unknown.

Used internally by `autopilot_to` and `autopilot_explore` for pathfinding. Exposed to the model via `query_map`.

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
1. **`Dlvl:` from the status line** — gives `D1`, `D2`, ... in the main dungeon. Stable per-floor.
2. **Branch-detection messages** — "You enter the Gnomish Mines.", "You enter Sokoban.", "You arrive in the Town." Bobbihack watches for these on the message line and updates the active branch label.

Combined floor ID: `<branch>:<dlvl>`. Examples:
- Main dungeon: `D1`, `D2`, ...
- Mines: `Mines:2`, `Mines:5`
- Sokoban: `Sokoban:1`, ..., `Sokoban:4`
- Quest: `Quest:Home`, `Quest:Lower`
- Special: `Castle`, `Vlad`, `Plane:Earth`, `Plane:Air`, ...

Edge case: stairway transitions are detected by `<` / `>` movement + a Dlvl change in the status line. The Map allocates a new FloorMap when a transition lands on a Dlvl + branch combo not yet seen.

---

## Exploration policy (autopilot_explore)

Hand-coded, deterministic. Goal: visit unvisited tiles efficiently without LLM reasoning.

```
1. From current tile, identify adjacent walkable tiles.
2. If any adjacent tile is unvisited, step into it (prefer corridors over rooms;
   prefer continuing in current direction).
3. Else: BFS from current tile to nearest unvisited known-frontier tile;
   step toward it.
4. If no unvisited frontier exists on this floor, step toward the nearest
   stairs-down (or stairs-up if no down).
5. If no stairs known, return with `summary: "explored entire known map"`.
```

Each step is checked against the **interrupt list** before continuing.

---

## Interrupt conditions for autopilot

Both `autopilot_to` and `autopilot_explore` halt and return when any of:

- **Modal prompt detected** — top message line matches `[yn]`, `[a-z]`, `--More--`, or any prompt the existing `detectPrompt` helper recognizes.
- **Monster visible** — a non-letter glyph at a non-current tile, or a letter glyph not present last frame.
- **HP drop** — HP decreased between frames (any amount).
- **Hunger transition** — hunger state change (e.g. `Hungry` → `Weak`).
- **New item visible** — item glyph (`?`, `!`, `(`, `[`, `=`, `*`, `$`, `%`, `/`, `"`) appears that wasn't on the previous frame.
- **Bell** — `frameReason === "bell"` (NetHack rang the bell, often signaling an action failure).
- **Step cap** — configurable maximum (default 50) to avoid runaway loops.
- **Abort signal** — user pressed `q`; `signal.aborted === true`.
- **Path exhausted** (`autopilot_to`) — arrived at target.

The `summary` line in the tool_result names the specific interrupt: `"autopilot_explore: 23 steps. stopped: monster_visible (k at (8,12))"`.

---

## Conductor implementation sketch

```ts
async function conductor(opts: ConductorOpts): Promise<void> {
  const { runner, map, journal, ac, ui } = opts;
  const messages: Message[] = await loadMessagesOrInit(opts.messagesPath);

  while (!ac.signal.aborted && !runner.exited) {
    const stream = client.messages.stream({
      model: "claude-haiku-4-5",  // or sonnet — see open questions
      system: [
        { type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } },
      ],
      tools: TOOLS,
      messages,
      max_tokens: 1024,
    });

    let pendingTool: ToolUse | null = null;
    for await (const event of stream) {
      if (ac.signal.aborted) break;

      if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
        ui.appendThinking(event.delta.text);
        continue;
      }

      if (event.type === "content_block_start" && event.content_block.type === "tool_use") {
        pendingTool = { id: event.content_block.id, name: event.content_block.name, args: "" };
        continue;
      }

      if (event.type === "content_block_delta" && event.delta.type === "input_json_delta") {
        if (pendingTool) pendingTool.args += event.delta.partial_json;
        continue;
      }

      if (event.type === "content_block_stop" && pendingTool) {
        // Execute the tool, append tool_use + tool_result, restart the stream.
        const toolResult = await runTool(pendingTool, { runner, map, journal, ac });
        messages.push(
          { role: "assistant", content: [{ type: "tool_use", ...pendingTool }] },
          { role: "user",      content: [{ type: "tool_result", tool_use_id: pendingTool.id, content: toolResult }] },
        );
        await persistMessages(messages);
        ui.commitTurn(toolResult);
        pendingTool = null;
        break;  // exit this stream; outer while restarts with new messages
      }
    }
  }
}

async function runTool(tool, ctx): Promise<string> {
  switch (tool.name) {
    case "move":              return await handleMove(JSON.parse(tool.args), ctx);
    case "autopilot_to":      return await handleAutopilotTo(JSON.parse(tool.args), ctx);
    case "autopilot_explore": return await handleAutopilotExplore(JSON.parse(tool.args), ctx);
    case "journal_read":      return await handleJournalRead(JSON.parse(tool.args), ctx);
    case "journal_write":     return await handleJournalWrite(JSON.parse(tool.args), ctx);
    case "query_map":         return await handleQueryMap(JSON.parse(tool.args), ctx);
  }
}
```

Each `runTool` handler honors `ctx.ac.signal` so a user `q` aborts mid-tool. The handler returns whatever string content goes into `tool_result`; for game-advancing tools, that's the standard `summary + standing + status + screen` payload.

---

## Compaction strategy

The journal and the GameMap together carry the durable state of the run, which means we can compact aggressively without losing what matters. The compaction loop is the primary token-economy mechanism — it's what keeps a 500-turn game runnable.

### Layered defense

1. **Prompt caching** at two breakpoints:
   - **B1** (always-cached): `system` prompt + initial user message. Stable for the entire run.
   - **B2** (rolling): the boundary between "compacted history" and "live tail" of `tool_use`/`tool_result` pairs. Re-issued each compaction.
   Anthropic SDK's `cache_control: { type: "ephemeral" }` markers handle this; cache hits cut input cost ~10× on the cached prefix.
2. **Live tail of K turns kept verbatim.** The most recent K (default: 20) `tool_use`/`tool_result` pairs are preserved with their full screen ANSI. The model has high-fidelity recent context.
3. **Compacted history.** Older pairs have their `tool_result.content` replaced with a one-line stub: `"<turn 73 — autopilot_to(D1,29,7) arrived; HP 14→14; see Dungeon.md + query_map(D1)>"`. The `tool_use` stays so the message structure is intact and the model can still see *what it did*; the bulky screen is gone. A single line per old turn keeps the pre-tail prefix small.
4. **Compaction marker.** When compaction runs, bobbihack injects a synthetic `user` message at the boundary: `"NOTE: turns 1–N have been compacted. Their summaries remain inline. For full state, call journal_read(...) and query_map(...). Recent K turns are intact below."`
5. **Model-driven recovery.** The system prompt teaches the model to call `journal_read({section: "Goals"})`, `journal_read({section: "Knowledge"})`, and `query_map(currentFloor)` after a compaction marker — so the model recovers its plans, identifications, and terrain memory deliberately rather than guessing.

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

The messages array is held in memory only during a run. We do persist `messages/NNNN.json` snapshots periodically (cheap, append-only, named by sequence number) so a process restart *could* in principle replay — but the matching nethack process is gone, so cross-process resumption is **not a goal**. The snapshot files are forensic, not load-bearing. We may use them for debugging post-mortem.

If you want serious long-running play across machine restarts, that's a future spec — it'd need NetHack save-file integration plus a way to verify the saved game matches the saved messages. Not solving that now.

---

## Migration from current architecture

| Today                                          | After                                          |
|------------------------------------------------|------------------------------------------------|
| `AnthropicAgent.decide()` — fresh per turn      | Conductor — one long call                       |
| `pickAgent()` returns one of three Agents       | `pickClient()` returns real or mock SDK; conductor is universal |
| `for await (frame of runner.frames())` in main  | conductor owns frame-awaiting via tool handlers |
| `streamToAgentEvents` translator                | inline in conductor (cleaner with messages)     |
| `MOVE_TOOL` only                                | six tools (move + 5 new)                        |
| `Agent.AgentInput` / `AgentEvent`               | conductor reads frames directly; UI events still emitted |
| `MockAgent` is its own code path                | `MockAgent` becomes a `MockAnthropicClient` — yields scripted SDK events. Same conductor runs in production and tests. |

The existing `state.ts` / `render.ts` / pane plumbing stays — they consume events emitted by the conductor (regardless of whether the SDK behind it is real or mock). The event shape needs a small expansion (e.g., a `tool_executing` event so the UI can show "running: autopilot_explore").

**`agents/anthropic.ts` and `agents/mock.ts` get rewritten or replaced.** What was an `Agent` interface becomes a thin SDK adapter; the bulk of behavior moves into the conductor.

---

## UI considerations

The agent pane (top 1/3 thinking, bottom 2/3 history) keeps its current shape. Three signals to surface that don't exist today:

1. **Currently executing tool** — title-bar suffix during a long handler: `Agent (anthropic claude-haiku-4-5) — running autopilot_explore (step 12)`.
2. **Tool result summary** — each turn's history line shows the summary line: `"#142 move(east): bumped a door"`.
3. **Streaming model text** — unchanged from today; appears in the live region as the model thinks between tool calls.

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

**Phase 1 — GameMap + tool_result format (no new tools).** Build the Map data structure and the tool_result formatter (summary + standing + status + screen). Wire them into the existing per-turn AnthropicAgent path so the smart agent already gets richer context. No architectural change yet. Watch whether the model's spatial reasoning improves.

**Phase 2 — Conductor refactor.** Move the smart agent to the long-running `messages.stream` pattern with just the existing `move` tool. Persist messages. Add cache_control. Watch token cost. (This is the load-bearing architectural step; everything else builds on it.)

**Phase 3 — Journal (`journal_read`, `journal_write`).** Trivial tools, but high value for compaction-resistance. Update system prompt to teach the model when to journal.

**Phase 4 — `query_map`.** Exposes the Map from Phase 1 as a tool.

**Phase 5 — `autopilot_to`.** A* + the keystroke loop + interrupt list.

**Phase 6 — `autopilot_explore`.** Frontier policy + interrupts. The hardest one because of policy design.

**Phase 7 — Compaction + backoff.** Production hardening: the layered compaction strategy (cache breakpoints + live-tail + summarized history + compaction marker) and Anthropic-API retry-with-backoff. The hardest phase because it's the least testable in isolation — it's where everything has to actually work together at long runtimes.

Each phase is independently demonstrable. Stop at any phase if it's not pulling weight; the architecture is the same shape.

---

## Open questions

1. **Model choice.** `claude-haiku-4-5` is current default. Sonnet 4.6 will likely be better at long-horizon reasoning + tool orchestration; haiku is cheaper. Should the system prompt + tool design be stable across model swap, or do we tune for a chosen model?
2. **Live-tail size K.** Default 20 in this spec; could be 10 or 30. Right answer depends on observed behavior — first-pass guess.
3. **The `move(quit)` action vs game-over.** How does the conductor know to exit cleanly? `runner.exited` is one signal; a model-emitted `move(quit)` is another. Need both paths handled.

Resolved by Glyph's research and Matt's review of revision 1:
- ~~Journal section list~~ — fixed at six (`Character`, `Inventory`, `Knowledge`, `Dungeon`, `Goals`, `Hypotheses`).
- ~~Color in `query_map`~~ — plain ASCII; structured info goes in `Dungeon.md`.
- ~~MockAgent disposition~~ — refactored to mock SDK, not separate Agent.
- ~~Cross-process resumption~~ — out of scope.
- ~~Trim cadence~~ — periodic (50 turns) + token-budget (80%) + hard fail-safe.
- ~~Cache breakpoint policy~~ — two breakpoints (system+initial / live-tail boundary).

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
