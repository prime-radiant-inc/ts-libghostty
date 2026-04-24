# Agent-drives-TUI design: `blinkyterm` + KeyEncoder

**Date:** 2026-04-24
**Author:** Breq (Bob 4bb6a96b)
**Status:** Design — awaiting Codex review

## Summary

Add the plumbing needed for an autonomous agent (LLM or otherwise) to run a
real TUI program in a pty, observe its rendered screen, send keystrokes
the program understands, and exit cleanly without resorting to out-of-band
process termination. NetHack is the canonical demonstration target — it's a
robust, real-world, color-heavy, modal TUI that generates its own content —
but nothing in the design is NetHack-specific.

Two concrete deliverables:

1. **Pass 4 — `KeyEncoder`** inside `libghostty-vt`. FFI wrapper over
   libghostty's `ghostty_key_encoder_*` C API. Converts `KeyEvent` objects
   into VT byte sequences that respect the terminal's current mode state.
   Usable directly by consumers who do their own pty wiring.

2. **Pass 5 — `blinkyterm`**, a new package in this repo. Pure-TypeScript
   orchestration layer that composes `Bun.Terminal` (pty + child), the
   `libghostty-vt` Terminal (VT model), and `KeyEncoder` into a single
   `Runner` class. Provides the agent-facing async-iterator API, clean-quit
   protocol, and lifecycle management.

## Scope

**In scope:**

- Binding-layer key encoding (Pass 4)
- Runner class with `frames()` iterator, `sendText`/`sendKey`/`sendBytes`,
  two-phase clean quit, async disposal
- Frame scheduler with quiesce debounce, rate limit, change gate, heartbeat
- Error taxonomy: expected-transitions-as-frames, unexpected-states-as-throws
- Test strategy with deterministic test children and clock injection
- Working NetHack example (random-bot + LLM-bot variants)
- Repo restructure to monorepo

**Out of scope (deferred, acknowledged in §Non-goals):**

- Mouse encoding (`ghostty_mouse_encoder_*` — parallel future pass)
- Paste encoding / bracketed paste / OSC 52
- IME / composition events
- Linux / Windows / x64 platform support
- Host-terminal SIGWINCH auto-propagation
- Multiplexing (multiple child processes through one Runner)
- Agent quality / strategy (we test plumbing, not gameplay)

## 1. Architecture & packaging

### 1.1 Layers

```
┌─────────────────────────────────────────────────────────────┐
│  Agent                                                      │
│  (LLM, test harness, user code)                             │
└────────────────┬────────────────────────────────────────────┘
                 │ .frames(), .sendText/.sendKey/.sendBytes,
                 │ .waitExit(), .terminate(), .exited
                 ▼
┌─────────────────────────────────────────────────────────────┐
│  Runner (blinkyterm — Pass 5)                               │
│  ── pure TypeScript, NO FFI ──                              │
│   • owns a Bun.Terminal (pty + child lifecycle)             │
│   • owns a vt.Terminal (VT model)                           │
│   • owns a vt.KeyEncoder (keystroke → bytes)                │
│   • wires pty.data  → vt.vtWrite                            │
│   • wires vt.onWritePty → pty.write  (DA1/cursor replies)   │
│   • keeps resize in sync on both                            │
│   • quit protocol + exit-code + dispose                     │
└─────┬──────────────────┬─────────────────────────────┬──────┘
      │                  │                             │
      ▼                  ▼                             ▼
┌──────────────┐  ┌────────────────────────────────────────────┐
│ Bun.Terminal │  │  libghostty-vt binding  (Pass 1–4)         │
│  built-in    │  │  ── FFI wrappers over libghostty-vt.dylib ─│
│  pty+spawn   │  │   • Terminal                               │
│              │  │   • KeyEncoder         ← Pass 4            │
│              │  │   • RenderState, Formatter, cellAt, ...    │
└──────┬───────┘  └────────────────────┬───────────────────────┘
       │                               │ dlopen
       ▼                               ▼
┌──────────────┐            ┌──────────────────────────────────┐
│ child proc   │            │  libghostty-vt.dylib             │
│ (nethack,    │            │  (C library, Ghostty pin)        │
│  vim, top)   │            │                                  │
└──────────────┘            └──────────────────────────────────┘
```

