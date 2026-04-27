# bobbihack Stateful Agentic Loop — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the design specified in `docs/superpowers/specs/2026-04-26-bobbihack-agentic-loop-design.md` (rev 4). Convert bobbihack from a per-turn one-shot Anthropic call into a stateful conductor with 27 tools, journal+map durable state, and layered compaction. Maintainable and testable in 8 phases.

**Architecture:** See spec. Briefly: one long-running `messages.stream()` call drives the game; tools (`move`, item-actions, `autopilot_*`, `journal_*`, `query_terrain`, `respond_prompt`, `command`/`extended_command`) execute in handlers and return `tool_result` payloads. GameMap and Journal are bobbihack-owned durable state.

**Tech stack:** Bun, TypeScript 5.x. New deps inside this plan: `@anthropic-ai/sdk` already present as optional. Tests use `bun:test`.

**Worktree:** Implementation MUST happen on an isolated git worktree branched from `main`. The current `main` has the rev-4 spec at `docs/superpowers/specs/2026-04-26-bobbihack-agentic-loop-design.md` and the previous bobbihack code at `packages/blinkyterm/examples/bobbihack/`. Use `superpowers:using-git-worktrees` to set up `.worktrees/bobbihack-agentic-loop`.

**Reference:** rev 4 spec at `docs/superpowers/specs/2026-04-26-bobbihack-agentic-loop-design.md`.

**Reporting checkpoints to Matt:** at the end of Phases 2, 3, 5, 8 — each is a natural spot where bobbihack runs and behavior is observable. The plan notes which checkpoints are "ready for testing."

**Plan revisions:** rev 2 incorporates Bob-Strigoi's review findings — Phase 1 dropped the throwaway integration with the existing per-turn agent, Task 8.1 is broken into named sub-functions, several test cases added per phase (security caps, runner-exited mid-tool, gameOver propagation across batch, B2 cache placement, run-id collision, weird-message parser fixture, multi-page inventory, etc.), risks expanded.

---

## File map (full)

New files:
```
packages/blinkyterm/examples/bobbihack/
  conductor.ts          # the long-running message-stream driver (Phase 2)
  game-map.ts           # GameMap class + Tile types (Phase 1)
  parsers.ts            # message-line + status-line + glyph parsers (Phase 1)
  tool-result.ts        # tool_result string formatter + JSON shapes (Phase 1)
  tools/                # one file per tool family
    move.ts             # move, search, pickup (Phase 2)
    items.ts            # eat/quaff/read/zap/wear/.../command (Phase 3)
    respond-prompt.ts   # modal answer (Phase 3)
    autopilot.ts        # autopilot_to + autopilot_explore (Phase 6, 7)
    journal.ts          # journal_read + journal_write (Phase 4)
    query.ts            # query_terrain (Phase 5)
  interrupts.ts         # interrupt detection library (Phase 1, expanded in 6)
  client.ts             # AnthropicClient interface + MockAnthropicClient (Phase 2)
  compaction.ts         # message-array compaction logic (Phase 8)
  cost.ts               # token usage + USD calculation (Phase 2 stub, full Phase 8)
  observability.ts      # run.jsonl writer (Phase 2)
  paths.ts              # .bobbihack/<run-id>/ directory layout (Phase 2)
```

Modified files:
```
packages/blinkyterm/examples/bobbihack/
  main.ts               # rewires from per-turn to conductor (Phase 2)
  state.ts              # adds tool_executing event (Phase 2)
  render.ts             # tool-execution status, autopilot-progress narration (Phase 2)
  system-prompt.txt     # rewritten for tool surface, refined per phase
  agent.ts              # deleted in Phase 2 (replaced by conductor + client)
  agents/anthropic.ts   # collapsed into client.ts in Phase 2
  agents/mock.ts        # replaced by client.ts MockAnthropicClient in Phase 2
```

Test files (parallel structure under `packages/blinkyterm/test/smoke/`):
```
bobbihack.game-map.test.ts        # Phase 1
bobbihack.parsers.test.ts         # Phase 1
bobbihack.tool-result.test.ts     # Phase 1
bobbihack.interrupts.test.ts      # Phase 1
bobbihack.conductor.test.ts       # Phase 2
bobbihack.client.test.ts          # Phase 2
bobbihack.tools-move.test.ts      # Phase 2
bobbihack.tools-items.test.ts     # Phase 3
bobbihack.tools-respond.test.ts   # Phase 3
bobbihack.tools-journal.test.ts   # Phase 4
bobbihack.tools-query.test.ts     # Phase 5
bobbihack.tools-autopilot.test.ts # Phase 6, 7
bobbihack.compaction.test.ts      # Phase 8
bobbihack.cost.test.ts            # Phase 8
```

The existing `bobbihack.mock.test.ts`, `bobbihack.anthropic.test.ts`, `bobbihack.events.test.ts`, `bobbihack.layout.test.ts`, `bobbihack.render.test.ts`, `bobbihack.state.test.ts` are kept where their subject (layout, render, state, events) survives. Tests for the deleted `Agent` interface are deleted in Phase 2.

