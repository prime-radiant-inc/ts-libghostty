import { mulberry32 } from "../../shared/mulberry32";
import type { Agent, AgentDecision, AgentEvent, AgentInput } from "../agent";

const PHRASES = [
  "Looking at the corridor.",
  "There's a creature nearby.",
  "I should explore further.",
  "Picking a direction.",
  "Considering my options.",
  "The wall blocks the way.",
  "Stepping carefully.",
];

const MOVES: AgentDecision[] = ["north", "south", "east", "west", "search", "pickup"];

export interface MockAgentOptions {
  seed?: number;
  gapMs?: number;        // default 80
  minThoughts?: number;  // default 2
  maxThoughts?: number;  // default 4
}

export class MockAgent implements Agent {
  readonly name = "mock";
  readonly #rng: () => number;
  readonly #gapMs: number;
  readonly #minThoughts: number;
  readonly #maxThoughts: number;

  constructor(opts: MockAgentOptions = {}) {
    this.#rng = mulberry32(opts.seed ?? 42);
    // 250ms default gives the spectator a beat to read each delta.
    // Tests pass `gapMs: 0` to keep the suite snappy.
    this.#gapMs = opts.gapMs ?? 250;
    this.#minThoughts = opts.minThoughts ?? 2;
    this.#maxThoughts = opts.maxThoughts ?? 4;
  }

  async *decide(_input: AgentInput, signal: AbortSignal): AsyncIterable<AgentEvent> {
    const span = this.#maxThoughts - this.#minThoughts + 1;
    const n = this.#minThoughts + Math.floor(this.#rng() * span);
    for (let i = 0; i < n; i++) {
      if (signal.aborted) return;
      const phrase = PHRASES[Math.floor(this.#rng() * PHRASES.length)] ?? "Thinking.";
      yield { kind: "thinking", delta: phrase + " " };
      if (this.#gapMs > 0) await sleep(this.#gapMs, signal);
      if (signal.aborted) return;
    }
    if (signal.aborted) return;
    const move = MOVES[Math.floor(this.#rng() * MOVES.length)] ?? "search";
    yield { kind: "action", move };
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(t);
      resolve();
    }, { once: true });
  });
}
