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
