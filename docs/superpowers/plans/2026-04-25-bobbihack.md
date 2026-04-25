# bobbihack Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the `bobbihack` example — a full-screen TUI that watches an
LLM agent play NetHack — under `packages/blinkyterm/examples/bobbihack/`.

**Architecture:** Multi-file example. Pure modules (`layout.ts`,
`state.ts`, `render.ts`) are TDD-first. Side-effect modules
(`events.ts`, `agents/anthropic.ts`, `main.ts`) factor pure helpers out
for testing and treat the I/O shell as integration-tested. Two `Agent`
implementations: a built-in `MockAgent` (no deps) and an `AnthropicAgent`
(optional `@anthropic-ai/sdk` dep, lazy-imported).

**Tech Stack:** Bun (test, runtime, FFI), TypeScript 5.x,
`libghostty-vt` and `blinkyterm` workspace packages, optional
`@anthropic-ai/sdk`. Rendering uses hand-rolled ANSI (alt-screen,
cursor positioning, Unicode box-drawing). Tests use `bun:test`.

**Worktree:** A parallel sibling implementation (`robohack`) is in
flight on `main`. Implementation Bobs MUST work on an isolated git
worktree to avoid file collisions — a robohack file already lives at
`packages/blinkyterm/test/smoke/robohack.layout.test.ts` (untracked).
All bobbihack tests use the prefix `bobbihack.*.test.ts` and the example
lives in its own subdirectory, but the worktree is still required because
the parallel implementation may modify shared files
(`packages/blinkyterm/package.json`).

**Reference:** Spec at
`docs/superpowers/specs/2026-04-25-bobbihack-design.md`.

---

## File Map

**Created (in order of task):**

| Path | Purpose | Task |
|---|---|---|
| `packages/blinkyterm/examples/bobbihack/agent.ts` | Agent interface + AgentEvent types | 1 |
| `packages/blinkyterm/examples/bobbihack/layout.ts` | Pure layout function | 2 |
| `packages/blinkyterm/test/smoke/bobbihack.layout.test.ts` | Layout tests | 2 |
| `packages/blinkyterm/examples/bobbihack/state.ts` | ViewState + reducers | 3 |
| `packages/blinkyterm/test/smoke/bobbihack.state.test.ts` | State tests | 3 |
| `packages/blinkyterm/examples/bobbihack/render.ts` | Pure render function | 4 |
| `packages/blinkyterm/test/smoke/bobbihack.render.test.ts` | Render tests | 4 |
| `packages/blinkyterm/examples/bobbihack/events.ts` | stdin raw-mode + key parser | 5 |
| `packages/blinkyterm/test/smoke/bobbihack.events.test.ts` | Key parser tests | 5 |
| `packages/blinkyterm/examples/bobbihack/agents/mock.ts` | MockAgent | 6 |
| `packages/blinkyterm/test/smoke/bobbihack.mock.test.ts` | MockAgent tests | 6 |
| `packages/blinkyterm/examples/bobbihack/agents/anthropic.ts` | AnthropicAgent | 7 |
| `packages/blinkyterm/test/smoke/bobbihack.anthropic.test.ts` | Anthropic translator tests | 7 |
| `packages/blinkyterm/examples/bobbihack/main.ts` | Composition + lifecycle | 8 |
| `packages/blinkyterm/examples/bobbihack/README.md` | User docs | 9 |

**Modified:**
- `packages/blinkyterm/package.json` — add `@anthropic-ai/sdk` to
  `optionalDependencies`, add `bobbihack` script (Tasks 0 + 9)

---

## Task 0: Worktree + optional dependency

**Files:**
- Modify: `packages/blinkyterm/package.json`

- [ ] **Step 1: Verify you are on a clean worktree branch off `main`**

Run: `git branch --show-current && git status --short`
Expected: branch name is `bobbihack-impl` (or similar — anything other
than `main`); the only `??` lines are pre-existing parallel-implementation
files (`docs/superpowers/specs/2026-04-25-robohack-design.md`,
`docs/superpowers/plans/2026-04-25-robohack.md`,
`packages/blinkyterm/examples/robohack/`,
`packages/blinkyterm/test/smoke/robohack.layout.test.ts`).

If you are on `main`, STOP and ask the dispatcher to create a worktree.

- [ ] **Step 2: Add `@anthropic-ai/sdk` as an optional dependency**

Read `packages/blinkyterm/package.json` first. Then add the
`optionalDependencies` block (or extend it if present). Final
dependencies section should look like:

```json
  "dependencies": {
    "libghostty-vt": "workspace:*"
  },
  "optionalDependencies": {
    "@anthropic-ai/sdk": "^0.65.0"
  },
  "devDependencies": {
    "@types/bun": "latest",
    "typescript": "^5.4.0"
  }
```

If `optionalDependencies` already contains `@anthropic-ai/sdk` (because
the parallel implementation added it), leave the block alone.

- [ ] **Step 3: Run `bun install` from the workspace root**

Run: `bun install`
Expected: succeeds; `node_modules/@anthropic-ai/sdk/` exists.

- [ ] **Step 4: Commit**

```bash
git add packages/blinkyterm/package.json bun.lock
git commit -m "chore(blinkyterm): add @anthropic-ai/sdk as optional dep for bobbihack

Co-Authored-By: <your-bob-name> (Bob <session-id-prefix>/<model>)"
```

If the parallel implementation already committed this dependency, skip
the commit.

---

## Task 1: Agent interface

**Files:**
- Create: `packages/blinkyterm/examples/bobbihack/agent.ts`

This task has no test of its own — it's pure types. Subsequent tasks
import from it; the typecheck across them is the test.

- [ ] **Step 1: Create the agent interface module**

Write `packages/blinkyterm/examples/bobbihack/agent.ts`:

```ts
import type { BotMove } from "../shared/keymap";
import type { FrameReason } from "../../src/types";

/** A move the agent can decide to execute, plus a clean-quit option. */
export type AgentDecision = BotMove | "quit";

export interface AgentInput {
  readonly turn: number;
  readonly frameReason: FrameReason;
  /** ANSI rendering of the current NetHack screen (`frame.snapshot.toAnsi()`). */
  readonly screenAnsi: string;
}

export type AgentEvent =
  | { readonly kind: "thinking"; readonly delta: string }
  | { readonly kind: "action"; readonly move: AgentDecision }
  | { readonly kind: "error"; readonly message: string };

export interface Agent {
  readonly name: string;
  /**
   * Stream zero or more `thinking` events, then exactly one terminator
   * (`action` or `error`). Honor `signal` for mid-turn cancellation.
   */
  decide(input: AgentInput, signal: AbortSignal): AsyncIterable<AgentEvent>;
  [Symbol.asyncDispose]?(): Promise<void>;
}
```

- [ ] **Step 2: Verify typecheck passes**

Run: `cd packages/blinkyterm && bun run typecheck`
Expected: PASS — no errors in `agent.ts`.

- [ ] **Step 3: Commit**

```bash
git add packages/blinkyterm/examples/bobbihack/agent.ts
git commit -m "feat(bobbihack): Agent interface + AgentEvent types"
```

---

## Task 2: layout.ts

**Files:**
- Create: `packages/blinkyterm/examples/bobbihack/layout.ts`
- Test: `packages/blinkyterm/test/smoke/bobbihack.layout.test.ts`

- [ ] **Step 1: Write failing tests**

Write `packages/blinkyterm/test/smoke/bobbihack.layout.test.ts`:

