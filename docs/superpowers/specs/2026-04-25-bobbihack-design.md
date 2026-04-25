# bobbihack — agentic NetHack-watching TUI

**Date:** 2026-04-25
**Author:** Sancho (Bob 811efc4e)
**Status:** Design — awaiting Matt's review

## Summary

A full-screen TUI example that watches an LLM-driven agent play NetHack.
NetHack runs in an embedded 80×25 pane; a second pane streams the agent's
thinking and per-turn decisions in real time. Layout adapts to host
terminal geometry — side-by-side when wide, stacked when tall.

Built as an example in `packages/blinkyterm/examples/bobbihack/`, on top
of the existing `Runner` API. Demonstrates that blinkyterm + libghostty-vt
are not just plumbing for headless agents — they're enough to build a
spectator UI for one.

A parallel implementation (separate Bob, separate worktree) is being
built concurrently. This spec describes the bobbihack variant only; no
coordination requirements with the sibling implementation.

## Scope

**In:**
- Multi-file example under `packages/blinkyterm/examples/bobbihack/`
- Two-pane TUI (NetHack + agent thinking) with responsive layout
- Pluggable `Agent` interface; two adapters: `AnthropicAgent` (optional
  `@anthropic-ai/sdk` dep) and `MockAgent` (built-in, no dep)
- Live + history view of agent reasoning per turn
- `q` to quit; clean alt-screen restoration in all exit paths
- SIGWINCH live re-layout
- README documenting how to run with each agent

**Out:**
- Pause / resume / single-step / speed control (deferred)
- Spectator-driven manual moves (deferred)
- Multiple concurrent agents / branching playthroughs
- Recording / replay of past runs
- Anything Linux/Windows/x64 (darwin-arm64 only, per repo gate)
- Coordination with the parallel sibling implementation

## 1. Architecture

```
packages/blinkyterm/examples/bobbihack/
  main.ts          entry: argv/env, agent selection, alt-screen lifecycle
  layout.ts        pure: (hostCols, hostRows) → Layout | TooSmall
  render.ts        pure: (Layout, ViewState) → ANSI bytes
  events.ts        stdin raw-mode reader → user keystrokes
  state.ts         ViewState + reducers
  agent.ts         Agent interface + AgentEvent types
  agents/
    anthropic.ts   @anthropic-ai/sdk streaming + tool-use adapter
    mock.ts        seeded PRNG with canned thinking text
  README.md
```

Each module ≤ ~150 LOC. `layout.ts`, `render.ts`, `state.ts` are pure;
`events.ts` and `agents/*.ts` own I/O; `main.ts` composes everything.

**Dependencies:** `blinkyterm` (workspace). `@anthropic-ai/sdk` is an
`optionalDependency` lazily imported inside `agents/anthropic.ts`. No
other deps. Uses Bun runtime for stdin raw mode and `process.on("SIGWINCH")`.

## 2. The Agent interface

```ts
import type { BotMove } from "../shared/keymap";

export type AgentDecision = BotMove | "quit";

export interface AgentInput {
  readonly turn: number;
  readonly frameReason: FrameReason;
  readonly screenAnsi: string;       // frame.snapshot.toAnsi()
}

export type AgentEvent =
  | { kind: "thinking"; delta: string }
  | { kind: "action";   move: AgentDecision }
  | { kind: "error";    message: string };

export interface Agent {
  readonly name: string;
  decide(input: AgentInput, signal: AbortSignal): AsyncIterable<AgentEvent>;
  [Symbol.asyncDispose]?(): Promise<void>;
}
```

**Stream contract:** zero or more `thinking` events, then exactly one
terminator (`action` or `error`). On `error`, bobbihack falls back to
`search` and continues — same recovery posture `llm-bot.ts` uses for
unrecognized moves.

**Modal prompts handled by main, not agents.** `detectPrompt` runs first;
`--More--` → `Space`, `(y/n)` → `n`, death → break. The agent never
sees these.

