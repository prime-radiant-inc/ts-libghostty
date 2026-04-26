# bobbihack render-rect Switchover Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Switch bobbihack's NetHack pane from `frame.snapshot.toAnsi()` (with defensive `\r`/CSI stripping) to `Terminal.renderToAnsiRect()`, eliminating ~80 lines of sanitization and making bobbihack work for any TUI program.

**Architecture:** `render(state, nethackContent)` accepts a pre-positioned ANSI string from main.ts; main.ts computes it on each paint via `runner.terminal.renderToAnsiRect({row, col, cols: 80, rows: 24})` with a defensive try/catch for teardown. `state.nethack.screenAnsi` is removed; `sanitizeForInline`/`stripAnsi` helpers are deleted. The agent's input (`AgentInput.screenAnsi` from `frame.snapshot.toAnsi()`) is unchanged — different field, different consumer.

**Tech Stack:** Bun, TypeScript, blinkyterm + libghostty-vt 0.5.0 (already shipped on this branch in Pass 5).

**Reference spec:** `docs/superpowers/specs/2026-04-25-bobbihack-render-rect-design.md`.

**Worktree:** All work on `worktree-bobbihack-impl`. Implementer Bobs MUST verify with `git branch --show-current` before any commit.

---

## File Map

**Modified:**

| Path | Changes | Task |
|---|---|---|
| `packages/blinkyterm/examples/bobbihack/render.ts` | Signature: `render(state, nethackContent)`. Replace `drawNethackContent` with `drawNethackPane` that splices content. Delete `sanitizeForInline` and `stripAnsi`. | 1 |
| `packages/blinkyterm/test/smoke/bobbihack.render.test.ts` | Add `""` to all `render(s)` calls; rewrite content-placement test; delete `\r` and CSI regression tests. | 1 |
| `packages/blinkyterm/examples/bobbihack/state.ts` | Drop `screenAnsi` from `NethackPane`; `onChildFrame` no longer writes it. | 2 |
| `packages/blinkyterm/test/smoke/bobbihack.state.test.ts` | Delete `onChildFrame updates the NetHack pane content` test. | 2 |
| `packages/blinkyterm/examples/bobbihack/main.ts` | Compute `nethackContent` via `runner.terminal.renderToAnsiRect` in `requestPaint`; pass to `render`. | 2 |

**Untouched:** `agent.ts`, `agents/mock.ts`, `agents/anthropic.ts`, `events.ts`, `layout.ts`, `bobbihack.layout.test.ts`, `bobbihack.mock.test.ts`, `bobbihack.events.test.ts`, `bobbihack.anthropic.test.ts`. The agent's input flow (`frame.snapshot.toAnsi()` → `AgentInput.screenAnsi`) is unchanged.

**⚠ NAMING-COLLISION WARNING:** Two fields are called `screenAnsi`. We delete `state.nethack.screenAnsi` (NethackPane). We KEEP `AgentInput.screenAnsi` (in `agent.ts`). Don't do a global rename.

---

## Task 1: Refactor render.ts + update render tests

This task changes `render`'s signature to take `nethackContent: string` as a second argument and rewrites the NetHack-pane drawing path. After this task, typecheck will FAIL on `main.ts` (which still calls `render(state)` with one arg). That's expected; Task 2 fixes it.

**Files:**
- Modify: `packages/blinkyterm/examples/bobbihack/render.ts`
- Modify: `packages/blinkyterm/test/smoke/bobbihack.render.test.ts`

- [ ] **Step 1: Read the current files**

Run:
```bash
cat packages/blinkyterm/examples/bobbihack/render.ts
cat packages/blinkyterm/test/smoke/bobbihack.render.test.ts
```

Confirm:
- `render.ts` has functions `render`, `drawBox`, `drawNethackContent`, `drawAgentContent`, `drawErrorBanner`, `wrapText`, `stripAnsi`, `sanitizeForInline` plus helpers.
- `bobbihack.render.test.ts` has 9 tests, including two near the bottom (`render strips CR…` and `render strips non-SGR CSI sequences…`).