```ts
import { expect, test } from "bun:test";
import { layout } from "../../examples/bobbihack/layout";

test("side-by-side when wide enough", () => {
  const out = layout(200, 60);
  expect(out.kind).toBe("side");
  if (out.kind !== "side") return;
  expect(out.nethack).toEqual({ row: 1, col: 1, cols: 82, rows: 27 });
  // thinking pane occupies remaining width (200 - 82 - 1 = 117), full host height
  expect(out.thinking).toEqual({ row: 1, col: 84, cols: 117, rows: 60 });
});

test("side-by-side at the exact threshold (124x27)", () => {
  const out = layout(124, 27);
  expect(out.kind).toBe("side");
  if (out.kind !== "side") return;
  expect(out.thinking.cols).toBe(41); // 124 - 82 - 1
  expect(out.thinking.rows).toBe(27);
});

test("stacked when tall but not wide enough for side-by-side", () => {
  const out = layout(100, 40);
  expect(out.kind).toBe("stacked");
  if (out.kind !== "stacked") return;
  expect(out.nethack).toEqual({ row: 1, col: 1, cols: 82, rows: 27 });
  // thinking pane below NetHack, full width, remaining height (40 - 27 - 1 = 12)
  expect(out.thinking).toEqual({ row: 29, col: 1, cols: 100, rows: 12 });
});

test("stacked at the exact threshold (82x39)", () => {
  const out = layout(82, 39);
  expect(out.kind).toBe("stacked");
});

test("side-by-side wins when both fit", () => {
  // 124x39 satisfies both: side-by-side preferred
  const out = layout(124, 39);
  expect(out.kind).toBe("side");
});

test("tooSmall when neither layout fits", () => {
  const out = layout(80, 24);
  expect(out.kind).toBe("tooSmall");
  if (out.kind !== "tooSmall") return;
  expect(out.minSideCols).toBe(124);
  expect(out.minSideRows).toBe(27);
  expect(out.minStackedCols).toBe(82);
  expect(out.minStackedRows).toBe(39);
});

test("tooSmall on degenerate input", () => {
  expect(layout(1, 1).kind).toBe("tooSmall");
  expect(layout(0, 0).kind).toBe("tooSmall");
});
```

- [ ] **Step 2: Run tests to confirm they fail**

Run: `cd packages/blinkyterm && bun test test/smoke/bobbihack.layout.test.ts`
Expected: FAIL with "Cannot find module '../../examples/bobbihack/layout'".

- [ ] **Step 3: Implement `layout.ts`**

Write `packages/blinkyterm/examples/bobbihack/layout.ts`:

```ts
export interface Box {
  readonly row: number;   // 1-based
  readonly col: number;   // 1-based
  readonly cols: number;
  readonly rows: number;
}

export type Layout =
  | { readonly kind: "side"; readonly nethack: Box; readonly thinking: Box }
  | { readonly kind: "stacked"; readonly nethack: Box; readonly thinking: Box }
  | {
      readonly kind: "tooSmall";
      readonly minSideCols: number;
      readonly minSideRows: number;
      readonly minStackedCols: number;
      readonly minStackedRows: number;
    };

const NETHACK_COLS = 82;   // 80 inner + 2 border
const NETHACK_ROWS = 27;   // 25 inner + 1 title bar + 2 border (row 27 incl title)
const GAP = 1;
const SIDE_MIN_THINKING_COLS = 40;
const STACKED_MIN_THINKING_ROWS = 11;

export function layout(hostCols: number, hostRows: number): Layout {
  const sideMinCols = NETHACK_COLS + GAP + SIDE_MIN_THINKING_COLS; // 123 + 1 = 124
  const sideMinRows = NETHACK_ROWS;                                 // 27
  const stackedMinCols = NETHACK_COLS;                              // 82
  const stackedMinRows = NETHACK_ROWS + GAP + STACKED_MIN_THINKING_ROWS; // 39

  if (hostCols >= sideMinCols && hostRows >= sideMinRows) {
    return {
      kind: "side",
      nethack: { row: 1, col: 1, cols: NETHACK_COLS, rows: NETHACK_ROWS },
      thinking: {
        row: 1,
        col: NETHACK_COLS + GAP + 1,
        cols: hostCols - NETHACK_COLS - GAP,
        rows: hostRows,
      },
    };
  }

  if (hostCols >= stackedMinCols && hostRows >= stackedMinRows) {
    return {
      kind: "stacked",
      nethack: { row: 1, col: 1, cols: NETHACK_COLS, rows: NETHACK_ROWS },
      thinking: {
        row: NETHACK_ROWS + GAP + 1,
        col: 1,
        cols: hostCols,
        rows: hostRows - NETHACK_ROWS - GAP,
      },
    };
  }

  return {
    kind: "tooSmall",
    minSideCols: sideMinCols,
    minSideRows: sideMinRows,
    minStackedCols: stackedMinCols,
    minStackedRows: stackedMinRows,
  };
}
```

- [ ] **Step 4: Run tests to confirm they pass**

Run: `cd packages/blinkyterm && bun test test/smoke/bobbihack.layout.test.ts`
Expected: PASS — 7 tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/blinkyterm/examples/bobbihack/layout.ts packages/blinkyterm/test/smoke/bobbihack.layout.test.ts
git commit -m "feat(bobbihack): pure layout function with side/stacked/tooSmall"
```

---

## Task 3: state.ts (ViewState + reducers)

**Files:**
- Create: `packages/blinkyterm/examples/bobbihack/state.ts`
- Test: `packages/blinkyterm/test/smoke/bobbihack.state.test.ts`

- [ ] **Step 1: Write failing tests**

Write `packages/blinkyterm/test/smoke/bobbihack.state.test.ts`:

```ts
import { expect, test } from "bun:test";
import {
  initialState,
  onAgentEvent,
  onChildExited,
  onChildFrame,
  onResize,
  onTurnEnd,
  onTurnStart,
} from "../../examples/bobbihack/state";
import type { Frame } from "../../src/types";

const fakeSnapshot = (text: string) => ({
  text,
  title: "",
  cursor: { x: 0, y: 0, visible: true },
  bellsSinceLast: 0,
  titleChangesSinceLast: [],
  toAnsi: () => text,
  toHtml: () => `<pre>${text}</pre>`,
  toVt: () => text,
  cellAt: () => null,
});

const fakeFrame = (text: string, reason = "cellChange" as const): Frame => ({
  reason,
  snapshot: fakeSnapshot(text) as Frame["snapshot"],
});

test("initialState has empty pane and history", () => {
  const s = initialState({ hostCols: 200, hostRows: 60, agentLabel: "mock", pid: 999 });
  expect(s.status).toBe("running");
  expect(s.history).toEqual([]);
  expect(s.currentTurn).toBeNull();
  expect(s.agentLabel).toBe("mock");
  expect(s.layout.kind).toBe("side");
});

test("onChildFrame updates the NetHack pane content", () => {
  const s0 = initialState({ hostCols: 200, hostRows: 60, agentLabel: "mock", pid: 1 });
  const s1 = onChildFrame(s0, fakeFrame("hello"));
  expect(s1.nethack.screenAnsi).toBe("hello");
});

test("onTurnStart sets currentTurn with empty streamingText", () => {
  let s = initialState({ hostCols: 200, hostRows: 60, agentLabel: "mock", pid: 1 });
  s = onTurnStart(s, { turn: 1, frameReason: "cellChange" });
  expect(s.currentTurn).toEqual({
    number: 1,
    frameReason: "cellChange",
    streamingText: "",
    committed: null,
  });
});

test("onAgentEvent thinking appends delta to streamingText", () => {
  let s = initialState({ hostCols: 200, hostRows: 60, agentLabel: "mock", pid: 1 });
  s = onTurnStart(s, { turn: 1, frameReason: "cellChange" });
  s = onAgentEvent(s, { kind: "thinking", delta: "hello " });
  s = onAgentEvent(s, { kind: "thinking", delta: "world" });
  expect(s.currentTurn?.streamingText).toBe("hello world");
});

test("onAgentEvent action sets committed", () => {
  let s = initialState({ hostCols: 200, hostRows: 60, agentLabel: "mock", pid: 1 });
  s = onTurnStart(s, { turn: 1, frameReason: "cellChange" });
  s = onAgentEvent(s, { kind: "action", move: "east" });
  expect(s.currentTurn?.committed).toBe("east");
});

test("onAgentEvent thinking is ignored when no current turn", () => {
  const s0 = initialState({ hostCols: 200, hostRows: 60, agentLabel: "mock", pid: 1 });
  const s1 = onAgentEvent(s0, { kind: "thinking", delta: "stray" });
  expect(s1).toBe(s0);
});