Load-bearing properties:

1. Runner has no FFI. All dylib calls go through the binding.
2. Both `Terminal` and `KeyEncoder` are binding-layer FFI wrappers. They
   ship together (Pass 4 completes the binding for interactive use).
3. The binding is usable without Runner — differential tests feed captured
   `.vt` bytes directly into `Terminal`. Consumers parsing recorded streams
   don't pay for pty code they don't use.
4. Runner is unusable without the binding (one-way dependency).
5. `Bun.Terminal` is a Runner-only dependency. The binding stays
   Bun-runtime-agnostic beyond the FFI loader.

### 1.2 Repo layout

```
ts-libghostty/                       ← repo (renamed from ts-libghostty-vt)
  package.json                       (workspace root, private, no publish)
  tsconfig.base.json
  CLAUDE.md                          (no root CHANGELOG — per-package only)
  vendor/ghostty/                    shared pin
  prebuilds/darwin-arm64/            shared dylib
  scripts/                           shared build/probe tools
  docs/
  packages/
    libghostty-vt/
      package.json                   npm: "libghostty-vt"
      src/  test/  CHANGELOG.md
    blinkyterm/
      package.json                   npm: "blinkyterm"
      src/  test/  examples/  CHANGELOG.md
```

- The repo rename is a one-time structural change. The GitHub URL and
  clone instructions update accordingly.
- The npm package name for the binding drops the `ts-` prefix (now
  `libghostty-vt`), matching the upstream C library's name. `ts-` was
  redundant with `package.json → types`.
- Shared `vendor/`, `prebuilds/`, `scripts/`, `docs/` — the pin is a
  single source of truth for both packages.
- Bun workspaces (`workspaces: ["packages/*"]`). `bun install` at root
  hoists and symlinks.

### 1.3 Dependency graph

- `libghostty-vt` dependencies: none (as today). Bun runtime for FFI.
- `blinkyterm` dependencies: `libghostty-vt` (workspace:*). Bun runtime
  for `Bun.Terminal`. No other npm deps in the default API surface.
- Example code under `blinkyterm/examples/` may pull in `@anthropic-ai/sdk`
  for the LLM bot, declared as an `optionalDependency`.

### 1.4 Release cadence

- Binding continues from `libghostty-vt@0.3.0`. Pass 4 ships as
  `libghostty-vt@0.4.0`.
- `blinkyterm` starts at `v0.1.0`. Ships after Pass 5.
- Tags use package-prefixed form: `libghostty-vt@0.4.0` and
  `blinkyterm@0.1.0`. Each package versions independently.
- `CHANGELOG.md` per package.

### 1.5 CLAUDE.md updates

- Header revises to describe both packages and the monorepo structure.
- "Where stuff lives" section updates paths.
- New load-bearing gotcha: packaging boundary — binding has no
  `Bun.Terminal` import; orchestration has no dylib-adjacent imports.

## 2. Binding addition: Pass 4 KeyEncoder

Goal: wrap libghostty's C key encoder (`ghostty/vt/key.h`) as a TypeScript
class. Becomes part of `libghostty-vt@0.4.0`.

### 2.1 Public surface