- [ ] **Step 2: Update test expectations FIRST (TDD)**

Edit `packages/blinkyterm/test/smoke/bobbihack.render.test.ts`:

(a) **Update every `render(s)` and `render(initSide())` / `render(initStacked())` / `render(initTooSmall())` call** to pass an empty string as the second argument. Example transformations:

```ts
// before
const out = render(initSide());
// after
const out = render(initSide(), "");
```

```ts
// before
const out = render(s);
// after
const out = render(s, "");
```

There are 7 call sites that need this change (all except the content-placement test, which gets a different treatment in (b)).

(b) **Replace the "render places NetHack content row by row at the right offsets" test** with a test that asserts the function passes through whatever `nethackContent` it's given:

```ts
test("render splices nethackContent verbatim into the output", () => {
  const s = initSide();
  // Synthetic pre-positioned content — what runner.terminal.renderToAnsiRect()
  // would produce, with embedded gotos targeting the NetHack pane area.
  const synthetic = "\x1b[2;3HABCDEFG\x1b[3;3HHIJKLMN";
  const out = render(s, synthetic);
  expect(out).toContain("ABCDEFG");
  expect(out).toContain("HIJKLMN");
  // The synthetic positioning sequence appears verbatim in output.
  expect(out).toContain("\x1b[2;3H");
});
```

Remove the original `onChildFrame(s, frame(...))` setup from this test — it's no longer needed.

Also remove the now-unused imports if `onChildFrame` and `frame` aren't used elsewhere in this file. (Other tests use `onTurnStart` / `onAgentEvent` / `onTurnEnd`; check before deleting.) Likely keep `onAgentEvent`/`onTurnEnd`/`onTurnStart` and remove `onChildFrame` from the import list.

(c) **Delete two tests near the bottom of the file:**
- `test("render strips CR so trailing \\r in toAnsi() rows doesn't clobber the left border", () => { … })` (the test at lines ~49-60)
- `test("render strips non-SGR CSI sequences (e.g. cursor-positioning) but keeps SGR", () => { … })` (the test that follows it)

These guard `sanitizeForInline`, which is going away.

- [ ] **Step 3: Run tests to confirm they fail**

Run: `cd packages/blinkyterm && bun test test/smoke/bobbihack.render.test.ts`
Expected: FAIL — `render` takes 1 argument but is being called with 2 (or similar typecheck-style error). Some tests may pass if the type system isn't strict at runtime.

- [ ] **Step 4: Update `render.ts` — signature, drawNethackPane, deletions**

Replace the entire `render.ts` file content with:

```ts
import type { Box, Layout } from "./layout";
import type { TurnRecord, TurnState, ViewState } from "./state";

const ESC = "\x1b[";
const RESET = `${ESC}0m`;
const HIDE_CURSOR = `${ESC}?25l`;
const CLEAR_SCREEN = `${ESC}2J${ESC}H`;

const goto = (row: number, col: number) => `${ESC}${row};${col}H`;

const TL = "┌", TR = "┐", BL = "└", BR = "┘", H = "─", V = "│";

/**
 * Compose the bobbihack TUI as ANSI bytes.
 *
 * `nethackContent` is the pre-positioned ANSI rendering of NetHack's pane,
 * produced by `runner.terminal.renderToAnsiRect({...nethack-content-rect})`
 * in main.ts. Its embedded goto sequences place each row at the right
 * host coordinates already; render() just splices it in after drawing
 * the pane border and clearing the 1-cell horizontal padding columns.
 *
 * Pass an empty string when there's no Runner yet or during teardown.
 */
export function render(state: ViewState, nethackContent: string): string {
  if (state.layout.kind === "tooSmall") return renderTooSmall(state);

  const parts: string[] = [];
  parts.push(CLEAR_SCREEN);
  parts.push(RESET);

  // NetHack pane
  drawNethackPane(parts, state.layout.nethack, state.nethack.pid, nethackContent);

  // Agent pane
  const agentTitle = currentTurnTitle(state);
  drawBox(parts, state.layout.thinking, agentTitle);
  drawAgentContent(parts, state.layout.thinking, state);

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
  parts.push(goto(box.row, box.col));
  const topInner = H.repeat(Math.max(0, box.cols - 2));
  const t = ` ${title.trim()} `;
  const fitted = t.length <= topInner.length ? t : t.slice(0, topInner.length);
  const top = TL + fitted + topInner.slice(fitted.length) + TR;
  parts.push(top);

  for (let r = 1; r < box.rows - 1; r++) {
    parts.push(goto(box.row + r, box.col));
    parts.push(V);
    parts.push(goto(box.row + r, box.col + box.cols - 1));
    parts.push(V);
  }

  parts.push(goto(box.row + box.rows - 1, box.col));
  parts.push(BL + H.repeat(Math.max(0, box.cols - 2)) + BR);
}

/**
 * Draw the NetHack pane: border + title, blank the 1-cell horizontal padding
 * columns, then splice in the pre-positioned nethackContent.
 *
 * The padding-column blanks are defensive — `renderToAnsiRect` only writes
 * the 80×24 content area at the inner content cols, so if anything ever
 * wrote into the padding cells, the next paint would still leave them dirty.
 * A single space per row keeps them clean.
 */
function drawNethackPane(
  parts: string[],
  box: Box,
  pid: number,
  nethackContent: string,
): void {
  drawBox(parts, box, ` NetHack — pid=${pid} `);

  const innerRows = box.rows - 2;
  for (let i = 0; i < innerRows; i++) {
    parts.push(goto(box.row + 1 + i, box.col + 1));
    parts.push(" ");                                  // left padding cell
    parts.push(goto(box.row + 1 + i, box.col + box.cols - 2));
    parts.push(" ");                                  // right padding cell
  }

  parts.push(nethackContent);
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

  parts.push(goto(dividerRow, box.col + 1));
  parts.push(H.repeat(innerCols));

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
  parts.push(`${ESC}33m${trimmed}${RESET}`);
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
```

Note what's gone:
- `import type { TurnRecord, TurnState, ViewState }` — keep as-is, but note `ViewState.nethack.screenAnsi` is no longer read.
- `sanitizeForInline()` — deleted.
- `stripAnsi()` — deleted (was only used by the old `drawNethackContent`).
- `drawNethackContent()` — replaced by `drawNethackPane()`.

The `goto()` helper is unchanged.

- [ ] **Step 5: Run render tests to confirm they pass**

Run: `cd packages/blinkyterm && bun test test/smoke/bobbihack.render.test.ts`
Expected: PASS — all remaining tests pass. Count is 1 lower than before Pass 6 (deleted 2, added 1).

- [ ] **Step 6: Confirm typecheck fails on main.ts (as expected)**

Run: `cd packages/blinkyterm && bun run typecheck 2>&1 | head -20`
Expected: FAIL — error in `main.ts` like "Expected 2 arguments, but got 1" at the `render(state)` call site. This is intentional; Task 2 fixes it.

- [ ] **Step 7: Commit**

```bash
git add packages/blinkyterm/examples/bobbihack/render.ts packages/blinkyterm/test/smoke/bobbihack.render.test.ts
git commit -m "refactor(bobbihack): render takes nethackContent param; drop sanitization

Drops sanitizeForInline() and stripAnsi() — defensive code that
worked around frame.snapshot.toAnsi()'s embedded escape sequences.
Replaces drawNethackContent's line-by-line parsing with
drawNethackPane that splices a pre-positioned ANSI string from the
caller. Tests that asserted the strip behavior are deleted; the
content-placement test is rewritten to pass synthetic positioned
content directly.

main.ts will be updated in the next commit to compute and pass the
content via runner.terminal.renderToAnsiRect().

Co-Authored-By: <YourName> (Bob 811efc4e/<your-model>)"
```

---

## Task 2: Wire main.ts + drop state.screenAnsi

