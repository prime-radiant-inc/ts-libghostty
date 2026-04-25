# Pass 5 - blinkyterm Runner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `packages/blinkyterm`, a pure-TypeScript Runner package that spawns a real TUI in a `Bun.Terminal`, observes it through `libghostty-vt`, sends text/keys/bytes, yields frozen screen frames, and shuts down cleanly.

**Architecture:** `Runner` composes four owned resources: a `Bun.Terminal` pty, a child `Subprocess`, a `libghostty-vt` `Terminal`/`RenderState`, and a Pass 4 `KeyEncoder`. Pty output flows into `Terminal.vtWrite`; libghostty pty replies flow back through a serialized write queue; scheduler state decides when the single frame iterator wakes; frame materialization happens only when the consumer calls `next()`.

**Tech Stack:** TypeScript, Bun workspaces, Bun 1.3.13+, `Bun.Terminal`, `Bun.spawn`, `libghostty-vt@0.4.0` (`Terminal`, `RenderState`, `Formatter`, `KeyEncoder`).

---

## Pre-execution context

**Where the work happens:** Run this plan after Pass 4 has landed on `main`. Pass 4 must publish the `KeyEncoder` surface from `packages/libghostty-vt`; this plan does not add or repair key encoding.

**Spec reference:** `docs/superpowers/specs/2026-04-24-agent-tui-runner-design.md` sections 3-9. Pass 5 is the second concrete deliverable: a new `packages/blinkyterm` package with `Runner`, frame scheduling, send APIs, lifecycle management, deterministic tests, and NetHack examples.

**Starting state assumptions:**
- `packages/libghostty-vt/package.json` is version `0.4.0`.
- `libghostty-vt` exports `Terminal`, `RenderState`, `Formatter`, `KeyEncoder`, `Key`, `KeyEvent`, `Mods`, `EncodeError`, and the public cell types.
- Baseline `packages/libghostty-vt` tests pass before touching `blinkyterm`.
- `vendor/` and `prebuilds/` remain gitignored artifacts inside `packages/libghostty-vt`; worktree bootstrap must copy them from the main checkout when needed.

**Important design choice:** `FrameSnapshot` is a frozen capture. Because `libghostty-vt` does not expose a native terminal clone, `blinkyterm` must copy the data it needs at frame-finalize time. Capture formatted strings and cell data eagerly enough that later terminal mutations cannot change old frames. Lazy `toAnsi()` / `toHtml()` / `toVt()` methods may memoize, but they must read only captured data.

---

## File structure

New package:

```text
packages/blinkyterm/
  package.json
  tsconfig.json
  tsconfig.check.json
  CHANGELOG.md
  README.md
  src/
    index.ts
    runner.ts
    types.ts
    errors.ts
    scheduler.ts
    snapshot.ts
    clock.ts
    deferred.ts
    write-queue.ts
    us-layout.ts
  scripts/
    probe-bun-terminal.ts
  test/
    smoke/
      exports.test.ts
      scheduler.test.ts
      snapshot.test.ts
      runner.lifecycle.test.ts
      runner.frames.test.ts
      runner.send.test.ts
    integration/
      fixtures.test.ts
    fixtures/
      children/
        echo-and-exit.sh
        wait-for-input.sh
        infinite-loop.sh
        signal-ignorant.sh
        bell-and-title.sh
        slow-painter.sh
        mini-tui.sh
    helpers/
      fake-clock.ts
      fixture-path.ts
      runner-test.ts
  examples/
    README.md
    random-bot.ts
    llm-bot.ts
    shared/
      keymap.ts
      nethack-setup.ts
      prompt-detect.ts
```

Existing files modified:

```text
package.json                       # workspace already includes packages/*; only root scripts if needed
bun.lock                           # workspace lock after adding blinkyterm package
.github/workflows/ci.yml           # add blinkyterm typecheck/build/test steps
README.md                          # blinkyterm is no longer future-only
docs/superpowers/specs/2026-04-24-agent-tui-runner-design.md
                                    # only if implementation discovers a small spec correction
```

---

### Task 1: Preflight - branch, bootstrap, and prove Pass 4 baseline

**Files:**
- Write: `.worktrees/pass-5-blinkyterm-runner/` (new git worktree)
- Write: `.tmp/preflight-pass5.txt` (gitignored)

- [ ] **Step 1: Confirm `main` is the post-Pass-4 baseline**

```bash
git status --short
git rev-parse --abbrev-ref HEAD
git log --oneline -5
grep '"version"' packages/libghostty-vt/package.json
grep -n "KeyEncoder" packages/libghostty-vt/src/index.ts
```

Expected:
- Branch is `main`.
- Tree has no tracked modifications.
- `packages/libghostty-vt/package.json` shows `"version": "0.4.0"`.
- `packages/libghostty-vt/src/index.ts` exports `KeyEncoder`.

If any Pass 4 check fails, stop. Plan C must branch after Pass 4, not from the Plan B document commit.

- [ ] **Step 2: Create an isolated worktree**

```bash
git worktree add .worktrees/pass-5-blinkyterm-runner -b codex/pass-5-blinkyterm-runner
cd .worktrees/pass-5-blinkyterm-runner
```

- [ ] **Step 3: Copy ignored native artifacts into the worktree**

```bash
cp -R /Users/mw/Code/prime/ts-libghostty-vt/packages/libghostty-vt/vendor packages/libghostty-vt/vendor
cp -R /Users/mw/Code/prime/ts-libghostty-vt/packages/libghostty-vt/prebuilds packages/libghostty-vt/prebuilds
ls packages/libghostty-vt/prebuilds/darwin-arm64/libghostty-vt.dylib
```

Expected: the dylib path prints.

- [ ] **Step 4: Install and capture baseline tests**

```bash
bun install
mkdir -p .tmp
cd packages/libghostty-vt
bun run typecheck
bun run test 2>&1 | tee ../../.tmp/preflight-pass5.txt
cd ../..
```

Expected: `typecheck` and all libghostty-vt tests pass.

- [ ] **Step 5: No commit**

```bash
git status --short
```

Expected: empty or only ignored `.tmp/` output.

---

### Task 2: Scaffold the blinkyterm package

**Files:**
- Create: `packages/blinkyterm/package.json`
- Create: `packages/blinkyterm/tsconfig.json`
- Create: `packages/blinkyterm/tsconfig.check.json`
- Create: `packages/blinkyterm/src/index.ts`
- Create: `packages/blinkyterm/CHANGELOG.md`
- Create: `packages/blinkyterm/README.md`
- Modify: `bun.lock`

- [ ] **Step 1: Create `packages/blinkyterm/package.json`**