```ts
// New exports from libghostty-vt

export interface KeyEvent {
  key: Key;                         // string union from generated.ts
  action?: "press" | "release" | "repeat";    // default: "press"
  mods?: Mods;
  text?: string;                    // literal text the key produces (for printable chars)
}

export interface Mods {
  shift?: boolean;
  ctrl?: boolean;
  alt?: boolean;
  super?: boolean;                  // Cmd/Win
  hyper?: boolean;
  meta?: boolean;
  capsLock?: boolean;
  numLock?: boolean;
}

export interface KeyEncoderOptions {
  cursorKeyMode?: "normal" | "application";
  keypadKeyMode?: "normal" | "application";
  kittyFlags?: KittyFlags;
  // rest of libghostty's encoder options as they're surfaced
}

export class KeyEncoder implements Disposable {
  constructor(opts: { terminal: Terminal } | { options?: KeyEncoderOptions });
  encode(event: KeyEvent): Uint8Array;
  syncFromTerminal(terminal: Terminal): void;  // rarely needed; auto-synced
  [Symbol.dispose](): void;
}
```

### 2.2 C-API mapping

| TypeScript | C |
|---|---|
| `new KeyEncoder({terminal})` | `ghostty_key_encoder_new()` + `ghostty_key_encoder_setopt_from_terminal()` |
| `new KeyEncoder({options})` | `ghostty_key_encoder_new()` + `ghostty_key_encoder_setopt()` per field |
| `encoder.encode(event)` | `ghostty_key_event_new(...)` → `ghostty_key_encoder_encode(...)` → buffer → `ghostty_key_event_free()` |
| `encoder.syncFromTerminal(t)` | `ghostty_key_encoder_setopt_from_terminal()` |
| `[Symbol.dispose]` | `ghostty_key_encoder_free()` |

### 2.3 Lifecycle notes

- `new KeyEncoder({terminal})` — bound mode. Each `encode()` internally
  calls `setopt_from_terminal` before encoding so it reflects live mode
  changes (DECCKM, Kitty keyboard flags). The microsecond overhead is
  below the threshold of correctness risk.
- `new KeyEncoder({options})` — standalone mode. For consumers who know
  their target state statically. No Terminal dependency.
- `encode()` returns a freshly-allocated `Uint8Array`. No buffer reuse.
- Disposal is idempotent.

### 2.4 Runner's use

Runner owns one encoder bound to its Terminal:

- `sendText(text)` — iterate chars, synthesize `KeyEvent` per char with
  `text:` field populated, encode each, concatenate bytes, write to pty.
  Going through the encoder (vs. raw byte write) keeps text correct under
  Kitty-keyboard mode or other variants that alter plain-text encoding.
- `sendKey(key, mods?)` — construct `KeyEvent{key, action:"press", mods}`,
  encode, write.
- `sendBytes(bytes)` — bypass encoder entirely. Named escape hatch.

### 2.5 Explicitly not in Pass 4

- Mouse encoding — parallel `ghostty_mouse_encoder_*` API, future pass.
- Paste / OSC 52 / bracketed paste.
- IME / composition events.

## 3. Runner API: `blinkyterm`

### 3.1 Core shape

```ts
class Runner implements AsyncDisposable {
  static spawn(argv: readonly string[], opts?: SpawnOptions): Promise<Runner>;

  readonly pid: number;
  readonly exited: boolean;
  readonly exitCode?: number;
  readonly signal?: NodeJS.Signals;

  // escape hatches for consumers who want raw access
  readonly terminal: Terminal;
  readonly renderState: RenderState;

  frames(): AsyncIterable<Frame>;

  sendText(text: string): Promise<void>;
  sendKey(key: Key, mods?: Mods): Promise<void>;
  sendBytes(bytes: Uint8Array): Promise<void>;

  resize(cols: number, rows: number): Promise<void>;
  waitExit(opts?: { timeoutMs?: number }): Promise<WaitExitResult>;
  terminate(opts?: TerminateOptions): Promise<void>;

  [Symbol.asyncDispose](): Promise<void>;
}
```

### 3.2 Options