**`AnthropicAgent`:**
- Streaming Messages API + tool-use.
- One tool: `move`, schema = the `AgentDecision` enum.
- System prompt: think aloud, then call `move` once.
- Each `text_delta` → `{kind: "thinking", delta}`.
- `tool_use` block → `{kind: "action", move}`.
- Default model: `claude-haiku-4-5` (cost). Override via `BOBBIHACK_MODEL`.
- Constructed only when `ANTHROPIC_API_KEY` is present (and either
  selected explicitly via `BOBBIHACK_AGENT=anthropic` or by the auto
  rule below). Without a key, bobbihack falls through to `MockAgent` —
  it does not exit.
- Honors `signal` — propagates to the SDK stream for cancellation.

**`MockAgent`:**
- Seeded PRNG (default seed 42) picks moves from `BotMove` vocabulary.
- Emits 2–4 short `thinking` deltas per turn from a canned phrase pool
  (e.g. `"Looking at the corridor…"`, `"Picking randomly: east."`).
- 50–150ms artificial delay between deltas to make streaming visible.
- Used for: development without an API key, smoke tests, CI loop tests.

**Selection:** `BOBBIHACK_AGENT=anthropic|mock` env var picks. Auto:
prefer `anthropic` if API key present, else `mock`. (No more "exit 0
without an agent" path — `MockAgent` is always available.)

## 3. Layout & rendering

**Geometry:**
- NetHack inner: 80×25. With 1-cell border + 1-row title bar: 82×27 outer.
- Thinking pane minimum useful: 40 cols × 12 rows.
- 1-cell gap between panes when split.

**`layout(hostCols, hostRows)` rules:**
1. `hostCols ≥ 124 && hostRows ≥ 27` → side-by-side. NetHack pinned left
   at 82×27; thinking takes the remaining width.
2. Else `hostCols ≥ 82 && hostRows ≥ 39` → stacked. NetHack pinned top
   at 82×27; thinking takes the remaining height.
3. Else → `tooSmall` with required minimums in the message.

Side-by-side wins when both fit.

**Thinking pane internals:**

```
┌─ Agent (anthropic claude-haiku-4-5) — turn 17, frame: cellChange ───┐
│ ▶ I see a corridor heading east. The goblin is two squares away.    │  ← live area
│   I'll move toward it to engage.                                    │     (top, fixed)
│ ─────────────────────────────────────────────────────────────────── │  ← divider
│ #16 cellChange → east   "Heading toward the goblin"                 │  ← history
│ #15 cellChange → north  "Exploring the unexplored region"           │     (newest top,
│ ...                                                                 │      ring buffer)
└─────────────────────────────────────────────────────────────────────┘
```

- Live area height: `min(8, paneHeight / 3)`. Wraps to pane width.
- History entry: `#turn frameReason → MOVE  "first 60 chars of thinking"`.
- Ring buffer sized to `paneHeight - liveHeight - 3`.

**Render approach** (hand-rolled ANSI):
1. Reset SGR; move to (1,1).
2. Draw both pane borders + title bars (Unicode box-drawing).
3. NetHack pane: split `frame.snapshot.toAnsi()` on `\n`; each row gets
   a cursor-position prefix and an `\x1b[0m` suffix as a stripe-leak guard.
4. Thinking pane: live area (word-wrapped accumulated text), divider,
   history rows.
5. Hide cursor (`\x1b[?25l`).
6. Single buffered write to `process.stdout`.

Full repaint per state change. No diff renderer in v1 (~180KB worst case
per paint at 200×60, well under any latency budget at 60Hz coalescing).

## 4. State & data flow

**`ViewState`** is a single immutable struct replaced atomically.
Fields: `layout`, `status`, `nethack` snapshot, `currentTurn` (live),
`history` ring buffer, `agentLabel`, `errorBanner`.

**Reducers** in `state.ts` (all pure):
- `onChildFrame` — refresh NetHack pane
- `onTurnStart` — set `currentTurn`
- `onAgentEvent` — append delta, or commit decision
- `onTurnEnd` — move `currentTurn` into `history`
- `onResize` — recompute layout
- `onChildExited` — freeze with terminal banner

**Main loop** drives:
1. Frame iterator from `Runner` (NetHack screen updates)
2. Per-frame: dismiss modal prompts; otherwise start a turn,
   stream agent events, end turn, send the keystroke
3. User keystroke listener runs in parallel; `q` aborts a shared
   `AbortController` that the agent honors mid-stream
4. SIGWINCH triggers `onResize` + repaint

Every state mutation calls `requestPaint()`, which is debounced to ~16ms
to coalesce streaming-token bursts.

**Quit dance** matches existing examples:
`sendText("#quit\r y\r y\r")` → `waitExit({timeoutMs: 3000})` →
`terminate({thenAfterMs: 1000})` if needed.

## 5. Errors & lifecycle

User-visible behavior in failure modes:

| Condition | What the user sees |
|---|---|
| `nethack` not on PATH | Exit 0 with `brew install nethack` message, before alt-screen |
| `ANTHROPIC_API_KEY` missing, no override | Auto-select `MockAgent`; banner notes "running with mock agent" |
| Host terminal too small | Alt-screen with "resize to 124×27 or 82×39" message; recovers when resized |
| NetHack dies mid-game | Final frame frozen, banner "child exited (code N)", waits for keypress, exits 0 |
| Anthropic API error | Turn shows "error: …" in history; agent falls back to `search`; run continues |
| User hits `q` | Clean quit dance, alt-screen restored, exit 0 |
| Unexpected throw | Restore alt-screen *first*, then surface the error |

**Cleanup invariants:**
- Alt-screen is always exited and stdin raw mode always restored, on
  every exit path including thrown errors. Implemented via a single
  `try { ... } finally { restoreTerminal() }` wrapper at the top of
  `main.ts`.
- `Runner` disposal happens in the same `finally`, ensuring NetHack is
  reaped before the host terminal is restored.

## 6. Testing

| Tier | Target | Approach |
|---|---|---|
| Unit | `layout.ts` | Table-driven: input geometry → expected `Layout` |
| Unit | `state.ts` | Reducers as pure functions; assert state transitions |
| Unit | `render.ts` | Snapshot tests on emitted ANSI for canned `ViewState`s |
| Integration | Full loop with `MockAgent` + scripted test child | Confirms end-to-end: spawn → frames → agent stream → renders → exit |
| Manual | Real NetHack + `AnthropicAgent` | Human-runnable; not in CI |

Real NetHack + real Anthropic stays out of CI, matching the existing
`random-bot.ts` / `llm-bot.ts` posture.

## 7. Non-goals & deferred

1. Spectator pause / resume / single-step. Add when actually needed.
2. Speed control (`>` / `<`).
3. Spectator-driven manual moves alongside the agent.
4. Recording/replay of past runs.
5. Multiple concurrent agents.
6. Diff-based renderer (full-repaint is fine at NetHack cadence).
7. Linux / Windows / x64.
8. Coordination with the parallel sibling implementation — bobbihack
   is self-contained.

## 8. Open questions

1. **Mock agent verbosity.** Default 2–4 deltas/turn with 50–150ms gaps
   is a guess. May feel too chatty or too sparse — easy to tune after
   first run.
2. **History ring buffer size.** Currently sized to fill the pane.
   Could persist longer history to a file for post-run review; deferred.
3. **`requestPaint()` debounce window.** 16ms is one 60Hz frame;
   bursts of Anthropic deltas may land in <1ms of each other. Tunable.
4. **Anthropic system prompt.** First draft is "play NetHack; think
   aloud; call `move` exactly once." Will iterate against real runs.
