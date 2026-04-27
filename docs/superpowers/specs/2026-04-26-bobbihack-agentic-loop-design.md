# Bobbihack — Stateful Agentic Loop Design

**Author:** Dirk (Bob `1dffecf5`)
**Date:** 2026-04-26
**Status:** draft — for review
**Scope:** `packages/blinkyterm/examples/bobbihack/` — the smart-agent path
**Replaces:** the current per-turn one-shot Anthropic invocation

---

## Goals

1. **Coherent long-running play.** The agent maintains strategy and identifications across hundreds of NetHack turns without re-deriving everything from the screen each time.
2. **Token economy.** Use prompt caching, a structured tool result, and on-demand queries (`query_map`) so per-turn cost stays roughly flat as the game gets longer.
3. **Compaction resistance.** A persisted journal carries the agent's interpretive state (plans, identifications, hypotheses) across model context resets and across runs.
4. **Lower cognitive load via autopilot tools.** Repetitive movement (corridor-walking, point-to-point travel) is handled by binding-side functions that the agent invokes, returning structured results instead of a per-step LLM trace.
5. **Stable under network / transient errors.** The agent's messages array is persisted; if the long-running API call dies, bobbihack resumes from the saved state.

## Non-goals

- Multiple LLM agents (we have **one** smart agent driving; autopilots are tools, not agents).
- ML training, RLHF, or learned exploration policies — autopilot policies are hand-coded.
- Multi-game generalization — this is NetHack-specific.
- Removing `MockAgent` — kept as the deterministic baseline for tests.

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
- a `Journal` (four named sections, persisted to disk)
- the `Runner` (nethack pty)
- the `AbortController` for user-initiated cancellation

There is no per-turn `Agent` interface anymore for the smart path. The conductor is a single long-running async function. `MockAgent` still exists for tests and BOBBIHACK_AGENT=mock smoke runs; it's invoked via a different code path (per-turn `decide()` like today) since it doesn't need stateful tool use.

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
Returns the named section's current content. `section` ∈ `{PlayerSheet, Inventory, Quest, Notes}`.

**Handler:** reads `.bobbihack/journal.json` and returns `{ section, content }` (content is a string). Missing section returns `{ section, content: "" }` — never an error.

### `journal_write({ section, content })`
Replace the named section's content. Same enum.

**Handler:** writes the file atomically (temp + rename), returns `{ ok: true }`. No partial writes.

### `query_map({ floor })`
Returns the recorded ASCII map of a floor + a feature list.

**Handler:** reads from the GameMap. If `floor` is omitted, returns a list of all visited floors with turn ranges. Otherwise returns `{ floor, ascii: "<rendered terrain>", features: [{glyph, x, y, kind}] }`. Returns `{ error: "no map recorded for floor 'D5'" }` for unvisited floors.

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

```
.bobbihack/
  journal.json     // { PlayerSheet: "...", Inventory: "...", Quest: "...", Notes: "..." }
  messages.json    // persisted Anthropic messages array (for resumption)
  map.json         // serialized GameMap (for resumption)
```

Four fixed sections — `PlayerSheet`, `Inventory`, `Quest`, `Notes`. The fixed list keeps the surface bounded and the agent from creating a sprawl of one-off sections.

**Read** is non-mutating, returns the section content as a string.
**Write** replaces (not appends) the entire section — atomic via temp + rename.

The persistence file is per-game by default (`.bobbihack/<run-id>/journal.json`). The system prompt encourages the model to use it for things that aren't recoverable from screen + map: identifications, plans, hypotheses, character info.

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

## Window pressure & compaction

Long games will accumulate hundreds of `tool_result` payloads, each carrying a screen snapshot. Strategies:

1. **Prompt caching** on the system prompt and first stable user message. Anthropic SDK supports `cache_control` markers — they cut input cost on repeated long prefixes.
2. **Tool result trimming.** After N (50? 100?) turns, replace old screen ANSI in `tool_result.content` with a one-line summary: `"<screen elided; floor D2 turn 73; HP was 14/14; see query_map(D2) for layout>"`. Keep the `tool_use` and the summary line; drop the screen.
3. **Journal as escape hatch.** The model is taught to write important state (plans, identifications) to the journal so trimming doesn't lose it.
4. **Fail-soft on context overflow.** If the API returns a context-length error, force-trim aggressively and retry.

A single trim pass after every 50 game-turns is probably the right cadence. Cache breakpoints are placed before the trimmable region.

---

## Cancellation

`ac: AbortController` lives at the conductor scope. User pressing `q` calls `ac.abort()` (existing wiring in `main.ts:108`). Threads:

- Inside the streaming loop: `if (ac.signal.aborted) break` ends the for-await; the SDK aborts the HTTP call.
- Inside `runTool` handlers: `ac.signal` is checked at each iteration of any loop; on abort, the handler returns a partial result (`{ stopped: "user_aborted", at: ... }`).
- The conductor's outer `while` exits when `ac.signal.aborted`.
- `runner.sendText` and `runner.frames()` are not interrupted directly — but since the conductor exits, no further reads happen. The Runner is disposed in main.ts's `finally` block.

---

## Resumption

If the conductor exits abnormally (network error, process crash), `messages.json` and `map.json` are on disk. Restart resumes from those:

1. `loadMessagesOrInit` reads `messages.json` if present.
2. Map deserializes from `map.json`.
3. The Runner spawns a fresh nethack process — but **NetHack itself doesn't resume across processes** unless we use save files. For now, accept that resumption only works while the same nethack process is running (i.e., conductor crash without nethack crash). Multi-process resumption would need NetHack save-file integration; deferred.

---

## Migration from current architecture

| Today                                          | After                                          |
|------------------------------------------------|------------------------------------------------|
| `AnthropicAgent.decide()` — fresh per turn      | Conductor — one long call                       |
| `pickAgent()` returns one of three Agents       | `pickAgent()` selects conductor vs MockAgent   |
| `for await (frame of runner.frames())` in main  | conductor owns frame-awaiting via tool handlers |
| `streamToAgentEvents` translator                | inline in conductor (cleaner with messages)     |
| `MOVE_TOOL` only                                | six tools (move + 5 new)                        |
| `Agent.AgentInput` / `AgentEvent`               | conductor reads frames directly; UI events still emitted |
| MockAgent stays                                 | MockAgent stays (test fixture, mock-mode smoke) |

The existing `state.ts` / `render.ts` / pane plumbing stays — they react to events emitted by either the conductor or MockAgent. The shape of those events may need a small expansion (e.g., a `tool_executing` event so the UI can show "running: autopilot_explore").

---

## UI considerations

The agent pane (top 1/3 thinking, bottom 2/3 history) keeps its current shape. Three signals to surface that don't exist today:

1. **Currently executing tool** — title-bar suffix during a long handler: `Agent (anthropic claude-haiku-4-5) — running autopilot_explore (step 12)`.
2. **Tool result summary** — each turn's history line shows the summary line: `"#142 move(east): bumped a door"`.
3. **Streaming model text** — unchanged from today; appears in the live region as the model thinks between tool calls.

---

## Testing

- **Mock the SDK stream.** Build a `FakeStream` that yields scripted events (`text_delta` then `tool_use` then `content_block_stop`). Wire it into the conductor in tests; assert the conductor calls the right tool handler and appends the right messages.
- **Snapshot tool_result formatting.** Given a synthetic frame + map state, assert the constructed `summary + standing + status + screen` payload is byte-stable.
- **Map building.** Replay a sequence of fake frames (rendered ASCII strings) and assert the final FloorMap state.
- **Pathfinding.** A* over hand-built FloorMaps. Verify edge cases: no path, unknown target, target on different floor.
- **Autopilot interrupts.** Drive the autopilot handler with synthetic frames that trigger each interrupt condition; assert the right `summary` is returned.
- **Persistence round-trip.** Write messages + map, reload, continue; assert state matches.

`MockAgent` keeps its existing tests as-is; new conductor tests live alongside.

---

## Sequencing

Build in dependency order, with checkpoints:

**Phase 1 — GameMap + tool_result format (no new tools).** Build the Map data structure and the tool_result formatter (summary + standing + status + screen). Wire them into the existing per-turn AnthropicAgent path so the smart agent already gets richer context. No architectural change yet. Watch whether the model's spatial reasoning improves.

**Phase 2 — Conductor refactor.** Move the smart agent to the long-running `messages.stream` pattern with just the existing `move` tool. Persist messages. Add cache_control. Watch token cost. (This is the load-bearing architectural step; everything else builds on it.)

**Phase 3 — Journal (`journal_read`, `journal_write`).** Trivial tools, but high value for compaction-resistance. Update system prompt to teach the model when to journal.

**Phase 4 — `query_map`.** Exposes the Map from Phase 1 as a tool.

**Phase 5 — `autopilot_to`.** A* + the keystroke loop + interrupt list.

**Phase 6 — `autopilot_explore`.** Frontier policy + interrupts. The hardest one because of policy design.

**Phase 7 — Trimming + resumption.** Production hardening: tool-result summarization at N-turn cadence; persisted messages + map across crashes.

Each phase is independently demonstrable. Stop at any phase if it's not pulling weight; the architecture is the same shape.

---

## Open questions

1. **Model choice.** `claude-haiku-4-5` is current default. Sonnet 4.6 will likely be better at long-horizon reasoning + tool orchestration; haiku is cheaper. Should the system prompt + tool design be stable across model swap, or do we tune for a chosen model?
2. **Cache breakpoint policy.** Where exactly to place `cache_control` markers — only on system, or also on early stable tool results?
3. **Trim cadence.** Every 50 game-turns? Every K tokens? Trigger only on context-overflow? First-pass would be a simple turn-count threshold.
4. **Journal section sprawl.** Fix at four sections, or allow custom names? I'd start fixed; relax if the model strains against it.
5. **Cross-process resumption.** Tied to NetHack save-files. Deferred for now — but if you want serious long-running play, this becomes important.
6. **MockAgent in this world.** Keep as-is for tests + smoke (per-turn `decide()`)? Or refactor to also be tool-based for consistency? I'd keep as-is — it's a fixture, not the main path.
7. **The `move(quit)` action vs game-over.** How does the conductor know to exit cleanly? `runner.exited` is one signal; a model-emitted `move(quit)` is another. Need both paths handled.

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
