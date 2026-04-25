import type { Clock, FrameReason } from "../types";
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