**Files:**
- Modify: `packages/blinkyterm/examples/bobbihack/state.ts`
- Modify: `packages/blinkyterm/test/smoke/bobbihack.state.test.ts`
- Modify: `packages/blinkyterm/examples/bobbihack/main.ts`

- [ ] **Step 1: Drop `screenAnsi` from `NethackPane` interface in `state.ts`**

Read `packages/blinkyterm/examples/bobbihack/state.ts` first.

Find the `NethackPane` interface and remove the `screenAnsi` field. Before:

```ts
export interface NethackPane {
  readonly screenAnsi: string;
  readonly pid: number;
  readonly bellsCumulative: number;
  readonly title: string;
}
```

After:

```ts
export interface NethackPane {
  readonly pid: number;
  readonly bellsCumulative: number;
  readonly title: string;
}
```

Find the `initialState` function. Remove the `screenAnsi: ""` line from the `nethack` initializer:

```ts
// before
nethack: {
  screenAnsi: "",
  pid: args.pid,
  bellsCumulative: 0,
  title: "",
},
// after
nethack: {
  pid: args.pid,
  bellsCumulative: 0,
  title: "",
},
```

Find the `onChildFrame` reducer. Remove the `screenAnsi` write:

```ts
// before
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
// after
export function onChildFrame(state: ViewState, frame: Frame): ViewState {
  return {
    ...state,
    nethack: {
      ...state.nethack,
      bellsCumulative: state.nethack.bellsCumulative + frame.snapshot.bellsSinceLast,
      title: frame.snapshot.title || state.nethack.title,
    },
  };
}
```

- [ ] **Step 2: Drop the `screenAnsi`-related test in `bobbihack.state.test.ts`**

Read `packages/blinkyterm/test/smoke/bobbihack.state.test.ts` first.

Find and **delete** this entire test:

```ts
test("onChildFrame updates the NetHack pane content", () => {
  const s0 = initialState({ hostCols: 200, hostRows: 60, agentLabel: "mock", pid: 1 });
  const s1 = onChildFrame(s0, fakeFrame("hello"));
  expect(s1.nethack.screenAnsi).toBe("hello");
});
```

If the file imports `onChildFrame` only for this test, leave the import — `onChildFrame` is still used by other tests OR might be needed by future ones; only remove imports if they become genuinely unused (typecheck will catch this).

- [ ] **Step 3: Run state tests to confirm they still pass (one fewer)**

Run: `cd packages/blinkyterm && bun test test/smoke/bobbihack.state.test.ts`
Expected: PASS — count is 1 lower than before (we deleted one test).

- [ ] **Step 4: Wire `runner.terminal.renderToAnsiRect` into `main.ts`**

Read `packages/blinkyterm/examples/bobbihack/main.ts` first to confirm the structure of `requestPaint`. The current `requestPaint`:

```ts
let writePending: NodeJS.Immediate | null = null;
const requestPaint = (): void => {
  if (writePending !== null) return;
  writePending = setImmediate(() => {
    writePending = null;
    process.stdout.write(render(state));
  });
};
```

Replace it with:

```ts
let writePending: NodeJS.Immediate | null = null;
const requestPaint = (): void => {
  if (writePending !== null) return;
  writePending = setImmediate(() => {
    writePending = null;
    let nethackContent = "";
    if (state.layout.kind !== "tooSmall") {
      const box = state.layout.nethack;
      try {
        nethackContent = runner.terminal.renderToAnsiRect({
          row: box.row + 1,
          col: box.col + 2,
          cols: 80,
          rows: 24,
        });
      } catch {
        // Runner disposed mid-paint, or strict size match failed.
        // Render with empty pane; next paint catches up.
      }
    }
    process.stdout.write(render(state, nethackContent));
  });
};
```

- [ ] **Step 5: Run typecheck**

Run: `cd packages/blinkyterm && bun run typecheck 2>&1 | tail -3`
Expected: PASS (no errors). The `render(state, nethackContent)` call now matches the new two-arg signature, and `runner.terminal.renderToAnsiRect` exists in libghostty-vt 0.5.0 (already shipped in this branch).

