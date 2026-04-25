import type { Agent, AgentDecision, AgentEvent, AgentInput } from "../agent";

const VALID_DECISIONS = new Set<AgentDecision>([
  "north", "south", "east", "west", "search", "pickup", "quit",
]);

// Trimmed shape of the @anthropic-ai/sdk stream events we care about.
// Defined locally so the test suite can construct synthetic streams
// without pulling the SDK as a dev dep.
export type RawStreamEvent =
  | { type: "content_block_start"; content_block: { type: "tool_use"; name: string; id: string } | { type: "text"; text?: string } }
  | { type: "content_block_delta"; delta: { type: "text_delta"; text: string } | { type: "input_json_delta"; partial_json: string } }
  | { type: "content_block_stop" }
  | { type: "message_start" | "message_delta" | "message_stop"; [k: string]: unknown };

interface ToolBuffer {
  name: string;
  jsonChunks: string[];
}

export async function* streamToAgentEvents(
  raw: AsyncIterable<RawStreamEvent>,
): AsyncIterable<AgentEvent> {
  let pendingTool: ToolBuffer | null = null;
  let actionEmitted = false;

  for await (const event of raw) {
    if (actionEmitted) continue;

    if (event.type === "content_block_start") {
      if (event.content_block.type === "tool_use") {
        pendingTool = { name: event.content_block.name, jsonChunks: [] };
      }
      continue;
    }

    if (event.type === "content_block_delta") {
      if (event.delta.type === "text_delta") {
        if (event.delta.text.length > 0) {
          yield { kind: "thinking", delta: event.delta.text };
        }
      } else if (event.delta.type === "input_json_delta" && pendingTool !== null) {
        pendingTool.jsonChunks.push(event.delta.partial_json);
      }
      continue;
    }

    if (event.type === "content_block_stop") {
      if (pendingTool !== null && pendingTool.name === "move") {
        const out = parseMoveTool(pendingTool.jsonChunks.join(""));
        yield out;
        actionEmitted = true;
        pendingTool = null;
      }
      continue;
    }
  }

  if (!actionEmitted) {
    yield { kind: "error", message: "stream ended without a move" };
  }
}

function parseMoveTool(json: string): AgentEvent {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (e) {
    return { kind: "error", message: `invalid tool input JSON: ${(e as Error).message}` };
  }
  if (typeof parsed !== "object" || parsed === null || !("move" in parsed)) {
    return { kind: "error", message: "tool input missing 'move' field" };
  }
  const move = (parsed as { move: unknown }).move;
  if (typeof move !== "string" || !VALID_DECISIONS.has(move as AgentDecision)) {
    return { kind: "error", message: `unknown move: ${String(move)}` };
  }
  return { kind: "action", move: move as AgentDecision };
}

export interface AnthropicAgentOptions {
  apiKey: string;
  model?: string;
  systemPrompt?: string;
}

const DEFAULT_MODEL = "claude-haiku-4-5";

const DEFAULT_SYSTEM = `You are an agent playing NetHack. Each turn you receive the current screen as ANSI text. Briefly explain what you observe and what you plan to do (1–3 short sentences), then call the \`move\` tool exactly once with one of: north, south, east, west, search, pickup, quit. Do not call the tool more than once per turn.`;

const MOVE_TOOL = {
  name: "move",
  description: "Commit one move for this turn.",
  input_schema: {
    type: "object" as const,
    properties: {
      move: {
        type: "string",
        enum: ["north", "south", "east", "west", "search", "pickup", "quit"],
      },
    },
    required: ["move"],
  },
};

export class AnthropicAgent implements Agent {
  readonly name: string;
  readonly #model: string;
  readonly #system: string;
  readonly #apiKey: string;
  // SDK client is created lazily in decide() so importing this module
  // doesn't require @anthropic-ai/sdk to be installed.
  #client: { messages: { stream: (req: unknown) => AsyncIterable<RawStreamEvent> } } | null = null;

  constructor(opts: AnthropicAgentOptions) {
    this.#apiKey = opts.apiKey;
    this.#model = opts.model ?? DEFAULT_MODEL;
    this.#system = opts.systemPrompt ?? DEFAULT_SYSTEM;
    this.name = `anthropic ${this.#model}`;
  }

  async *decide(input: AgentInput, signal: AbortSignal): AsyncIterable<AgentEvent> {
    if (this.#client === null) {
      const mod = await import("@anthropic-ai/sdk").catch(() => null);
      if (mod === null) {
        yield { kind: "error", message: "@anthropic-ai/sdk not installed" };
        return;
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const Anthropic = (mod as any).default ?? mod;
      this.#client = new Anthropic({ apiKey: this.#apiKey });
    }

    const userText = `Turn ${input.turn} (waking on: ${input.frameReason}). Current screen:\n\n${input.screenAnsi}`;
    const stream = this.#client!.messages.stream({
      model: this.#model,
      max_tokens: 1024,
      system: this.#system,
      tools: [MOVE_TOOL],
      messages: [{ role: "user", content: userText }],
    });

    const cancellableStream = abortableStream<RawStreamEvent>(stream, signal);
    yield* streamToAgentEvents(cancellableStream);
  }
}

async function* abortableStream<T>(
  source: AsyncIterable<T>,
  signal: AbortSignal,
): AsyncIterable<T> {
  for await (const item of source) {
    if (signal.aborted) return;
    yield item;
  }
}