---

## Phase 1 — GameMap + parsers + tool_result format (no behavior change)

**Goal:** Build the data structures and parsers that subsequent phases consume. Wire them into the *existing* per-turn `AnthropicAgent.decide()` so the smart agent immediately gets richer context. No conductor refactor yet.

**Phase 1 wiring is intentionally throwaway** — Phase 2 deletes the per-turn path. Don't over-engineer the integration layer.

**Output checkpoint:** bobbihack runs, agent receives screen+status+map context, observable improvement in spatial reasoning. Not yet "ready for testing" — same single tool, same per-turn pattern.

### Task 1.1: Worktree + scaffolding

- [ ] **Step 1:** Set up worktree per `superpowers:using-git-worktrees`. Branch name `bobbihack-agentic-loop`.
- [ ] **Step 2:** Verify clean baseline — `bun test test/smoke` from `packages/blinkyterm/` and `packages/libghostty-vt/`. Both pass.
- [ ] **Step 3:** Commit: `chore(bobbihack): worktree baseline for agentic-loop refactor` (no-op commit, just establishes the branch state).

### Task 1.2: parsers.ts — status-line + message-line + glyph

- [ ] **Step 1:** Write failing tests in `bobbihack.parsers.test.ts`:
  - `parseStatusLine` extracts `{name, attrs, ac, hp, hpMax, pw, pwMax, level, xp, dlvl, turn, hunger, conditions[]}` from a NetHack status row. Test on synthetic 80-char status strings; cover Hungry, Weak, Conf, Stun, Hallu, Blind.
  - `parseMessageLine` extracts the top-row message, trimming `--More--` markers.
  - `classifyGlyph(char)` returns `TileKind` for terrain glyphs and `null` for transient (monsters, items, `@`).
  - `detectBranch(messageLine)` returns a branch label or `null` for canonical NetHack messages (`"You enter the Gnomish Mines."`, `"Welcome to Sokoban!"`, etc.).
  - `detectRogueLevel(messageLine)` matches `"You enter what seems to be an older, more primitive world."`.
  - `detectPolymorph(messageLine)` matches `"You suddenly turn into..."`.
  - **Weird-message fixture:** include at least one "production-shape" message that breaks naïve string-matching — e.g. multi-clause messages like `"There is a staircase down here.--More--"`, embedded color codes from libghostty, or a status line with negative HP. The parser must handle them or skip cleanly with a documented fallback.
- [ ] **Step 2:** Run tests; confirm all fail.
- [ ] **Step 3:** Implement `parsers.ts`. Pure functions, no side effects.
- [ ] **Step 4:** Run tests; confirm all pass.
- [ ] **Step 5:** Commit: `feat(bobbihack): parsers — status, message, glyphs, branches`.

### Task 1.3: game-map.ts — GameMap class

- [ ] **Step 1:** Write failing tests in `bobbihack.game-map.test.ts`:
  - Construction: empty, no current floor.
  - `updateFromFrame` records terrain glyphs into the current FloorMap. Player tile gets `walkable: "by_inference"`.
  - `lastSeenTurn` on each tile updates monotonically — assert tile freshness on a multi-frame replay.
  - Branch transitions allocate a new FloorMap and switch `current`.
  - **`level_changed_unexpectedly` detection** — Dlvl change in a frame whose preceding action wasn't `move(up)`/`move(down)` flags the trapdoor case. Returns the new floor as fresh (allocates a new FloorMap). Test by simulating a Dlvl-jump after a `move(east)` action.
  - Boulder tracking — boulder moves between frames update prior + new tile.
  - Door state transitions (`+` → `'` on bump-open).
  - `pathfind` returns `null` for impossible targets, valid step list otherwise.
  - 8-connectivity in pathfinding; diagonal-doorway rule (no diagonal through `door_*` tiles); no diagonal squeeze past boulders.
  - `renderAscii(floorId)` returns terrain glyphs only (no monsters/items/`@`).
  - `features(floorId)` lists stairs, altars, fountains, etc.
  - Polymorph sets `walkabilitySuspect`; pathfind returns error.
  - Rogue level detection sets `isRogueLevel`; renderAscii still works (recorded glyphs are whatever was painted).
  - **Empty/zero-floor edge:** `query`-shaped methods return well-formed empty results before any frame has arrived (no `null` deref).
- [ ] **Step 2:** Run tests; confirm all fail.
- [ ] **Step 3:** Implement `game-map.ts`. The A* impl is small (priority-queue + grid). Use the diagonal-doorway rule from spec §autopilot.
- [ ] **Step 4:** Run tests; confirm all pass.
- [ ] **Step 5:** Commit: `feat(bobbihack): GameMap — per-floor terrain graph + A*`.

### Task 1.4: tool-result.ts — formatter

