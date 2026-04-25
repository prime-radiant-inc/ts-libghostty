import type { Clock, ClockTimer, FrameOptions, FrameReason } from "../types";
import { makeDeferred, type Deferred } from "./deferred";

export interface SchedulerSnapshot {
  pendingReasons: FrameReason[];
  bellsSinceLast: number;
  titleChangesSinceLast: string[];
  exitCode?: number;
  signal?: NodeJS.Signals;
}

export const PRIORITY_ORDER: readonly FrameReason[] = [
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

const DEFAULT_FRAME_OPTIONS: Required<FrameOptions> = {
  minIntervalMs: 1000,
  maxIntervalMs: 30000,
  quiesceMs: 100,
  yieldOn: ["cellChange", "titleChange", "bell"],
};

export class Scheduler {
  readonly #clock: Clock;
  readonly #frame: Required<FrameOptions>;
  #readyToYield = false;
  #yieldSignal: Deferred<void> = makeDeferred<void>();
  #pendingReasons = new Set<FrameReason>();
  #bellsSinceLast = 0;
  #titleChangesSinceLast: string[] = [];
  #lastYieldAt: number;
  #exitCode: number | undefined;
  #signal: NodeJS.Signals | undefined;
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
    this.#restartHeartbeat();
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