test("onTurnEnd moves currentTurn into history (newest first)", () => {
  let s = initialState({ hostCols: 200, hostRows: 60, agentLabel: "mock", pid: 1 });
  s = onTurnStart(s, { turn: 1, frameReason: "cellChange" });
  s = onAgentEvent(s, { kind: "thinking", delta: "going east " });
  s = onAgentEvent(s, { kind: "thinking", delta: "to fight goblin" });
  s = onAgentEvent(s, { kind: "action", move: "east" });
  s = onTurnEnd(s);

  expect(s.currentTurn).toBeNull();
  expect(s.history.length).toBe(1);
  expect(s.history[0]).toMatchObject({
    number: 1,
    frameReason: "cellChange",
    decision: "east",
  });
  expect(s.history[0]?.summary).toContain("going east");
});

test("onTurnEnd records error decision when committed is null", () => {
  let s = initialState({ hostCols: 200, hostRows: 60, agentLabel: "mock", pid: 1 });
  s = onTurnStart(s, { turn: 7, frameReason: "bell" });
  s = onAgentEvent(s, { kind: "error", message: "rate limited" });
  s = onTurnEnd(s);
  expect(s.history[0]?.decision).toBe("error");
});

test("history is newest-first and bounded by capacity", () => {
  let s = initialState({ hostCols: 200, hostRows: 60, agentLabel: "mock", pid: 1, historyCapacity: 3 });
  for (let i = 1; i <= 5; i++) {
    s = onTurnStart(s, { turn: i, frameReason: "cellChange" });
    s = onAgentEvent(s, { kind: "action", move: "north" });
    s = onTurnEnd(s);
  }
  expect(s.history.map((h) => h.number)).toEqual([5, 4, 3]);
});

test("onResize recomputes layout", () => {
  let s = initialState({ hostCols: 200, hostRows: 60, agentLabel: "mock", pid: 1 });
  expect(s.layout.kind).toBe("side");
  s = onResize(s, 100, 40);
  expect(s.layout.kind).toBe("stacked");
});

test("onChildExited freezes status and stores exit info", () => {
  let s = initialState({ hostCols: 200, hostRows: 60, agentLabel: "mock", pid: 1 });
  s = onChildExited(s, "exited", 0);
  expect(s.status).toBe("exited");
  expect(s.errorBanner).toContain("exited");
});
```

- [ ] **Step 2: Run tests to confirm they fail**

Run: `cd packages/blinkyterm && bun test test/smoke/bobbihack.state.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `state.ts`**

Write `packages/blinkyterm/examples/bobbihack/state.ts`:

```ts
import type { Frame, FrameReason } from "../../src/types";
import { layout, type Layout } from "./layout";
import type { AgentDecision, AgentEvent } from "./agent";

const DEFAULT_HISTORY_CAPACITY = 200;
const SUMMARY_LEN = 60;

export interface NethackPane {
  readonly screenAnsi: string;
  readonly pid: number;
  readonly bellsCumulative: number;
  readonly title: string;
}

export interface TurnState {
  readonly number: number;
  readonly frameReason: FrameReason;
  readonly streamingText: string;
  readonly committed: AgentDecision | null;
}

export interface TurnRecord {
  readonly number: number;
  readonly frameReason: FrameReason;
  readonly summary: string;
  readonly decision: AgentDecision | "error";
}

export type Status = "running" | "quitting" | "exited" | "tooSmall";

export interface ViewState {
  readonly layout: Layout;
  readonly status: Status;
  readonly nethack: NethackPane;
  readonly currentTurn: TurnState | null;
  readonly history: readonly TurnRecord[];
  readonly historyCapacity: number;
  readonly agentLabel: string;
  readonly errorBanner: string | null;
}

export interface InitArgs {
  hostCols: number;
  hostRows: number;
  agentLabel: string;
  pid: number;
  historyCapacity?: number;
}

export function initialState(args: InitArgs): ViewState {
  return {
    layout: layout(args.hostCols, args.hostRows),
    status: "running",
    nethack: {
      screenAnsi: "",
      pid: args.pid,
      bellsCumulative: 0,
      title: "",
    },
    currentTurn: null,
    history: [],
    historyCapacity: args.historyCapacity ?? DEFAULT_HISTORY_CAPACITY,
    agentLabel: args.agentLabel,
    errorBanner: null,
  };
}

export function onChildFrame(state: ViewState, frame: Frame): ViewState {
  return {
    ...state,
    nethack: {
      ...state.nethack,
      screenAnsi: frame.snapshot.toAnsi(),
      bellsCumulative: state.nethack.bellsCumulative + frame.snapshot.bellsSinceLast,
      title: frame.snapshot.title || state.nethack.title,
    },
  };
}

export function onTurnStart(
  state: ViewState,
  args: { turn: number; frameReason: FrameReason },
): ViewState {
  return {
    ...state,
    currentTurn: {
      number: args.turn,
      frameReason: args.frameReason,
      streamingText: "",
      committed: null,
    },
  };
}

export function onAgentEvent(state: ViewState, event: AgentEvent): ViewState {
  if (state.currentTurn === null) return state;
  const turn = state.currentTurn;
  switch (event.kind) {
    case "thinking":
      return {
        ...state,
        currentTurn: { ...turn, streamingText: turn.streamingText + event.delta },
      };
    case "action":
      return { ...state, currentTurn: { ...turn, committed: event.move } };
    case "error":
      return {
        ...state,
        currentTurn: { ...turn, committed: null },
        errorBanner: `agent error: ${event.message}`,
      };
  }
}

export function onTurnEnd(state: ViewState): ViewState {
  if (state.currentTurn === null) return state;
  const turn = state.currentTurn;
  const decision: AgentDecision | "error" = turn.committed ?? "error";
  const summary = turn.streamingText.replace(/\s+/g, " ").trim().slice(0, SUMMARY_LEN);
  const record: TurnRecord = {
    number: turn.number,
    frameReason: turn.frameReason,
    summary,
    decision,
  };
  const next = [record, ...state.history].slice(0, state.historyCapacity);
  return { ...state, currentTurn: null, history: next };
}

export function onResize(state: ViewState, hostCols: number, hostRows: number): ViewState {
  return { ...state, layout: layout(hostCols, hostRows) };
}

export function onChildExited(
  state: ViewState,
  reason: "exited" | "crashed",
  exitCode?: number,
): ViewState {
  const code = exitCode === undefined ? "?" : String(exitCode);
  return {
    ...state,
    status: "exited",
    errorBanner: `child ${reason} (code=${code}) — press q to exit`,
  };
}
```

- [ ] **Step 4: Run tests to confirm they pass**

Run: `cd packages/blinkyterm && bun test test/smoke/bobbihack.state.test.ts`
Expected: PASS — 11 tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/blinkyterm/examples/bobbihack/state.ts packages/blinkyterm/test/smoke/bobbihack.state.test.ts
git commit -m "feat(bobbihack): ViewState + pure reducers"
```

---

## Task 4: render.ts

**Files:**
- Create: `packages/blinkyterm/examples/bobbihack/render.ts`
- Test: `packages/blinkyterm/test/smoke/bobbihack.render.test.ts`

This task TDDs the *structure* of the rendered output, not pixel-perfect
ANSI. We assert that the right cursor-position sequences appear in the
right order, that the box-drawing characters are present, and that the
NetHack screen text and live-area text get into the output. We do
**not** snapshot-test the entire byte string — that would lock the design.

- [ ] **Step 1: Write failing tests**

Write `packages/blinkyterm/test/smoke/bobbihack.render.test.ts`:

```ts
import { expect, test } from "bun:test";
import { render } from "../../examples/bobbihack/render";
import { initialState, onAgentEvent, onChildFrame, onTurnEnd, onTurnStart } from "../../examples/bobbihack/state";
import type { Frame } from "../../src/types";

const fakeSnapshot = (text: string) => ({
  text,
  title: "",
  cursor: { x: 0, y: 0, visible: true },
  bellsSinceLast: 0,
  titleChangesSinceLast: [],
  toAnsi: () => text,
  toHtml: () => `<pre>${text}</pre>`,
  toVt: () => text,
  cellAt: () => null,
});