```ts
interface SpawnOptions {
  cols?: number;                    // default 80
  rows?: number;                    // default 24
  cwd?: string;                     // default: process.cwd()
  env?: Record<string, string>;     // merged; TERM defaults to "xterm-256color"
  firstFrameTimeoutMs?: number;     // default 10_000

  frame?: FrameOptions;
  clock?: Clock;                    // default: real time (for test injection)

  // pass-through to Terminal:
  maxScrollback?: number;
  cellPx?: { width: number; height: number };
}

interface FrameOptions {
  minIntervalMs?: number;           // default 1000 (max ~1Hz frame rate)
  maxIntervalMs?: number;           // default 30_000 (heartbeat)
  quiesceMs?: number;               // default 100
  yieldOn?: readonly FrameReason[]; // default: ['cellChange', 'titleChange', 'bell']
}

interface TerminateOptions {
  signal?: NodeJS.Signals;          // default "SIGTERM"
  thenAfterMs?: number;             // if still alive, escalate after
  signal2?: NodeJS.Signals;         // default "SIGKILL"
}

interface WaitExitResult {
  exited: boolean;                  // false if timeout fired
  exitCode?: number;
  signal?: NodeJS.Signals;
}
```

### 3.3 Frame shape

```ts
type FrameReason =
  | "initial"
  | "cellChange"
  | "titleChange"
  | "bell"
  | "cursorMove"                    // opt-in via yieldOn
  | "heartbeat"
  | "exited"
  | "crashed"
  | "quitTimeout";                  // terminal reasons

interface Frame {
  readonly reason: FrameReason;
  readonly snapshot: FrameSnapshot;
  readonly exitCode?: number;       // set on terminal frames
  readonly signal?: NodeJS.Signals; // set when reason === "crashed"
}

interface FrameSnapshot {
  // eager, cheap
  readonly text: string;
  readonly title: string;
  readonly cursor: { readonly x: number; readonly y: number; readonly visible: boolean };
  readonly bellsSinceLast: number;
  readonly titleChangesSinceLast: readonly string[];

  // lazy, rich
  toAnsi(): string;                 // plain text + inline SGR (recommended for LLMs)
  toHtml(): string;                 // HTML + inline CSS (debug overlays)
  toVt(): string;                   // raw VT replay
  cellAt(x: number, y: number): CellInfo | null;
}
```

`toAnsi()` emits whichever color form the program originally used — palette
index for classical/256-color, RGB for truecolor — preserving libghostty's
faithful color representation.

**Snapshot is a frozen capture.** At yield time, Runner takes a copy of the
Terminal state sufficient to answer every accessor on `FrameSnapshot`. The
agent may hold a `Frame` reference across arbitrary awaits; `toAnsi()` /
`cellAt(x,y)` / etc. always reflect the state that was current when the
frame was yielded, not the live Terminal. Lazy methods memoize after first
call (one HTML render per frame, for consumers that call it twice).

### 3.4 Full lifecycle example

```ts
await using runner = await Runner.spawn(["nethack"], {
  cols: 80, rows: 24,
  env: { NETHACKOPTIONS: "name:agent,role:valkyrie" },
});

outer: for await (const frame of runner.frames()) {
  switch (frame.reason) {
    case "exited": case "crashed": case "quitTimeout":
      console.log(`ended: ${frame.reason}, code=${frame.exitCode}`);
      console.log(frame.snapshot.text);    // final screen
      break outer;
  }

  const move = await agent.decide(frame.snapshot.toAnsi());
  if (move === "quit") {
    await runner.sendText("#quit\r y\r y\r");
    const r = await runner.waitExit({ timeoutMs: 3000 });
    if (!r.exited) await runner.terminate({ thenAfterMs: 1000 });
    // loop closes on the child's actual terminal frame
  } else {
    await runner.sendText(move);
  }
}
```

### 3.5 State machine