```json
{
  "name": "blinkyterm",
  "version": "0.1.0",
  "description": "Agent-facing TUI runner built on Bun.Terminal and libghostty-vt.",
  "license": "Apache-2.0",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  },
  "files": [
    "src/",
    "dist/",
    "examples/",
    "README.md",
    "CHANGELOG.md"
  ],
  "engines": {
    "bun": ">=1.3.13"
  },
  "scripts": {
    "build:js": "bun build ./src/index.ts --outdir dist --target bun --format esm",
    "build:types": "tsc -p tsconfig.json",
    "build": "bun run build:js && bun run build:types",
    "typecheck": "tsc -p tsconfig.check.json",
    "test": "bun test test/smoke test/integration",
    "test:smoke": "bun test test/smoke",
    "test:integration": "bun test test/integration",
    "probe:bun-terminal": "bun scripts/probe-bun-terminal.ts"
  },
  "dependencies": {
    "libghostty-vt": "workspace:*"
  },
  "devDependencies": {
    "@types/bun": "latest",
    "typescript": "^5.4.0"
  }
}
```

- [ ] **Step 2: Create `packages/blinkyterm/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "./src",
    "outDir": "dist",
    "declaration": true,
    "declarationMap": true,
    "emitDeclarationOnly": true
  },
  "include": ["src/**/*.ts"],
  "exclude": ["node_modules", "dist", "test", "examples", "scripts"]
}
```

`packages/blinkyterm/tsconfig.check.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "noEmit": true
  },
  "include": ["src/**/*.ts", "test/**/*.ts", "examples/**/*.ts", "scripts/**/*.ts"],
  "exclude": ["node_modules", "dist"]
}
```

- [ ] **Step 3: Create stub exports**

`packages/blinkyterm/src/index.ts`:

```ts
export { Runner } from "./runner";
export {
  BlinkyTermError,
  SpawnError,
  FirstFrameTimeoutError,
  ExitedError,
  DisposedError,
  IteratorInUseError,
} from "./errors";
export type {
  SpawnOptions,
  FrameOptions,
  FrameReason,
  Frame,
  FrameSnapshot,
  WaitExitResult,
  TerminateOptions,
  Clock,
} from "./types";
export { EncodeError } from "libghostty-vt";
export type { Key, KeyEvent, Mods } from "libghostty-vt";
```

Create temporary `packages/blinkyterm/src/runner.ts` so exports typecheck before the real task:

```ts
export class Runner {
  private constructor() {}
}
```

- [ ] **Step 4: Create package docs shell**

`packages/blinkyterm/CHANGELOG.md`:

```markdown
# Changelog

## [0.1.0] - 2026-04-25

### Added

- Initial `Runner` package for spawning TUI children through `Bun.Terminal`,
  observing frames with `libghostty-vt`, sending text/keys/bytes, and shutting
  down cleanly.
```

`packages/blinkyterm/README.md`:

````markdown
# blinkyterm

Agent-facing TUI runner built on `Bun.Terminal` and `libghostty-vt`.

```ts
import { Runner } from "blinkyterm";

await using runner = await Runner.spawn(["bash", "-lc", "printf 'hello\\n'; sleep 0.2"]);
for await (const frame of runner.frames()) {
  console.log(frame.snapshot.text);
  if (frame.reason === "exited" || frame.reason === "crashed") break;
}
```
````

- [ ] **Step 5: Install and run the package-level smoke**

```bash
bun install
cd packages/blinkyterm
bun run typecheck
bun run build
cd ../..
```

Expected: typecheck/build succeed with stub implementation.

- [ ] **Step 6: Commit**

```bash
git add package.json bun.lock packages/blinkyterm
git commit -m "chore(blinkyterm): scaffold package"
```

---

### Task 3: Probe Bun.Terminal behavior before production code

**Files:**
- Create: `packages/blinkyterm/scripts/probe-bun-terminal.ts`

Bun's pty API is young enough that the implementation should verify runtime behavior before relying on type declarations. The probe becomes a checked-in diagnostic script; it is not part of the public package API.

- [ ] **Step 1: Add the probe script**

`packages/blinkyterm/scripts/probe-bun-terminal.ts`:

```ts
#!/usr/bin/env bun

const decoder = new TextDecoder();
const events: string[] = [];

const term = new Bun.Terminal({
  cols: 20,
  rows: 5,
  data(_terminal, chunk) {
    events.push(`data:${decoder.decode(chunk).replace(/\r/g, "\\r").replace(/\n/g, "\\n")}`);
  },
  exit(_terminal, code, signal) {
    events.push(`pty-exit:${code}:${signal ?? "null"}`);
  },
  drain() {
    events.push("drain");
  },
});

const proc = Bun.spawn({
  cmd: ["bash", "-lc", "stty size; read line; printf 'got:%s\\n' \"$line\""],
  env: { ...process.env, TERM: "xterm-256color" },
  terminal: term,
  onExit(subprocess, exitCode, signalCode, error) {
    events.push(`proc-exit:${exitCode ?? "null"}:${signalCode ?? "null"}:${error ? "error" : "ok"}:${subprocess.pid}`);
  },
} as Parameters<typeof Bun.spawn>[0]);

const writeReturn = term.write("hello\n");
events.push(`write-return:${String(writeReturn)}:${typeof writeReturn}`);
term.resize(30, 7);

const exitCode = await proc.exited;
events.push(`exited-promise:${exitCode}`);
events.push(`proc-fields:${proc.exitCode ?? "null"}:${proc.signalCode ?? "null"}:${proc.killed}`);
term.close();
events.push(`term-closed:${term.closed}`);

for (const event of events) console.log(event);
```

- [ ] **Step 2: Run the probe**

```bash
cd packages/blinkyterm
bun run probe:bun-terminal
cd ../..
```

Expected observations:
- `data:` includes the child output.
- `write-return:` reports a number.
- `proc-exit:` or `exited-promise:` reports exit code `0`.
- `term-closed:true` appears after `term.close()`.

If `write-return` is not a number, update Task 11's write queue before implementing it.

- [ ] **Step 3: Commit**

```bash
git add packages/blinkyterm/scripts/probe-bun-terminal.ts
git commit -m "test(blinkyterm): add Bun.Terminal probe"
```

---

### Task 4: Add deterministic child fixtures

**Files:**
- Create: `packages/blinkyterm/test/fixtures/children/*.sh`
- Create: `packages/blinkyterm/test/helpers/fixture-path.ts`
- Create: `packages/blinkyterm/test/integration/fixtures.test.ts`

- [ ] **Step 1: Create fixture path helper**

`packages/blinkyterm/test/helpers/fixture-path.ts`:

```ts
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const fixtureRoot = path.resolve(here, "..", "fixtures");

export function childFixture(name: string): string {
  return path.join(fixtureRoot, "children", name);
}
```

This helper is intentionally rooted at `import.meta.url`, not `process.cwd()`, so root-level `bun test packages/blinkyterm/test/...` works.

- [ ] **Step 2: Add child scripts**

`echo-and-exit.sh`:

```bash
#!/usr/bin/env bash
printf 'hello from child\r\n'
sleep 0.2
```

`wait-for-input.sh`:

```bash
#!/usr/bin/env bash
IFS= read -r line
printf 'input:%s\r\n' "$line"
```

`infinite-loop.sh`:

```bash
#!/usr/bin/env bash
trap 'exit 0' TERM
while :; do sleep 0.1; done
```

`signal-ignorant.sh`:

```bash
#!/usr/bin/env bash
trap '' TERM
while :; do sleep 0.1; done
```

`bell-and-title.sh`:

```bash
#!/usr/bin/env bash
printf '\033]0;title-one\a'
printf '\a'
printf 'paint\r\n'
```

`slow-painter.sh`:

```bash
#!/usr/bin/env bash
printf 'one\r\n'
sleep 0.05
printf 'two\r\n'
sleep 0.05
printf 'three\r\n'
```

`mini-tui.sh`:

```bash
#!/usr/bin/env bash
printf '\033[2J\033[H'
printf 'Mini TUI\r\n'
printf 'Command: '
while IFS= read -r line; do
  case "$line" in
    quit) printf '\r\nbye\r\n'; exit 0 ;;
    *) printf '\r\nyou typed:%s\r\nCommand: ' "$line" ;;
  esac
done
```

- [ ] **Step 3: Make scripts executable and add fixture smoke tests**

```bash
chmod +x packages/blinkyterm/test/fixtures/children/*.sh
```

`packages/blinkyterm/test/integration/fixtures.test.ts`:

```ts
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { childFixture } from "../helpers/fixture-path";

test("child fixture paths resolve from workspace root", () => {
  const result = spawnSync(childFixture("echo-and-exit.sh"), {
    encoding: "utf8",
  });
  expect(result.status).toBe(0);
  expect(result.stdout).toContain("hello from child");
});
```

- [ ] **Step 4: Run from package and root**

```bash
cd packages/blinkyterm
bun test test/integration/fixtures.test.ts
cd ../..
bun test packages/blinkyterm/test/integration/fixtures.test.ts
```

Expected: both pass.

- [ ] **Step 5: Commit**

```bash
git add packages/blinkyterm/test
git commit -m "test(blinkyterm): add deterministic child fixtures"
```

---

### Task 5: Public types and error taxonomy

**Files:**
- Create: `packages/blinkyterm/src/types.ts`
- Create: `packages/blinkyterm/src/errors.ts`
- Modify: `packages/blinkyterm/src/index.ts`
- Create: `packages/blinkyterm/test/smoke/exports.test.ts`

- [ ] **Step 1: Write export and error tests first**

`packages/blinkyterm/test/smoke/exports.test.ts`:

```ts
import { expect, test } from "bun:test";
import {
  BlinkyTermError,
  DisposedError,
  ExitedError,
  FirstFrameTimeoutError,
  IteratorInUseError,
  SpawnError,
} from "../../src";

test("public error classes preserve names and codes", () => {
  expect(new SpawnError("nope").name).toBe("SpawnError");
  expect(new FirstFrameTimeoutError(25).code).toBe("first_frame_timeout");
  expect(new ExitedError("sendText").code).toBe("exited");
  expect(new DisposedError("Runner").code).toBe("disposed");
  expect(new IteratorInUseError().code).toBe("iterator_in_use");
});

test("all blinkyterm errors share one base class", () => {
  expect(new ExitedError("sendText")).toBeInstanceOf(BlinkyTermError);
});
```

- [ ] **Step 2: Run red**

```bash
cd packages/blinkyterm
bun test test/smoke/exports.test.ts
cd ../..
```

Expected: fails because the classes are not implemented.

- [ ] **Step 3: Add public types**

`packages/blinkyterm/src/types.ts`:

```ts
import type { CellInfo, Key, KeyEvent, Mods, Terminal, RenderState } from "libghostty-vt";

export type FrameReason =
  | "initial"
  | "cellChange"
  | "titleChange"
  | "bell"
  | "cursorMove"
  | "heartbeat"
  | "exited"
  | "crashed";

export interface FrameOptions {
  minIntervalMs?: number;
  maxIntervalMs?: number;
  quiesceMs?: number;
  yieldOn?: readonly FrameReason[];
}

export interface SpawnOptions {
  cols?: number;
  rows?: number;
  cwd?: string;
  env?: Record<string, string>;
  firstFrameTimeoutMs?: number;
  frame?: FrameOptions;
  clock?: Clock;
  maxScrollback?: number;
  cellPx?: { width: number; height: number };
}

export interface TerminateOptions {
  signal?: NodeJS.Signals;
  thenAfterMs?: number;
  signal2?: NodeJS.Signals;
}

export interface WaitExitResult {
  exited: boolean;
  exitCode?: number;
  signal?: NodeJS.Signals;
}

export interface Clock {
  now(): number;
  setTimeout(cb: () => void, ms: number): { clear(): void };
}

export interface FrameSnapshot {
  readonly text: string;
  readonly title: string;
  readonly cursor: { readonly x: number; readonly y: number; readonly visible: boolean };
  readonly bellsSinceLast: number;
  readonly titleChangesSinceLast: readonly string[];
  toAnsi(): string;
  toHtml(): string;
  toVt(): string;
  cellAt(x: number, y: number): CellInfo | null;
}

export interface Frame {
  readonly reason: FrameReason;
  readonly snapshot: FrameSnapshot;
  readonly exitCode?: number;
  readonly signal?: NodeJS.Signals;
}

export interface RunnerInternals {
  readonly terminal: Terminal;
  readonly renderState: RenderState;
}

export type { Key, KeyEvent, Mods };
```

- [ ] **Step 4: Add error classes**

`packages/blinkyterm/src/errors.ts`:

```ts
export type BlinkyTermErrorCode =
  | "spawn_failed"
  | "first_frame_timeout"
  | "exited"
  | "disposed"
  | "iterator_in_use";

export class BlinkyTermError extends Error {
  readonly code: BlinkyTermErrorCode;

  constructor(message: string, code: BlinkyTermErrorCode, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
    this.code = code;
  }
}

export class SpawnError extends BlinkyTermError {
  constructor(
    message: string,
    code: "spawn_failed" | "first_frame_timeout" = "spawn_failed",
    options?: ErrorOptions,
  ) {
    super(message, code, options);
  }
}

export class FirstFrameTimeoutError extends SpawnError {
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`Runner did not receive an initial frame within ${timeoutMs}ms`, "first_frame_timeout");
    this.name = "FirstFrameTimeoutError";
    this.timeoutMs = timeoutMs;
  }

  declare readonly code: "first_frame_timeout";
}

export class ExitedError extends BlinkyTermError {
  constructor(methodName: string) {
    super(`Runner.${methodName} cannot be used after the child has exited`, "exited");
  }
}

export class DisposedError extends BlinkyTermError {
  constructor(handleType: string) {
    super(`${handleType} has been disposed`, "disposed");
  }
}

export class IteratorInUseError extends BlinkyTermError {
  constructor() {
    super("Runner.frames() already has an active iterator", "iterator_in_use");
  }
}
```

- [ ] **Step 5: Run green and commit**

```bash
cd packages/blinkyterm
bun test test/smoke/exports.test.ts
bun run typecheck
cd ../..
git add packages/blinkyterm/src packages/blinkyterm/test/smoke/exports.test.ts
git commit -m "feat(blinkyterm): define public types and errors"
```

---

### Task 6: Clock and deferred utilities

**Files:**
- Create: `packages/blinkyterm/src/deferred.ts`
- Create: `packages/blinkyterm/src/clock.ts`
- Create: `packages/blinkyterm/test/helpers/fake-clock.ts`
- Create: `packages/blinkyterm/test/smoke/clock.test.ts`

