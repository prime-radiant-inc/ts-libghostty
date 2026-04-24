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
- Runner class with `frames()` iterator, `sendText`/`sendKey`/
  `sendKeyEvent`/`sendBytes`, two-phase clean quit, async disposal
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
                 │ .sendKeyEvent(), .waitExit(), .terminate(), .exited
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
  docs/
  packages/
    libghostty-vt/                   npm: "libghostty-vt"
      package.json
      src/  test/  CHANGELOG.md
      vendor/ghostty/                pinned Ghostty tree (headers + source
                                     for probe/gen-bindings)
      prebuilds/darwin-arm64/        compiled dylib — MUST live inside the
                                     package so npm/bun pack includes it
      scripts/                       binding build, probe, gen-bindings
    blinkyterm/                      npm: "blinkyterm"
      package.json
      src/  test/  examples/  CHANGELOG.md
      scripts/                       blinkyterm-specific (test children, etc.)
```

**Nothing FFI-related lives at the workspace root.** `vendor/`,
`prebuilds/`, and binding-specific `scripts/` stay inside
`packages/libghostty-vt/` because:

- The binding's FFI loader (`src/ffi.ts`) resolves `prebuilds/...`
  relative to the package root. `bun/npm pack` only includes files
  inside the package tree — a shared `../../prebuilds/` would silently
  drop from the published tarball and the installed binding would fail
  to load its dylib.
- `vendor/ghostty/` is consumed at build time by `gen-bindings.ts`
  (binding-specific) and stays with it.
- `blinkyterm` has no FFI of its own; it depends on the binding via
  `workspace:*`. No shared native state.

Only genuinely-shared things (workspace root `package.json`,
`tsconfig.base.json`, `CLAUDE.md`, `docs/`) live at the repo root.

- The repo rename is a one-time structural change. The GitHub URL and
  clone instructions update accordingly.
- The npm package name for the binding drops the `ts-` prefix (now
  `libghostty-vt`), matching the upstream C library's name. `ts-` was
  redundant with `package.json → types`.
- `vendor/`, `prebuilds/`, and binding `scripts/` live inside
  `packages/libghostty-vt/` (see rationale above). `docs/` is shared
  at the workspace root for cross-cutting design work.
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
  // Required
  key: Key;                         // physical key code (string union from generated.ts,
                                    // e.g., "KeyA", "Enter", "ArrowUp"); maps to GhosttyKey enum
  action?: "press" | "release" | "repeat";   // default: "press"
  mods?: Mods;

  // Text-producing key fields (pass-through to GhosttyKeyEvent's
  // utf8 / unshifted_codepoint / consumed_mods). Required by the C API
  // contract for printable-layout keys; Runner computes them from a
  // US-layout default when consumers use the Runner.sendKey shortcut.
  //
  // `utf8`: the unmodified character before any Ctrl/Meta transform.
  //         MUST NOT be a C0 control (U+0000–U+001F, U+007F) or PUA
  //         function-key codepoint — omit and let the encoder derive
  //         bytes from the logical key instead. Enforced at encode time.
  utf8?: string;
  unshiftedCodepoint?: number;
  consumedMods?: Mods;
  composing?: boolean;
}

export interface Mods {
  shift?: boolean;
  ctrl?: boolean;
  alt?: boolean;
  super?: boolean;                  // Cmd/Win
  // Side info (optional, for platforms that distinguish L/R modifiers):
  shiftSide?: "left" | "right";
  ctrlSide?: "left" | "right";
  altSide?: "left" | "right";
  superSide?: "left" | "right";
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

The binding's `encode()` enforces the C-API contract: throws `EncodeError`
if `utf8` contains a C0 control or PUA codepoint. Consumers constructing
a `KeyEvent` for Ctrl+C should set `key="KeyC"` + `mods={ctrl:true}` +
`utf8="c"` (or omit `utf8`); they should **not** try to pass `""`.

### 2.2 C-API mapping

| TypeScript | C |
|---|---|
| `new KeyEncoder({terminal})` | `ghostty_key_encoder_new()` + `ghostty_key_encoder_setopt_from_terminal()` |
| `new KeyEncoder({options})` | `ghostty_key_encoder_new()` + `ghostty_key_encoder_setopt()` per field |
| `encoder.encode(event)` | `ghostty_key_event_new()` → `_set_action` / `_set_key` / `_set_mods` / `_set_consumed_mods` / `_set_composing` / `_set_unshifted_codepoint` / `_set_utf8` → `ghostty_key_encoder_encode()` → buffer → `ghostty_key_event_free()` |
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

- `sendText(text)` — **raw UTF-8 bytes, no encoder**. Writes the string's
  UTF-8 encoding to the pty directly. C0 controls (`\r`, `\t`, `\n`)
  pass through unchanged — they're byte-exact, not key events. This
  matches what every shell-scripted input-automation tool does and
  avoids the C API's "no C0 in utf8" restriction entirely. Plain text
  doesn't need the encoder; modes like DECCKM and Kitty keyboard apply
  to *keys*, not to typed characters.

- `sendKey(key, mods?)` — through encoder. Runner builds a `KeyEvent`
  with a US-layout default:
    - `key` — maps name to `GhosttyKey` enum
    - `action: "press"`, `mods` from second arg
    - For printable keys (letters, digits, symbols): compute `utf8` +
      `unshiftedCodepoint` from the US-layout canonical character,
      accounting for shift. Example: `sendKey("KeyA", {shift:true})`
      → `utf8="A"`, `unshiftedCodepoint=0x61`.
    - For C0/function/navigation keys (Enter, Escape, Arrow*, F1–F25,
      Backspace, Home, etc.): `utf8` left `undefined` so the encoder
      derives bytes from the logical key per the C API contract.
  Non-US layouts or composition cases use `sendKeyEvent(event)` with
  a fully-specified `KeyEvent`.

- `sendKeyEvent(event: KeyEvent)` — full control escape hatch. Agent
  passes a complete `KeyEvent`; Runner encodes and writes. For
  non-US layouts, IME composition, or any case where the US-default
  `sendKey` is wrong.

- `sendBytes(bytes)` — bypass encoder entirely. Named escape hatch for
  "I know what I'm doing."

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

  sendText(text: string): Promise<void>;               // raw UTF-8 bytes
  sendKey(key: Key, mods?: Mods): Promise<void>;       // US-layout convenience
  sendKeyEvent(event: KeyEvent): Promise<void>;        // full KeyEvent control
  sendBytes(bytes: Uint8Array): Promise<void>;         // raw escape hatch

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
  | "exited"                        // terminal — normal child exit
  | "crashed";                      // terminal — child died by signal

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
    case "exited": case "crashed":
      console.log(`ended: ${frame.reason}, code=${frame.exitCode}`);
      console.log(frame.snapshot.text);    // final screen
      break outer;
  }

  const move = await agent.decide(frame.snapshot.toAnsi());
  if (move === "quit") {
    await runner.sendText("#quit\r y\r y\r");
    const r = await runner.waitExit({ timeoutMs: 3000 });
    if (!r.exited) await runner.terminate({ thenAfterMs: 1000 });
    // iterator keeps delivering frames until the child actually exits;
    // the next terminal frame ("exited" or "crashed") closes the loop
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
     │                            (exited / crashed)
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
interface Deferred<T = void> {
  promise: Promise<T>;
  resolve: () => void;
}
function makeDeferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

interface SchedulerState {
  lastYieldAt: number;                  // ms of last consumer-observed frame
  pendingReasons: Set<FrameReason>;     // accumulated across events
  bellsSinceLast: number;               // accumulated across events
  titleChangesSinceLast: string[];      // accumulated across events
  quiesceTimer: Timer | null;           // restarts on each pty write
  heartbeatTimer: Timer;                // fires at lastYieldAt + maxIntervalMs
  minIntervalWait: Promise<void> | null;
  readyToYield: boolean;                // scheduler decided a yield is warranted
  yieldSignal: Deferred;                // one-shot, recreated each consume cycle
  exitCode?: number;                    // latched when child exits
  signal?: NodeJS.Signals;              // latched when child dies by signal
}
```