```
  spawn() ──► [spawning] ─success──► [running] 
     │            │                     │
     │         failure                  │
     │            │                     ├── pty.data / sendKey (loop)
     │            ▼                     │
     │   rejects with                   ├── terminate() / waitExit()
     │   SpawnError or                  │
     │   FirstFrameTimeoutError         ├── child exits (any reason)
     │                                  │
     │                                  ▼
     │                            yields terminal frame
     │                            (exited / crashed / quitTimeout)
     │                                  │
     │                                  ▼
     │                              [exited]
     │                                  │
     │         [Symbol.asyncDispose] ───┤
     │                                  ▼
     ▼                             [disposed] (idempotent)
  any state ─────────────────────► [disposed]
```

## 4. Frame scheduler internals

### 4.1 State

```ts
interface SchedulerState {
  lastYieldAt: number;
  lastRenderDigest: string | null;
  pendingReasons: Set<FrameReason>;
  bellsSinceLast: number;
  titleChangesSinceLast: string[];
  quiesceTimer: Timer | null;
  heartbeatTimer: Timer;
  minIntervalWait: Promise<void> | null;
}
```

### 4.2 Event flow

```
child writes bytes
  └── pty.data → terminal.vtWrite(chunk)
        ├── may fire onBell        → pendingReasons += "bell", bellsSinceLast++
        ├── may fire onTitleChanged → pendingReasons += "titleChange", append to list
        └── may mutate cells       → checked via RenderState at quiesce
  └── restart quiesceTimer(quiesceMs)

quiesceTimer fires
  └── renderState.update(terminal)
        └── if dirty() !== "none": pendingReasons += "cellChange"
  └── scheduler.maybeYield()

scheduler.maybeYield()
  ├── if exitSignal resolved → yield terminal frame (iterator closes)
  ├── if now - lastYieldAt < minIntervalMs → defer to boundary
  ├── if pendingReasons ∩ yieldOn is empty → skip (no yield)
  └── else:
        ├── renderState.update(terminal)   ← ensure snapshot is current
        └── yield frame with reason = priorityPick(pendingReasons)

heartbeatTimer fires (maxIntervalMs elapsed with no yield)
  └── pendingReasons += "heartbeat" → scheduler.maybeYield()
        (note: maybeYield always refreshes renderState before snapshotting,
        so heartbeat frames during continuous-paint never carry stale state)
```

### 4.3 Reason priority

```
crashed > exited > quitTimeout              ← terminal; override everything
  > initial                                  ← first frame only
  > titleChange                              ← semantic event
  > bell                                     ← alert
  > cellChange                               ← routine paint
  > cursorMove                               ← noisy (opt-in)
  > heartbeat                                ← nothing else fired
```

Between frames, all events still accumulate into `bellsSinceLast` /
`titleChangesSinceLast` — but `frame.reason` is the single most-salient
trigger.

### 4.4 Latest-only semantics

The iterator does not buffer. If the agent thinks for 5 seconds while the
child paints 17 times, the next `next()` yields **one** frame reflecting
the current terminal state and the accumulated reasons/bells/titles from
that window. It does not yield 17 stale frames.

### 4.5 Guarantees

1. `Frame.snapshot` is frozen at yield time; values do not shift under the
   agent across await points.
2. Between frame yields, no pty bytes are dropped.
3. Exactly one terminal frame closes the iterator.
4. `sendText`/`sendKey` during agent-think time is safe — bytes go
   through the pty immediately; responses surface in the next frame.
5. **Write serialization.** Concurrent calls to `sendText`/`sendKey`/
   `sendBytes` complete in call order — the N-th call's bytes land on
   the pty before the (N+1)-th's. No interleaving.
6. **No write timeout by default.** `sendBytes` awaits until the pty
   has room. A pathologically non-draining child can cause a send to
   hang indefinitely; agents that need a bound should wrap in
   `Promise.race` with their own timer.

### 4.6 Non-goals (scheduler)

- No priority queue for "urgent" keystrokes — sends are FIFO on the pty.
- No speculative rendering — the frame reflects actual libghostty state,
  not a predicted post-keystroke state.
