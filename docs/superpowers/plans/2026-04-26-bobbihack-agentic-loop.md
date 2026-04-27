# bobbihack Stateful Agentic Loop — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the design specified in `docs/superpowers/specs/2026-04-26-bobbihack-agentic-loop-design.md` (rev 4). Convert bobbihack from a per-turn one-shot Anthropic call into a stateful conductor with 27 tools, journal+map durable state, and layered compaction. Maintainable and testable in 8 phases.

**Architecture:** See spec. Briefly: one long-running `messages.stream()` call drives the game; tools (`move`, item-actions, `autopilot_*`, `journal_*`, `query_terrain`, `respond_prompt`, `command`/`extended_command`) execute in handlers and return `tool_result` payloads. GameMap and Journal are bobbihack-owned durable state.

**Tech stack:** Bun, TypeScript 5.x. New deps inside this plan: `@anthropic-ai/sdk` already present as optional. Tests use `bun:test`.

**Worktree:** Implementation MUST happen on an isolated git worktree branched from `main`. The current `main` has the rev-4 spec at `docs/superpowers/specs/2026-04-26-bobbihack-agentic-loop-design.md` and the previous bobbihack code at `packages/blinkyterm/examples/bobbihack/`. Use `superpowers:using-git-worktrees` to set up `.worktrees/bobbihack-agentic-loop`.

**Reference:** rev 4 spec at `docs/superpowers/specs/2026-04-26-bobbihack-agentic-loop-design.md`.

**Reporting checkpoints to Matt:** at the end of Phases 2, 3, 5, 8 — each is a natural spot where bobbihack runs and behavior is observable. The plan notes which checkpoints are "ready for testing."

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
- [ ] **Step 2:** Run tests; confirm all fail.
- [ ] **Step 3:** Implement `parsers.ts`. Pure functions, no side effects.
- [ ] **Step 4:** Run tests; confirm all pass.
- [ ] **Step 5:** Commit: `feat(bobbihack): parsers — status, message, glyphs, branches`.

### Task 1.3: game-map.ts — GameMap class

- [ ] **Step 1:** Write failing tests in `bobbihack.game-map.test.ts`:
  - Construction: empty, no current floor.
  - `updateFromFrame` records terrain glyphs into the current FloorMap. Player tile gets `walkable: "by_inference"`.
  - Branch transitions allocate a new FloorMap and switch `current`.
  - Boulder tracking — boulder moves between frames update prior + new tile.
  - Door state transitions (`+` → `'` on bump-open).
  - `pathfind` returns `null` for impossible targets, valid step list otherwise.
  - 8-connectivity in pathfinding; diagonal-doorway rule (no diagonal through `door_*` tiles).
  - `renderAscii(floorId)` returns terrain glyphs only (no monsters/items/`@`).
  - `features(floorId)` lists stairs, altars, fountains, etc.
  - Polymorph sets `walkabilitySuspect`; pathfind returns error.
  - Rogue level detection sets `isRogueLevel`; renderAscii still works (recorded glyphs are whatever was painted).
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

### Task 1.6: Wire into existing AnthropicAgent (throwaway integration)

- [ ] **Step 1:** Modify `agents/anthropic.ts`'s `decide()` to:
  - Update an in-memory GameMap from each frame.
  - Construct the user message body using `formatToolResult` (instead of the raw "Turn N (waking on: X). Current screen:\n\n${ansi}" string).
- [ ] **Step 2:** Run existing `bobbihack.anthropic.test.ts` smoke; update to expect new prompt shape if it asserts on it.
- [ ] **Step 3:** Manual smoke: `BOBBIHACK_AGENT=mock bun examples/bobbihack/main.ts` (mock smoke is unaffected, just verify it still runs). If `ANTHROPIC_API_KEY` is set locally, brief live smoke.
- [ ] **Step 4:** Commit: `feat(bobbihack): enrich per-turn user message with map+status (Phase 1 wiring, throwaway)`.

### Phase 1 done-when:

- All Phase 1 tests pass.
- Existing smoke tests still pass.
- `bun run typecheck` clean for blinkyterm.
- bobbihack runs end-to-end with mock agent.

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
  - All required event kinds (`run_start`, `run_end`, `turn`, `retry`, `compaction`, `interrupt`, `error`) round-trip correctly.
  - System-prompt-hash is included in `run_start`.
- [ ] **Step 2:** Write a minimal `cost.ts` returning hardcoded `0` for now (full impl in Phase 8).
- [ ] **Step 3:** Run tests; confirm fail.
- [ ] **Step 4:** Implement `observability.ts` and stub `cost.ts`.
- [ ] **Step 5:** Tests pass.
- [ ] **Step 6:** Commit: `feat(bobbihack): observability + cost stub`.

### Task 2.5: conductor.ts — the main loop