const frame = (text: string): Frame => ({
  reason: "cellChange",
  snapshot: fakeSnapshot(text) as Frame["snapshot"],
});

const initSide = () => initialState({ hostCols: 200, hostRows: 60, agentLabel: "mock", pid: 999 });
const initStacked = () => initialState({ hostCols: 100, hostRows: 40, agentLabel: "mock", pid: 999 });
const initTooSmall = () => initialState({ hostCols: 30, hostRows: 10, agentLabel: "mock", pid: 999 });

test("render emits alt-screen-safe SGR resets and hides cursor", () => {
  const out = render(initSide());
  expect(out).toContain("\x1b[?25l");      // hide cursor
  expect(out).toContain("\x1b[0m");        // SGR reset
});

test("render side-by-side layout includes both pane title bars", () => {
  const out = render(initSide());
  expect(out).toContain("NetHack");        // NetHack pane title
  expect(out).toContain("Agent (mock)");   // Agent pane title
});

test("render places NetHack content row by row at the right offsets", () => {
  let s = initSide();
  s = onChildFrame(s, frame("ABCDEFG\nHIJKLMN"));
  const out = render(s);
  expect(out).toContain("ABCDEFG");
  expect(out).toContain("HIJKLMN");
  // Cursor positioning to (row=2, col=2) — first content row, inside left border
  expect(out).toContain("\x1b[2;2H");
});

test("render shows current turn streaming text in live area", () => {
  let s = initSide();
  s = onTurnStart(s, { turn: 7, frameReason: "cellChange" });
  s = onAgentEvent(s, { kind: "thinking", delta: "looking around" });
  const out = render(s);
  expect(out).toContain("turn 7");
  expect(out).toContain("looking around");
});

test("render shows history entries newest-first with decision and summary", () => {
  let s = initSide();
  s = onTurnStart(s, { turn: 1, frameReason: "cellChange" });
  s = onAgentEvent(s, { kind: "thinking", delta: "going east now" });
  s = onAgentEvent(s, { kind: "action", move: "east" });
  s = onTurnEnd(s);
  s = onTurnStart(s, { turn: 2, frameReason: "bell" });
  s = onAgentEvent(s, { kind: "action", move: "north" });
  s = onTurnEnd(s);
  const out = render(s);
  // newest first
  const idxTurn2 = out.indexOf("#2");
  const idxTurn1 = out.indexOf("#1");
  expect(idxTurn2).toBeGreaterThan(-1);
  expect(idxTurn1).toBeGreaterThan(-1);
  expect(idxTurn2).toBeLessThan(idxTurn1);
  expect(out).toContain("→ north");
  expect(out).toContain("→ east");
});

test("render stacked layout still emits both pane titles", () => {
  const out = render(initStacked());
  expect(out).toContain("NetHack");
  expect(out).toContain("Agent (mock)");
});

test("render tooSmall shows a single resize message and no boxes", () => {
  const out = render(initTooSmall());
  expect(out).toContain("Resize");
  expect(out).toContain("124");  // side-by-side minimum
  expect(out).toContain("82");   // stacked minimum cols
});
```

- [ ] **Step 2: Run tests to confirm they fail**

Run: `cd packages/blinkyterm && bun test test/smoke/bobbihack.render.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `render.ts`**

Write `packages/blinkyterm/examples/bobbihack/render.ts`:

```ts
import type { Box, Layout } from "./layout";
import type { TurnRecord, TurnState, ViewState } from "./state";

const ESC = "\x1b[";
const RESET = `${ESC}0m`;
const HIDE_CURSOR = `${ESC}?25l`;
const CLEAR_SCREEN = `${ESC}2J${ESC}H`;

const goto = (row: number, col: number) => `${ESC}${row};${col}H`;

const TL = "┌", TR = "┐", BL = "└", BR = "┘", H = "─", V = "│";

export function render(state: ViewState): string {
  if (state.layout.kind === "tooSmall") return renderTooSmall(state);

  const parts: string[] = [];
  parts.push(CLEAR_SCREEN);
  parts.push(RESET);

  // NetHack pane
  drawBox(parts, state.layout.nethack, ` NetHack — pid=${state.nethack.pid} `);
  drawNethackContent(parts, state.layout.nethack, state.nethack.screenAnsi);

  // Agent pane
  const agentTitle = currentTurnTitle(state);
  drawBox(parts, state.layout.thinking, agentTitle);
  drawAgentContent(parts, state.layout.thinking, state);

  // Error banner (if present) — appended below history, last-line in pane
  if (state.errorBanner !== null) {
    drawErrorBanner(parts, state.layout.thinking, state.errorBanner);
  }

  parts.push(HIDE_CURSOR);
  parts.push(goto(1, 1));
  return parts.join("");
}

function renderTooSmall(state: ViewState): string {
  if (state.layout.kind !== "tooSmall") return "";
  const { minSideCols, minSideRows, minStackedCols, minStackedRows } = state.layout;
  return [
    CLEAR_SCREEN,
    RESET,
    HIDE_CURSOR,
    goto(2, 2),
    `Resize terminal to at least ${minSideCols}×${minSideRows} (side-by-side) or ${minStackedCols}×${minStackedRows} (stacked).`,
    goto(3, 2),
    `Press q to quit.`,
  ].join("");
}

function drawBox(parts: string[], box: Box, title: string): void {
  // Top
  parts.push(goto(box.row, box.col));
  const topInner = H.repeat(Math.max(0, box.cols - 2));
  // overlay title at left, truncated to fit
  const t = ` ${title.trim()} `;
  const fitted = t.length <= topInner.length ? t : t.slice(0, topInner.length);
  const top = TL + fitted + topInner.slice(fitted.length) + TR;
  parts.push(top);

  // Sides
  for (let r = 1; r < box.rows - 1; r++) {
    parts.push(goto(box.row + r, box.col));
    parts.push(V);
    parts.push(goto(box.row + r, box.col + box.cols - 1));
    parts.push(V);
  }

  // Bottom
  parts.push(goto(box.row + box.rows - 1, box.col));
  parts.push(BL + H.repeat(Math.max(0, box.cols - 2)) + BR);
}

function drawNethackContent(parts: string[], box: Box, screenAnsi: string): void {
  const lines = screenAnsi.split("\n");
  const innerCols = box.cols - 2;
  const innerRows = box.rows - 2;
  for (let i = 0; i < innerRows; i++) {
    const line = lines[i] ?? "";
    parts.push(goto(box.row + 1 + i, box.col + 1));
    parts.push(line);
    parts.push(RESET);
    // pad with spaces if line was shorter than innerCols (visually clear stale chars)
    const visible = stripAnsi(line).length;
    if (visible < innerCols) parts.push(" ".repeat(innerCols - visible));
  }
}

function currentTurnTitle(state: ViewState): string {
  const t = state.currentTurn;
  if (t === null) return ` Agent (${state.agentLabel}) `;
  return ` Agent (${state.agentLabel}) — turn ${t.number}, frame: ${t.frameReason} `;
}

function drawAgentContent(parts: string[], box: Box, state: ViewState): void {
  const innerCols = box.cols - 2;
  const innerRows = box.rows - 2;
  const liveRows = Math.max(1, Math.min(8, Math.floor(innerRows / 3)));
  const dividerRow = box.row + 1 + liveRows;
  const historyStartRow = dividerRow + 1;
  const historyRows = Math.max(0, innerRows - liveRows - 1);

  // Live area
  const liveLines = wrapText(state.currentTurn?.streamingText ?? "", innerCols - 2);
  for (let i = 0; i < liveRows; i++) {
    parts.push(goto(box.row + 1 + i, box.col + 1));
    const prefix = i === 0 ? "▶ " : "  ";
    const text = liveLines[i] ?? "";
    parts.push(prefix + text);
    parts.push(RESET);
    const used = prefix.length + text.length;
    if (used < innerCols) parts.push(" ".repeat(innerCols - used));
  }

  // Divider
  parts.push(goto(dividerRow, box.col + 1));
  parts.push(H.repeat(innerCols));

  // History
  for (let i = 0; i < historyRows; i++) {
    const rec = state.history[i];
    parts.push(goto(historyStartRow + i, box.col + 1));
    if (!rec) {
      parts.push(" ".repeat(innerCols));
      continue;
    }
    const line = formatHistoryLine(rec, innerCols);
    parts.push(line);
    if (line.length < innerCols) parts.push(" ".repeat(innerCols - line.length));
  }
}

function drawErrorBanner(parts: string[], box: Box, banner: string): void {
  const innerCols = box.cols - 2;
  const lastRow = box.row + box.rows - 2;
  parts.push(goto(lastRow, box.col + 1));
  const trimmed = banner.length > innerCols ? banner.slice(0, innerCols) : banner;
  parts.push(`${ESC}33m${trimmed}${RESET}`);  // yellow
  if (trimmed.length < innerCols) parts.push(" ".repeat(innerCols - trimmed.length));
}

function formatHistoryLine(rec: TurnRecord, innerCols: number): string {
  const head = `#${rec.number} ${rec.frameReason} → ${rec.decision}`;
  const summary = rec.summary ? `  "${rec.summary}"` : "";
  const full = head + summary;
  return full.length > innerCols ? full.slice(0, innerCols) : full;
}