- [ ] **Step 1: Write fake-clock tests**

`packages/blinkyterm/test/smoke/clock.test.ts`:

```ts
import { expect, test } from "bun:test";
import { createFakeClock } from "../helpers/fake-clock";

test("fake clock fires timers in time order", () => {
  const clock = createFakeClock();
  const fired: string[] = [];
  clock.setTimeout(() => fired.push("b"), 20);
  clock.setTimeout(() => fired.push("a"), 10);
  clock.advance(10);
  expect(fired).toEqual(["a"]);
  clock.advance(10);
  expect(fired).toEqual(["a", "b"]);
});

test("fake clock clear prevents callback", () => {
  const clock = createFakeClock();
  const timer = clock.setTimeout(() => {
    throw new Error("cleared timer fired");
  }, 10);
  timer.clear();
  clock.advance(10);
  expect(clock.now()).toBe(10);
});
```

- [ ] **Step 2: Add production clock/deferred and test helper**

`packages/blinkyterm/src/deferred.ts`:

```ts
export interface Deferred<T = void> {
  readonly promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
  reject(reason?: unknown): void;
}

export function makeDeferred<T = void>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
```

`packages/blinkyterm/src/clock.ts`:

```ts
import type { Clock } from "./types";

export const realClock: Clock = {
  now: () => Date.now(),
  setTimeout(cb, ms) {
    const timer = setTimeout(cb, ms);
    return { clear: () => clearTimeout(timer) };
  },
};
```

`packages/blinkyterm/test/helpers/fake-clock.ts`:

```ts
import type { Clock } from "../../src/types";

interface Timer {
  id: number;
  due: number;
  cb: () => void;
  cleared: boolean;
}

export function createFakeClock(): Clock & { advance(ms: number): void } {
  let now = 0;
  let nextId = 1;
  const timers: Timer[] = [];

  const clock = {
    now: () => now,
    setTimeout(cb: () => void, ms: number) {
      const timer: Timer = { id: nextId++, due: now + ms, cb, cleared: false };
      timers.push(timer);
      timers.sort((a, b) => a.due - b.due || a.id - b.id);
      return { clear: () => { timer.cleared = true; } };
    },
    advance(ms: number) {
      const target = now + ms;
      while (true) {
        timers.sort((a, b) => a.due - b.due || a.id - b.id);
        const timer = timers.find((t) => !t.cleared && t.due <= target);
        if (!timer) break;
        timer.cleared = true;
        now = timer.due;
        timer.cb();
      }
      now = target;
    },
  };
  return clock;
}
```

- [ ] **Step 3: Verify and commit**

```bash
cd packages/blinkyterm
bun test test/smoke/clock.test.ts
bun run typecheck
cd ../..
git add packages/blinkyterm/src/deferred.ts packages/blinkyterm/src/clock.ts packages/blinkyterm/test/helpers/fake-clock.ts packages/blinkyterm/test/smoke/clock.test.ts
git commit -m "test(blinkyterm): add injectable clock utilities"
```

---

### Task 7: Scheduler with latest-only semantics

**Files:**
- Create: `packages/blinkyterm/src/scheduler.ts`
- Create: `packages/blinkyterm/test/smoke/scheduler.test.ts`

- [ ] **Step 1: Write scheduler tests**

Cover these cases in `scheduler.test.ts`:

```ts
import { expect, test } from "bun:test";
import { Scheduler } from "../../src/scheduler";
import { createFakeClock } from "../helpers/fake-clock";

test("initial bypasses yieldOn and wakes immediately after quiesce", async () => {
  const clock = createFakeClock();
  const scheduler = new Scheduler(clock, {
    minIntervalMs: 1000,
    maxIntervalMs: 30000,
    quiesceMs: 100,
    yieldOn: [],
  });
  scheduler.markInitial();
  scheduler.markPtyData();
  clock.advance(100);
  await scheduler.awaitReady();
  expect(scheduler.snapshot().pendingReasons).toContain("initial");
});

test("heartbeat bypasses yieldOn", async () => {
  const clock = createFakeClock();
  const scheduler = new Scheduler(clock, {
    minIntervalMs: 1000,
    maxIntervalMs: 3000,
    quiesceMs: 100,
    yieldOn: [],
  });
  clock.advance(3000);
  await scheduler.awaitReady();
  expect(scheduler.snapshot().pendingReasons).toEqual(["heartbeat"]);
});

test("latest-only accumulates bells and titles until consume", async () => {
  const clock = createFakeClock();
  const scheduler = new Scheduler(clock, {
    minIntervalMs: 0,
    maxIntervalMs: 30000,
    quiesceMs: 100,
    yieldOn: ["bell", "titleChange"],
  });
  scheduler.markBell();
  scheduler.markTitle("one");
  clock.advance(100);
  await scheduler.awaitReady();
  scheduler.markBell();
  scheduler.markTitle("two");
  const snap = scheduler.snapshot();
  expect(snap.bellsSinceLast).toBe(2);
  expect(snap.titleChangesSinceLast).toEqual(["one", "two"]);
  scheduler.consume();
  expect(scheduler.snapshot().bellsSinceLast).toBe(0);
});

test("terminal reasons bypass min interval", async () => {
  const clock = createFakeClock();
  const scheduler = new Scheduler(clock, {
    minIntervalMs: 10000,
    maxIntervalMs: 30000,
    quiesceMs: 100,
    yieldOn: ["cellChange"],
  });
  scheduler.markInitial();
  scheduler.markPtyData();
  clock.advance(100);
  await scheduler.awaitReady();
  scheduler.consume();
  scheduler.markExit({ exitCode: 7 });
  await scheduler.awaitReady();
  expect(scheduler.pickReason()).toBe("exited");
});
```

- [ ] **Step 2: Run red**

```bash
cd packages/blinkyterm
bun test test/smoke/scheduler.test.ts
cd ../..
```

Expected: fails because `Scheduler` does not exist.

- [ ] **Step 3: Implement scheduler**

`packages/blinkyterm/src/scheduler.ts` owns:
- `pendingReasons: Set<FrameReason>`
- `bellsSinceLast: number`
- `titleChangesSinceLast: string[]`
- one-shot `yieldSignal`
- quiesce, heartbeat, and min-interval timers
- `markInitial`, `markPtyData`, `markCellChange`, `markBell`, `markTitle`, `markExit`
- `awaitReady`, `snapshot`, `pickReason`, `consume`, `dispose`

Reason priority must be:

```ts
const REASON_PRIORITY: readonly FrameReason[] = [
  "crashed",
  "exited",
  "initial",
  "titleChange",
  "bell",
  "cellChange",
  "cursorMove",
  "heartbeat",
];
```

`consume()` must clear accumulators and recreate the deferred. Do not store a `pendingFrame`; frames are built by `Runner` at consumer `next()` time.

- [ ] **Step 4: Run green and commit**

```bash
cd packages/blinkyterm
bun test test/smoke/scheduler.test.ts
bun run typecheck
cd ../..
git add packages/blinkyterm/src/scheduler.ts packages/blinkyterm/test/smoke/scheduler.test.ts
git commit -m "feat(blinkyterm): add frame scheduler"
```

