// run.jsonl writer — append-only structured event log for forensic
// debugging of long-running games.

import { appendFileSync, openSync, closeSync, writeSync } from "node:fs";

export interface RunStartEvent {
  event: "run_start";
  runId: string;
  model: string;
  systemPromptHash: string;
  specVersion: string;
  toolSchemaHash: string;
}

export interface TurnEvent {
  event: "turn";
  turn: number;
  tool: string;
  args: unknown;
  summary: string;
  screenHash: string;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens: number;
    cache_creation_input_tokens: number;
  };
}

export interface CompactionEvent {
  event: "compaction";
  compactedThroughTurn: number;
  liveTailSize: number;
  messagesBefore: number;
  messagesAfter: number;
  snapshotPath: string;
}

export interface RetryEvent {
  event: "retry";
  attempt: number;
  delaySec: number;
  errorClass: string;
  statusCode?: number;
}

export interface InterruptEvent {
  event: "interrupt";
  tool: string;
  kind: string;
  detail: string | undefined;
  also: string[];
}

export interface ErrorEvent {
  event: "error";
  errorClass: string;
  message: string;
  fatal: boolean;
}

export interface RunEndEvent {
  event: "run_end";
  reason: string;
  totalTurns: number;
  totalCostUsd: number;
}

export type RunEvent =
  | RunStartEvent
  | TurnEvent
  | CompactionEvent
  | RetryEvent
  | InterruptEvent
  | ErrorEvent
  | RunEndEvent;

export class RunLog {
  #fd: number | null;
  #path: string;

  constructor(path: string) {
    this.#path = path;
    this.#fd = openSync(path, "a");
  }

  append(event: RunEvent): void {
    if (this.#fd === null) {
      // Lazily reopen if closed unexpectedly.
      this.#fd = openSync(this.#path, "a");
    }
    const stamped = { ...event, ts: new Date().toISOString() };
    const line = JSON.stringify(stamped) + "\n";
    writeSync(this.#fd, line);
  }

  close(): void {
    if (this.#fd !== null) {
      closeSync(this.#fd);
      this.#fd = null;
    }
  }
}

// Convenience: append-only single-event helper for callers that don't
// want to manage file handles.
export function appendRunEvent(path: string, event: RunEvent): void {
  const stamped = { ...event, ts: new Date().toISOString() };
  appendFileSync(path, JSON.stringify(stamped) + "\n");
}