- [ ] **Step 6: Run all bobbihack tests**

Run: `cd packages/blinkyterm && bun test test/smoke/bobbihack 2>&1 | tail -5`
Expected: PASS — all bobbihack tests pass.

- [ ] **Step 7: Commit**

```bash
git add packages/blinkyterm/examples/bobbihack/state.ts \
        packages/blinkyterm/examples/bobbihack/main.ts \
        packages/blinkyterm/test/smoke/bobbihack.state.test.ts
git commit -m "feat(bobbihack): switch NetHack pane to Terminal.renderToAnsiRect

Pass 6 / consumer-side completion. main.ts computes nethackContent
on each paint via runner.terminal.renderToAnsiRect with a defensive
try/catch for teardown races (renderToAnsiRect throws
UseAfterCloseError if the Terminal is disposed). state.nethack
drops the screenAnsi field — no longer needed; the agent's
AgentInput.screenAnsi is unaffected.

Co-Authored-By: <YourName> (Bob 811efc4e/<your-model>)"
```

---

## Task 3: Final verification + manual smoke

- [ ] **Step 1: Full typecheck**

Run: `cd packages/blinkyterm && bun run typecheck 2>&1 | tail -3`
Expected: PASS.

- [ ] **Step 2: Full bobbihack test suite**

Run: `cd packages/blinkyterm && bun test test/smoke/bobbihack 2>&1 | tail -5`
Expected: PASS — total is 3 lower than before Pass 6 (2 deleted in render, 1 deleted in state).

- [ ] **Step 3: Full smoke suite (no regressions in libghostty-vt or rest of blinkyterm)**

Run: `cd packages/blinkyterm && bun test test/smoke 2>&1 | tail -5`
Expected: PASS — total down by 3 from pre-Pass-6 count (the same 3 deletions; rest unchanged).

Run: `cd packages/libghostty-vt && bun test test/smoke 2>&1 | tail -5`
Expected: PASS — 302/302 unchanged (Pass 6 doesn't touch libghostty-vt).

- [ ] **Step 4: Clean up locks before manual smoke**

NetHack accumulates lock files in `/opt/homebrew/share/nethack/` from prior crashes. Clear them before testing:

```bash
rm -f /opt/homebrew/share/nethack/[a-z]lock.[0-9] 2>/dev/null
```

- [ ] **Step 5: Manual smoke run with mock agent**

Run: `cd packages/blinkyterm && BOBBIHACK_AGENT=mock bun examples/bobbihack/main.ts`

Visual checks (compare to user's earlier screenshot showing the bug):
- All four pane borders intact (top, bottom, left, right) on every row.
- No phantom blank row inside the NetHack pane (Pass 4 fix already addressed; render-rect should preserve it).
- No missing right-border cells when NetHack writes a status line.
- `Agent the Stripling` (or similar) renders fully — no first-character-eaten artifact.
- Mock agent thoughts stream into the right pane.
- `q` quits cleanly; alt-screen restored; no terminal corruption.

If any visual issue appears, capture the output: `BOBBIHACK_AGENT=mock bun examples/bobbihack/main.ts > /tmp/nethack.debug.6 2>&1` (run for ~5s, then Ctrl-C in another shell to terminate via process kill if `q` fails for any reason).

- [ ] **Step 6: Confirm clean state**

Run: `cd /Users/mw/Code/prime/ts-libghostty-vt/.claude/worktrees/bobbihack-impl && git status --short && git log --oneline -5`

Expected:
- `git status` shows clean tree (or only the pre-existing `.tmp/` artifact).
- `git log` shows the two new commits at the top:
  ```
  feat(bobbihack): switch NetHack pane to Terminal.renderToAnsiRect
  refactor(bobbihack): render takes nethackContent param; drop sanitization
  ```

- [ ] **Step 7: Report**

Report: status, total LOC delta (use `git diff --stat 5c84319..HEAD` against the pre-Pass-6 spec commit), test count delta, manual smoke outcome.