`yieldSignal` is a one-shot deferred, **not a long-lived Promise**.
A plain `Promise` that resolves on `readyToYield = true` would remain
resolved forever — every subsequent `await` would return immediately,
causing the iterator to tight-loop instead of waiting for the next
scheduler wake-up. The deferred is recreated in `scheduler.consume()`
(below) after each finalize, so the iterator's next `await` sees a
fresh pending promise.

The scheduler exposes three methods the iterator uses:

```ts
class Scheduler {
  awaitReady(): Promise<void> {
    return this.state.readyToYield
      ? Promise.resolve()
      : this.state.yieldSignal.promise;
  }

  markReady(): void {
    if (this.state.readyToYield) return;   // idempotent
    this.state.readyToYield = true;
    this.state.yieldSignal.resolve();
  }

  consume(): void {                        // called by iterator after finalize
    this.state.readyToYield = false;
    this.state.yieldSignal = makeDeferred();
    this.state.pendingReasons.clear();
    this.state.bellsSinceLast = 0;
    this.state.titleChangesSinceLast = [];
    this.state.lastYieldAt = clock.now();
    this.restartHeartbeat();
  }
}
```

Key contrast with an earlier design: there is no `pendingFrame` slot.
The Frame is constructed by the iterator's `next()` from live scheduler
state when the consumer calls for it — see §4.2.1.

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

