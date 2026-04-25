import { KeyEncoder, RenderState, Terminal } from "libghostty-vt";

import { DisposedError, SpawnError } from "./errors";
import type { SpawnOptions } from "./types";
import { realClock } from "./internal/clock";
import { Scheduler } from "./internal/scheduler";
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

  private constructor(args: {
    pty: BunTerminalLike;
    proc: BunSubprocessLike;
    terminal: Terminal;
    renderState: RenderState;
    encoder: KeyEncoder;
    scheduler: Scheduler;
    writeQueue: WriteQueue;
  }) {
    this.#pid = args.proc.pid;
    this.#pty = args.pty;
    this.#proc = args.proc;
    this.#terminal = args.terminal;
    this.#renderState = args.renderState;
    this.#encoder = args.encoder;
    this.#scheduler = args.scheduler;
    this.#writeQueue = args.writeQueue;
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
