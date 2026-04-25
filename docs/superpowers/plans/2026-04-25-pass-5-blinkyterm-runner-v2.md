# Pass 5 - blinkyterm Runner Hybrid Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `packages/blinkyterm`, a pure-TypeScript Runner package that lets agents spawn a real TUI in a `Bun.Terminal`, observe frozen screen frames via `libghostty-vt`, send text/keys/bytes, and shut down cleanly. Ships as `blinkyterm@0.1.0`.

**Architecture:** `Runner` owns a `Bun.Terminal` pty, a child `Subprocess`, a `libghostty-vt` `Terminal` + `RenderState`, a bound `KeyEncoder`, a `Scheduler`, and a serialized `WriteQueue`. Pty data flows into `Terminal.vtWrite`; libghostty pty replies flow back through the write queue; scheduler timers decide when a single async frame iterator wakes; frame construction happens on consumer `next()` and returns a frozen capture.

**Tech Stack:** Bun 1.3.13+ (`Bun.Terminal`, `Bun.spawn`, workspaces, `bun:test`), TypeScript 5.x, `libghostty-vt@0.4.0`, no runtime npm dependencies beyond the binding.

---

## Canonical Plan Notice

This hybrid plan supersedes these two drafts for execution:

- `docs/superpowers/plans/2026-04-25-pass-5-blinkyterm-runner.md`
- `docs/superpowers/plans/2026-04-24-pass-5-blinkyterm-breq.md`

It keeps Breq's finer task granularity and useful probes, but preserves the safer implementation choices from the shorter Codex draft:

- frozen snapshots must copy data at frame-finalize time, not lazily read the live terminal;
- `sendKey` must use a US-layout helper to populate `utf8` and `unshiftedCodepoint` for printable physical keys;
- pty writes must use a real serialized write queue with drain notification;
- typecheck must cover tests/examples/scripts without emitting declarations for them;
- examples stay dependency-free by using `BLINKYTERM_LLM_COMMAND` instead of adding an SDK to the package.

---

## Pre-execution Context

**Spec:** `docs/superpowers/specs/2026-04-24-agent-tui-runner-design.md` sections 3-9.

**Pass 4 dependency:** Execute only after Pass 4 has landed on `main` with the review fix for `KeyEncoder`'s borrowed `utf8` buffer lifetime. The binding must export `Terminal`, `RenderState`, `Formatter`, `KeyEncoder`, `Key`, `KeyEvent`, `Mods`, `KeyEncoderOptions`, and `EncodeError`.

**No FFI in blinkyterm:** All dylib calls stay in `packages/libghostty-vt`. `blinkyterm` is orchestration only.

**Frozen snapshot rule:** `FrameSnapshot` is a value capture. Because `libghostty-vt` has no terminal clone API, snapshot construction must eagerly copy the strings and cells needed by all accessors. Lazy methods may memoize, but they must return captured data.

---

## File Structure

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
    internal/
      clock.ts
      deferred.ts
      scheduler.ts
      snapshot.ts
      us-layout.ts
      write-queue.ts
  scripts/
    probe-bun-terminal.ts
    probe-nethack-startup.ts
  test/
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
      fixture-path.ts
    smoke/
      exports.test.ts
      errors.test.ts
      deferred.test.ts
      clock.test.ts
      scheduler.test.ts
      snapshot.test.ts
      write-queue.test.ts
      us-layout.test.ts
      runner.spawn.test.ts
      runner.frames.test.ts
      runner.send.test.ts
      runner.lifecycle.test.ts
      runner.integration.test.ts
  examples/
    README.md
    random-bot.ts
    llm-bot.ts
    shared/
      keymap.ts
      mulberry32.ts
      nethack-setup.ts
      prompt-detect.ts
```

Existing files modified:

```text
bun.lock
.github/workflows/ci.yml
README.md
```

---

### Task 1: Preflight - post-Pass-4 baseline

**Files:**
- Write: `.worktrees/pass-5-blinkyterm/`
- Write: `.tmp/preflight-pass5.txt`

- [ ] **Step 1: Verify current main and Pass 4 surface**

```bash
git status --short
git rev-parse --abbrev-ref HEAD
git log --oneline -5
grep '"version"' packages/libghostty-vt/package.json
grep -n "KeyEncoder" packages/libghostty-vt/src/index.ts
grep -n "utf8Bytes" packages/libghostty-vt/src/key-encoder.ts
```

Expected:
- branch is `main`;
- no tracked changes;
- `packages/libghostty-vt/package.json` is `0.4.0`;
- `KeyEncoder` is exported;
- the `utf8Bytes` lifetime fix is present. If the last grep fails, stop and fix Pass 4 first.

- [ ] **Step 2: Create worktree**

```bash
git worktree add .worktrees/pass-5-blinkyterm -b feat/pass-5-blinkyterm
cd .worktrees/pass-5-blinkyterm
```

- [ ] **Step 3: Copy ignored binding artifacts**

```bash
cp -R /Users/mw/Code/prime/ts-libghostty-vt/packages/libghostty-vt/vendor packages/libghostty-vt/vendor
cp -R /Users/mw/Code/prime/ts-libghostty-vt/packages/libghostty-vt/prebuilds packages/libghostty-vt/prebuilds
ls packages/libghostty-vt/prebuilds/darwin-arm64/libghostty-vt.dylib
```

Expected: dylib path prints.

- [ ] **Step 4: Baseline install and binding verification**

```bash
bun install --frozen-lockfile
mkdir -p .tmp
cd packages/libghostty-vt
bun run typecheck
bun test test/smoke 2>&1 | tee ../../.tmp/preflight-pass5.txt
bun run verify:generated
cd ../..
```

Expected: typecheck, smoke tests, and verify:generated pass.

- [ ] **Step 5: No commit**

```bash
git status --short
```

Expected: only ignored `.tmp/` artifacts.

---

### Task 2: Package Scaffold

**Files:**
- Create: `packages/blinkyterm/package.json`
- Create: `packages/blinkyterm/tsconfig.json`
- Create: `packages/blinkyterm/tsconfig.check.json`
- Create: `packages/blinkyterm/src/index.ts`
- Create: `packages/blinkyterm/src/runner.ts`
- Create: `packages/blinkyterm/README.md`
- Create: `packages/blinkyterm/CHANGELOG.md`
- Modify: `bun.lock`

- [ ] **Step 1: Create `package.json`**

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
    "test": "bun test test/smoke",
    "test:smoke": "bun test test/smoke",
    "probe:bun-terminal": "bun scripts/probe-bun-terminal.ts",
    "probe:nethack": "bun scripts/probe-nethack-startup.ts"
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

Do not add `@anthropic-ai/sdk`; the LLM example uses an external command.

- [ ] **Step 2: Create TypeScript configs**

`packages/blinkyterm/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "./src",
    "outDir": "./dist",
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

- [ ] **Step 3: Add stubs**

`packages/blinkyterm/src/runner.ts`:

```ts
export class Runner {
  private constructor() {}
}
```

`packages/blinkyterm/src/index.ts`:

```ts
export { Runner } from "./runner";
```

`packages/blinkyterm/README.md`:

```markdown
# blinkyterm

Agent-facing TUI runner built on `Bun.Terminal` and `libghostty-vt`.
```

`packages/blinkyterm/CHANGELOG.md`:

```markdown
# Changelog

## [0.1.0] - 2026-04-25

### Added

- Initial `Runner` package.
```

- [ ] **Step 4: Verify and commit**

```bash
bun install
cd packages/blinkyterm
bun run typecheck
bun run build
cd ../..
git add bun.lock packages/blinkyterm
git commit -m "chore(blinkyterm): scaffold package"
```

---

### Task 3: Probe Bun.Terminal

**Files:**
- Create: `packages/blinkyterm/scripts/probe-bun-terminal.ts`

- [ ] **Step 1: Add probe**

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

try {
  term.resize(30, 7);
  events.push("resize:ok");
} catch (error) {
  events.push(`resize:error:${(error as Error).message}`);
}