scheduler.maybeYield()          // evaluates "is now a good time to yield?"
  ├── if exitSignal resolved → force finalize-on-consume path with
  │     a terminal reason pre-queued; signal consumer.
  ├── if now - lastYieldAt < minIntervalMs → defer; schedule re-eval at boundary
  ├── determine trigger:
  │     • if pendingReasons contains "heartbeat" → bypass yieldOn filter
  │     • if pendingReasons contains "initial"   → bypass yieldOn filter
  │     • if pendingReasons contains a terminal  → bypass yieldOn filter
  │     • else if pendingReasons ∩ yieldOn is empty → skip
  │     • else → proceed
  └── scheduler.markReady()          // sets readyToYield + resolves one-shot signal

heartbeatTimer fires (maxIntervalMs elapsed with no yield)
  └── pendingReasons += "heartbeat" → scheduler.maybeYield()
```

### 4.2.1 Finalize-on-consume

A strictly earlier design that published a materialized `pendingFrame`
and cleared accumulators at publish time had a correctness bug: if the
consumer was slow and multiple publishes occurred during think-time,
the accumulators got reset on each — either the pending frame went
stale, or a later publish overwrote it and dropped the earlier
window's bell/title/reason counts. This contradicted §4.4's guarantee.

The design therefore **finalizes the frame only when the consumer is
ready to receive it.** Scheduler keeps:

- `pendingReasons: Set<FrameReason>` — accumulates across events
- `bellsSinceLast: number` — accumulates
- `titleChangesSinceLast: string[]` — accumulates
- `readyToYield: boolean` — scheduler's "now is a good time" decision
- `yieldSignal: Deferred` — one-shot, awaited by the iterator when
  `readyToYield` is false; recreated by `scheduler.consume()` each
  finalize cycle (see below)
- `closed: boolean` — iterator-local flag set after a terminal reason
  has been delivered; next `next()` returns `{done: true}`

The iterator looks like this:

```ts
class FrameIterator implements AsyncIterator<Frame> {
  private closed = false;

  async next(): Promise<IteratorResult<Frame>> {
    if (this.closed) return { done: true, value: undefined };

    while (!scheduler.state.readyToYield) {
      await scheduler.awaitReady();   // one-shot; recreated after each consume
    }

    // FINALIZE — atomic, no intervening await
    renderState.update(terminal);
    const snap = buildFrozenSnapshot(terminal, renderState,
                                     scheduler.state.bellsSinceLast,
                                     scheduler.state.titleChangesSinceLast);
    const reason = priorityPick(scheduler.state.pendingReasons);
    const frame: Frame = {
      reason,
      snapshot: snap,
      exitCode:  isTerminal(reason) ? scheduler.state.exitCode : undefined,
      signal:    isTerminal(reason) ? scheduler.state.signal   : undefined,
    };
    renderState.markClean();
    scheduler.consume();              // clears accumulators, recreates yieldSignal,
                                      // resets lastYieldAt, restarts heartbeat

    if (isTerminal(reason)) this.closed = true;
    return { done: false, value: frame };
  }
}
```

Key properties:

- **Terminal frames are delivered, not swallowed.** The `isTerminal`
  branch sets `this.closed = true` and still returns `{done: false,
  value: frame}`. The *next* call returns `{done: true}`.
- **Latest-only with complete accumulation.** Between a `maybeYield`
  setting `readyToYield = true` and the consumer's `next()`,
  additional events continue accumulating into `pendingReasons` /
  `bellsSinceLast` / `titleChangesSinceLast`. When the consumer
  finally calls `next()`, one frame is finalized carrying *all*
  events accumulated since the last yield. The agent thinks for 5
  seconds, the child paints 17 times — the next frame reflects the
  current state plus every bell, title, and reason from the whole
  5-second window.
- **Rate limit is consumer-facing.** `lastYieldAt` resets when the
  consumer takes the frame, not when the scheduler decides one is
  ready. `minIntervalMs` bounds observed frame delivery.
- **No generator semantics.** `next()` executes finalization steps
  synchronously after `awaitReady()` resolves — the bug with
  `yield frame; cleanup()` (where cleanup runs only on resume) is
  avoided by not using a generator at all.

### 4.2.2 Scheduler notes

- **`initial`, `heartbeat`, and terminal reasons bypass `yieldOn`.**
  `yieldOn` exists to silence *change*-driven noise. Initial ("the
  first frame after spawn"), heartbeat ("poke me at least every N ms"),
  and terminal ("the child is gone") are not noise — they're unconditional
  signals. The scheduler's trigger-determination special-cases them.
- **`initial` is set once, on the first publish-worthy event after
  `Runner.spawn`.** Whatever combination of `cellChange`/`bell`/
  `titleChange` triggered the first wake-up, `initial` is OR'd in so
  priorityPick yields `reason: "initial"`. After the first consumer
  `next()`, `initial` is cleared along with the other pending reasons.
- **Dirty state is cleared at consume**, not at `update()`. Per the
  Pass 3 `RenderState` contract (§Pass 3 Codex round 1 fix),
  `update()` refreshes but does not clear; `markClean()` clears.
  Without `markClean` in the finalize block, every subsequent quiesce
  would continue to report `"cellChange"` and defeat the change gate.
- **Exit info is captured onto the Frame at finalize.** The scheduler
  latches `exitCode` / `signal` from the pty's child-exit event onto
  its own fields as soon as it sees them; finalize copies them onto
  the Frame for terminal reasons.

### 4.3 Reason priority

```
crashed > exited                            ← terminal; override everything
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