---

### Task 8: Frozen FrameSnapshot builder

**Files:**
- Create: `packages/blinkyterm/src/snapshot.ts`
- Create: `packages/blinkyterm/test/smoke/snapshot.test.ts`

- [ ] **Step 1: Write snapshot freeze tests**

`snapshot.test.ts` should feed a `libghostty-vt` terminal directly, build a snapshot, mutate the terminal, then assert the old snapshot is unchanged:

```ts
import { expect, test } from "bun:test";
import { Terminal, RenderState } from "libghostty-vt";
import { buildFrameSnapshot } from "../../src/snapshot";

const enc = new TextEncoder();

test("snapshot text and cells are frozen after capture", () => {
  using terminal = new Terminal({ cols: 10, rows: 3 });
  using renderState = new RenderState();
  terminal.vtWrite(enc.encode("alpha"));
  renderState.update(terminal);

  const snap = buildFrameSnapshot({
    terminal,
    renderState,
    bellsSinceLast: 1,
    titleChangesSinceLast: ["first"],
  });

  terminal.vtWrite(enc.encode("\r\nbeta"));
  renderState.update(terminal);

  expect(snap.text).toContain("alpha");
  expect(snap.text).not.toContain("beta");
  expect(snap.cellAt(0, 0)?.text).toBe("a");
  expect(snap.bellsSinceLast).toBe(1);
  expect(snap.titleChangesSinceLast).toEqual(["first"]);
  expect(Object.isFrozen(snap)).toBe(true);
  expect(Object.isFrozen(snap.cursor)).toBe(true);
});
```

- [ ] **Step 2: Run red**

```bash
cd packages/blinkyterm
bun test test/smoke/snapshot.test.ts
cd ../..
```

Expected: fails because `buildFrameSnapshot` does not exist.

- [ ] **Step 3: Implement builder**

Implementation requirements:
- Call `terminal.snapshot()` for title/cursor.
- Use `new Formatter({ format: "plain" }).formatString(terminal)` for `text`.
- Use `new Formatter({ format: "vt", style: true, cursor: true }).formatString(terminal)` for `toAnsi()` and `toVt()` in v0. The names stay separate so a future binding can distinguish "ANSI view" from "VT replay" without changing the API.
- Use `new Formatter({ format: "html", style: true, hyperlink: true }).formatString(terminal)` for `toHtml()`.
- Copy cells by iterating `renderState.rows()` and each row's `cells()`.
- Freeze the snapshot object, cursor object, title change array, and copied cell objects.
- Return `null` from `cellAt(x, y)` for out-of-bounds cells.

- [ ] **Step 4: Run green and commit**

```bash
cd packages/blinkyterm
bun test test/smoke/snapshot.test.ts
bun run typecheck
cd ../..
git add packages/blinkyterm/src/snapshot.ts packages/blinkyterm/test/smoke/snapshot.test.ts
git commit -m "feat(blinkyterm): add frozen frame snapshots"
```

---

### Task 9: Runner spawn and first frame

**Files:**
- Modify: `packages/blinkyterm/src/runner.ts`
- Create: `packages/blinkyterm/test/helpers/runner-test.ts`
- Create: `packages/blinkyterm/test/smoke/runner.lifecycle.test.ts`

- [ ] **Step 1: Write spawn tests**

Cover:
- `Runner.spawn([childFixture("echo-and-exit.sh")])` resolves.
- First `frames().next()` returns `reason: "initial"` and text contains child output.
- Spawning a missing binary rejects with `SpawnError`.
- A no-output child rejects with `FirstFrameTimeoutError`.

Use `firstFrameTimeoutMs: 100` only in the no-output test.

- [ ] **Step 2: Run red**

```bash
cd packages/blinkyterm
bun test test/smoke/runner.lifecycle.test.ts
cd ../..
```

- [ ] **Step 3: Implement minimal Runner resource wiring**

`Runner.spawn(cmd, opts)` must:
- Normalize `cols` default `80`, `rows` default `24`, `cwd` default `process.cwd()`.
- Merge env with `TERM: "xterm-256color"`, `LC_ALL: "en_US.UTF-8"`, `LANG: "en_US.UTF-8"`, `COLUMNS`, and `LINES`.
- Construct `libghostty-vt` `Terminal` with `onWritePty`, `onBell`, and `onTitleChanged`.
- Construct `RenderState`.
- Construct `KeyEncoder({ terminal })`.
- Construct `Bun.Terminal` with `data`, `exit`, and `drain` callbacks.
- Spawn child with `{ cmd, cwd, env, terminal: pty, onExit }`.
- Feed every pty `data` chunk to `terminal.vtWrite(chunk)`, mark initial, and restart quiesce.
- On libghostty `onWritePty`, enqueue bytes to the pty write queue once Task 11 exists. Until Task 11, write directly with `pty.write(bytes)`.
- Await first frame readiness during `spawn()`. If no first frame arrives before `firstFrameTimeoutMs`, dispose partial resources and reject with `FirstFrameTimeoutError`.

Add post-spawn getters:

```ts
get terminal(): Terminal;
get renderState(): RenderState;
```

They throw `DisposedError` after async dispose completes.

- [ ] **Step 4: Run green and commit**

```bash
cd packages/blinkyterm
bun test test/smoke/runner.lifecycle.test.ts
bun run typecheck
cd ../..
git add packages/blinkyterm/src/runner.ts packages/blinkyterm/test/helpers/runner-test.ts packages/blinkyterm/test/smoke/runner.lifecycle.test.ts
git commit -m "feat(blinkyterm): spawn pty-backed runners"
```

---

### Task 10: Frame iterator semantics

**Files:**
- Modify: `packages/blinkyterm/src/runner.ts`
- Create: `packages/blinkyterm/test/smoke/runner.frames.test.ts`

- [ ] **Step 1: Write frame iterator tests**

Tests:
- `frames()` allows only one active iterator and second call throws `IteratorInUseError`.
- Terminal frame is delivered exactly once; next `next()` returns `done: true`.
- Slow consumer receives one latest frame, not a backlog.
- Terminal frame reason is `"exited"` for normal exit and `"crashed"` for signal exit.
- `waitExit({ timeoutMs })` timing out does not close the iterator.

- [ ] **Step 2: Implement custom async iterable**

Avoid `async function*`. Implement a small iterator object so finalization happens before returning from `next()`:

```ts
frames(): AsyncIterable<Frame> {
  this.#assertUsable("frames");
  if (this.#iteratorActive) throw new IteratorInUseError();
  this.#iteratorActive = true;
  const runner = this;
  let closed = false;
  return {
    [Symbol.asyncIterator]() {
      return {
        async next() {
          if (closed) return { done: true, value: undefined };
          const frame = await runner.#nextFrame();
          if (!frame) {
            closed = true;
            runner.#iteratorActive = false;
            return { done: true, value: undefined };
          }
          if (frame.reason === "exited" || frame.reason === "crashed") closed = true;
          return { done: false, value: frame };
        },
        async return() {
          closed = true;
          runner.#iteratorActive = false;
          return { done: true, value: undefined };
        },
      };
    },
  };
}
```