function wrapText(text: string, width: number): string[] {
  if (width <= 0 || text === "") return [];
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let current = "";
  for (const w of words) {
    if (w.length === 0) continue;
    if (current === "") {
      current = w;
    } else if (current.length + 1 + w.length <= width) {
      current += " " + w;
    } else {
      lines.push(current);
      current = w.length > width ? w.slice(0, width) : w;
    }
  }
  if (current !== "") lines.push(current);
  return lines;
}

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
}
```

- [ ] **Step 4: Run tests to confirm they pass**

Run: `cd packages/blinkyterm && bun test test/smoke/bobbihack.render.test.ts`
Expected: PASS — 7 tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/blinkyterm/examples/bobbihack/render.ts packages/blinkyterm/test/smoke/bobbihack.render.test.ts
git commit -m "feat(bobbihack): pure render(state) → ANSI"
```

---

## Task 5: events.ts (key parser + raw stdin)

**Files:**
- Create: `packages/blinkyterm/examples/bobbihack/events.ts`
- Test: `packages/blinkyterm/test/smoke/bobbihack.events.test.ts`

The pure parser is fully TDD'd. The raw-mode stdin reader is a thin
adapter and gets a single integration smoke test (spawn a Bun child that
imports `keys()` and pipe a byte to it).

- [ ] **Step 1: Write failing tests**

Write `packages/blinkyterm/test/smoke/bobbihack.events.test.ts`:

```ts
import { expect, test } from "bun:test";
import { parseStdinByte } from "../../examples/bobbihack/events";

test("q (lowercase) maps to quit", () => {
  expect(parseStdinByte("q".charCodeAt(0))).toBe("quit");
});

test("Q (uppercase) maps to quit", () => {
  expect(parseStdinByte("Q".charCodeAt(0))).toBe("quit");
});

test("Ctrl-C (0x03) maps to quit", () => {
  expect(parseStdinByte(0x03)).toBe("quit");
});

test("Ctrl-D (0x04) maps to quit", () => {
  expect(parseStdinByte(0x04)).toBe("quit");
});

test("other bytes are ignored (return null)", () => {
  expect(parseStdinByte("a".charCodeAt(0))).toBeNull();
  expect(parseStdinByte(0x1b)).toBeNull();      // ESC
  expect(parseStdinByte(0x20)).toBeNull();      // space
});
```

- [ ] **Step 2: Run tests to confirm they fail**

Run: `cd packages/blinkyterm && bun test test/smoke/bobbihack.events.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `events.ts`**

Write `packages/blinkyterm/examples/bobbihack/events.ts`:

```ts
export type UserKey = "quit";

/** Pure: maps a single stdin byte to a high-level user key, or null. */
export function parseStdinByte(byte: number): UserKey | null {
  // q, Q, Ctrl-C (0x03), Ctrl-D (0x04)
  if (byte === 0x71 || byte === 0x51) return "quit";
  if (byte === 0x03 || byte === 0x04) return "quit";
  return null;
}

export interface KeyStream {
  keys(): AsyncIterable<UserKey>;
  close(): void;
}

/**
 * Open stdin in raw mode and emit user keys until close() is called.
 * Restores the original mode on close.
 */
export function openKeyStream(): KeyStream {
  const stdin = process.stdin;
  const wasRaw = stdin.isRaw === true;
  stdin.setRawMode?.(true);
  stdin.resume();

  let closed = false;
  const queue: UserKey[] = [];
  const waiters: Array<(value: IteratorResult<UserKey>) => void> = [];

  const onData = (chunk: Buffer) => {
    for (const byte of chunk) {
      const key = parseStdinByte(byte);
      if (key === null) continue;
      const waiter = waiters.shift();
      if (waiter) waiter({ value: key, done: false });
      else queue.push(key);
    }
  };

  stdin.on("data", onData);

  const close = (): void => {
    if (closed) return;
    closed = true;
    stdin.off("data", onData);
    stdin.setRawMode?.(wasRaw);
    stdin.pause();
    while (waiters.length > 0) {
      waiters.shift()!({ value: undefined as never, done: true });
    }
  };

  const keys = (): AsyncIterable<UserKey> => ({
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<UserKey>> {
          if (queue.length > 0) {
            return Promise.resolve({ value: queue.shift()!, done: false });
          }
          if (closed) return Promise.resolve({ value: undefined as never, done: true });
          return new Promise((resolve) => waiters.push(resolve));
        },
        return(): Promise<IteratorResult<UserKey>> {
          close();
          return Promise.resolve({ value: undefined as never, done: true });
        },
      };
    },
  });

  return { keys, close };
}
```

- [ ] **Step 4: Run tests to confirm they pass**

Run: `cd packages/blinkyterm && bun test test/smoke/bobbihack.events.test.ts`
Expected: PASS — 5 tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/blinkyterm/examples/bobbihack/events.ts packages/blinkyterm/test/smoke/bobbihack.events.test.ts
git commit -m "feat(bobbihack): stdin raw-mode key stream + pure byte parser"
```

---

## Task 6: agents/mock.ts

**Files:**
- Create: `packages/blinkyterm/examples/bobbihack/agents/mock.ts`
- Test: `packages/blinkyterm/test/smoke/bobbihack.mock.test.ts`

- [ ] **Step 1: Write failing tests**

Write `packages/blinkyterm/test/smoke/bobbihack.mock.test.ts`:

```ts
import { expect, test } from "bun:test";
import { MockAgent } from "../../examples/bobbihack/agents/mock";
import type { AgentEvent } from "../../examples/bobbihack/agent";

const collect = async (agent: MockAgent, signal: AbortSignal): Promise<AgentEvent[]> => {
  const out: AgentEvent[] = [];
  for await (const ev of agent.decide(
    { turn: 1, frameReason: "cellChange", screenAnsi: "" },
    signal,
  )) {
    out.push(ev);
  }
  return out;
};

test("MockAgent emits one or more thinking deltas then exactly one action", async () => {
  const agent = new MockAgent({ seed: 42, gapMs: 0 });
  const events = await collect(agent, new AbortController().signal);
  const thinkingCount = events.filter((e) => e.kind === "thinking").length;
  const actionCount = events.filter((e) => e.kind === "action").length;
  expect(thinkingCount).toBeGreaterThanOrEqual(1);
  expect(actionCount).toBe(1);
  expect(events[events.length - 1]?.kind).toBe("action");
});

test("MockAgent is deterministic for the same seed", async () => {
  const a = new MockAgent({ seed: 42, gapMs: 0 });
  const b = new MockAgent({ seed: 42, gapMs: 0 });
  const ea = await collect(a, new AbortController().signal);
  const eb = await collect(b, new AbortController().signal);
  expect(ea).toEqual(eb);
});

test("MockAgent action move is one of the valid moves", async () => {
  const agent = new MockAgent({ seed: 1, gapMs: 0 });
  const events = await collect(agent, new AbortController().signal);
  const action = events.find((e) => e.kind === "action") as Extract<AgentEvent, { kind: "action" }>;
  expect(["north", "south", "east", "west", "search", "pickup", "quit"]).toContain(action.move);
});

test("MockAgent honors abort signal mid-stream", async () => {
  const agent = new MockAgent({ seed: 42, gapMs: 50 });
  const ac = new AbortController();
  const collected: AgentEvent[] = [];
  const iter = agent.decide(
    { turn: 1, frameReason: "cellChange", screenAnsi: "" },
    ac.signal,
  )[Symbol.asyncIterator]();
  // pull one event, then abort
  const first = await iter.next();
  expect(first.done).toBe(false);
  collected.push(first.value);
  ac.abort();
  const second = await iter.next();
  expect(second.done).toBe(true);
});
```

