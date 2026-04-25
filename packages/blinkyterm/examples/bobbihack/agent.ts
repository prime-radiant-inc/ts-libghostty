import type { BotMove } from "../shared/keymap";
import type { FrameReason } from "../../src/types";

/** A move the agent can decide to execute, plus a clean-quit option. */
export type AgentDecision = BotMove | "quit";

export interface AgentInput {
  readonly turn: number;
  readonly frameReason: FrameReason;
  /** ANSI rendering of the current NetHack screen (`frame.snapshot.toAnsi()`). */
  readonly screenAnsi: string;
}

export type AgentEvent =
  | { readonly kind: "thinking"; readonly delta: string }
  | { readonly kind: "action"; readonly move: AgentDecision }
  | { readonly kind: "error"; readonly message: string };

export interface Agent {
  readonly name: string;
  /**
   * Stream zero or more `thinking` events, then exactly one terminator
   * (`action` or `error`). Honor `signal` for mid-turn cancellation.
   */
  decide(input: AgentInput, signal: AbortSignal): AsyncIterable<AgentEvent>;
  [Symbol.asyncDispose]?(): Promise<void>;
}