`#nextFrame()` must:
- Await scheduler readiness.
- Call `renderState.update(terminal)`.
- Build the frozen snapshot from current state and scheduler accumulators.
- Pick reason.
- Copy exit data if terminal reason.
- Call `renderState.markClean()`.
- Call `scheduler.consume()`.
- Mark the iterator closed only after returning the terminal frame.

- [ ] **Step 3: Verify and commit**

```bash
cd packages/blinkyterm
bun test test/smoke/runner.frames.test.ts
bun run typecheck
cd ../..
git add packages/blinkyterm/src/runner.ts packages/blinkyterm/test/smoke/runner.frames.test.ts
git commit -m "feat(blinkyterm): implement frame iterator semantics"
```

---

### Task 11: Serialized write queue, sendBytes, and sendText

**Files:**
- Create: `packages/blinkyterm/src/write-queue.ts`
- Modify: `packages/blinkyterm/src/runner.ts`
- Create: `packages/blinkyterm/test/smoke/runner.send.test.ts`

- [ ] **Step 1: Write send tests**

Tests:
- `sendText("hello\n")` round-trips through `wait-for-input.sh`.
- Concurrent `sendText("a")`, `sendText("b")`, `sendText("\n")` writes in call order.
- `sendBytes(new Uint8Array([0x68, 0x69, 0x0a]))` writes raw bytes.
- Send after terminal exit throws `ExitedError`.

- [ ] **Step 2: Implement write queue**

`write-queue.ts` responsibilities:
- Serialize writes by chaining promises.
- Loop on partial `Bun.Terminal.write()` return values until all bytes are written.
- Await the next `drain` callback when `write()` writes `0` or less than remaining length.
- Reject pending writes with `DisposedError` when Runner disposes.

Use a `notifyDrain()` method called from the `Bun.Terminal` drain callback.

- [ ] **Step 3: Wire send methods**

`Runner` methods:

```ts
sendBytes(bytes: Uint8Array): Promise<void>;
sendText(text: string): Promise<void>;
```

`sendText` encodes raw UTF-8 using `TextEncoder`. It deliberately does not use `KeyEncoder`; text bytes are not physical key events.

- [ ] **Step 4: Verify and commit**

```bash
cd packages/blinkyterm
bun test test/smoke/runner.send.test.ts
bun run typecheck
cd ../..
git add packages/blinkyterm/src/write-queue.ts packages/blinkyterm/src/runner.ts packages/blinkyterm/test/smoke/runner.send.test.ts
git commit -m "feat(blinkyterm): serialize pty writes"
```

---

### Task 12: sendKeyEvent and sendKey convenience

**Files:**
- Create: `packages/blinkyterm/src/us-layout.ts`
- Modify: `packages/blinkyterm/src/runner.ts`
- Modify: `packages/blinkyterm/test/smoke/runner.send.test.ts`

- [ ] **Step 1: Add key send tests**

Tests:
- `sendKey("Enter")` sends carriage return / enter behavior to `wait-for-input.sh`.
- `sendKey("KeyA")` sends `a`.
- `sendKey("KeyA", { shift: true })` sends `A`.
- `sendKeyEvent({ key: "KeyC", mods: { ctrl: true }, utf8: "c" })` can interrupt `infinite-loop.sh` or produces the expected encoded byte in a fake-pty harness.
- Invalid `utf8` rethrows Pass 4 `EncodeError`.

- [ ] **Step 2: Implement US layout helper**

`us-layout.ts` maps physical key names to printable `utf8` and `unshiftedCodepoint` for:
- `KeyA` through `KeyZ`
- `Digit0` through `Digit9`
- `Space`
- `Minus`, `Equal`, `BracketLeft`, `BracketRight`, `Backslash`, `Semicolon`, `Quote`, `Backquote`, `Comma`, `Period`, `Slash`

It must not invent text for non-printable keys (`Enter`, arrows, function keys). For those, pass only `key` and `mods` to `KeyEncoder`.

- [ ] **Step 3: Wire key methods**

```ts
sendKeyEvent(event: KeyEvent): Promise<void> {
  this.#assertRunning("sendKeyEvent");
  return this.sendBytes(this.#keyEncoder.encode(event));
}

sendKey(key: Key, mods?: Mods): Promise<void> {
  return this.sendKeyEvent(eventFromUsLayout(key, mods));
}
```

The bound `KeyEncoder` auto-syncs from `Terminal` on each encode per Pass 4.

- [ ] **Step 4: Verify and commit**

```bash
cd packages/blinkyterm
bun test test/smoke/runner.send.test.ts
bun run typecheck
cd ../..
git add packages/blinkyterm/src/us-layout.ts packages/blinkyterm/src/runner.ts packages/blinkyterm/test/smoke/runner.send.test.ts
git commit -m "feat(blinkyterm): add key sending helpers"
```

---

### Task 13: resize, waitExit, and terminate escalation

**Files:**
- Modify: `packages/blinkyterm/src/runner.ts`
- Modify: `packages/blinkyterm/test/smoke/runner.lifecycle.test.ts`

- [ ] **Step 1: Add lifecycle method tests**

Tests:
- `resize(100, 40)` calls both `Bun.Terminal.resize` and `Terminal.resize`.
- `resize()` after exit throws `ExitedError`.
- `waitExit({ timeoutMs: 50 })` returns `{ exited: false }` for `infinite-loop.sh`.
- `terminate()` sends SIGTERM and waits for `infinite-loop.sh` to exit cleanly.
- `terminate({ thenAfterMs: 50 })` escalates to SIGKILL for `signal-ignorant.sh`.
- Double `terminate()` awaits the first termination path and does not send a second sequence.

- [ ] **Step 2: Implement lifecycle methods**

`resize(cols, rows)`:
- Assert Runner is running.
- Update stored cols/rows.
- Call `pty.resize(cols, rows)`.
- Call `terminal.resize(cols, rows, opts.cellPx)`.
- Mark scheduler with `cellChange` so a frame can surface the new geometry.

`waitExit(opts)`:
- If already exited, return latched exit result.
- If no timeout, await child exit.
- If timeout, race child exit with timer and return `{ exited: false }` on timeout.
- Do not synthesize a terminal frame on timeout.

`terminate(opts)`:
- Default `signal: "SIGTERM"`, `signal2: "SIGKILL"`.
- If child already exited, resolve.
- If another terminate is active, return the same promise.
- Send `signal`.
- If `thenAfterMs` is set, wait that long; if still alive, send `signal2`.
- Await actual exit.

- [ ] **Step 3: Verify and commit**

```bash
cd packages/blinkyterm
bun test test/smoke/runner.lifecycle.test.ts
bun run typecheck
cd ../..
git add packages/blinkyterm/src/runner.ts packages/blinkyterm/test/smoke/runner.lifecycle.test.ts
git commit -m "feat(blinkyterm): add resize and termination lifecycle"
```

---

### Task 14: Async disposal and partial-spawn rollback