- [ ] **Step 2: Run tests to confirm they fail**

Run: `cd packages/blinkyterm && bun test test/smoke/bobbihack.mock.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `agents/mock.ts`**

Write `packages/blinkyterm/examples/bobbihack/agents/mock.ts`:

```ts
import { mulberry32 } from "../../shared/mulberry32";
import type { Agent, AgentDecision, AgentEvent, AgentInput } from "../agent";

const PHRASES = [
  "Looking at the corridor.",
  "There's a creature nearby.",
  "I should explore further.",
  "Picking a direction.",
  "Considering my options.",
  "The wall blocks the way.",
  "Stepping carefully.",
];

const MOVES: AgentDecision[] = ["north", "south", "east", "west", "search", "pickup"];

export interface MockAgentOptions {
  seed?: number;
  gapMs?: number;        // default 80
  minThoughts?: number;  // default 2
  maxThoughts?: number;  // default 4
}

export class MockAgent implements Agent {
  readonly name = "mock";
  readonly #rng: () => number;
  readonly #gapMs: number;
  readonly #minThoughts: number;
  readonly #maxThoughts: number;

  constructor(opts: MockAgentOptions = {}) {
    this.#rng = mulberry32(opts.seed ?? 42);
    this.#gapMs = opts.gapMs ?? 80;
    this.#minThoughts = opts.minThoughts ?? 2;
    this.#maxThoughts = opts.maxThoughts ?? 4;
  }

