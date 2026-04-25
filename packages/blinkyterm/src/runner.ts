import { KeyEncoder, RenderState, Terminal } from "libghostty-vt";
import type { Key, KeyEvent, Mods } from "libghostty-vt";

import {
  DisposedError,
  ExitedError,
  FirstFrameTimeoutError,
  IteratorInUseError,
  SpawnError,
} from "./errors";
import type {
  Frame,
  FrameReason,
  SpawnOptions,
  TerminateOptions,
  WaitExitResult,
} from "./types";
import { realClock } from "./internal/clock";
import { priorityPick, Scheduler } from "./internal/scheduler";
import { buildFrameSnapshot } from "./internal/snapshot";
import { eventFromUsLayout } from "./internal/us-layout";
import { WriteQueue } from "./internal/write-queue";

// Subset of `Bun.Subprocess` we actually use. Avoids leaning on Bun's full
// type, which has shifted across versions.
interface BunSubprocessLike {
  readonly pid: number;
  readonly exited: Promise<number>;
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  kill(signal?: number | NodeJS.Signals): void;
}

interface BunTerminalLike {
  readonly closed: boolean;
  write(bytes: Uint8Array): number;
  resize(cols: number, rows: number): void;
  close(): void;
}

interface BunSpawnTerminalConfig {
  cols: number;
  rows: number;
  data(term: BunTerminalLike, chunk: Uint8Array): void;
  drain?(): void;
  exit?(term: BunTerminalLike, code: number | null, signal: NodeJS.Signals | null): void;
}

// Minimal globalThis shape — Bun's namespace types include `Terminal` and
// `spawn` but we type the bits we use locally to avoid coupling tightly to
// the Bun build version.
interface BunGlobals {
  Terminal: new (config: BunSpawnTerminalConfig) => BunTerminalLike;
  spawn(config: {
    cmd: string[];
    cwd?: string;
    env?: Record<string, string>;
    terminal?: BunTerminalLike;
  }): BunSubprocessLike;
}

const BunRef = (globalThis as unknown as { Bun: BunGlobals }).Bun;

function buildEnv(opts: SpawnOptions, cols: number, rows: number): Record<string, string> {
  const base: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") base[key] = value;
  }
  base["TERM"] = "xterm-256color";
  base["LC_ALL"] = "en_US.UTF-8";
  base["LANG"] = "en_US.UTF-8";
  base["COLUMNS"] = String(cols);
  base["LINES"] = String(rows);
  if (opts.env) {
    for (const [key, value] of Object.entries(opts.env)) {
      base[key] = value;
    }
  }
  return base;
}

export class Runner {
  readonly #pid: number;
  readonly #pty: BunTerminalLike;
  readonly #proc: BunSubprocessLike;
  readonly #terminal: Terminal;
  readonly #renderState: RenderState;
  readonly #encoder: KeyEncoder;
  readonly #scheduler: Scheduler;
  readonly #writeQueue: WriteQueue;

  #disposed = false;
  #exited = false;
  #exitCode: number | undefined;
  #signal: NodeJS.Signals | undefined;
  #iteratorActive = false;
  #cols: number;
  #rows: number;
  #cellPx: { width: number; height: number } | undefined;
  #terminating: Promise<void> | undefined;

  private constructor(args: {
    pty: BunTerminalLike;
    proc: BunSubprocessLike;
    terminal: Terminal;
    renderState: RenderState;
    encoder: KeyEncoder;
    scheduler: Scheduler;
    writeQueue: WriteQueue;
    cols: number;
    rows: number;
    cellPx: { width: number; height: number } | undefined;
  }) {
    this.#pid = args.proc.pid;
    this.#pty = args.pty;
    this.#proc = args.proc;
    this.#terminal = args.terminal;
    this.#renderState = args.renderState;
    this.#encoder = args.encoder;
    this.#scheduler = args.scheduler;
    this.#writeQueue = args.writeQueue;
    this.#cols = args.cols;
    this.#rows = args.rows;
    this.#cellPx = args.cellPx;
  }