1. `Frame.snapshot` is frozen at finalize time (i.e., when the consumer
   receives the frame); values do not shift under the agent across
   await points.
2. Between frame yields, no pty bytes are dropped.
3. Exactly one terminal frame is delivered to the consumer. The next
   `next()` call after a terminal frame returns `{done: true}`.
4. `sendText`/`sendKey` during agent-think time is safe — bytes go
   through the pty immediately; responses surface in the next frame.
5. **Write serialization.** Concurrent calls to `sendText`/`sendKey`/
   `sendKeyEvent`/`sendBytes` complete in call order — the N-th call's
   bytes land on the pty before the (N+1)-th's. No interleaving. Runner
   enforces this via an internal write mutex.
6. **Full-buffer drain contract.** Every send method loops over partial
   writes. `Bun.Terminal.write()` may return a byte count smaller than
   the requested buffer when the pty's input side is backed up; Runner
   internally loops, awaiting drain between attempts, until *every*
   byte of the requested payload has been written. A send only
   resolves once the full payload is flushed to the pty. Partial writes
   are never silently dropped.
7. **No write timeout by default.** A pathologically non-draining child
   can cause a send to hang indefinitely. Agents that need a bound
   should wrap in `Promise.race` with their own timer, or call
   `terminate()` from a watchdog.

### 4.6 Non-goals (scheduler)

- No priority queue for "urgent" keystrokes — sends are FIFO on the pty.
- No speculative rendering — the frame reflects actual libghostty state,
  not a predicted post-keystroke state.
- No backpressure relief (no drop-on-full). Sends drain completely (§4.5 #6);
  a non-draining child causes `sendBytes` to await indefinitely. TUI
  programs don't stall input in practice.

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
| `ExitedError` | `sendText`/`sendKey`/`sendKeyEvent`/`sendBytes`/`resize` | Child has exited |
| `DisposedError` | any method | After `[Symbol.asyncDispose]` completed |
| `IteratorInUseError` | `frames()` | A previous iterator is still active |
| `EncodeError` | `sendKey`/`sendKeyEvent` | Encoder returned non-success, or `utf8` contains a forbidden C0/PUA codepoint |

**Terminal frames (not errors):**

| Reason | Meaning |
|---|---|
| `"exited"` | Child exited normally (any exit code, including non-zero) |
| `"crashed"` | Child died by signal (SIGSEGV, external SIGKILL, etc.) |

`waitExit` timeouts are **not** terminal frames. The timeout is signaled
through `WaitExitResult.exited = false`. The iterator only closes when the
child actually dies. This keeps the agent's loop able to observe the real
terminal frame after a subsequent `terminate()` or late self-exit.

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
6. Dispose, in order:
     a. RenderState  ([Symbol.dispose] — frees libghostty row/cell iterator handles)
     b. KeyEncoder   ([Symbol.dispose] — frees encoder + pending event handles)
     c. Terminal     ([Symbol.dispose] — frees terminal handle)
```

Idempotent. Subsequent calls resolve immediately.

**Two layers of post-dispose access error.** After `Runner` dispose
completes:

- Runner's own accessors — `runner.renderState`, `runner.terminal`,
  `runner.sendText()`, etc. — throw Runner's `DisposedError`. The
  getter is the gate; the underlying handle isn't consulted.
- A consumer who held a `RenderState` or `Terminal` reference from
  *before* disposal and calls methods on it afterwards gets the
  binding's existing error: `GhosttyError` with code `"closed"` from
  the Pass 3 `#assertOpen` check. Each layer is honest about its own
  lifecycle; neither pretends the other's state is still alive.

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
    case "exited": case "crashed":
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

5. **`sendText` as raw UTF-8 bytes.** Plain text skips the encoder —
   C0 controls pass through as-is, modes like DECCKM / Kitty-keyboard
   apply to keys, not typed characters. Edge case: under an exotic
   mode that genuinely re-encodes plain text, consumers should switch
   to per-character `sendKey(...)`. We can revisit if any real program
   surfaces this.

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