**Files:**
- Modify: `packages/blinkyterm/src/runner.ts`
- Modify: `packages/blinkyterm/src/scheduler.ts`
- Modify: `packages/blinkyterm/src/write-queue.ts`
- Modify: `packages/blinkyterm/test/smoke/runner.lifecycle.test.ts`

- [ ] **Step 1: Add disposal tests**

Tests:
- `[Symbol.asyncDispose]()` is idempotent.
- Disposing a running child sends SIGKILL and returns within the 2s cap.
- After dispose, `terminal`, `renderState`, and send methods throw `DisposedError`.
- If `Runner.spawn()` fails after partial setup, no child is left running and no caller cleanup is required.
- Active iterator gets a terminal `"crashed"` frame or closes cleanly when disposal happens before natural exit.

- [ ] **Step 2: Implement disposal order**

Order must match the spec:
1. Cancel scheduler timers.
2. Reject queued writes.
3. If active iterator has not received a terminal frame, materialize one final frozen frame with reason `"crashed"` before closing libghostty resources, then wake the iterator. If snapshot materialization itself fails, close the iterator without attempting to read a closed terminal.
4. If child still running, send SIGKILL.
5. Await child exit with a 2s cap.
6. Close `Bun.Terminal`.
7. Dispose `RenderState`.
8. Dispose `KeyEncoder`.
9. Dispose `Terminal`.
10. Mark Runner disposed.

Every step must be idempotent. Catch and retain the first cleanup error, but continue freeing later resources. Re-throw only after all cleanup attempts.

- [ ] **Step 3: Verify and commit**

```bash
cd packages/blinkyterm
bun test test/smoke/runner.lifecycle.test.ts
bun run typecheck
cd ../..
git add packages/blinkyterm/src/runner.ts packages/blinkyterm/src/scheduler.ts packages/blinkyterm/src/write-queue.ts packages/blinkyterm/test/smoke/runner.lifecycle.test.ts
git commit -m "feat(blinkyterm): implement async disposal"
```

---

### Task 15: Package scripts, CI, and root-level test shape

**Files:**
- Modify: `.github/workflows/ci.yml`
- Modify: `README.md`
- Create: `packages/blinkyterm/test/smoke/root-invocation.test.ts`

- [ ] **Step 1: Add root-invocation smoke**

`root-invocation.test.ts`:

```ts
import { expect, test } from "bun:test";
import { childFixture } from "../helpers/fixture-path";

test("fixture helper is independent of process.cwd", () => {
  expect(childFixture("mini-tui.sh")).toContain("packages/blinkyterm/test/fixtures/children/mini-tui.sh");
});
```

- [ ] **Step 2: Update CI**

Add after the existing `libghostty-vt` build/test steps:

```yaml
      - name: Typecheck blinkyterm
        working-directory: packages/blinkyterm
        run: bun run typecheck

      - name: Test blinkyterm
        working-directory: packages/blinkyterm
        run: bun run test

      - name: Build blinkyterm TypeScript
        working-directory: packages/blinkyterm
        run: bun run build
```

Keep package working directories for package tests. Root-level tests are still covered by the explicit root invocation smoke.

- [ ] **Step 3: Update root README package status**

Change the root README so `blinkyterm` is listed as present, not future. The entry should say:

```markdown
- `packages/blinkyterm` - agent-facing Runner over `Bun.Terminal` plus
  `libghostty-vt`, with async frame iteration and send helpers.
```

- [ ] **Step 4: Verify and commit**

```bash
cd packages/blinkyterm
bun test test/smoke/root-invocation.test.ts
bun run test
cd ../..
git add .github/workflows/ci.yml README.md packages/blinkyterm/test/smoke/root-invocation.test.ts
git commit -m "ci(blinkyterm): add runner package gates"
```

---

### Task 16: Package README and API examples

**Files:**
- Modify: `packages/blinkyterm/README.md`
- Create: `packages/blinkyterm/examples/README.md`

- [ ] **Step 1: Expand `packages/blinkyterm/README.md`**

Include these sections:
- "Install" with workspace import examples.
- "Spawn a child and read frames".
- "Send text, keys, and raw bytes".
- "Clean quit vs terminate".
- "Frame timing options".
- "Snapshot semantics".
- "Errors".

Use this core example:

```ts
import { Runner } from "blinkyterm";

await using runner = await Runner.spawn(["bash", "-lc", "printf 'ready\\n'; read line; printf 'typed:%s\\n' \"$line\""], {
  cols: 80,
  rows: 24,
  frame: { minIntervalMs: 250, quiesceMs: 50 },
});

const iter = runner.frames()[Symbol.asyncIterator]();
await runner.sendText("hello\n");

for (;;) {
  const { value: frame, done } = await iter.next();
  if (done) break;
  console.log(frame.snapshot.text);
  if (frame.reason === "exited" || frame.reason === "crashed") break;
}
```

- [ ] **Step 2: Add examples README**

`packages/blinkyterm/examples/README.md` should document:
- `bun examples/random-bot.ts`
- `bun examples/llm-bot.ts`
- `brew install nethack`
- The examples skip with a clear message when `nethack` is absent.

- [ ] **Step 3: Verify docs commands compile**

```bash
cd packages/blinkyterm
bun run typecheck
cd ../..
git add packages/blinkyterm/README.md packages/blinkyterm/examples/README.md
git commit -m "docs(blinkyterm): document Runner API"
```

---

### Task 17: NetHack random bot example

**Files:**
- Create: `packages/blinkyterm/examples/shared/nethack-setup.ts`
- Create: `packages/blinkyterm/examples/shared/prompt-detect.ts`
- Create: `packages/blinkyterm/examples/shared/keymap.ts`
- Create: `packages/blinkyterm/examples/random-bot.ts`

- [ ] **Step 1: Add shared helpers**

`nethack-setup.ts`:

```ts
import { spawnSync } from "node:child_process";

export function hasNethack(): boolean {
  return spawnSync("bash", ["-lc", "command -v nethack"], { stdio: "ignore" }).status === 0;
}

export function nethackEnv(): Record<string, string> {
  return {
    NETHACKOPTIONS: "name:agent,role:valkyrie,race:human,gender:female,align:lawful",
  };
}
```

`prompt-detect.ts`:

```ts
import type { FrameSnapshot } from "../../src";

export type PromptKind = "more" | "yn" | "death" | "none";

export function detectPrompt(snapshot: FrameSnapshot): PromptKind {
  const text = snapshot.text;
  if (text.includes("--More--")) return "more";
  if (/\(y\/n\)/i.test(text)) return "yn";
  if (/Do you want your possessions identified|You die/i.test(text)) return "death";
  return "none";
}
```

`keymap.ts`:

```ts
export type BotMove = "north" | "south" | "east" | "west" | "search" | "pickup";

export function toKeystroke(move: BotMove): string {
  switch (move) {
    case "north": return "k";
    case "south": return "j";
    case "east": return "l";
    case "west": return "h";
    case "search": return "s";
    case "pickup": return ",";
  }
}
```

- [ ] **Step 2: Add random bot**

`random-bot.ts`:

```ts
#!/usr/bin/env bun
import { Runner } from "../src";
import { detectPrompt } from "./shared/prompt-detect";
import { hasNethack, nethackEnv } from "./shared/nethack-setup";
import { toKeystroke, type BotMove } from "./shared/keymap";

function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

if (!hasNethack()) {
  console.log("nethack not found; install with `brew install nethack` to run this example");
  process.exit(0);
}

const rng = mulberry32(42);
const moves: readonly BotMove[] = ["north", "south", "east", "west", "search", "pickup"];
let turns = 0;

await using runner = await Runner.spawn(["nethack"], {
  cols: 80,
  rows: 24,
  env: nethackEnv(),
  frame: { minIntervalMs: 500, maxIntervalMs: 10000, quiesceMs: 100 },
});

outer: for await (const frame of runner.frames()) {
  if (frame.reason === "exited" || frame.reason === "crashed") break outer;

  const prompt = detectPrompt(frame.snapshot);
  if (prompt === "more") { await runner.sendKey("Space"); continue; }
  if (prompt === "yn") { await runner.sendText("n"); continue; }
  if (prompt === "death") break outer;

  if (++turns >= 200) {
    await runner.sendText("#quit\r y\r y\r");
    const result = await runner.waitExit({ timeoutMs: 3000 });
    if (!result.exited) await runner.terminate({ thenAfterMs: 1000 });
    continue;
  }

  const move = moves[Math.floor(rng() * moves.length)]!;
  await runner.sendText(toKeystroke(move));
}
```

- [ ] **Step 3: Verify example compiles and commits**

```bash
cd packages/blinkyterm
bun run typecheck
bun examples/random-bot.ts
cd ../..
```

Expected: typecheck succeeds. Runtime either starts NetHack or prints the skip message.

```bash
git add packages/blinkyterm/examples
git commit -m "docs(blinkyterm): add NetHack random bot example"
```

---

### Task 18: LLM bot example

**Files:**
- Create: `packages/blinkyterm/examples/llm-bot.ts`
- Modify: `packages/blinkyterm/examples/README.md`

Keep this example dependency-free in the package. It should read a command from `BLINKYTERM_LLM_COMMAND`; the command receives the screen on stdin and prints one move (`north`, `south`, `east`, `west`, `search`, `pickup`, or `quit`) on stdout. This lets users plug in OpenAI, Anthropic, a local model, or a shell script without adding an SDK to `blinkyterm`.

- [ ] **Step 1: Add `llm-bot.ts`**

Core behavior:
- Skip with a clear message if `nethack` is absent.
- Skip with a clear message if `BLINKYTERM_LLM_COMMAND` is absent.
- Spawn NetHack exactly like `random-bot.ts`.
- For each non-terminal frame, send `frame.snapshot.toAnsi()` to the command.
- Validate the returned move against the known move set.
- Use `#quit\r y\r y\r` for `quit` or turn budget exhaustion.

- [ ] **Step 2: Add a dry-run command example to docs**

Document:

```bash
BLINKYTERM_LLM_COMMAND='ruby -e "STDIN.read; puts %[north south east west search pickup].sample"' bun examples/llm-bot.ts
```

- [ ] **Step 3: Verify and commit**

```bash
cd packages/blinkyterm
bun run typecheck
BLINKYTERM_LLM_COMMAND='printf quit' bun examples/llm-bot.ts
cd ../..
```

Expected: typecheck succeeds. Runtime either skips for missing NetHack or cleanly asks the command for a move.

```bash
git add packages/blinkyterm/examples/llm-bot.ts packages/blinkyterm/examples/README.md
git commit -m "docs(blinkyterm): add LLM command bot example"
```

---

### Task 19: Final verification, changelog, and tag

**Files:**
- Modify: `packages/blinkyterm/CHANGELOG.md`
- Read-only: all package tests/builds
- Create tag: `blinkyterm@0.1.0`

- [ ] **Step 1: Full workspace install and package builds**

```bash
bun install --frozen-lockfile
cd packages/libghostty-vt
bun run typecheck
bun run test
bun run build:ts
cd ../blinkyterm
bun run typecheck
bun run test
bun run build
cd ../..
```

Expected: all commands pass.

- [ ] **Step 2: Root-level blinkyterm test shape**

```bash
bun test packages/blinkyterm/test/smoke packages/blinkyterm/test/integration
```

Expected: all blinkyterm tests pass from the workspace root.

- [ ] **Step 3: Optional example smoke**

```bash
cd packages/blinkyterm
bun examples/random-bot.ts
BLINKYTERM_LLM_COMMAND='printf quit' bun examples/llm-bot.ts
cd ../..
```

Expected: each example either runs or prints the documented `nethack not found` skip.

- [ ] **Step 4: Update changelog date and contents**

Ensure `packages/blinkyterm/CHANGELOG.md` has:

```markdown
## [0.1.0] - 2026-04-25

### Added

- `Runner.spawn()` for pty-backed child processes.
- `frames()` async iterator with frozen snapshots, quiesce, rate limit,
  heartbeat, latest-only semantics, and terminal frames.
- `sendText`, `sendBytes`, `sendKey`, and `sendKeyEvent`.
- `resize`, `waitExit`, `terminate`, and async disposal.
- Deterministic child fixtures and NetHack examples.
```

- [ ] **Step 5: Final clean tree and tag**

```bash
git status --short
git add packages/blinkyterm/CHANGELOG.md
git commit -m "docs(changelog): blinkyterm 0.1.0"
git tag -a blinkyterm@0.1.0 -m "blinkyterm@0.1.0 - Pass 5 Runner"
git tag --list "blinkyterm@*"
```

Expected: tag list includes `blinkyterm@0.1.0`.

- [ ] **Step 6: Final report**

Report:
- exact commit count from `git log --oneline main..HEAD | wc -l`
- final test commands and pass status
- whether NetHack examples ran or skipped
- tag name

No push or publish in this plan.

---

## Self-review checklist

- [x] **Spec coverage:** Spec section 3 maps to Tasks 5, 8, 9, 10, 11, 12, and 13. Section 4 maps to Tasks 7 and 10. Section 5 maps to Tasks 5, 13, and 14. Section 6 maps to Tasks 4, 6, 7, 8, 9, 10, 11, 12, 13, and 15. Section 7 maps to Tasks 17 and 18.
- [x] **Pass separation:** Pass 4 `KeyEncoder` is a preflight dependency, not reimplemented here. Pass 5 starts only after `libghostty-vt@0.4.0`.
- [x] **Frozen snapshots:** Task 8 explicitly copies formatted strings and cells at finalize time because there is no terminal clone API.
- [x] **Finalize-on-consume:** Task 10 builds frames inside `next()` and avoids generator cleanup timing.
- [x] **Write contract:** Task 11 serializes all send paths and loops on partial pty writes.
- [x] **Lifecycle:** Task 14 follows the spec disposal order and covers partial-spawn rollback.
- [x] **Root cwd safety:** Task 4 and Task 15 root fixture paths at `import.meta.url`, not `process.cwd()`.
- [x] **Examples:** Task 17 provides deterministic random NetHack automation. Task 18 provides a dependency-free LLM-command adapter rather than adding an SDK to the default package.