- [ ] **Step 1:** Write failing tests in `bobbihack.tool-result.test.ts`:
  - `formatToolResult({summary, frame, map, gameOver?})` returns the spec's string layout (header + summary + standing + status + screen).
  - The `== bobbihack tool_result v1 ==` header is exact.
  - Standing-state line includes current floor, visited floors (from map.visitedFloors()), and turn count (from status).
  - Status block parsed from the bottom row.
  - Screen is `frame.snapshot.toAnsi()`.
  - `formatGameOverResult({reason, finalTurn, finalHpMax, finalScreen})` returns the GAME OVER variant.
  - JSON-shape tool_results (`journal_read`, etc.) are passed through unchanged.
- [ ] **Step 2:** Run tests; confirm all fail.
- [ ] **Step 3:** Implement `tool-result.ts`.
- [ ] **Step 4:** Run tests; confirm all pass.
- [ ] **Step 5:** Commit: `feat(bobbihack): tool_result formatter`.

### Task 1.5: interrupts.ts — interrupt library

- [ ] **Step 1:** Write failing tests in `bobbihack.interrupts.test.ts`:
  - Each interrupt from spec §Interrupt conditions is exposed as `{name, priority, detect(prevFrame, curFrame, prevStatus, curStatus): boolean | string}`.
  - Each detect function works on synthetic frame pairs.
  - `runInterruptChecks(prev, cur, prevStatus, curStatus)` returns `{primary, also[]}` ordered by priority.
- [ ] **Step 2:** Run tests; confirm all fail.
- [ ] **Step 3:** Implement `interrupts.ts`. ~25 interrupt definitions.
- [ ] **Step 4:** Run tests; confirm all pass.
- [ ] **Step 5:** Commit: `feat(bobbihack): interrupt detection library`.

### Phase 1 done-when:

- All Phase 1 unit tests pass (parsers, game-map, tool-result, interrupts).
- Existing blinkyterm smoke tests still pass (Phase 1 doesn't touch them).
- `bun run typecheck` clean for blinkyterm.
- The current bobbihack still runs end-to-end with mock agent (we haven't changed it yet).

**Phase 1 deliberately does NOT wire the new modules into the existing per-turn agent.** Per Strigoi's review: that would be a throwaway commit. Phase 2 wires everything into the new conductor in one clean step.

---

## Phase 2 — Conductor refactor + backoff (READY FOR TESTING checkpoint)

**Goal:** Replace the per-turn agent with the conductor. Three game-state tools (`move`, `search`, `pickup`). Persistence + backoff in place.

**Output checkpoint:** **READY FOR TESTING #1.** bobbihack runs as a stateful agent. Watch token usage; confirm cache hits; observe single-game continuity. The agent can only move/search/pickup — same surface as today, but now with memory.

### Task 2.1: paths.ts + run-id + flock

- [ ] **Step 1:** Write failing tests in `bobbihack.paths.test.ts`:
  - `generateRunId()` returns `bbh-YYYYMMDD-HHMMSS-<6-hex>`.
  - `runDirs(runId)` returns the `.bobbihack/<runId>/` paths (journal/, messages/, map.json, run.jsonl, run.lock).
  - `acquireRunLock(runDir)` returns `{ released: () => void }` on success or throws if already held. Use Node fs.openSync with O_EXCL or a flock binding (Bun ships `Bun.flock` if available).
- [ ] **Step 2:** Run tests; confirm all fail.
- [ ] **Step 3:** Implement `paths.ts`.
- [ ] **Step 4:** Tests pass.
- [ ] **Step 5:** Commit: `feat(bobbihack): paths.ts — run-id, dir layout, flock`.

### Task 2.2: client.ts — AnthropicClient interface + MockAnthropicClient

- [ ] **Step 1:** Write failing tests in `bobbihack.client.test.ts`:
  - `AnthropicClient` interface: `messages.stream(args): StreamHandle` where `StreamHandle` exposes `on("text", cb)` and `finalMessage(): Promise<Message>`.
  - `MockAnthropicClient` constructor takes a scripted plan (array of `{ text?, toolUses[] }` per turn). Returns scripted streams.
  - `RealAnthropicClient` wraps `@anthropic-ai/sdk`'s `Anthropic` client; thin pass-through.
  - Test that `MockAnthropicClient` correctly emits `text` events then resolves `finalMessage()` with the assembled `assistant` message including tool_uses.
- [ ] **Step 2:** Run tests; confirm all fail.
- [ ] **Step 3:** Implement `client.ts`.
- [ ] **Step 4:** Tests pass.
- [ ] **Step 5:** Commit: `feat(bobbihack): AnthropicClient interface + MockAnthropicClient`.

### Task 2.3: tools/move.ts — move, search, pickup

- [ ] **Step 1:** Write failing tests in `bobbihack.tools-move.test.ts`:
  - `handleMove({direction, count?}, ctx)` sends the right vi-key (h/j/k/l/y/u/b/n/`.`/`>`/`<`) with optional count prefix.
  - `count` capped at 50.
  - Direction `up`/`down` send `<`/`>`.
  - Each handler awaits the next frame, updates the map, returns `formatToolResult(...)` string.
  - `handleSearch` sends `s`, awaits frame.
  - `handlePickup` sends `,`, awaits frame.
- [ ] **Step 2:** Run tests; confirm all fail.
- [ ] **Step 3:** Implement `tools/move.ts`.
- [ ] **Step 4:** Tests pass.
- [ ] **Step 5:** Commit: `feat(bobbihack): tools/move — move/search/pickup`.

### Task 2.4: cost.ts (stub) + observability.ts

- [ ] **Step 1:** Write failing tests in `bobbihack.observability.test.ts`:
  - `RunLog` writes to `run.jsonl`. Each `append(event)` is a single line. Concurrent writes serialize.
  - **Each event kind has a pinned JSON shape** (validated in tests):
    - `{event: "run_start", ts, runId, model, systemPromptHash, specVersion, toolSchemaHash}`
    - `{event: "turn", turn, ts, tool, args, summary, screenHash, usage: {input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens}}`
    - `{event: "compaction", ts, compactedThroughTurn, liveTailSize, messagesBefore, messagesAfter, snapshotPath}`
    - `{event: "retry", ts, attempt, delaySec, errorClass, statusCode?}`
    - `{event: "interrupt", ts, tool, kind, detail, also: string[]}`
    - `{event: "error", ts, errorClass, message, fatal: boolean}`
    - `{event: "run_end", ts, reason, totalTurns, totalCostUsd}`
  - System-prompt-hash + `specVersion` + `toolSchemaHash` (sha256 of TOOLS array) included in `run_start`.
  - Tests assert byte-stable JSON shape per kind (extras allowed; required fields enforced).
- [ ] **Step 2:** Write a minimal `cost.ts` returning hardcoded `0` for now (full impl in Phase 8).
- [ ] **Step 3:** Run tests; confirm fail.
- [ ] **Step 4:** Implement `observability.ts` and stub `cost.ts`.
- [ ] **Step 5:** Tests pass.
- [ ] **Step 6:** Commit: `feat(bobbihack): observability + cost stub`.

### Task 2.5: conductor.ts — the main loop

- [ ] **Step 1:** Write failing tests in `bobbihack.conductor.test.ts`:
  - End-to-end with a `MockAnthropicClient` scripted to emit `tool_use(move, north)` then `tool_use(move, east)` then text-only (graceful end). Conductor calls handlers in order, appends correct messages, persists messages, exits gracefully.
  - Multiple tool_uses in one assistant turn are batched into one user-message tool_results.
  - **N-turn end-to-end run:** scripted plan with 50 turns of `move(...)`. Assert messages array stays well-formed throughout, RunLog accumulates correct `turn` events, no leaked file handles, conductor exits cleanly on mock-emitted graceful-end.
  - When the mock injects a recoverable error (HTTP 500), the conductor retries with the documented backoff schedule (verify via fake timer or mocked `sleep`). Test against actual SDK error class (`APIError` / `RateLimitError`) instead of duck-typed `.status`.
  - **Pty quiesce flake:** mock the runner to deliver duplicate frames or out-of-order frames; conductor doesn't double-fire keystrokes.
  - Mid-batch game-over: stub tool_results are synthesized for unexecuted tools; persisted log is well-formed; `runState.gameOver` propagates correctly across the rest of the batch.
  - Mid-batch abort signal: same stub-result behavior.
  - **runner.exited mid-tool-handler:** if the runner exits during `handleMove`, the handler returns a sentinel result and the conductor exits cleanly without trying to send more keystrokes.
  - Cancellation: `signal.aborted` exits the outer while loop cleanly.
  - **Tool input validation:** model emits `move({direction: "northnorth"})` (invalid). Conductor returns a tool_result `{error: "invalid direction"}` to the model rather than crashing.
- [ ] **Step 2:** Run tests; confirm all fail.
- [ ] **Step 3:** Implement `conductor.ts` per spec §Conductor implementation sketch. Use Zod (or hand-written validators) for tool-input validation; reject malformed args with a structured error in tool_result.
- [ ] **Step 4:** Tests pass.
- [ ] **Step 5:** Commit: `feat(bobbihack): conductor — stateful messages.stream loop + backoff`.

### Task 2.6: Rewire main.ts; delete Agent interface; create dry-run fixture

- [ ] **Step 1:** Update `system-prompt.txt` to teach the model about the conductor's tool flow and the three new movement tools (`move`/`search`/`pickup` split). Keep it short — Phase 3 expands.
- [ ] **Step 2:** Create `packages/blinkyterm/examples/bobbihack/test/fixtures/scripted-plan.json` — a small plan (10-20 turns) used by both the `BOBBIHACK_DRY_RUN` smoke and the conductor tests.
- [ ] **Step 3:** Modify `main.ts`:
  - Remove `pickAgent()` Agent path.
  - Add `pickClient()` returning real or mock client. Honor `BOBBIHACK_DRY_RUN=1` + `BOBBIHACK_DRY_RUN_PLAN=<path>` to swap in MockAnthropicClient with the loaded plan.
  - Initialize Map, Journal stubs (Phase 4 makes them real), RunLog, RunState.
  - Instantiate `Conductor` and run.
- [ ] **Step 4:** Delete `agent.ts`, `agents/anthropic.ts`, `agents/mock.ts` (their tests too).
- [ ] **Step 5:** Update `bobbihack.render.test.ts` and `bobbihack.state.test.ts` expectations — UI events now include `tool_executing`.
- [ ] **Step 6:** Run all blinkyterm tests; everything passes.
- [ ] **Step 7:** Manual smoke: `BOBBIHACK_DRY_RUN=1 BOBBIHACK_DRY_RUN_PLAN=examples/bobbihack/test/fixtures/scripted-plan.json bun examples/bobbihack/main.ts` — runs end-to-end without API. This is the **non-conditional Phase 2 done-when gate** (works regardless of API-key availability). Optional live smoke if `ANTHROPIC_API_KEY` is set.
- [ ] **Step 8:** Commit: `refactor(bobbihack): replace per-turn Agent with conductor (Phase 2)`.

### Phase 2 done-when:

- All blinkyterm tests pass (including new conductor + client + tool tests).
- Typecheck clean.
- `BOBBIHACK_DRY_RUN=1` smoke runs end-to-end against the scripted-plan fixture (this is the unconditional gate; no API key required).
- bobbihack runs against the real Anthropic API with a small smoke (if `ANTHROPIC_API_KEY` is set).
- Old per-turn Agent code is gone.
- **STOP HERE AND REPORT TO MATT FOR FIRST TESTING.**

---

## Phase 3 — Item & inventory tools

**Goal:** Add the 18 item-action tools + `respond_prompt` + `inventory`. The agent can now eat, fight, identify, etc.

### Task 3.1: tools/items.ts — verb tools (one big file, one task per ~3 verbs)

For each cluster (eat/quaff/read; zap/wear/wield; puton/takeoff/remove; drop/throw/apply; kick/pray/force_fight; extended_command/command):

- [ ] **Step 1:** Write failing tests for the cluster in `bobbihack.tools-items.test.ts`. Each verb's keystroke sequence verified.
- [ ] **Step 2:** Implement.
- [ ] **Step 3:** Tests pass.
- [ ] **Step 4:** Commit per cluster: `feat(bobbihack): tools/items — eat/quaff/read` (etc).

### Task 3.2: tools/respond-prompt.ts

- [ ] **Step 1:** Write failing tests for `handleRespondPrompt({keys}, ctx)` — sends literal keys, awaits next frame.
- [ ] **Step 2:** Implement.
- [ ] **Step 3:** Tests pass.
- [ ] **Step 4:** Commit.

### Task 3.3: tools/items.ts — `inventory({})`

- [ ] **Step 1:** Write failing tests:
  - `handleInventory({}, ctx)` sends `i`, captures the inventory screen, parses items, sends `<esc>` or `<space>`, awaits frame to confirm dismissed, returns `{items: [...]}`.
  - Inventory parser handles: empty, single-item, item lines like `a - a +1 long sword (weapon in hand)`, BUC prefix markers (`* + ?`).
  - **Multi-page inventory:** a separate test exercises the `(end)` and `(N of M)` page markers. Asserts that `<space>`-to-advance-page logic captures all items across pages before dismissing.
  - Free action — nethack's turn count doesn't advance.
- [ ] **Step 2:** Implement.
- [ ] **Step 3:** Tests pass.
- [ ] **Step 4:** Commit: `feat(bobbihack): tools/items — inventory (free action, multi-page)`.

### Task 3.4: System prompt update

- [ ] **Step 1:** Update `system-prompt.txt` with all 18 new tools + their semantics, plus when to use `respond_prompt`. Concrete examples per tool.
- [ ] **Step 2:** Manual smoke with mock + scripted plan exercising eat/wear/read.
- [ ] **Step 3:** Commit: `docs(bobbihack): system-prompt — full item-action verb teaching`.

### Task 3.5: Conductor tool registry

- [ ] **Step 1:** Update `conductor.ts` `runTool` switch to dispatch all 21 new tool names. Update TOOLS array to include all 21 schemas.
- [ ] **Step 2:** Run conductor tests; everything passes.
- [ ] **Step 3:** Commit: `feat(bobbihack): conductor — wire item-action tools`.

### Phase 3 done-when:

- All Phase 3 tests pass.
- Manual smoke shows agent can eat/read/wear in a scripted plan.
- **STOP HERE AND REPORT TO MATT FOR SECOND TESTING.** This is the first phase where bobbihack can do meaningfully different things from before.

---

## Phase 4 — Journal (`journal_read`, `journal_write`)

**Goal:** Two trivial tools, big payoff for cross-compaction continuity.

### Task 4.1: tools/journal.ts

- [ ] **Step 1:** Write failing tests in `bobbihack.tools-journal.test.ts`:
  - `handleJournalRead({section}, ctx)` reads `.bobbihack/<run-id>/journal/<section>.md`. Missing returns `{section, content: ""}`. Unknown section returns `{error: ...}`.
  - `handleJournalWrite({section, content}, ctx)` writes atomically (temp + rename). Validates section enum. Rejects content > 64KB.
  - Section enum: Character, Inventory, Knowledge, Dungeon, Goals, Hypotheses.
- [ ] **Step 2:** Implement.
- [ ] **Step 3:** Tests pass.
- [ ] **Step 4:** Commit: `feat(bobbihack): tools/journal — read/write markdown sections`.

### Task 4.2: System prompt teaches journal usage

- [ ] **Step 1:** Update `system-prompt.txt` with the six section purposes (from spec §Journal table) and when to write to which.
- [ ] **Step 2:** Add an explicit instruction: "After a compaction marker, call `journal_read` for `Goals` and `Knowledge` to recover plans and identifications."
- [ ] **Step 3:** Manual smoke — scripted plan that writes Goals + Knowledge, reads them back.
- [ ] **Step 4:** Commit: `docs(bobbihack): system-prompt — journal section semantics`.

### Phase 4 done-when:

- Phase 4 tests pass.
- Mock smoke shows journal round-trip.

---

## Phase 5 — `query_terrain`

**Goal:** Surface the GameMap as a tool.

### Task 5.1: tools/query.ts

- [ ] **Step 1:** Write failing tests in `bobbihack.tools-query.test.ts`:
  - `handleQueryTerrain({floor})` returns ASCII + features for the named floor, or `{error}` if unrecorded.
  - `handleQueryTerrain({})` (no floor) returns `{floors: [...]}` listing visited floors.
  - The ASCII matches `GameMap.renderAscii` for the queried floor.
- [ ] **Step 2:** Implement.
- [ ] **Step 3:** Tests pass.
- [ ] **Step 4:** Commit: `feat(bobbihack): tools/query — query_terrain`.

### Task 5.2: System prompt + conductor wiring

- [ ] **Step 1:** Update system-prompt with the coord-then-autopilot pattern: "to walk to a remembered tile, call `query_terrain({floor})` to get its (x,y), then `autopilot_to({floor, x, y})` once that tool is available."
- [ ] **Step 2:** Wire into conductor TOOLS + dispatch.
- [ ] **Step 3:** Smoke + commit: `feat(bobbihack): conductor — wire query_terrain`.

### Phase 5 done-when:

- Phase 5 tests pass.
- Mock smoke shows model querying terrain after a compaction marker.
- **STOP HERE AND REPORT TO MATT FOR THIRD TESTING.** With journal + query_terrain, the agent has its full situational awareness toolkit; only autopilot remains.

---

## Phase 6 — `autopilot_to`

**Goal:** Pathfinding-driven autopilot to a known tile.

### Task 6.1: tools/autopilot.ts — `handleAutopilotTo`

- [ ] **Step 1:** Write failing tests in `bobbihack.tools-autopilot.test.ts`:
  - Plan A* path from current to target.
  - Step keystroke loop with frame-await and interrupt checks.
  - Stops on each interrupt condition (driven by synthetic frame sequences).
  - Returns `{error: "no path"}` for impossible.
  - Refuses Sokoban / Rogue / walkability-suspect floors.
  - Trap protection: never paths through `trap_known`; halts via `entered_trap_tile` if a trap reveals mid-step.
  - Step cap (default 50) honored.
- [ ] **Step 2:** Implement.
- [ ] **Step 3:** Tests pass.
- [ ] **Step 4:** Commit: `feat(bobbihack): tools/autopilot — autopilot_to`.

### Task 6.2: Conductor + system prompt

- [ ] **Step 1:** Wire `autopilot_to` into conductor.
- [ ] **Step 2:** Update system prompt with autopilot_to usage notes (cost, interrupt expectations).
- [ ] **Step 3:** Smoke.
- [ ] **Step 4:** Commit.

### Phase 6 done-when:

- Phase 6 tests pass.
- Mock smoke: agent calls `autopilot_to`, runs many steps, hits an interrupt, decides next.

---

## Phase 7 — `autopilot_explore`

**Goal:** Frontier-policy autopilot — the harder one.

### Task 7.1: Exploration policy

- [ ] **Step 1:** Write failing tests:
  - On a synthetic floor with one corridor exit, policy walks the corridor.
  - On a fork, prefers continuing direction.
  - BFS to nearest frontier when no adjacent unvisited.
  - Refuses Sokoban / Rogue / suspect.
  - Step cap (default 50).
  - All interrupts halt as expected.
  - Frontier exhausted returns the right summary.
- [ ] **Step 2:** Implement `handleAutopilotExplore` per spec §Exploration policy.
- [ ] **Step 3:** Tests pass.
- [ ] **Step 4:** Commit: `feat(bobbihack): tools/autopilot — autopilot_explore`.

### Task 7.2: Conductor + system prompt

- [ ] **Step 1:** Wire + system prompt.
- [ ] **Step 2:** Smoke.
- [ ] **Step 3:** Commit.

### Phase 7 done-when:

- Phase 7 tests pass.
- Mock smoke: agent calls `autopilot_explore` repeatedly; explores a multi-room floor.

---

## Phase 8 — Compaction + cost (READY FOR TESTING checkpoint)

**Goal:** Long-running production-readiness. Layered compaction, full cost monitoring, BOBBIHACK_MAX_USD kill switch.

### Task 8.1: compaction.ts

The compaction module has four named sub-functions. Implement each as a separately-tested unit, then the orchestrator.

#### 8.1a — `summarizeOldToolResult(turnIdx, toolUse, oldResult): string`

Replaces a verbose `tool_result.content` with a one-line stub. Pure function, no side effects.

- [ ] **Step 1:** Tests assert byte-stable stub format: `"<turn N — toolName(args-summary): outcome-summary>"`. Examples for `move`, `autopilot_to`, `journal_read`, etc.
- [ ] **Step 2:** Implement.
- [ ] **Step 3:** Tests pass.
- [ ] **Step 4:** Commit: `feat(bobbihack): compaction — summarizeOldToolResult`.

#### 8.1b — `placeBreakpoints(messages, liveTailStart): Message[]`

Sets `cache_control: {type: "ephemeral", ttl: "1h"}` on B1 (system) and B2 (first message at or after `liveTailStart` that wasn't rewritten in this compaction). Returns a new messages array (immutable in).

- [ ] **Step 1:** Tests:
  - B1 stays on system prompt block.
  - B2 placed correctly at `liveTailStart`.
  - **Re-compaction moves B2 forward** — second compaction's B2 must be at the new boundary, not the old.
  - **Byte-exact prefix invariant:** test that the messages-array prefix up to B2 is byte-identical to a prior request that ended at B2 (cache-eligible).
- [ ] **Step 2:** Implement.
- [ ] **Step 3:** Tests pass.
- [ ] **Step 4:** Commit: `feat(bobbihack): compaction — placeBreakpoints`.

#### 8.1c — `injectCompactionMarker(messages, atIdx, throughTurn): Message[]`

Inserts a synthetic `user` message at the boundary between compacted history and live tail.

- [ ] **Step 1:** Tests assert the marker text and position; idempotent (re-injection at the same idx replaces the existing marker rather than stacking).
- [ ] **Step 2:** Implement.
- [ ] **Step 3:** Tests pass.
- [ ] **Step 4:** Commit: `feat(bobbihack): compaction — injectCompactionMarker`.

#### 8.1d — `writeSnapshot(runDir, seqNum, messages): Promise<string>`

Writes `messages/NNNN.json` (full snapshot, NNNN = compaction sequence). Honors `BOBBIHACK_KEEP_SNAPSHOTS` retention (deletes older snapshots beyond N).

- [ ] **Step 1:** Tests:
  - First call writes `0001.json`. Second `0002.json`. Sequence increments monotonically.
  - With `BOBBIHACK_KEEP_SNAPSHOTS=2`, third call deletes `0001.json`.
  - Atomic write (temp + rename); concurrent caller never sees a partial file.
- [ ] **Step 2:** Implement.
- [ ] **Step 3:** Tests pass.
- [ ] **Step 4:** Commit: `feat(bobbihack): compaction — writeSnapshot + retention`.

#### 8.1e — `maybeCompact(messages, runState, ctx): Promise<Message[]>` (orchestrator)

Combines the four sub-functions. Triggered by:
- Periodic: every 50 turns since last compaction.
- Token budget: estimated input tokens > 80% of context window.
- Hard fail-safe: caller passes `force: true` after a 400 invalid_request_error; aggressive K=5.

- [ ] **Step 1:** Tests:
  - Trigger conditions covered (turn count, token budget via mocked estimator, force).
  - Hard fail-safe: K=5 instead of K=20.
  - On no-trigger, returns input messages unchanged.
  - Compaction event logged to RunLog.
  - `also`-style enrichment of summary line preserved when condensing tool_results.
- [ ] **Step 2:** Implement.
- [ ] **Step 3:** Tests pass.
- [ ] **Step 4:** Commit: `feat(bobbihack): compaction — maybeCompact orchestrator`.

### Task 8.2: Cost monitoring full impl

- [ ] **Step 1:** Tests in `bobbihack.cost.test.ts`:
  - Per-turn input/output/cache-read/cache-creation token usage logged.
  - Running total in USD computed from a hard-coded rates table for the chosen model.
  - `BOBBIHACK_MAX_USD` kill switch fires at threshold and exits cleanly.
  - Status-bar cost line emitted in UI events.
- [ ] **Step 2:** Implement `cost.ts` fully (replacing the Phase 2 stub).
- [ ] **Step 3:** Tests pass.
- [ ] **Step 4:** Commit: `feat(bobbihack): cost — usage tracking, USD calc, kill switch`.

### Task 8.3: Conductor wiring for compaction + cost

- [ ] **Step 1:** Conductor calls `maybeCompact(messages, runState)` after each tool batch.
- [ ] **Step 2:** Per-turn `usage` from `finalMessage().usage` logged via `RunLog.append("turn", ...)` with cost fields.
- [ ] **Step 3:** UI emits `cost_update` events; render.ts shows status-bar line.
- [ ] **Step 4:** Tests pass; manual smoke shows compaction firing at turn 50.
- [ ] **Step 5:** Commit: `feat(bobbihack): conductor — compaction + cost wiring`.

### Phase 8 done-when:

- All Phase 8 tests pass.
- Manual smoke: long mock run (200+ turns) shows compaction firing, cache hits, cost tracking.
- **STOP HERE AND REPORT TO MATT FOR FOURTH (FINAL) TESTING.** This is the production-ready milestone.

---

## Cross-cutting checks

After each phase:
- `bun test test/smoke` clean across blinkyterm and libghostty-vt.
- `bun run typecheck` clean.
- `git status` clean (no untracked / unstaged worth committing).
- A summary commit message that explains what changed.

After Phase 8:
- Update `packages/blinkyterm/CHANGELOG.md` with a "0.2.0" entry covering the agentic-loop refactor (or pick the right version per project's semver).
- Optionally tag a release.

---

## Open questions to resolve in-flight (not blocking the plan)

The spec has 5 open questions. Disposition during implementation:

1. **Model choice** (haiku-4-5 vs sonnet-4-6): start with haiku in Phase 2; switch in Phase 8 if costs warrant testing sonnet.
2. **Live-tail size K** (default 20): configurable via env `BOBBIHACK_LIVE_TAIL=N`, default 20.
3. **Inventory.md update cadence:** model-responsible per spec; revisit in Phase 8 if thrash observed.
4. **Conduct tracking:** add `extended_command({name: "conduct"})` mention in Phase 3 system prompt; no tool-side support beyond that.
5. **Travel command (`_`) fast-path:** out of scope for v0; revisit post-Phase 8.

---

## Risks the implementing Bob should watch

- **NetHack version drift.** The plan assumes NetHack 3.6 keystrokes and message strings. If the host has a different version (3.4, 3.7), tests + interrupts may fail. Document the version at the start of each run via `extended_command({name: "version"})` and stamp it into `run.jsonl`.
- **SDK API drift.** `stream.finalMessage()` is part of `@anthropic-ai/sdk`; pin a version in `package.json` to avoid silent breakage.
- **SDK error class drift.** Anthropic's SDK wraps API errors in `APIError`/`RateLimitError`/etc. classes. `isRecoverableApiError` should match against these classes (and their `.status` accessor) rather than duck-typed `.status` — recent SDK versions may not expose status the same way on all error types. Phase 2 tests include this.
- **Tool input parsing.** `tu.input` from the SDK is `unknown`-shaped; a malformed tool call (e.g. model emits `move({direction: "northnorth"})`) must fail safely with a `tool_result: {error}` rather than throw. Use Zod or hand-written validators per tool schema.
- **Cache TTL economics.** 1h `ephemeral` TTL is supported but **costs more on cache write** than 5m. Phase 8 cost tests must verify cache-creation tokens are correctly counted in the running USD total — otherwise we under-bill ourselves.
- **Pty quiesce sensitivity.** `runner.frames()` quiesce timing affects how many keystrokes the agent thinks succeeded. Phase 6/7 autopilots depend on this. Phase 2 tests include a quiesce-flake mock to verify the conductor doesn't double-fire on a flaky frame stream.
- **Worktree forgetfulness.** This is an 8-phase plan. Don't merge to main until Phase 8 done-when is satisfied (or Matt explicitly asks to merge an earlier phase). Each phase done-when is a natural rebase/merge candidate but only with explicit approval. **Rebase the worktree onto `main` between phases** — main may move while you're 8 phases deep.
- **CHANGELOG decision.** The repo's `libghostty-vt` package ships a CHANGELOG; `blinkyterm` does not (it's unpublished example-shaped code). Phase 8 doesn't add a blinkyterm CHANGELOG by default — if Matt wants one before this ships externally, it's a separate cleanup. Don't bikeshed it during the plan.
- **Co-Authored-By footer.** Commits in this repo's recent history use `Co-Authored-By: <BobName> (Bob <id>/<model>)`. Honor that style on every commit during execution; the plan's commit-message examples omit it for brevity but the implementing Bob should add it.

---

## What this plan doesn't decide

- The exact wire-format for tool input schemas (JSON Schema strings) — left to the implementer using the spec's tool table.
- Specific TypeScript class names beyond what's in the file map.
- The system-prompt wording — phases 2/3/4/5/6/7 each have a system-prompt update step; the implementer iterates.
- The exact A* implementation (priority queue choice, heuristic) — implementer picks.