- [ ] **Step 1:** Write failing tests in `bobbihack.conductor.test.ts`:
  - End-to-end with a `MockAnthropicClient` scripted to emit `tool_use(move, north)` then `tool_use(move, east)` then text-only (graceful end). Conductor calls handlers in order, appends correct messages, persists messages, exits gracefully.
  - Multiple tool_uses in one assistant turn are batched into one user-message tool_results.
  - When the mock injects a recoverable error (HTTP 500), the conductor retries with the documented backoff schedule (verify via fake timer or mocked `sleep`).
  - Mid-batch game-over: stub tool_results are synthesized for unexecuted tools; persisted log is well-formed.
  - Mid-batch abort signal: same stub-result behavior.
  - Cancellation: `signal.aborted` exits the outer while loop cleanly.
- [ ] **Step 2:** Run tests; confirm all fail.
- [ ] **Step 3:** Implement `conductor.ts` per spec §Conductor implementation sketch.
- [ ] **Step 4:** Tests pass.
- [ ] **Step 5:** Commit: `feat(bobbihack): conductor — stateful messages.stream loop + backoff`.

### Task 2.6: Rewire main.ts; delete Agent interface

- [ ] **Step 1:** Update `system-prompt.txt` to teach the model about the conductor's tool flow and the three new movement tools (`move`/`search`/`pickup` split). Keep it short — Phase 3 expands.
- [ ] **Step 2:** Modify `main.ts`:
  - Remove `pickAgent()` Agent path.
  - Add `pickClient()` returning real or mock client.
  - Initialize Map, Journal stubs (Phase 4 makes them real), RunLog, RunState.
  - Instantiate `Conductor` and run.
- [ ] **Step 3:** Delete `agent.ts`, `agents/anthropic.ts`, `agents/mock.ts` (their tests too).
- [ ] **Step 4:** Update `bobbihack.render.test.ts` and `bobbihack.state.test.ts` expectations — UI events now include `tool_executing`.
- [ ] **Step 5:** Run all blinkyterm tests; everything passes.
- [ ] **Step 6:** Manual smoke: `BOBBIHACK_DRY_RUN=1 BOBBIHACK_DRY_RUN_PLAN=test/fixtures/scripted-plan.json bun examples/bobbihack/main.ts`. Optional live smoke if `ANTHROPIC_API_KEY` is set.
- [ ] **Step 7:** Commit: `refactor(bobbihack): replace per-turn Agent with conductor (Phase 2)`.

### Phase 2 done-when:

- All blinkyterm tests pass (including new conductor + client + tool tests).
- Typecheck clean.
- bobbihack runs against MockAnthropicClient with a scripted plan.
- bobbihack runs against the real Anthropic API with a small smoke (if keys available).
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
  - Inventory parser handles: empty, single-item, multi-page, item lines like `a - a +1 long sword (weapon in hand)`.
  - Free action — nethack's turn count doesn't advance.
- [ ] **Step 2:** Implement.
- [ ] **Step 3:** Tests pass.
- [ ] **Step 4:** Commit: `feat(bobbihack): tools/items — inventory (free action)`.

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

- [ ] **Step 1:** Write failing tests in `bobbihack.compaction.test.ts`:
  - Trigger periodic (every 50 turns) and token-budget (>80%) compaction.
  - Live tail of K=20 kept verbatim; older `tool_result.content` replaced with stub.
  - Compaction marker injected at the boundary.
  - Compaction sequence numbered; snapshot written to `messages/NNNN.json`.
  - `BOBBIHACK_KEEP_SNAPSHOTS` retention.
  - Hard fail-safe (400 invalid_request_error) compacts aggressively to K=5 and retries once.
- [ ] **Step 2:** Implement.
- [ ] **Step 3:** Tests pass.
- [ ] **Step 4:** Commit: `feat(bobbihack): compaction — cache breakpoints, live tail, marker`.

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
- **Pty quiesce sensitivity.** `runner.frames()` quiesce timing affects how many keystrokes the agent thinks succeeded. Phase 6/7 autopilots depend on this. If autopilot loops feel wrong, instrument with `runner.frames({quiesceMs: ...})` tuning.
- **Worktree forgetfulness.** This is a 8-phase plan. Don't merge to main until Phase 8 done-when is satisfied (or Matt explicitly asks to merge an earlier phase). Each phase done-when is a natural rebase/merge candidate but only with explicit approval.

---

## What this plan doesn't decide

- The exact wire-format for tool input schemas (JSON Schema strings) — left to the implementer using the spec's tool table.
- Specific TypeScript class names beyond what's in the file map.
- The system-prompt wording — phases 2/3/4/5/6/7 each have a system-prompt update step; the implementer iterates.
- The exact A* implementation (priority queue choice, heuristic) — implementer picks.