- No backpressure relief — if the pty's input buffer is full, `sendBytes`
  awaits. TUI programs don't stall input in practice.

## 5. Lifecycle & error surfaces

### 5.1 Taxonomy

Rule: **expected state transitions are frames; unexpected states throw.**

**Constructor rejections** (`Runner.spawn` → `Promise<Runner>`):

| Error | When |
|---|---|
| `SpawnError` | ENOENT, permission denied, child setup failure |
| `FirstFrameTimeoutError` (extends `SpawnError`) | No output within `firstFrameTimeoutMs` |

**Method throws:**

| Error | Thrown by | When |
|---|---|---|
| `ExitedError` | `sendText`/`sendKey`/`sendBytes`/`resize` | Child has exited |
| `DisposedError` | any method | After `[Symbol.asyncDispose]` completed |
| `IteratorInUseError` | `frames()` | A previous iterator is still active |
| `EncodeError` | `sendText`/`sendKey` | Encoder returned non-success (rare) |

**Terminal frames (not errors):**

| Reason | Meaning |
|---|---|
| `"exited"` | Child exited normally (any exit code, including non-zero) |
| `"crashed"` | Child died by signal (SIGSEGV, external SIGKILL, etc.) |
| `"quitTimeout"` | `waitExit({timeoutMs})` timeout fired; child still alive |

**Explicitly not surfaced:**

- Unparseable VT bytes — libghostty's parser is robust, ignores garbage.
- Pty backpressure — `sendBytes` awaits, no error.

### 5.2 Dispose order

```
1. Cancel all timers (quiesce, heartbeat, minInterval).
2. If frame iterator is active without a terminal frame:
     synthesize "crashed" and close it.
3. If child still running:
     SIGKILL immediately (dispose is nuclear — polite shutdown is terminate()).
4. Await child exit, capped at 2s. If it misses, log and continue.
5. Close pty master/slave fds.
6. Dispose Terminal and KeyEncoder.
```

Idempotent. Subsequent calls resolve immediately.

### 5.3 Edge cases (required test coverage)

- Double `terminate()`: second call is a no-op / awaits the first.
- `waitExit()` with no timeout: waits indefinitely — caller's choice.
- `sendText` during quiesce window: bytes flow to pty; child response
  surfaces in the next frame.
- Agent never iterates `frames()`: Runner still watches pty. Scheduler
  runs silently. Child can run to completion.
- Iterator `next()` after terminal frame: returns `{done: true}`.
- `spawn()` called multiple times: each produces a fresh Runner with its
  own pid.
- `resize()` after exit: throws `ExitedError`.
- `renderState` accessed after dispose: throws `DisposedError`.
- **Spawn failure after partial setup**: if `Runner.spawn()` fails after
  allocating a pty but before returning the Runner, resources are rolled
  back (pty closed, any partial child reaped) before the rejection
  surfaces. Callers never need to clean up a rejected spawn.
- **Dispose not called**: if consumer code forgets `await using` and
  drops the Runner reference without calling `[Symbol.asyncDispose]`,
  pty fds and libghostty-side state leak until process exit. No GC
  finalizer; this is by design (async cleanup in a finalizer is
  unreliable).

## 6. Testing strategy

### 6.1 Three tiers

**Tier 1 — Unit (fast, hermetic, no child, no pty).**

| Target | Approach |
|---|---|
| `KeyEncoder` | Golden table: events → expected bytes. Mode variants covered. |
| `FrameSnapshot` views | Given a Terminal state fed directly, assert `text`/`toAnsi`/`cellAt`. |
| Frame scheduler | Clock injection. Feed synthetic events, advance clock, assert yields. |

**Tier 2 — Integration (fast, real pty, scripted deterministic children).**

Test children at `packages/blinkyterm/test/fixtures/children/`:

| Fixture | Exercises |
|---|---|
| `echo-and-exit.sh` | Spawn → first frame → exit terminal frame |
| `wait-for-input.sh` | `sendText` round-trip |
| `infinite-loop.sh` | `terminate()` with default SIGTERM |
| `signal-ignorant.sh` (traps SIGTERM) | `terminate()` escalation path |
| `bell-and-title.sh` | `onBell`/`onTitleChanged` → frame reasons |
| `slow-painter.sh` | `quiesceMs` debounce |
| `mini-tui.sh` | End-to-end agent-loop shape (the canary) |

**Tier 3 — Example-level (runnable, not in CI).**

`examples/random-bot.ts` runs against real NetHack if the binary is on
PATH; skipped with a clear message otherwise. Human-runnable, not a CI gate.

### 6.2 Clock injection

```ts
interface Clock {
  now(): number;
  setTimeout(cb: () => void, ms: number): { clear: () => void };
}

const clock = createFakeClock();
const runner = await Runner.spawn(cmd, { clock });
clock.advance(100);               // precise control
```

Only way to test the scheduler without timing flake. Real-clock tests fall
under Tier 2 with ±50ms tolerances.

### 6.3 Existing v0 tests

- `test/smoke/` → `packages/libghostty-vt/test/smoke/`
- `test/fixtures/` → `packages/libghostty-vt/test/fixtures/`
- `test/differential/` → `packages/libghostty-vt/test/differential/`
- `test/tarball/` → `packages/libghostty-vt/test/tarball/`
- New: `packages/blinkyterm/test/{smoke,integration,fixtures}/`

### 6.4 CI

- Runner: macos-14 (darwin-arm64, pre-Tahoe). Same as today.
- `bun install` at workspace root.
- Two parallel test jobs: `bun test packages/libghostty-vt/test` and
  `bun test packages/blinkyterm/test`.
- `verify:generated` remains the ABI trip-wire.

### 6.5 Not-tested gaps (acknowledged)

- Real NetHack in CI — too heavy, non-deterministic.
- Host-terminal SIGWINCH propagation — v1 assumes static geometry.
- LLM-driven agent correctness — plumbing only.
- Linux / Windows / x64 — darwin-arm64 gate.

## 7. NetHack example

### 7.1 Variants

**`random-bot.ts`** — CI-adjacent smoke.

- Deterministic (seeded PRNG).
- No external API dependency.
- Fixed turn budget (200 turns) or until death/quit.
- Exits cleanly via `#quit y y`.
- Runs in CI if `nethack` is on PATH, skipped otherwise.

**`llm-bot.ts`** — real-world demo.

- Reads `frame.snapshot.toAnsi()`, sends to Anthropic/OpenAI.
- Requires an API key env var.
- Explicit error on startup if key missing.
- Logs each turn to a playback file for review.
- Not runnable in CI.

### 7.2 Shared helpers

`packages/blinkyterm/examples/shared/` (not exported from `blinkyterm`):

- `nethack-setup.ts` — `NETHACKOPTIONS` preset to skip character creation.
- `prompt-detect.ts` — heuristics for common NetHack prompts we handle
  directly: `--More--`, `(y/n)`, `Pick an object:`, death screen.
- `keymap.ts` — tiny translator from bot-internal moves to keystrokes.

Deliberately small. The NetHack-specific logic is confined to these helpers.
The Runner API has no knowledge of NetHack.

### 7.3 Random-bot skeleton