  async *decide(_input: AgentInput, signal: AbortSignal): AsyncIterable<AgentEvent> {
    const span = this.#maxThoughts - this.#minThoughts + 1;
    const n = this.#minThoughts + Math.floor(this.#rng() * span);
    for (let i = 0; i < n; i++) {
      if (signal.aborted) return;
      const phrase = PHRASES[Math.floor(this.#rng() * PHRASES.length)] ?? "Thinking.";
      yield { kind: "thinking", delta: phrase + " " };
      if (this.#gapMs > 0) await sleep(this.#gapMs, signal);
      if (signal.aborted) return;
    }
    if (signal.aborted) return;
    const move = MOVES[Math.floor(this.#rng() * MOVES.length)] ?? "search";
    yield { kind: "action", move };
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(t);
      resolve();
    }, { once: true });
  });
}
```

- [ ] **Step 4: Run tests to confirm they pass**

Run: `cd packages/blinkyterm && bun test test/smoke/bobbihack.mock.test.ts`
Expected: PASS — 4 tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/blinkyterm/examples/bobbihack/agents/mock.ts packages/blinkyterm/test/smoke/bobbihack.mock.test.ts
git commit -m "feat(bobbihack): MockAgent with seeded PRNG"
```

---

## Task 7: agents/anthropic.ts

**Files:**
- Create: `packages/blinkyterm/examples/bobbihack/agents/anthropic.ts`
- Test: `packages/blinkyterm/test/smoke/bobbihack.anthropic.test.ts`

The adapter has two layers:
- `streamToAgentEvents(rawStream)` — pure async-generator that translates
  Anthropic SDK stream events into `AgentEvent`s. Fully TDD'd with
  hand-rolled synthetic streams.
- `AnthropicAgent` — opens an SDK stream and pipes it through the
  translator. Lazy-imports `@anthropic-ai/sdk` so the agent module stays
  importable without the dep. No automated tests for the SDK call;
  acceptance is human-runnable.

- [ ] **Step 1: Write failing tests for the translator**

Write `packages/blinkyterm/test/smoke/bobbihack.anthropic.test.ts`:

```ts
import { expect, test } from "bun:test";
import { streamToAgentEvents, type RawStreamEvent } from "../../examples/bobbihack/agents/anthropic";
import type { AgentEvent } from "../../examples/bobbihack/agent";

const collect = async (raw: RawStreamEvent[]): Promise<AgentEvent[]> => {
  const out: AgentEvent[] = [];
  async function* source() {
    for (const e of raw) yield e;
  }
  for await (const ev of streamToAgentEvents(source())) out.push(ev);
  return out;
};

test("text deltas pass through as thinking events", async () => {
  const events = await collect([
    { type: "content_block_delta", delta: { type: "text_delta", text: "hello " } },
    { type: "content_block_delta", delta: { type: "text_delta", text: "world" } },
  ]);
  expect(events).toEqual([
    { kind: "thinking", delta: "hello " },
    { kind: "thinking", delta: "world" },
  ]);
});

test("tool_use input emits an action with the move", async () => {
  const events = await collect([
    { type: "content_block_delta", delta: { type: "text_delta", text: "I'll go east. " } },
    { type: "content_block_start", content_block: { type: "tool_use", name: "move", id: "abc" } },
    { type: "content_block_delta", delta: { type: "input_json_delta", partial_json: '{"move":"east"}' } },
    { type: "content_block_stop" },
  ]);
  expect(events).toEqual([
    { kind: "thinking", delta: "I'll go east. " },
    { kind: "action", move: "east" },
  ]);
});

test("invalid tool input emits an error event", async () => {
  const events = await collect([
    { type: "content_block_start", content_block: { type: "tool_use", name: "move", id: "abc" } },
    { type: "content_block_delta", delta: { type: "input_json_delta", partial_json: "{not-json" } },
    { type: "content_block_stop" },
  ]);
  expect(events.length).toBe(1);
  expect(events[0]?.kind).toBe("error");
});

test("unknown move value emits an error event", async () => {
  const events = await collect([
    { type: "content_block_start", content_block: { type: "tool_use", name: "move", id: "abc" } },
    { type: "content_block_delta", delta: { type: "input_json_delta", partial_json: '{"move":"dance"}' } },
    { type: "content_block_stop" },
  ]);
  expect(events[0]?.kind).toBe("error");
});

test("tool input split across multiple deltas reassembles correctly", async () => {
  const events = await collect([
    { type: "content_block_start", content_block: { type: "tool_use", name: "move", id: "abc" } },
    { type: "content_block_delta", delta: { type: "input_json_delta", partial_json: '{"mov' } },
    { type: "content_block_delta", delta: { type: "input_json_delta", partial_json: 'e":"north"}' } },
    { type: "content_block_stop" },
  ]);
  expect(events).toEqual([{ kind: "action", move: "north" }]);
});
```

- [ ] **Step 2: Run tests to confirm they fail**

Run: `cd packages/blinkyterm && bun test test/smoke/bobbihack.anthropic.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `agents/anthropic.ts`**

Write `packages/blinkyterm/examples/bobbihack/agents/anthropic.ts`:

```ts
import type { Agent, AgentDecision, AgentEvent, AgentInput } from "../agent";

const VALID_DECISIONS = new Set<AgentDecision>([
  "north", "south", "east", "west", "search", "pickup", "quit",
]);

// Trimmed shape of the @anthropic-ai/sdk stream events we care about.
// Defined locally so the test suite can construct synthetic streams
// without pulling the SDK as a dev dep.
export type RawStreamEvent =
  | { type: "content_block_start"; content_block: { type: "tool_use"; name: string; id: string } | { type: "text"; text?: string } }
  | { type: "content_block_delta"; delta: { type: "text_delta"; text: string } | { type: "input_json_delta"; partial_json: string } }
  | { type: "content_block_stop" }
  | { type: "message_start" | "message_delta" | "message_stop"; [k: string]: unknown };

interface ToolBuffer {
  name: string;
  jsonChunks: string[];
}

export async function* streamToAgentEvents(
  raw: AsyncIterable<RawStreamEvent>,
): AsyncIterable<AgentEvent> {
  let pendingTool: ToolBuffer | null = null;
  let actionEmitted = false;

  for await (const event of raw) {
    if (actionEmitted) continue;

    if (event.type === "content_block_start") {
      if (event.content_block.type === "tool_use") {
        pendingTool = { name: event.content_block.name, jsonChunks: [] };
      }
      continue;
    }

    if (event.type === "content_block_delta") {
      if (event.delta.type === "text_delta") {
        if (event.delta.text.length > 0) {
          yield { kind: "thinking", delta: event.delta.text };
        }
      } else if (event.delta.type === "input_json_delta" && pendingTool !== null) {
        pendingTool.jsonChunks.push(event.delta.partial_json);
      }
      continue;
    }

    if (event.type === "content_block_stop") {
      if (pendingTool !== null && pendingTool.name === "move") {
        const out = parseMoveTool(pendingTool.jsonChunks.join(""));
        yield out;
        actionEmitted = true;
        pendingTool = null;
      }
      continue;
    }
  }

  if (!actionEmitted) {
    yield { kind: "error", message: "stream ended without a move" };
  }
}

function parseMoveTool(json: string): AgentEvent {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (e) {
    return { kind: "error", message: `invalid tool input JSON: ${(e as Error).message}` };
  }
  if (typeof parsed !== "object" || parsed === null || !("move" in parsed)) {
    return { kind: "error", message: "tool input missing 'move' field" };
  }
  const move = (parsed as { move: unknown }).move;
  if (typeof move !== "string" || !VALID_DECISIONS.has(move as AgentDecision)) {
    return { kind: "error", message: `unknown move: ${String(move)}` };
  }
  return { kind: "action", move: move as AgentDecision };
}

export interface AnthropicAgentOptions {
  apiKey: string;
  model?: string;
  systemPrompt?: string;
}

const DEFAULT_MODEL = "claude-haiku-4-5";

const DEFAULT_SYSTEM = `You are an agent playing NetHack. Each turn you receive the current screen as ANSI text. Briefly explain what you observe and what you plan to do (1–3 short sentences), then call the \`move\` tool exactly once with one of: north, south, east, west, search, pickup, quit. Do not call the tool more than once per turn.`;

const MOVE_TOOL = {
  name: "move",
  description: "Commit one move for this turn.",
  input_schema: {
    type: "object" as const,
    properties: {
      move: {
        type: "string",
        enum: ["north", "south", "east", "west", "search", "pickup", "quit"],
      },
    },
    required: ["move"],
  },
};

export class AnthropicAgent implements Agent {
  readonly name: string;
  readonly #model: string;
  readonly #system: string;
  readonly #apiKey: string;
  // SDK client is created lazily in decide() so importing this module
  // doesn't require @anthropic-ai/sdk to be installed.
  #client: { messages: { stream: (req: unknown) => AsyncIterable<RawStreamEvent> } } | null = null;

  constructor(opts: AnthropicAgentOptions) {
    this.#apiKey = opts.apiKey;
    this.#model = opts.model ?? DEFAULT_MODEL;
    this.#system = opts.systemPrompt ?? DEFAULT_SYSTEM;
    this.name = `anthropic ${this.#model}`;
  }

  async *decide(input: AgentInput, signal: AbortSignal): AsyncIterable<AgentEvent> {
    if (this.#client === null) {
      const mod = await import("@anthropic-ai/sdk").catch(() => null);
      if (mod === null) {
        yield { kind: "error", message: "@anthropic-ai/sdk not installed" };
        return;
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const Anthropic = (mod as any).default ?? mod;
      this.#client = new Anthropic({ apiKey: this.#apiKey });
    }

    const userText = `Turn ${input.turn} (waking on: ${input.frameReason}). Current screen:\n\n${input.screenAnsi}`;
    const stream = this.#client!.messages.stream({
      model: this.#model,
      max_tokens: 1024,
      system: this.#system,
      tools: [MOVE_TOOL],
      messages: [{ role: "user", content: userText }],
    });

    const cancellableStream = abortableStream<RawStreamEvent>(stream, signal);
    yield* streamToAgentEvents(cancellableStream);
  }
}

async function* abortableStream<T>(
  source: AsyncIterable<T>,
  signal: AbortSignal,
): AsyncIterable<T> {
  for await (const item of source) {
    if (signal.aborted) return;
    yield item;
  }
}
```

- [ ] **Step 4: Run tests to confirm they pass**

Run: `cd packages/blinkyterm && bun test test/smoke/bobbihack.anthropic.test.ts`
Expected: PASS — 5 tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/blinkyterm/examples/bobbihack/agents/anthropic.ts packages/blinkyterm/test/smoke/bobbihack.anthropic.test.ts
git commit -m "feat(bobbihack): AnthropicAgent with TDD'd stream translator"
```

---

## Task 8: main.ts (composition)

**Files:**
- Create: `packages/blinkyterm/examples/bobbihack/main.ts`

This task wires everything together. It is integration-tested manually
in Task 10. No new automated test in Task 8.

- [ ] **Step 1: Implement `main.ts`**

Write `packages/blinkyterm/examples/bobbihack/main.ts`:

```ts
#!/usr/bin/env bun
import { Runner } from "../../src/index";
import { hasNethack, nethackEnv } from "../shared/nethack-setup";
import { detectPrompt } from "../shared/prompt-detect";
import { toKeystroke, type BotMove } from "../shared/keymap";
import type { Agent, AgentDecision } from "./agent";
import { MockAgent } from "./agents/mock";
import { AnthropicAgent } from "./agents/anthropic";
import {
  initialState,
  onAgentEvent,
  onChildExited,
  onChildFrame,
  onResize,
  onTurnEnd,
  onTurnStart,
  type ViewState,
} from "./state";
import { render } from "./render";
import { openKeyStream } from "./events";

const ENTER_ALT = "\x1b[?1049h";
const EXIT_ALT = "\x1b[?1049l";
const SHOW_CURSOR = "\x1b[?25h";

async function main(): Promise<void> {
  if (!hasNethack()) {
    console.log("[bobbihack] nethack not on PATH; skipping. Install with `brew install nethack`.");
    process.exit(0);
  }

  const agent = pickAgent();
  console.log(`[bobbihack] using agent: ${agent.name}`);

  const runner = await Runner.spawn(["nethack"], {
    env: nethackEnv(),
    frame: { minIntervalMs: 500, maxIntervalMs: 10_000, quiesceMs: 100 },
  });

  const hostCols = process.stdout.columns ?? 200;
  const hostRows = process.stdout.rows ?? 60;
  let state: ViewState = initialState({
    hostCols,
    hostRows,
    agentLabel: agent.name,
    pid: runner.pid,
  });

  const ac = new AbortController();
  const keyStream = openKeyStream();

  let writePending: NodeJS.Immediate | null = null;
  const requestPaint = (): void => {
    if (writePending !== null) return;
    writePending = setImmediate(() => {
      writePending = null;
      process.stdout.write(render(state));
    });
  };

  const onWinch = (): void => {
    state = onResize(state, process.stdout.columns ?? hostCols, process.stdout.rows ?? hostRows);
    requestPaint();
  };

  let restored = false;
  const restoreTerminal = (): void => {
    if (restored) return;
    restored = true;
    keyStream.close();
    process.removeListener("SIGWINCH", onWinch);
    process.stdout.write(SHOW_CURSOR + EXIT_ALT);
  };

  process.stdout.write(ENTER_ALT);
  process.on("SIGWINCH", onWinch);

  const userKeyTask = (async () => {
    for await (const key of keyStream.keys()) {
      if (key === "quit") { ac.abort(); return; }
    }
  })();

  let turnCounter = 0;
  let cleanQuitSent = false;

  try {
    requestPaint();
    for await (const frame of runner.frames()) {
      if (frame.reason === "exited" || frame.reason === "crashed") {
        state = onChildExited(state, frame.reason, frame.exitCode);
        requestPaint();
        break;
      }

      state = onChildFrame(state, frame);
      requestPaint();

      const prompt = detectPrompt(frame.snapshot);
      if (prompt === "more") { await runner.sendKey("Space"); continue; }
      if (prompt === "yn") { await runner.sendText("n"); continue; }
      if (prompt === "death") { break; }

      if (ac.signal.aborted) {
        if (!cleanQuitSent) {
          cleanQuitSent = true;
          await runner.sendText("#quit\r y\r y\r");
        }
        continue;
      }

      const turn = ++turnCounter;
      state = onTurnStart(state, { turn, frameReason: frame.reason });
      requestPaint();

      let decision: AgentDecision = "search";
      try {
        for await (const event of agent.decide(
          { turn, frameReason: frame.reason, screenAnsi: frame.snapshot.toAnsi() },
          ac.signal,
        )) {
          state = onAgentEvent(state, event);
          requestPaint();
          if (event.kind === "action") decision = event.move;
          if (event.kind === "error") { decision = "search"; break; }
        }
      } catch (err) {
        if (!ac.signal.aborted) throw err;
      }

      state = onTurnEnd(state);
      requestPaint();

      if (ac.signal.aborted) continue;

      if (decision === "quit") {
        cleanQuitSent = true;
        await runner.sendText("#quit\r y\r y\r");
        const r = await runner.waitExit({ timeoutMs: 3000 });
        if (!r.exited) await runner.terminate({ thenAfterMs: 1000 });
        continue;
      }

      await runner.sendText(toKeystroke(decision as BotMove));
    }
  } finally {
    restoreTerminal();
    await runner[Symbol.asyncDispose]();
    await userKeyTask.catch(() => {});
  }

  console.log(`[bobbihack] done; turns=${turnCounter}`);
}

function pickAgent(): Agent {
  const choice = process.env.BOBBIHACK_AGENT;
  const model = process.env.BOBBIHACK_MODEL;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (choice === "mock") return new MockAgent();
  if (choice === "anthropic") {
    if (apiKey === undefined || apiKey === "") {
      console.error("[bobbihack] BOBBIHACK_AGENT=anthropic requires ANTHROPIC_API_KEY");
      process.exit(1);
    }
    return new AnthropicAgent({ apiKey, model });
  }
  if (apiKey !== undefined && apiKey !== "") {
    return new AnthropicAgent({ apiKey, model });
  }
  return new MockAgent();
}

const restoreOnUnhandled = (): void => {
  process.stdout.write("\x1b[?25h\x1b[?1049l");
};
process.on("uncaughtException", (err) => {
  restoreOnUnhandled();
  console.error(err);
  process.exit(1);
});
process.on("unhandledRejection", (err) => {
  restoreOnUnhandled();
  console.error(err);
  process.exit(1);
});

await main();
```

- [ ] **Step 2: Verify typecheck passes**

Run: `cd packages/blinkyterm && bun run typecheck`
Expected: PASS — no type errors anywhere in `examples/bobbihack/`.

- [ ] **Step 3: Verify all bobbihack unit tests still pass**

Run: `cd packages/blinkyterm && bun test test/smoke/bobbihack.*.test.ts`
Expected: all bobbihack tests pass.

- [ ] **Step 4: Commit**

```bash
git add packages/blinkyterm/examples/bobbihack/main.ts
git commit -m "feat(bobbihack): main loop composition + alt-screen lifecycle"
```

---

## Task 9: README + run script

**Files:**
- Create: `packages/blinkyterm/examples/bobbihack/README.md`
- Modify: `packages/blinkyterm/package.json`

- [ ] **Step 1: Add a `bobbihack` script to package.json**

Read `packages/blinkyterm/package.json` first. Add to `scripts`:

```json
    "bobbihack": "bun examples/bobbihack/main.ts"
```

- [ ] **Step 2: Write the README**

Write `packages/blinkyterm/examples/bobbihack/README.md`:

```markdown
# bobbihack

Full-screen TUI that watches an LLM agent play NetHack. NetHack runs in
an embedded 80×25 pane; a second pane streams the agent's reasoning live
and keeps a per-turn history.

## Install NetHack

```bash
brew install nethack
```

bobbihack exits cleanly with a message if NetHack isn't on PATH.

## Run

```bash
# With the built-in mock agent (no API key needed):
BOBBIHACK_AGENT=mock bun examples/bobbihack/main.ts

# With Anthropic (auto-selected when ANTHROPIC_API_KEY is set):
ANTHROPIC_API_KEY=sk-ant-... bun examples/bobbihack/main.ts

# Override the model:
ANTHROPIC_API_KEY=... BOBBIHACK_MODEL=claude-sonnet-4-6 bun examples/bobbihack/main.ts
```

Or via the script: `bun run bobbihack`.

## Controls

- `q` (or Ctrl-C / Ctrl-D) — quit. bobbihack sends NetHack the clean
  `#quit y y` dance, waits for it to exit, restores your terminal,
  exits 0.

## Layout

bobbihack picks one of three layouts based on host terminal size:

- **Side-by-side** when ≥ 124×27. NetHack pinned left at 82×27;
  agent pane fills the remaining width and full height.
- **Stacked** when ≥ 82×39 but not wide enough for side-by-side.
  NetHack pinned top; agent pane below.
- **Resize prompt** when neither fits.

The layout updates live on terminal resize (SIGWINCH).

## Agents

bobbihack ships two agent implementations behind one `Agent` interface:

- **`MockAgent`** — built-in, no dependencies. Seeded PRNG picks moves;
  emits canned thinking text. Useful for development, smoke tests, and
  running without an API key.
- **`AnthropicAgent`** — streaming Messages API + tool-use. Requires
  `ANTHROPIC_API_KEY`. The SDK is an `optionalDependency` and is
  lazy-imported, so omitting it doesn't break `MockAgent`.

Selection: `BOBBIHACK_AGENT=anthropic|mock` overrides; otherwise
auto-prefers `anthropic` if a key is present, falls back to `mock`.
```

- [ ] **Step 3: Smoke-run with the mock agent (manual)**

Run: `cd packages/blinkyterm && BOBBIHACK_AGENT=mock bun examples/bobbihack/main.ts`

Expected (manual visual confirmation):
- NetHack character creation prompt appears in the left pane.
- Mock agent thinking text streams in the right pane.
- Layout adapts when the terminal is resized.
- Pressing `q` cleanly quits NetHack and restores the terminal.

If NetHack character-creation hangs, the mock agent's random moves will
eventually pick something it accepts; let it run for ~30 seconds. If it
truly stalls, that's evidence of a real issue — investigate before
committing.

- [ ] **Step 4: Commit**

```bash
git add packages/blinkyterm/examples/bobbihack/README.md packages/blinkyterm/package.json
git commit -m "docs(bobbihack): README and bobbihack run script"
```

---

## Task 10: Final verification

- [ ] **Step 1: Full typecheck**

Run: `cd packages/blinkyterm && bun run typecheck`
Expected: PASS.

- [ ] **Step 2: Full smoke-test suite**

Run: `cd packages/blinkyterm && bun test test/smoke`
Expected: all tests pass — both the parallel `robohack.*.test.ts` files
(if present) and all new `bobbihack.*.test.ts` files.

- [ ] **Step 3: Verify the workspace `verify:generated` trip-wire**

Run: `cd packages/libghostty-vt && bun run verify:generated`
Expected: PASS — bobbihack should not have touched FFI bindings.

- [ ] **Step 4: Confirm no unintended modifications**

Run: `git status && git log --oneline -15`
Expected:
- `git status` shows a clean tree (or only the parallel
  `robohack` untracked files, which we never modified).
- `git log` shows the bobbihack tasks as separate commits in order.

- [ ] **Step 5: Manual smoke run with each agent (one-time)**

Run mock-mode: `BOBBIHACK_AGENT=mock bun examples/bobbihack/main.ts`
Run Anthropic mode (if key available):
`ANTHROPIC_API_KEY=... bun examples/bobbihack/main.ts`

Expected: both render correctly, both quit cleanly with `q`.