const exitCode = await proc.exited;
events.push(`exited-promise:${exitCode}`);
events.push(`proc-fields:${proc.exitCode ?? "null"}:${proc.signalCode ?? "null"}:${proc.killed}`);

let postExitWrite = "no-throw";
try {
  term.write("after\n");
} catch (error) {
  postExitWrite = `throw:${(error as Error).message}`;
}
events.push(`post-exit-write:${postExitWrite}`);

term.close();
events.push(`term-closed:${term.closed}`);

for (const event of events) console.log(event);
```

- [ ] **Step 2: Run and record**

```bash
cd packages/blinkyterm
bun run probe:bun-terminal
cd ../..
```

Expected:
- `write-return` reports a number;
- `resize:ok` appears on current Bun;
- child output appears in `data:`;
- `term-closed:true` appears.

If write return is not numeric or resize fails, amend downstream write/resize tasks before continuing.

- [ ] **Step 3: Commit**

```bash
git add packages/blinkyterm/scripts/probe-bun-terminal.ts
git commit -m "chore(blinkyterm): probe Bun.Terminal behavior"
```

---

### Task 4: Optional NetHack Startup Probe

**Files:**
- Create: `packages/blinkyterm/scripts/probe-nethack-startup.ts`

- [ ] **Step 1: Add skip-safe probe**

```ts
#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";

if (spawnSync("bash", ["-lc", "command -v nethack"], { stdio: "ignore" }).status !== 0) {
  console.log("nethack not on PATH; skipped");
  process.exit(0);
}

mkdirSync(".tmp", { recursive: true });
const chunks: Uint8Array[] = [];
const term = new Bun.Terminal({
  cols: 80,
  rows: 24,
  data(_terminal, chunk) {
    chunks.push(new Uint8Array(chunk));
  },
});

const proc = Bun.spawn({
  cmd: ["nethack"],
  env: {
    ...process.env,
    TERM: "xterm-256color",
    LC_ALL: "en_US.UTF-8",
    LANG: "en_US.UTF-8",
    COLUMNS: "80",
    LINES: "24",
    NETHACKOPTIONS: "name:agent,role:valkyrie,race:human,gender:female,align:lawful",
  },
  terminal: term,
} as Parameters<typeof Bun.spawn>[0]);

await Bun.sleep(3000);
proc.kill("SIGTERM");
await proc.exited;
term.close();