```ts
import { Runner } from "blinkyterm";
import { nethackEnv } from "./shared/nethack-setup.ts";
import { detectPrompt } from "./shared/prompt-detect.ts";
import { toKeystroke } from "./shared/keymap.ts";

const rng = mulberry32(42);
const moves = ["north", "south", "east", "west", "search", "pickup"];
let turns = 0;

await using runner = await Runner.spawn(["nethack"], {
  env: nethackEnv(),
  frame: { minIntervalMs: 500, maxIntervalMs: 10_000 },
});

outer: for await (const frame of runner.frames()) {
  switch (frame.reason) {
    case "exited": case "crashed": case "quitTimeout":
      console.log(`ended: ${frame.reason}`);
      break outer;
  }

  const prompt = detectPrompt(frame.snapshot);
  if (prompt === "more") { await runner.sendKey("Space"); continue; }
  if (prompt === "yn")   { await runner.sendText("n");    continue; }
  if (prompt === "death"){ break outer; }

  if (++turns >= 200) {
    await runner.sendText("#quit\r y\r y\r");
    await runner.waitExit({ timeoutMs: 3000 });
    continue;
  }

  await runner.sendText(toKeystroke(moves[Math.floor(rng() * moves.length)]));
}
```

### 7.4 README (`packages/blinkyterm/examples/README.md`)

Documents:

- How to install NetHack (`brew install nethack`).
- How to run each variant.
- Expected behavior / known limitations.
- A two-line "how to plug in your own TUI program" pointer to `Runner.spawn`.

## 8. Non-goals

Enumerated so reviewers know what's deliberately left out:

1. **Mouse encoding.** Parallel `ghostty_mouse_encoder_*` API exists in
   libghostty. Future pass.
2. **Paste / OSC 52 / bracketed paste.** Deferred until an agent wants it.
3. **IME / composition events.** Deferred.
4. **Linux / Windows / x64 support.** Gate #1 in CLAUDE.md. Still
   darwin-arm64 only.
5. **Host-terminal SIGWINCH auto-propagation.** Agent-headless use doesn't
   need it. V1 assumes static geometry.
6. **Multiplexing.** One Runner, one child. Pane/window semantics are a
   tmux-class project.
7. **Agent quality or strategy.** We test plumbing. A good NetHack player
   is someone else's problem.
8. **Batched change detail.** "Everything that happened in the last
   second" as a reason list. Deferred; add if a use case surfaces.
9. **Priority input queue.** FIFO is sufficient.
10. **Speculative rendering.** Frame reflects actual libghostty state.

## 9. Carry-forward / open questions

Areas where the design makes a call but reviewers may push back:

1. **`minIntervalMs` default of 1000ms.** Conservative for LLM-driven
   use. Faster children (real-time TUI like htop) may want 100ms. Tunable
   per-spawn; default tuned for NetHack-class.

2. **`maxIntervalMs` heartbeat default 30s.** Catches stuck children. May
   be too eager for long-idle programs (cron-like). Tunable.

3. **`quiesceMs` default 100.** Tested local value; network pty (ssh)
   may need 200–300ms. Tunable.

4. **Reason priority table.** The ordering between `titleChange`, `bell`,
   and `cellChange` is defensible but not provably correct. Reviewers
   may argue `bell > titleChange` or that reasons should be a Set
   instead of single value.

5. **`sendText` per-char encoding.** Going through the encoder per char
   is microseconds-slow but correctness-safe. A "raw text fast path" for
   known-simple modes is possible if it matters.

6. **One iterator at a time.** Reasonable simplification. Multiplexing
   `frames()` consumers is non-trivial and not a current need.

7. **Test children as shell scripts.** Simpler than Bun scripts. POSIX
   shell covers macOS and Linux (when we expand). Some fixtures may want
   to move to Bun scripts if behavior gets complex.

8. **NetHack-specific helpers in the example.** A future agent framework
   might want these promoted into a `blinkyterm-helpers` sub-module. Not
   yet.

9. **Repo rename timing.** `ts-libghostty-vt` → `ts-libghostty` touches
   CLAUDE.md, README, clone URLs. Should land before or with Pass 4, not
   during Pass 5 when `blinkyterm` is being added.

10. **Disposal timeout.** 2s for child exit after SIGKILL is a guess.
    Reviewers may argue it should be configurable or shorter.