  static async spawn(argv: string[], opts: SpawnOptions = {}): Promise<Runner> {
    if (BunRef === undefined) {
      throw new SpawnError("Runner.spawn requires the Bun runtime");
    }
    if (!Array.isArray(argv) || argv.length === 0) {
      throw new SpawnError("Runner.spawn requires a non-empty argv");
    }
    const cols = opts.cols ?? 80;
    const rows = opts.rows ?? 24;
    const cwd = opts.cwd ?? process.cwd();
    const clock = opts.clock ?? realClock;
    const firstFrameTimeoutMs = opts.firstFrameTimeoutMs ?? 10000;

    // Tracks whether the child has produced any output. The first-frame
    // handshake distinguishes "silent child" / "exit-before-output" (both
    // reject) from "produced output then exited" (proceed with a forced
    // quiesce so the first iterator frame is reason: "initial").
    let firstByteSeen = false;

    // Forward-reference the scheduler and write queue so the Terminal and
    // Bun.Terminal callbacks can close over them. Effects fire from
    // vtWrite synchronously, so we need stable handles that become non-null
    // before any data flows.
    let scheduler: Scheduler | null = null;
    let writeQueue: WriteQueue | null = null;

    // libghostty-vt Terminal options. `frame` is intentionally not forwarded
    // here — it controls the Scheduler, not the VT engine.
    const termOpts: ConstructorParameters<typeof Terminal>[0] = {
      cols,
      rows,
      onWritePty: (bytes) => {
        // libghostty wants these bytes flushed to the pty. The write queue
        // serialises and copies; failures after dispose are silent in v0.
        writeQueue?.write(bytes).catch(() => {});
      },
      onBell: () => {
        scheduler?.noteBell();
        scheduler?.maybeYield();
      },
      onTitleChanged: (title) => {
        scheduler?.noteTitleChange(title);
        scheduler?.maybeYield();
      },
    };
    if (opts.maxScrollback !== undefined) termOpts.maxScrollback = opts.maxScrollback;
    if (opts.cellPx !== undefined) termOpts.cellPx = opts.cellPx;

    const terminal = new Terminal(termOpts);
    const renderState = new RenderState();
    const encoder = new KeyEncoder({ terminal });
    scheduler = new Scheduler(
      opts.frame !== undefined
        ? { clock, frame: opts.frame }
        : { clock },
    );

    // Bun.Terminal callbacks. Captured `scheduler` is non-null by the time
    // any pty data can flow.
    const pty = new BunRef.Terminal({
      cols,
      rows,
      data(_t, chunk) {
        terminal.vtWrite(chunk);
        if (!firstByteSeen) {
          firstByteSeen = true;
          scheduler!.noteInitial();
        }
        scheduler!.notePtyChunk();
      },
      drain() {
        writeQueue?.notifyDrain();
      },
      // pty exit is informational on darwin — actual exit handling is via
      // proc.exited (the Promise) since onExit doesn't reliably fire there.
      exit() {},
    });

    const writeQueueInstance = new WriteQueue(pty);
    writeQueue = writeQueueInstance;

    scheduler.onQuiesce(() => {
      renderState.update(terminal);
      if (renderState.dirty() !== "none") {
        scheduler!.noteCellChange();
      }
      scheduler!.maybeYield();
    });

    let proc: BunSubprocessLike;
    try {
      proc = BunRef.spawn({
        cmd: argv,
        cwd,
        env: buildEnv(opts, cols, rows),
        terminal: pty,
      });
    } catch (err) {
      // Failed before any resource was attached to a Runner instance — clean
      // up everything we constructed and rethrow as SpawnError.
      try { pty.close(); } catch { /* ignore */ }
      try { renderState[Symbol.dispose](); } catch { /* ignore */ }
      try { encoder[Symbol.dispose](); } catch { /* ignore */ }
      try { terminal[Symbol.dispose](); } catch { /* ignore */ }
      scheduler.dispose();
      writeQueueInstance.dispose();
      throw new SpawnError(
        `Failed to spawn child: ${(err as Error).message ?? String(err)}`,
        "spawn_failed",
        { cause: err },
      );
    }

    const runner = new Runner({
      pty,
      proc,
      terminal,
      renderState,
      encoder,
      scheduler,
      writeQueue: writeQueueInstance,
      cols,
      rows,
      cellPx: opts.cellPx,
    });

    // Wire proc.exited to scheduler. We use a Promise rather than an onExit
    // callback because Bun's onExit does not reliably fire on darwin.
    proc.exited.then((rc) => {
      runner.#exitCode = typeof rc === "number" ? rc : undefined;
      runner.#signal = proc.signalCode ?? undefined;
      runner.#exited = true;
      const noteArg: { exitCode?: number; signal?: NodeJS.Signals } = {};
      if (runner.#exitCode !== undefined) noteArg.exitCode = runner.#exitCode;
      if (runner.#signal !== undefined) noteArg.signal = runner.#signal;
      scheduler!.noteExit(noteArg);
    }).catch(() => {
      // proc.exited is documented to always resolve (never reject); guard
      // anyway.
    });

    // First-frame handshake. Per the state machine in spec §3.5, a child
    // that produces no output OR exits before producing output rejects
    // with FirstFrameTimeoutError — there is no [spawning] -> [exited]
    // direct edge.
    type RaceWinner = "ready" | "timeout" | "exited";
    const ready: Promise<RaceWinner> = scheduler.awaitReady().then(() => "ready" as const);
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeout: Promise<RaceWinner> = new Promise<RaceWinner>((resolve) => {
      timeoutHandle = setTimeout(() => resolve("timeout"), firstFrameTimeoutMs);
    });
    const earlyExit: Promise<RaceWinner> = proc.exited.then(() => "exited" as const);
    const winner = await Promise.race([ready, timeout, earlyExit]);
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);

    const partialCleanup = async (): Promise<void> => {
      if (!runner.#exited) {
        try { proc.kill("SIGKILL"); } catch { /* ignore */ }
        let killTimer: ReturnType<typeof setTimeout> | undefined;
        const killTimeout = new Promise<void>((resolve) => {
          killTimer = setTimeout(resolve, 2000);
        });
        try {
          await Promise.race([proc.exited.then(() => {}), killTimeout]);
        } finally {
          if (killTimer !== undefined) clearTimeout(killTimer);
        }
      }
      try { pty.close(); } catch { /* ignore */ }
      try { renderState[Symbol.dispose](); } catch { /* ignore */ }
      try { encoder[Symbol.dispose](); } catch { /* ignore */ }
      try { terminal[Symbol.dispose](); } catch { /* ignore */ }
      scheduler!.dispose();
      writeQueueInstance.dispose();
      runner.#disposed = true;
    };

    if (winner === "timeout") {
      await partialCleanup();
      throw new FirstFrameTimeoutError(firstFrameTimeoutMs);
    }
    if (winner === "exited" && !firstByteSeen) {
      await partialCleanup();
      throw new FirstFrameTimeoutError(firstFrameTimeoutMs);
    }
    if (winner === "exited" && firstByteSeen) {
      // Child produced output then exited before quiesce fired. Run the
      // quiesce-equivalent once so the first iterator frame still surfaces
      // reason: "initial"; the terminal frame follows on the next next().
      renderState.update(terminal);
      if (renderState.dirty() !== "none") scheduler.noteCellChange();
      scheduler.maybeYield();
    }

    return runner;
  }

  get pid(): number { return this.#pid; }
  get disposed(): boolean { return this.#disposed; }
  get exited(): boolean { return this.#exited; }
  get exitCode(): number | undefined { return this.#exitCode; }
  get signal(): NodeJS.Signals | undefined { return this.#signal; }

  get terminal(): Terminal {
    if (this.#disposed) throw new DisposedError("Runner");
    return this.#terminal;
  }

  get renderState(): RenderState {
    if (this.#disposed) throw new DisposedError("Runner");
    return this.#renderState;
  }

  frames(): AsyncIterable<Frame> {
    if (this.#disposed) throw new DisposedError("Runner");
    if (this.#iteratorActive) throw new IteratorInUseError();
    this.#iteratorActive = true;

    let closed = false;
    let firstFrameDelivered = false;
    const terminal = this.#terminal;
    const renderState = this.#renderState;
    const scheduler = this.#scheduler;
    const releaseLock = (): void => {
      this.#iteratorActive = false;
    };

    const iter: AsyncIterator<Frame> = {
      next: async (): Promise<IteratorResult<Frame>> => {
        if (closed) {
          releaseLock();
          return { done: true, value: undefined };
        }
        await scheduler.awaitReady();

        // ATOMIC FINALIZE — no awaits between these steps. Anything that
        // could yield to the event loop here would let new effects land
        // mid-snapshot, smearing frame boundaries.
        renderState.update(terminal);
        const pending = scheduler.pendingReasonSet();
        // Edge case: child wrote bytes then exited before quiesce fired.
        // Both `initial` and `exited`/`crashed` are pending. Spec §3.5
        // promises the first iterator frame is `reason: "initial"`; the
        // terminal frame follows. priorityPick would otherwise rank
        // exited/crashed above initial and steal the first frame.
        let reason: FrameReason;
        let exitToReplay: { exitCode?: number; signal?: NodeJS.Signals } | null = null;
        if (
          !firstFrameDelivered &&
          pending.has("initial") &&
          (pending.has("exited") || pending.has("crashed"))
        ) {
          reason = "initial";
          const peek = scheduler.snapshot();
          exitToReplay = {
            ...(peek.exitCode !== undefined ? { exitCode: peek.exitCode } : {}),
            ...(peek.signal !== undefined ? { signal: peek.signal } : {}),
          };
        } else {
          reason = priorityPick(pending);
        }
        const schedSnap = scheduler.snapshot();
        const snapshot = buildFrameSnapshot({
          terminal,
          renderState,
          bellsSinceLast: schedSnap.bellsSinceLast,
          titleChangesSinceLast: schedSnap.titleChangesSinceLast,
        });
        const frame: Frame = (() => {
          if (reason === "exited" || reason === "crashed") {
            const f: Frame = {
              reason,
              snapshot,
              ...(schedSnap.exitCode !== undefined ? { exitCode: schedSnap.exitCode } : {}),
              ...(schedSnap.signal !== undefined ? { signal: schedSnap.signal } : {}),
            };
            return f;
          }
          return { reason, snapshot };
        })();
        renderState.markClean();
        scheduler.consume();
        firstFrameDelivered = true;
        // Re-queue the exit reason so the next next() delivers the
        // terminal frame. Replays through the existing noteExit path,
        // which markReady-s the scheduler.
        if (exitToReplay !== null) {
          scheduler.noteExit(exitToReplay);
        }
        if (reason === "exited" || reason === "crashed") {
          closed = true;
          releaseLock();
        }
        return { done: false, value: frame };
      },
      return: async (): Promise<IteratorResult<Frame>> => {
        closed = true;
        releaseLock();
        return { done: true, value: undefined };
      },
    };

    return {
      [Symbol.asyncIterator]() {
        return iter;
      },
    };
  }

  async sendBytes(bytes: Uint8Array): Promise<void> {
    this.#assertRunning("sendBytes");
    await this.#writeQueue.write(bytes);
  }

  async sendText(text: string): Promise<void> {
    const bytes = new TextEncoder().encode(text);
    await this.sendBytes(bytes);
  }

  async sendKeyEvent(event: KeyEvent): Promise<void> {
    this.#assertRunning("sendKeyEvent");
    const bytes = this.#encoder.encode(event);
    await this.sendBytes(bytes);
  }

  async sendKey(key: Key, mods?: Mods): Promise<void> {
    return this.sendKeyEvent(eventFromUsLayout(key, mods));
  }

  async waitExit(opts: { timeoutMs?: number } = {}): Promise<WaitExitResult> {
    if (this.#disposed) throw new DisposedError("Runner");
    if (this.#exited) return this.#latchedExitResult();

    if (opts.timeoutMs === undefined) {
      await this.#proc.exited;
      return this.#latchedExitResult();
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), opts.timeoutMs);
    });
    const exited = this.#proc.exited.then(() => "exited" as const);
    try {
      const winner = await Promise.race([exited, timeout]);
      if (winner === "timeout") {
        return { exited: false };
      }
      return this.#latchedExitResult();
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  async terminate(opts: TerminateOptions = {}): Promise<void> {
    if (this.#disposed) throw new DisposedError("Runner");
    if (this.#exited) return;
    if (this.#terminating !== undefined) return this.#terminating;

    const signal: NodeJS.Signals = opts.signal ?? "SIGTERM";
    const signal2: NodeJS.Signals = opts.signal2 ?? "SIGKILL";
    const thenAfterMs = opts.thenAfterMs;

    const run = async (): Promise<void> => {
      try {
        this.#proc.kill(signal);
      } catch {
        // Already dead — just await proc.exited below.
      }

      if (thenAfterMs === undefined) {
        await this.#proc.exited;
        return;
      }

      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), thenAfterMs);
      });
      const exited = this.#proc.exited.then(() => "exited" as const);
      let winner: "timeout" | "exited";
      try {
        winner = await Promise.race([exited, timeout]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
      if (winner === "timeout" && !this.#exited) {
        try {
          this.#proc.kill(signal2);
        } catch {
          // ignore
        }
      }
      await this.#proc.exited;
    };

    const pending = run();
    this.#terminating = pending;
    try {
      await pending;
    } finally {
      this.#terminating = undefined;
    }
  }

  async resize(cols: number, rows: number): Promise<void> {
    this.#assertRunning("resize");
    this.#cols = cols;
    this.#rows = rows;
    this.#pty.resize(cols, rows);
    if (this.#cellPx !== undefined) {
      this.#terminal.resize(cols, rows, this.#cellPx);
    } else {
      this.#terminal.resize(cols, rows);
    }
    this.#scheduler.noteCellChange();
    this.#scheduler.maybeYield();
  }

  #latchedExitResult(): WaitExitResult {
    const result: WaitExitResult = { exited: true };
    if (this.#exitCode !== undefined) result.exitCode = this.#exitCode;
    if (this.#signal !== undefined) result.signal = this.#signal;
    return result;
  }

  #assertRunning(methodName: string): void {
    if (this.#disposed) throw new DisposedError("Runner");
    if (this.#exited) throw new ExitedError(methodName);
  }

  async [Symbol.asyncDispose](): Promise<void> {
    if (this.#disposed) return;

    this.#scheduler.dispose();
    this.#writeQueue.dispose();

    if (!this.#exited) {
      try { this.#proc.kill("SIGKILL"); } catch { /* ignore */ }
      // Race exit against a 2s ceiling so dispose can never hang.
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, 2000);
      });
      try {
        await Promise.race([this.#proc.exited.then(() => {}), timeout]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    }

    try { this.#pty.close(); } catch { /* ignore */ }
    try { this.#renderState[Symbol.dispose](); } catch { /* ignore */ }
    try { this.#encoder[Symbol.dispose](); } catch { /* ignore */ }
    try { this.#terminal[Symbol.dispose](); } catch { /* ignore */ }

    this.#disposed = true;
  }
}