const bytes = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
await Bun.write(".tmp/probe-nethack-startup.log", bytes.toString("utf8"));
console.log(`wrote .tmp/probe-nethack-startup.log (${bytes.length} bytes)`);
```

- [ ] **Step 2: Run and commit**

```bash
cd packages/blinkyterm
bun run probe:nethack
cd ../..
git add packages/blinkyterm/scripts/probe-nethack-startup.ts
git commit -m "chore(blinkyterm): add optional NetHack startup probe"
```

---

### Task 5: Deterministic Fixtures

**Files:**
- Create: `packages/blinkyterm/test/helpers/fixture-path.ts`
- Create: `packages/blinkyterm/test/fixtures/children/*.sh`
- Create: `packages/blinkyterm/test/smoke/fixtures.test.ts`

- [ ] **Step 1: Add root-safe path helper**

```ts
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const fixtureRoot = path.resolve(here, "..", "fixtures");

export function childFixture(name: string): string {
  return path.join(fixtureRoot, "children", name);
}
```

- [ ] **Step 2: Add shell children**

`echo-and-exit.sh`:

```bash
#!/usr/bin/env bash
printf 'hello from child\r\n'
sleep 0.2
```

`wait-for-input.sh`:

```bash
#!/usr/bin/env bash
printf 'ready\r\n'
IFS= read -r line
printf 'input:%s\r\n' "$line"
```

`infinite-loop.sh`:

```bash
#!/usr/bin/env bash
trap 'exit 0' TERM
printf 'ready\r\n'
while :; do sleep 0.1; done
```

`signal-ignorant.sh`:

```bash
#!/usr/bin/env bash
trap '' TERM
printf 'ready\r\n'
while :; do sleep 0.1; done
```

`bell-and-title.sh`:

```bash
#!/usr/bin/env bash
printf '\033]0;title-one\a'
printf '\a'
printf 'paint\r\n'
sleep 0.2
```

`slow-painter.sh`:

```bash
#!/usr/bin/env bash
printf 'one\r\n'
sleep 0.05
printf 'two\r\n'
sleep 0.05
printf 'three\r\n'
sleep 0.2
```

`mini-tui.sh`:

```bash
#!/usr/bin/env bash
printf '\033[2J\033[H'
printf 'Mini TUI\r\n'
printf 'Command: '
IFS= read -r line
case "$line" in
  quit) printf '\r\nbye\r\n'; exit 0 ;;
  *) printf '\r\nyou typed:%s\r\n' "$line"; exit 0 ;;
esac
```

- [ ] **Step 3: Add fixture smoke**

```ts
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { childFixture } from "../helpers/fixture-path";

test("child fixture paths resolve from package and workspace roots", () => {
  const result = spawnSync(childFixture("echo-and-exit.sh"), { encoding: "utf8" });
  expect(result.status).toBe(0);
  expect(result.stdout).toContain("hello from child");
});
```

- [ ] **Step 4: Verify and commit**

```bash
chmod +x packages/blinkyterm/test/fixtures/children/*.sh
cd packages/blinkyterm
bun test test/smoke/fixtures.test.ts
cd ../..
bun test packages/blinkyterm/test/smoke/fixtures.test.ts
git add packages/blinkyterm/test
git commit -m "test(blinkyterm): add deterministic child fixtures"
```

---

### Task 6: Public Types

**Files:**
- Create: `packages/blinkyterm/src/types.ts`
- Modify: `packages/blinkyterm/src/index.ts`
- Create: `packages/blinkyterm/test/smoke/exports.test.ts`

- [ ] **Step 1: Write export/type test**

```ts
import { expect, test } from "bun:test";
import { Runner } from "../../src";
import type { FrameReason, FrameSnapshot, SpawnOptions } from "../../src";

test("Runner export exists", () => {
  expect(typeof Runner).toBe("function");
});

test("public type surface has expected shapes", () => {
  const reasons: FrameReason[] = [
    "initial",
    "cellChange",
    "titleChange",
    "bell",
    "cursorMove",
    "heartbeat",
    "exited",
    "crashed",
  ];
  const snapshot: FrameSnapshot = {
    text: "",
    title: "",
    cursor: { x: 0, y: 0, visible: true },
    bellsSinceLast: 0,
    titleChangesSinceLast: [],
    toAnsi: () => "",
    toHtml: () => "",
    toVt: () => "",
    cellAt: () => null,
  };
  const opts: SpawnOptions = { cols: 80, rows: 24 };
  expect(reasons).toHaveLength(8);
  expect(snapshot.cursor.visible).toBe(true);
  expect(opts.cols).toBe(80);
});
```

- [ ] **Step 2: Implement types**

```ts
import type {
  CellInfo,
  Key,
  KeyEvent,
  Mods,
  Terminal,
  RenderState,
} from "libghostty-vt";

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

export interface ClockTimer {
  clear(): void;
}

export interface Clock {
  now(): number;
  setTimeout(cb: () => void, ms: number): ClockTimer;
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

export type { CellInfo, Key, KeyEvent, Mods, Terminal, RenderState };
```

Update `src/index.ts`:

```ts
export { Runner } from "./runner";
export type {
  Clock,
  ClockTimer,
  Frame,
  FrameOptions,
  FrameReason,
  FrameSnapshot,
  SpawnOptions,
  TerminateOptions,
  WaitExitResult,
  Key,
  KeyEvent,
  Mods,
  CellInfo,
  Terminal,
  RenderState,
} from "./types";
export { EncodeError } from "libghostty-vt";
```

- [ ] **Step 3: Verify and commit**

```bash
cd packages/blinkyterm
bun test test/smoke/exports.test.ts
bun run typecheck
cd ../..
git add packages/blinkyterm/src/types.ts packages/blinkyterm/src/index.ts packages/blinkyterm/test/smoke/exports.test.ts
git commit -m "feat(blinkyterm): define public type surface"
```

---

### Task 7: Error Classes

**Files:**
- Create: `packages/blinkyterm/src/errors.ts`
- Modify: `packages/blinkyterm/src/index.ts`
- Create: `packages/blinkyterm/test/smoke/errors.test.ts`

- [ ] **Step 1: Add tests**

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

test("errors have stable names and codes", () => {
  expect(new SpawnError("nope").code).toBe("spawn_failed");
  expect(new FirstFrameTimeoutError(25)).toBeInstanceOf(SpawnError);
  expect(new FirstFrameTimeoutError(25).code).toBe("first_frame_timeout");
  expect(new ExitedError("sendText").code).toBe("exited");
  expect(new DisposedError("Runner").code).toBe("disposed");
  expect(new IteratorInUseError().code).toBe("iterator_in_use");
});

test("all blinkyterm errors share one base", () => {
  expect(new ExitedError("sendText")).toBeInstanceOf(BlinkyTermError);
});
```

- [ ] **Step 2: Implement**

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

Update `src/index.ts` to export all error classes.

- [ ] **Step 3: Verify and commit**

```bash
cd packages/blinkyterm
bun test test/smoke/errors.test.ts
bun run typecheck
cd ../..
git add packages/blinkyterm/src/errors.ts packages/blinkyterm/src/index.ts packages/blinkyterm/test/smoke/errors.test.ts
git commit -m "feat(blinkyterm): add error taxonomy"
```

---

### Task 8: Deferred Helper

**Files:**
- Create: `packages/blinkyterm/src/internal/deferred.ts`
- Create: `packages/blinkyterm/test/smoke/deferred.test.ts`

- [ ] **Step 1: Test**

```ts
import { expect, test } from "bun:test";
import { makeDeferred } from "../../src/internal/deferred";

test("deferred resolves only when resolve is called", async () => {
  const d = makeDeferred<void>();
  let done = false;
  d.promise.then(() => { done = true; });
  await Bun.sleep(0);
  expect(done).toBe(false);
  d.resolve();
  await d.promise;
  expect(done).toBe(true);
});

test("distinct deferreds do not share state", async () => {
  const a = makeDeferred<void>();
  const b = makeDeferred<void>();
  let bDone = false;
  b.promise.then(() => { bDone = true; });
  a.resolve();
  await a.promise;
  await Bun.sleep(0);
  expect(bDone).toBe(false);
});
```

- [ ] **Step 2: Implement**

```ts
export interface Deferred<T = void> {
  readonly promise: Promise<T>;
  resolve(value?: T | PromiseLike<T>): void;
  reject(reason?: unknown): void;
}

export function makeDeferred<T = void>(): Deferred<T> {
  let resolve!: (value?: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = (value) => res(value as T | PromiseLike<T>);
    reject = rej;
  });
  return { promise, resolve, reject };
}
```

- [ ] **Step 3: Verify and commit**

```bash
cd packages/blinkyterm
bun test test/smoke/deferred.test.ts
bun run typecheck
cd ../..
git add packages/blinkyterm/src/internal/deferred.ts packages/blinkyterm/test/smoke/deferred.test.ts
git commit -m "feat(blinkyterm): add deferred helper"
```

---

### Task 9: Clock and Fake Clock

**Files:**
- Create: `packages/blinkyterm/src/internal/clock.ts`
- Create: `packages/blinkyterm/test/smoke/clock.test.ts`

- [ ] **Step 1: Test**

```ts
import { expect, test } from "bun:test";
import { createFakeClock } from "../../src/internal/clock";

test("fake clock fires timers in due order", () => {
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

- [ ] **Step 2: Implement**

```ts
import type { Clock } from "../types";

export const realClock: Clock = {
  now: () => Date.now(),
  setTimeout(cb, ms) {
    const timer = setTimeout(cb, ms);
    return { clear: () => clearTimeout(timer) };
  },
};

interface FakeTimer {
  id: number;
  due: number;
  cb: () => void;
  cleared: boolean;
}

export function createFakeClock(start = 0): Clock & { advance(ms: number): void } {
  let now = start;
  let nextId = 1;
  const timers: FakeTimer[] = [];
  return {
    now: () => now,
    setTimeout(cb, ms) {
      const timer: FakeTimer = { id: nextId++, due: now + ms, cb, cleared: false };
      timers.push(timer);
      return { clear: () => { timer.cleared = true; } };
    },
    advance(ms) {
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
}
```

- [ ] **Step 3: Export, verify, commit**

Update `src/index.ts` to export `realClock` and `createFakeClock`.

```bash
cd packages/blinkyterm
bun test test/smoke/clock.test.ts
bun run typecheck
cd ../..
git add packages/blinkyterm/src/internal/clock.ts packages/blinkyterm/src/index.ts packages/blinkyterm/test/smoke/clock.test.ts
git commit -m "feat(blinkyterm): add clock injection"
```

---

### Task 10: Scheduler State and Priority

**Files:**
- Create: `packages/blinkyterm/src/internal/scheduler.ts`
- Create: `packages/blinkyterm/test/smoke/scheduler.test.ts`

- [ ] **Step 1: Test state, consume, and priority**

```ts
import { expect, test } from "bun:test";
import { createFakeClock } from "../../src/internal/clock";
import { Scheduler, priorityPick } from "../../src/internal/scheduler";

test("scheduler accumulates reasons and consume resets with fresh deferred", async () => {
  const scheduler = new Scheduler({ clock: createFakeClock() });
  scheduler.noteBell();
  scheduler.noteTitleChange("one");
  scheduler.markReady();
  await scheduler.awaitReady();
  expect(scheduler.snapshot().bellsSinceLast).toBe(1);
  expect(scheduler.snapshot().titleChangesSinceLast).toEqual(["one"]);
  scheduler.consume();
  expect(scheduler.snapshot().bellsSinceLast).toBe(0);
  expect(scheduler.snapshot().pendingReasons).toEqual([]);
});

test("priorityPick follows spec order", () => {
  expect(priorityPick(new Set(["heartbeat"]))).toBe("heartbeat");
  expect(priorityPick(new Set(["cellChange", "bell"]))).toBe("bell");
  expect(priorityPick(new Set(["cellChange", "titleChange", "exited"]))).toBe("exited");
  expect(priorityPick(new Set(["crashed", "exited"]))).toBe("crashed");
});
```

- [ ] **Step 2: Implement state-only scheduler**

```ts
import type { Clock, FrameReason } from "../types";
import { makeDeferred, type Deferred } from "./deferred";

export interface SchedulerSnapshot {
  pendingReasons: FrameReason[];
  bellsSinceLast: number;
  titleChangesSinceLast: string[];
  exitCode?: number;
  signal?: NodeJS.Signals;
}

const PRIORITY_ORDER: readonly FrameReason[] = [
  "crashed",
  "exited",
  "initial",
  "titleChange",
  "bell",
  "cellChange",
  "cursorMove",
  "heartbeat",
];

export function priorityPick(reasons: ReadonlySet<FrameReason>): FrameReason {
  for (const reason of PRIORITY_ORDER) {
    if (reasons.has(reason)) return reason;
  }
  return "heartbeat";
}

export class Scheduler {
  readonly #clock: Clock;
  #readyToYield = false;
  #yieldSignal: Deferred<void> = makeDeferred<void>();
  #pendingReasons = new Set<FrameReason>();
  #bellsSinceLast = 0;
  #titleChangesSinceLast: string[] = [];
  #lastYieldAt: number;
  #exitCode: number | undefined;
  #signal: NodeJS.Signals | undefined;

  constructor(opts: { clock: Clock }) {
    this.#clock = opts.clock;
    this.#lastYieldAt = this.#clock.now();
  }

  get readyToYield(): boolean {
    return this.#readyToYield;
  }

  get lastYieldAt(): number {
    return this.#lastYieldAt;
  }

  awaitReady(): Promise<void> {
    return this.#readyToYield ? Promise.resolve() : this.#yieldSignal.promise;
  }

  markReady(): void {
    if (this.#readyToYield) return;
    this.#readyToYield = true;
    this.#yieldSignal.resolve();
  }

  consume(): void {
    this.#readyToYield = false;
    this.#yieldSignal = makeDeferred<void>();
    this.#pendingReasons.clear();
    this.#bellsSinceLast = 0;
    this.#titleChangesSinceLast = [];
    this.#lastYieldAt = this.#clock.now();
  }

  snapshot(): SchedulerSnapshot {
    const snap: SchedulerSnapshot = {
      pendingReasons: [...this.#pendingReasons],
      bellsSinceLast: this.#bellsSinceLast,
      titleChangesSinceLast: [...this.#titleChangesSinceLast],
    };
    if (this.#exitCode !== undefined) snap.exitCode = this.#exitCode;
    if (this.#signal !== undefined) snap.signal = this.#signal;
    return snap;
  }

  pendingReasonSet(): ReadonlySet<FrameReason> {
    return this.#pendingReasons;
  }

  noteInitial(): void { this.#pendingReasons.add("initial"); }
  noteCellChange(): void { this.#pendingReasons.add("cellChange"); }
  noteCursorMove(): void { this.#pendingReasons.add("cursorMove"); }
  noteHeartbeat(): void { this.#pendingReasons.add("heartbeat"); }
  noteBell(): void { this.#bellsSinceLast += 1; this.#pendingReasons.add("bell"); }
  noteTitleChange(title: string): void {
    this.#titleChangesSinceLast.push(title);
    this.#pendingReasons.add("titleChange");
  }
  noteExit(result: { exitCode?: number; signal?: NodeJS.Signals }): void {
    if (result.signal !== undefined) this.#pendingReasons.add("crashed");
    else this.#pendingReasons.add("exited");
    this.#exitCode = result.exitCode;
    this.#signal = result.signal;
    this.markReady();
  }
}
```

- [ ] **Step 3: Verify and commit**

```bash
cd packages/blinkyterm
bun test test/smoke/scheduler.test.ts
bun run typecheck
cd ../..
git add packages/blinkyterm/src/internal/scheduler.ts packages/blinkyterm/test/smoke/scheduler.test.ts
git commit -m "feat(blinkyterm): add scheduler state and priority"
```

---

### Task 11: Scheduler Timers

**Files:**
- Modify: `packages/blinkyterm/src/internal/scheduler.ts`
- Modify: `packages/blinkyterm/test/smoke/scheduler.test.ts`

- [ ] **Step 1: Add fake-clock timer tests**

```ts
test("quiesce callback runs after quiet period and can mark ready", async () => {
  const clock = createFakeClock();
  const scheduler = new Scheduler({
    clock,
    frame: { quiesceMs: 100, minIntervalMs: 0, maxIntervalMs: 30000 },
  });
  scheduler.onQuiesce(() => scheduler.noteCellChange());
  scheduler.notePtyChunk();
  clock.advance(50);
  expect(scheduler.readyToYield).toBe(false);
  scheduler.notePtyChunk();
  clock.advance(99);
  expect(scheduler.readyToYield).toBe(false);
  clock.advance(1);
  await scheduler.awaitReady();
  expect(scheduler.snapshot().pendingReasons).toContain("cellChange");
});

test("heartbeat bypasses yieldOn", async () => {
  const clock = createFakeClock();
  const scheduler = new Scheduler({
    clock,
    frame: { quiesceMs: 100, minIntervalMs: 1000, maxIntervalMs: 3000, yieldOn: [] },
  });
  clock.advance(3000);
  await scheduler.awaitReady();
  expect(scheduler.snapshot().pendingReasons).toEqual(["heartbeat"]);
});

test("terminal reason bypasses min interval", async () => {
  const clock = createFakeClock();
  const scheduler = new Scheduler({
    clock,
    frame: { quiesceMs: 100, minIntervalMs: 10000, maxIntervalMs: 30000 },
  });
  scheduler.noteExit({ exitCode: 0 });
  await scheduler.awaitReady();
  expect(priorityPick(scheduler.pendingReasonSet())).toBe("exited");
});
```

- [ ] **Step 2: Extend implementation**

Add constructor options:

```ts
import type { Clock, ClockTimer, FrameOptions, FrameReason } from "../types";

const DEFAULT_FRAME_OPTIONS: Required<FrameOptions> = {
  minIntervalMs: 1000,
  maxIntervalMs: 30000,
  quiesceMs: 100,
  yieldOn: ["cellChange", "titleChange", "bell"],
};
```

Extend `Scheduler` with:

```ts
readonly #frame: Required<FrameOptions>;
#quiesceTimer: ClockTimer | null = null;
#heartbeatTimer: ClockTimer | null = null;
#minIntervalTimer: ClockTimer | null = null;
#onQuiesce: (() => void) | null = null;

constructor(opts: { clock: Clock; frame?: FrameOptions }) {
  this.#clock = opts.clock;
  this.#frame = { ...DEFAULT_FRAME_OPTIONS, ...(opts.frame ?? {}) };
  this.#lastYieldAt = this.#clock.now();
  this.#restartHeartbeat();
}

onQuiesce(cb: () => void): void {
  this.#onQuiesce = cb;
}

notePtyChunk(): void {
  this.#quiesceTimer?.clear();
  this.#quiesceTimer = this.#clock.setTimeout(() => {
    this.#quiesceTimer = null;
    this.#onQuiesce?.();
    this.maybeYield();
  }, this.#frame.quiesceMs);
}

maybeYield(): void {
  if (this.#readyToYield) return;
  const reasons = this.#pendingReasons;
  if (reasons.size === 0) return;

  const bypass =
    reasons.has("initial") ||
    reasons.has("heartbeat") ||
    reasons.has("exited") ||
    reasons.has("crashed");

  if (!bypass) {
    const allowed = new Set(this.#frame.yieldOn);
    if (![...reasons].some((reason) => allowed.has(reason))) return;
  }

  if (!bypass) {
    const sinceLast = this.#clock.now() - this.#lastYieldAt;
    if (sinceLast < this.#frame.minIntervalMs) {
      if (this.#minIntervalTimer === null) {
        this.#minIntervalTimer = this.#clock.setTimeout(() => {
          this.#minIntervalTimer = null;
          this.maybeYield();
        }, this.#frame.minIntervalMs - sinceLast);
      }
      return;
    }
  }

  this.markReady();
}

dispose(): void {
  this.#quiesceTimer?.clear();
  this.#heartbeatTimer?.clear();
  this.#minIntervalTimer?.clear();
  this.#quiesceTimer = null;
  this.#heartbeatTimer = null;
  this.#minIntervalTimer = null;
}

#restartHeartbeat(): void {
  this.#heartbeatTimer?.clear();
  this.#heartbeatTimer = this.#clock.setTimeout(() => {
    this.#heartbeatTimer = null;
    this.noteHeartbeat();
    this.maybeYield();
  }, this.#frame.maxIntervalMs);
}
```

Update `consume()` to call `#restartHeartbeat()`.

- [ ] **Step 3: Verify and commit**

```bash
cd packages/blinkyterm
bun test test/smoke/scheduler.test.ts
bun run typecheck
cd ../..
git add packages/blinkyterm/src/internal/scheduler.ts packages/blinkyterm/test/smoke/scheduler.test.ts
git commit -m "feat(blinkyterm): add scheduler timers"
```

---

### Task 12: Frozen Snapshot Builder

**Files:**
- Create: `packages/blinkyterm/src/internal/snapshot.ts`
- Create: `packages/blinkyterm/test/smoke/snapshot.test.ts`

- [ ] **Step 1: Test frozen behavior**

```ts
import { expect, test } from "bun:test";
import { RenderState, Terminal } from "libghostty-vt";
import { buildFrameSnapshot } from "../../src/internal/snapshot";

const enc = new TextEncoder();

test("snapshot text and cells stay frozen after terminal mutation", () => {
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
  expect(snap.toAnsi()).toContain("alpha");
  expect(snap.toHtml()).toContain("alpha");
  expect(snap.cellAt(0, 0)?.text).toBe("a");
  expect(snap.bellsSinceLast).toBe(1);
  expect(snap.titleChangesSinceLast).toEqual(["first"]);
  expect(Object.isFrozen(snap)).toBe(true);
  expect(Object.isFrozen(snap.cursor)).toBe(true);
});
```

- [ ] **Step 2: Implement eager capture**

```ts
import { Formatter, type RenderCell, type RenderState, type Terminal } from "libghostty-vt";
import type { CellInfo, FrameSnapshot } from "../types";

interface BuildFrameSnapshotOptions {
  terminal: Terminal;
  renderState: RenderState;
  bellsSinceLast: number;
  titleChangesSinceLast: readonly string[];
}

interface FrozenCell extends CellInfo {
  readonly x: number;
  readonly y: number;
}

function copyCell(cell: RenderCell, y: number): FrozenCell {
  const out: FrozenCell = Object.freeze({
    x: cell.x,
    y,
    text: cell.text,
    wide: cell.wide,
    isWideContinuation: cell.isWideContinuation,
    ...(cell.style !== undefined ? { style: Object.freeze({ ...cell.style }) } : {}),
    ...(cell.hyperlinkUri !== undefined ? { hyperlinkUri: cell.hyperlinkUri } : {}),
    protected: cell.protected,
  });
  return out;
}

export function buildFrameSnapshot(opts: BuildFrameSnapshotOptions): FrameSnapshot {
  const termSnap = opts.terminal.snapshot();
  const text = new Formatter({ format: "plain" }).formatString(opts.terminal);
  const vt = new Formatter({ format: "vt", style: true, cursor: true }).formatString(opts.terminal);
  const html = new Formatter({ format: "html", style: true, hyperlink: true }).formatString(opts.terminal);
  const rows = new Map<number, FrozenCell[]>();
  for (const row of opts.renderState.rows()) {
    rows.set(row.y, [...row.cells()].map((cell) => copyCell(cell, row.y)));
  }

  const cursor = Object.freeze({
    x: termSnap.cursor.x,
    y: termSnap.cursor.y,
    visible: termSnap.cursor.visible,
  });
  const titleChangesSinceLast = Object.freeze([...opts.titleChangesSinceLast]);

  const snapshot: FrameSnapshot = {
    text,
    title: termSnap.title ?? "",
    cursor,
    bellsSinceLast: opts.bellsSinceLast,
    titleChangesSinceLast,
    toAnsi: () => vt,
    toHtml: () => html,
    toVt: () => vt,
    cellAt(x, y) {
      const cell = rows.get(y)?.find((candidate) => candidate.x === x);
      return cell ?? null;
    },
  };
  return Object.freeze(snapshot);
}
```

This intentionally captures `html` and `vt` eagerly. If this becomes too expensive, add a native clone API in `libghostty-vt`; do not make old frames read live terminal state.

- [ ] **Step 3: Verify and commit**

```bash
cd packages/blinkyterm
bun test test/smoke/snapshot.test.ts
bun run typecheck
cd ../..
git add packages/blinkyterm/src/internal/snapshot.ts packages/blinkyterm/test/smoke/snapshot.test.ts
git commit -m "feat(blinkyterm): add frozen frame snapshots"
```

---

### Task 13: Write Queue

**Files:**
- Create: `packages/blinkyterm/src/internal/write-queue.ts`
- Create: `packages/blinkyterm/test/smoke/write-queue.test.ts`

- [ ] **Step 1: Test queue behavior with fake pty**

```ts
import { expect, test } from "bun:test";
import { WriteQueue } from "../../src/internal/write-queue";

test("WriteQueue serializes writes and handles partial writes", async () => {
  const written: string[] = [];
  const pty = {
    write(bytes: Uint8Array) {
      const take = Math.min(1, bytes.length);
      written.push(new TextDecoder().decode(bytes.subarray(0, take)));
      return take;
    },
  };
  const q = new WriteQueue(pty);
  await Promise.all([
    q.write(new TextEncoder().encode("ab")),
    q.write(new TextEncoder().encode("cd")),
  ]);
  expect(written.join("")).toBe("abcd");
});

test("WriteQueue waits for drain on zero progress", async () => {
  let blocked = true;
  const pty = {
    write(bytes: Uint8Array) {
      if (blocked) return 0;
      return bytes.length;
    },
  };
  const q = new WriteQueue(pty);
  const p = q.write(new TextEncoder().encode("x"));
  await Bun.sleep(0);
  blocked = false;
  q.notifyDrain();
  await p;
  expect(true).toBe(true);
});
```

- [ ] **Step 2: Implement**

```ts
import { DisposedError } from "../errors";
import { makeDeferred, type Deferred } from "./deferred";

interface WritablePty {
  write(bytes: Uint8Array): number | void;
}

export class WriteQueue {
  readonly #pty: WritablePty;
  #tail: Promise<void> = Promise.resolve();
  #drain: Deferred<void> | null = null;
  #disposed = false;

  constructor(pty: WritablePty) {
    this.#pty = pty;
  }

  write(bytes: Uint8Array): Promise<void> {
    if (this.#disposed) return Promise.reject(new DisposedError("WriteQueue"));
    const copy = new Uint8Array(bytes);
    const run = this.#tail.then(() => this.#writeAll(copy));
    this.#tail = run.catch(() => {});
    return run;
  }

  notifyDrain(): void {
    this.#drain?.resolve();
    this.#drain = null;
  }

  dispose(): void {
    this.#disposed = true;
    this.#drain?.reject(new DisposedError("WriteQueue"));
    this.#drain = null;
  }

  async #writeAll(bytes: Uint8Array): Promise<void> {
    let offset = 0;
    while (offset < bytes.length) {
      if (this.#disposed) throw new DisposedError("WriteQueue");
      const chunk = bytes.subarray(offset);
      const ret = this.#pty.write(chunk);
      const n = typeof ret === "number" ? ret : chunk.length;
      if (n <= 0) {
        await this.#awaitDrain();
      } else {
        offset += n;
        if (n < chunk.length) await this.#awaitDrain();
      }
    }
  }

  #awaitDrain(): Promise<void> {
    if (this.#drain === null) this.#drain = makeDeferred<void>();
    return this.#drain.promise;
  }
}
```

- [ ] **Step 3: Verify and commit**

```bash
cd packages/blinkyterm
bun test test/smoke/write-queue.test.ts
bun run typecheck
cd ../..
git add packages/blinkyterm/src/internal/write-queue.ts packages/blinkyterm/test/smoke/write-queue.test.ts
git commit -m "feat(blinkyterm): add serialized write queue"
```

---

### Task 14: US Layout Helper

**Files:**
- Create: `packages/blinkyterm/src/internal/us-layout.ts`
- Create: `packages/blinkyterm/test/smoke/us-layout.test.ts`

- [ ] **Step 1: Test printable key mapping**

```ts
import { expect, test } from "bun:test";
import { eventFromUsLayout } from "../../src/internal/us-layout";

test("letters map to utf8 and unshifted codepoint", () => {
  expect(eventFromUsLayout("KeyA")).toEqual({
    key: "KeyA",
    utf8: "a",
    unshiftedCodepoint: 0x61,
  });
  expect(eventFromUsLayout("KeyA", { shift: true })).toEqual({
    key: "KeyA",
    mods: { shift: true },
    utf8: "A",
    unshiftedCodepoint: 0x61,
  });
});

test("non-printable keys omit utf8", () => {
  expect(eventFromUsLayout("ArrowUp")).toEqual({ key: "ArrowUp" });
});
```

- [ ] **Step 2: Implement**

```ts
import type { Key, KeyEvent, Mods } from "libghostty-vt";

const shiftedDigits: Record<string, string> = {
  Digit1: "!",
  Digit2: "@",
  Digit3: "#",
  Digit4: "$",
  Digit5: "%",
  Digit6: "^",
  Digit7: "&",
  Digit8: "*",
  Digit9: "(",
  Digit0: ")",
};

const punctuation: Record<string, [normal: string, shifted: string]> = {
  Minus: ["-", "_"],
  Equal: ["=", "+"],
  BracketLeft: ["[", "{"],
  BracketRight: ["]", "}"],
  Backslash: ["\\", "|"],
  Semicolon: [";", ":"],
  Quote: ["'", "\""],
  Backquote: ["`", "~"],
  Comma: [",", "<"],
  Period: [".", ">"],
  Slash: ["/", "?"],
};

export function eventFromUsLayout(key: Key, mods?: Mods): KeyEvent {
  const shift = mods?.shift === true;
  const base: KeyEvent = { key, ...(mods !== undefined ? { mods } : {}) };
  if (/^Key[A-Z]$/.test(key)) {
    const lower = key.slice(3).toLowerCase();
    return {
      ...base,
      utf8: shift ? lower.toUpperCase() : lower,
      unshiftedCodepoint: lower.codePointAt(0)!,
    };
  }
  if (/^Digit[0-9]$/.test(key)) {
    const digit = key.slice(5);
    return {
      ...base,
      utf8: shift ? shiftedDigits[key]! : digit,
      unshiftedCodepoint: digit.codePointAt(0)!,
    };
  }
  if (key === "Space") {
    return { ...base, utf8: " ", unshiftedCodepoint: 0x20 };
  }
  const punct = punctuation[key];
  if (punct !== undefined) {
    return {
      ...base,
      utf8: shift ? punct[1] : punct[0],
      unshiftedCodepoint: punct[0].codePointAt(0)!,
    };
  }
  return base;
}
```

- [ ] **Step 3: Verify and commit**

```bash
cd packages/blinkyterm
bun test test/smoke/us-layout.test.ts
bun run typecheck
cd ../..
git add packages/blinkyterm/src/internal/us-layout.ts packages/blinkyterm/test/smoke/us-layout.test.ts
git commit -m "feat(blinkyterm): add US layout key helper"
```

---

### Task 15: Runner Resource Wiring

**Files:**
- Modify: `packages/blinkyterm/src/runner.ts`
- Create: `packages/blinkyterm/test/smoke/runner.spawn.test.ts`

- [ ] **Step 1: Test spawn and disposal**

```ts
import { expect, test } from "bun:test";
import { Runner, SpawnError } from "../../src";
import { childFixture } from "../helpers/fixture-path";

test("Runner.spawn allocates a running runner", async () => {
  await using runner = await Runner.spawn([childFixture("echo-and-exit.sh")], {
    firstFrameTimeoutMs: 1000,
  });
  expect(runner.pid).toBeGreaterThan(0);
  expect(runner.terminal.snapshot().cols).toBe(80);
});

test("missing command rejects with SpawnError", async () => {
  await expect(Runner.spawn(["/definitely/not/a/command"])).rejects.toThrow(SpawnError);
});

test("async dispose is idempotent", async () => {
  const runner = await Runner.spawn([childFixture("infinite-loop.sh")]);
  await runner[Symbol.asyncDispose]();
  await runner[Symbol.asyncDispose]();
  expect(runner.disposed).toBe(true);
});
```

- [ ] **Step 2: Implement Runner core**

Implementation requirements:
- owns `#pty`, `#proc`, `#terminal`, `#renderState`, `#encoder`, `#scheduler`, and `#writeQueue`;
- registers `Terminal` callbacks:
  - `onWritePty`: `writeQueue.write(bytes).catch(() => {})`;
  - `onBell`: `scheduler.noteBell(); scheduler.maybeYield();`;
  - `onTitleChanged`: `scheduler.noteTitleChange(title); scheduler.maybeYield();`;
- `Bun.Terminal.data`: mark first byte, `terminal.vtWrite(chunk)`, `scheduler.notePtyChunk()`;
- `Bun.Terminal.drain`: `writeQueue.notifyDrain()`;
- `proc.exited` latches `exitCode`/`signalCode` and calls `scheduler.noteExit(...)`;
- scheduler `onQuiesce`: `renderState.update(terminal)`, if dirty then `scheduler.noteCellChange()`, then `scheduler.maybeYield()`;
- async dispose order: scheduler timers, write queue, SIGKILL child if alive, wait up to 2s, close pty, dispose `RenderState`, `KeyEncoder`, `Terminal`;
- getters `terminal` and `renderState` throw `DisposedError` after dispose.

Do not add frame iterator or send methods yet.

- [ ] **Step 3: Verify and commit**

```bash
cd packages/blinkyterm
bun test test/smoke/runner.spawn.test.ts
bun run typecheck
cd ../..
git add packages/blinkyterm/src/runner.ts packages/blinkyterm/test/smoke/runner.spawn.test.ts
git commit -m "feat(blinkyterm): wire Runner resources"
```

---

### Task 16: First Frame Timeout

**Files:**
- Modify: `packages/blinkyterm/src/runner.ts`
- Modify: `packages/blinkyterm/test/smoke/runner.spawn.test.ts`

- [ ] **Step 1: Add tests**

```ts
test("silent child rejects with FirstFrameTimeoutError", async () => {
  await expect(Runner.spawn(["bash", "-lc", "sleep 1"], {
    firstFrameTimeoutMs: 50,
  })).rejects.toThrow("initial frame");
});

test("child that exits before output also rejects with FirstFrameTimeoutError", async () => {
  await expect(Runner.spawn(["bash", "-lc", "exit 0"], {
    firstFrameTimeoutMs: 50,
  })).rejects.toThrow("initial frame");
});
```

- [ ] **Step 2: Implement handshake**

`Runner.spawn` must not resolve until the scheduler is ready for an initial frame. On first pty data:
- call `scheduler.noteInitial()` exactly once;
- after quiesce/render-state dirty check, `scheduler.maybeYield()` should mark ready.

Race initial readiness against `firstFrameTimeoutMs`. Terminal `exited`/`crashed` readiness must not satisfy this handshake before the initial snapshot exists. If the child exits before any pty data, call the partial cleanup path and throw `FirstFrameTimeoutError`. If it exits after pty data but before quiesce fires, perform the same render/dirty finalize path once so the first iterator frame is still `reason: "initial"`, followed by the terminal frame.

- [ ] **Step 3: Verify and commit**

```bash
cd packages/blinkyterm
bun test test/smoke/runner.spawn.test.ts
bun run typecheck
cd ../..
git add packages/blinkyterm/src/runner.ts packages/blinkyterm/test/smoke/runner.spawn.test.ts
git commit -m "feat(blinkyterm): enforce first-frame timeout"
```

---

### Task 17: Frame Iterator

**Files:**
- Modify: `packages/blinkyterm/src/runner.ts`
- Create: `packages/blinkyterm/test/smoke/runner.frames.test.ts`

- [ ] **Step 1: Add iterator tests**

```ts
import { expect, test } from "bun:test";
import { IteratorInUseError, Runner } from "../../src";
import { childFixture } from "../helpers/fixture-path";

test("frames yields initial frame", async () => {
  await using runner = await Runner.spawn([childFixture("echo-and-exit.sh")]);
  const it = runner.frames()[Symbol.asyncIterator]();
  const first = await it.next();
  expect(first.done).toBe(false);
  expect(first.value.reason).toBe("initial");
  expect(first.value.snapshot.text).toContain("hello from child");
});

test("terminal frame is delivered once then iterator is done", async () => {
  await using runner = await Runner.spawn([childFixture("echo-and-exit.sh")]);
  const it = runner.frames()[Symbol.asyncIterator]();
  let sawTerminal = false;
  for (;;) {
    const next = await it.next();
    if (next.done) break;
    if (next.value.reason === "exited" || next.value.reason === "crashed") {
      sawTerminal = true;
      const done = await it.next();
      expect(done.done).toBe(true);
      break;
    }
  }
  expect(sawTerminal).toBe(true);
});

test("only one iterator may be active", async () => {
  await using runner = await Runner.spawn([childFixture("infinite-loop.sh")]);
  const iter = runner.frames()[Symbol.asyncIterator]();
  expect(() => runner.frames()).toThrow(IteratorInUseError);
  await iter.return?.();
});
```

- [ ] **Step 2: Implement custom iterator**

Requirements:
- no `async function*`;
- `frames()` throws `IteratorInUseError` if one iterator is active;
- `next()` waits for `scheduler.awaitReady()`;
- finalization block has no await between:
  - `renderState.update(terminal)`;
  - build frozen snapshot;
  - pick reason via `priorityPick`;
  - `renderState.markClean()`;
  - `scheduler.consume()`;
- terminal reason returns `{ done: false, value: frame }`, and the next `next()` returns done;
- `return()` releases the active iterator.

- [ ] **Step 3: Verify and commit**

```bash
cd packages/blinkyterm
bun test test/smoke/runner.frames.test.ts
bun run typecheck
cd ../..
git add packages/blinkyterm/src/runner.ts packages/blinkyterm/test/smoke/runner.frames.test.ts
git commit -m "feat(blinkyterm): implement frame iterator"
```

---

### Task 18: sendBytes and sendText

**Files:**
- Modify: `packages/blinkyterm/src/runner.ts`
- Create: `packages/blinkyterm/test/smoke/runner.send.test.ts`

- [ ] **Step 1: Test bytes and text**

```ts
import { expect, test } from "bun:test";
import { ExitedError, Runner } from "../../src";
import { childFixture } from "../helpers/fixture-path";

test("sendText round-trips through child", async () => {
  await using runner = await Runner.spawn([childFixture("wait-for-input.sh")]);
  const iter = runner.frames()[Symbol.asyncIterator]();
  await iter.next();
  await runner.sendText("hello\n");
  let saw = false;
  for (;;) {
    const next = await iter.next();
    if (next.done) break;
    if (next.value.snapshot.text.includes("input:hello")) saw = true;
    if (next.value.reason === "exited") break;
  }
  expect(saw).toBe(true);
});

test("sendBytes after exit throws ExitedError", async () => {
  const runner = await Runner.spawn([childFixture("echo-and-exit.sh")]);
  await runner.waitExit();
  await expect(runner.sendBytes(new Uint8Array([1]))).rejects.toThrow(ExitedError);
  await runner[Symbol.asyncDispose]();
});
```

- [ ] **Step 2: Implement**

```ts
sendBytes(bytes: Uint8Array): Promise<void>;
sendText(text: string): Promise<void>;
```

Both assert not disposed and not exited. `sendBytes` calls `#writeQueue.write(bytes)`. `sendText` encodes raw UTF-8 and deliberately does not use `KeyEncoder`; C0 controls pass through.

- [ ] **Step 3: Verify and commit**

```bash
cd packages/blinkyterm
bun test test/smoke/runner.send.test.ts
bun run typecheck
cd ../..
git add packages/blinkyterm/src/runner.ts packages/blinkyterm/test/smoke/runner.send.test.ts
git commit -m "feat(blinkyterm): add sendBytes and sendText"
```

---

### Task 19: sendKey and sendKeyEvent

**Files:**
- Modify: `packages/blinkyterm/src/runner.ts`
- Modify: `packages/blinkyterm/test/smoke/runner.send.test.ts`

- [ ] **Step 1: Add key tests**

```ts
test("sendKey maps printable US-layout key", async () => {
  await using runner = await Runner.spawn([childFixture("wait-for-input.sh")]);
  const iter = runner.frames()[Symbol.asyncIterator]();
  await iter.next();
  await runner.sendKey("KeyA");
  await runner.sendKey("Enter");
  let saw = false;
  for (;;) {
    const next = await iter.next();
    if (next.done) break;
    if (next.value.snapshot.text.includes("input:a")) saw = true;
    if (next.value.reason === "exited") break;
  }
  expect(saw).toBe(true);
});

test("sendKeyEvent propagates EncodeError for invalid utf8", async () => {
  await using runner = await Runner.spawn([childFixture("infinite-loop.sh")]);
  await expect(runner.sendKeyEvent({ key: "Enter", utf8: "\r" })).rejects.toThrow("forbidden");
});
```

- [ ] **Step 2: Implement**

```ts
sendKeyEvent(event: KeyEvent): Promise<void> {
  this.#assertRunning("sendKeyEvent");
  return this.sendBytes(this.#encoder.encode(event));
}

sendKey(key: Key, mods?: Mods): Promise<void> {
  return this.sendKeyEvent(eventFromUsLayout(key, mods));
}
```

Import `eventFromUsLayout` from `src/internal/us-layout.ts`.

- [ ] **Step 3: Verify and commit**

```bash
cd packages/blinkyterm
bun test test/smoke/runner.send.test.ts
bun run typecheck
cd ../..
git add packages/blinkyterm/src/runner.ts packages/blinkyterm/test/smoke/runner.send.test.ts
git commit -m "feat(blinkyterm): add key sending helpers"
```

---

### Task 20: waitExit, terminate, resize

**Files:**
- Modify: `packages/blinkyterm/src/runner.ts`
- Create: `packages/blinkyterm/test/smoke/runner.lifecycle.test.ts`

- [ ] **Step 1: Add lifecycle tests**

```ts
import { expect, test } from "bun:test";
import { ExitedError, Runner } from "../../src";
import { childFixture } from "../helpers/fixture-path";

test("waitExit returns false on timeout and true after exit", async () => {
  const runner = await Runner.spawn([childFixture("infinite-loop.sh")]);
  expect(await runner.waitExit({ timeoutMs: 20 })).toEqual({ exited: false });
  await runner.terminate();
  const result = await runner.waitExit();
  expect(result.exited).toBe(true);
  await runner[Symbol.asyncDispose]();
});

test("terminate escalates to SIGKILL", async () => {
  const runner = await Runner.spawn([childFixture("signal-ignorant.sh")]);
  await runner.terminate({ thenAfterMs: 50 });
  const result = await runner.waitExit();
  expect(result.exited).toBe(true);
  expect(result.signal).toBe("SIGKILL");
  await runner[Symbol.asyncDispose]();
});

test("resize updates VT geometry and throws after exit", async () => {
  const runner = await Runner.spawn([childFixture("infinite-loop.sh")]);
  await runner.resize(100, 40);
  expect(runner.terminal.snapshot().cols).toBe(100);
  await runner.terminate();
  await expect(runner.resize(80, 24)).rejects.toThrow(ExitedError);
  await runner[Symbol.asyncDispose]();
});
```

- [ ] **Step 2: Implement**

`waitExit`:
- returns latched result if already exited;
- no timeout waits forever;
- timeout races and returns `{ exited: false }` without closing iterator.

`terminate`:
- default `SIGTERM`;
- if `thenAfterMs` set, escalate to `SIGKILL` if still alive;
- double terminate returns the same active promise.

`resize`:
- assert running;
- call `pty.resize(cols, rows)`;
- call `terminal.resize(cols, rows, opts.cellPx)`;
- mark `cellChange` and `maybeYield`.

- [ ] **Step 3: Verify and commit**

```bash
cd packages/blinkyterm
bun test test/smoke/runner.lifecycle.test.ts
bun run typecheck
cd ../..
git add packages/blinkyterm/src/runner.ts packages/blinkyterm/test/smoke/runner.lifecycle.test.ts
git commit -m "feat(blinkyterm): add waitExit terminate and resize"
```

---

### Task 21: End-to-End Integration Tests

**Files:**
- Create: `packages/blinkyterm/test/smoke/runner.integration.test.ts`

- [ ] **Step 1: Add canary tests**

```ts
import { expect, test } from "bun:test";
import { Runner } from "../../src";
import { childFixture } from "../helpers/fixture-path";

test("mini-tui agent loop", async () => {
  await using runner = await Runner.spawn([childFixture("mini-tui.sh")], {
    frame: { minIntervalMs: 0, quiesceMs: 50, maxIntervalMs: 60000 },
  });
  let sent = false;
  let sawReply = false;
  for await (const frame of runner.frames()) {
    if (!sent && frame.snapshot.text.includes("Command:")) {
      await runner.sendText("hello\n");
      sent = true;
    }
    if (frame.snapshot.text.includes("you typed:hello")) sawReply = true;
    if (frame.reason === "exited" || frame.reason === "crashed") break;
  }
  expect(sent).toBe(true);
  expect(sawReply).toBe(true);
});

test("bell and title surface on frame snapshot", async () => {
  await using runner = await Runner.spawn([childFixture("bell-and-title.sh")], {
    frame: { minIntervalMs: 0, quiesceMs: 50, maxIntervalMs: 60000 },
  });
  let saw = false;
  for await (const frame of runner.frames()) {
    if (frame.snapshot.bellsSinceLast > 0 && frame.snapshot.titleChangesSinceLast.includes("title-one")) {
      saw = true;
    }
    if (frame.reason === "exited") break;
  }
  expect(saw).toBe(true);
});

test("slow painter coalesces into latest frame", async () => {
  await using runner = await Runner.spawn([childFixture("slow-painter.sh")], {
    frame: { minIntervalMs: 0, quiesceMs: 120, maxIntervalMs: 60000 },
  });
  let count = 0;
  let finalText = "";
  for await (const frame of runner.frames()) {
    count += 1;
    finalText = frame.snapshot.text;
    if (frame.reason === "exited") break;
  }
  expect(finalText).toContain("three");
  expect(count).toBeLessThan(8);
});
```

- [ ] **Step 2: Verify and commit**

```bash
cd packages/blinkyterm
bun test test/smoke/runner.integration.test.ts
bun run test
bun run typecheck
cd ../..
git add packages/blinkyterm/test/smoke/runner.integration.test.ts
git commit -m "test(blinkyterm): add end-to-end runner canaries"
```

---

### Task 22: CI, Root README, and Package README

**Files:**
- Modify: `.github/workflows/ci.yml`
- Modify: `README.md`
- Modify: `packages/blinkyterm/README.md`

- [ ] **Step 1: Update CI**

Add after libghostty-vt gates:

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

- [ ] **Step 2: Update docs**

Root README should list:

```markdown
- `packages/blinkyterm` - agent-facing Runner over `Bun.Terminal` plus
  `libghostty-vt`, with async frame iteration and send helpers.
```

Package README should include:
- install/import;
- `Runner.spawn` and `frames()`;
- `sendText`, `sendKey`, `sendBytes`;
- clean quit vs `terminate`;
- frozen snapshot note;
- timing options.

- [ ] **Step 3: Verify and commit**

```bash
cd packages/blinkyterm
bun run typecheck
cd ../..
git add .github/workflows/ci.yml README.md packages/blinkyterm/README.md
git commit -m "docs(blinkyterm): add CI and README coverage"
```

---

### Task 23: NetHack Random Bot Example

**Files:**
- Create: `packages/blinkyterm/examples/shared/*.ts`
- Create: `packages/blinkyterm/examples/random-bot.ts`

- [ ] **Step 1: Add shared helpers**

`nethack-setup.ts`, `prompt-detect.ts`, `keymap.ts`, and `mulberry32.ts` should be confined to `examples/shared/` and not exported from the package.

Use these behaviors:
- `hasNethack()` uses `command -v nethack`;
- `nethackEnv()` sets `NETHACKOPTIONS`;
- `detectPrompt(snapshot)` recognizes `--More--`, `(y/n)`, death, and none;
- `toKeystroke(move)` maps `north/south/east/west/search/pickup` to NetHack keys;
- `mulberry32(seed)` gives deterministic random moves.

- [ ] **Step 2: Add random bot**

`random-bot.ts`:
- skip cleanly if NetHack is absent;
- fixed seed;
- 200 turn budget;
- handles `more`, `yn`, and death prompts;
- quits with `#quit\r y\r y\r`;
- escalates with `terminate({ thenAfterMs: 1000 })` if clean quit times out.

- [ ] **Step 3: Verify and commit**

```bash
cd packages/blinkyterm
bun run typecheck
bun examples/random-bot.ts
cd ../..
git add packages/blinkyterm/examples
git commit -m "docs(blinkyterm): add NetHack random bot example"
```

Expected runtime: either starts NetHack or prints a skip message.

---

### Task 24: LLM Command Bot Example

**Files:**
- Create: `packages/blinkyterm/examples/llm-bot.ts`
- Create: `packages/blinkyterm/examples/README.md`

Use a dependency-free external command interface:

```bash
BLINKYTERM_LLM_COMMAND='ruby -e "STDIN.read; puts %[north south east west search pickup quit].sample"' bun examples/llm-bot.ts
```

- [ ] **Step 1: Implement**

Behavior:
- skip if NetHack missing;
- skip if `BLINKYTERM_LLM_COMMAND` missing;
- pass `frame.snapshot.toAnsi()` to command stdin;
- read one move/command from stdout;
- validate known moves plus `quit`;
- use shared helpers from Task 23.

- [ ] **Step 2: Docs**

`examples/README.md` documents:
- `brew install nethack`;
- `bun examples/random-bot.ts`;
- `BLINKYTERM_LLM_COMMAND=... bun examples/llm-bot.ts`;
- examples are not CI gates.

- [ ] **Step 3: Verify and commit**

```bash
cd packages/blinkyterm
bun run typecheck
BLINKYTERM_LLM_COMMAND='printf quit' bun examples/llm-bot.ts
cd ../..
git add packages/blinkyterm/examples/llm-bot.ts packages/blinkyterm/examples/README.md
git commit -m "docs(blinkyterm): add dependency-free LLM command bot"
```

---

### Task 25: Final Verification and Release Tag

**Files:**
- Modify: `packages/blinkyterm/CHANGELOG.md`
- Create tag: `blinkyterm@0.1.0`

- [ ] **Step 1: Full verification**

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
bun test packages/blinkyterm/test/smoke
```

Expected: all pass.

- [ ] **Step 2: Example smoke**

```bash
cd packages/blinkyterm
bun examples/random-bot.ts
BLINKYTERM_LLM_COMMAND='printf quit' bun examples/llm-bot.ts
cd ../..
```

Expected: each either runs or prints documented skip.

- [ ] **Step 3: Changelog**

Ensure `packages/blinkyterm/CHANGELOG.md` includes:

```markdown
## [0.1.0] - 2026-04-25

### Added

- `Runner.spawn()` for pty-backed TUI children.
- `frames()` async iterator with frozen snapshots, quiesce, rate limiting,
  heartbeat, latest-only semantics, and terminal frames.
- `sendBytes`, `sendText`, `sendKey`, and `sendKeyEvent`.
- `waitExit`, `terminate`, `resize`, and async disposal.
- Deterministic child fixtures and NetHack examples.
```

- [ ] **Step 4: Commit and tag**

```bash
git add packages/blinkyterm/CHANGELOG.md
git commit -m "docs(changelog): blinkyterm 0.1.0"
git tag -a blinkyterm@0.1.0 -m "blinkyterm@0.1.0 - Pass 5 Runner"
git tag --list "blinkyterm@*"
git status --short
```

Expected: tag exists and tree is clean except ignored artifacts.

---

## Self-Review Checklist

- [x] **Spec coverage:** Runner API, scheduler, lifecycle, tests, CI, and examples are all mapped to tasks.
- [x] **Hybrid decisions:** Breq's probes and task granularity are included; the unsafe snapshot/key/write choices are replaced.
- [x] **Frozen snapshots:** Task 12 eagerly captures text, VT/ANSI, HTML, and cell data.
- [x] **Key semantics:** Task 14/19 add US-layout `utf8` and `unshiftedCodepoint` for printable keys.
- [x] **Write semantics:** Task 13/18 use serialized queue plus drain, not `Bun.sleep(0)` polling.
- [x] **Typecheck shape:** `tsconfig.json` emits package declarations only; `tsconfig.check.json` checks tests/examples/scripts.
- [x] **Root cwd safety:** fixture paths use `import.meta.url`.
- [x] **Examples:** NetHack random bot and LLM command bot are present, dependency-free, and skip-safe.
