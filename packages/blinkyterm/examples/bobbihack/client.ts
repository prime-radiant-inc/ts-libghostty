// Anthropic SDK abstraction. Production uses RealAnthropicClient (lazy
// import of @anthropic-ai/sdk). Tests + dry-run smoke use
// MockAnthropicClient (scripted plan, no network).

export type StopReason =
  | "end_turn"
  | "max_tokens"
  | "tool_use"
  | "stop_sequence"
  | "pause_turn";

export interface TextBlock {
  type: "text";
  text: string;
}

export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
}

export type ContentBlock = TextBlock | ToolUseBlock;

export interface UsageStats {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
}

export interface AssistantMessage {
  role: "assistant";
  content: ContentBlock[];
  stop_reason: StopReason;
  usage: UsageStats;
}

export interface CacheControl {
  type: "ephemeral";
  ttl?: "5m" | "1h";
}

export interface SystemBlock {
  type: "text";
  text: string;
  cache_control?: CacheControl;
}

export interface ToolSchema {
  name: string;
  description?: string;
  input_schema: object;
}

export interface StreamArgs {
  model: string;
  max_tokens: number;
  system: SystemBlock[];
  tools: ToolSchema[];
  messages: unknown[];
}

export interface StreamHandle {
  on(event: "text", cb: (delta: string) => void): void;
  finalMessage(): Promise<AssistantMessage>;
}

export interface AnthropicClient {
  messages: {
    stream(args: StreamArgs): StreamHandle;
  };
}

// MockAnthropicClient ------------------------------------------------

export interface ScriptedTurn {
  text?: string;
  toolUses?: { name: string; input: unknown }[];
  usage?: UsageStats;
  error?: { status?: number; code?: string; message: string };
}

export class MockAnthropicClient implements AnthropicClient {
  #plan: ScriptedTurn[];
  #idx = 0;

  constructor(plan: ScriptedTurn[]) {
    this.#plan = plan;
  }

  messages = {
    stream: (_args: StreamArgs): StreamHandle => {
      const turn = this.#plan[this.#idx];
      this.#idx += 1;
      const textCallbacks: ((delta: string) => void)[] = [];

      const handle: StreamHandle = {
        on: (event, cb) => {
          if (event === "text") textCallbacks.push(cb);
        },
        finalMessage: async () => {
          await Promise.resolve();  // microtask flush so .on() can register first

          if (turn === undefined) {
            return {
              role: "assistant",
              content: [],
              stop_reason: "end_turn",
              usage: emptyUsage(),
            };
          }

          if (turn.error !== undefined) {
            const err = new Error(turn.error.message) as Error & {
              status?: number;
              code?: string;
            };
            if (turn.error.status !== undefined) err.status = turn.error.status;
            if (turn.error.code !== undefined) err.code = turn.error.code;
            throw err;
          }

          if (turn.text !== undefined && turn.text !== "") {
            for (const cb of textCallbacks) cb(turn.text);
          }

          const content: ContentBlock[] = [];
          if (turn.text !== undefined && turn.text !== "") {
            content.push({ type: "text", text: turn.text });
          }
          for (const tu of turn.toolUses ?? []) {
            content.push({
              type: "tool_use",
              id: `mock-${Math.random().toString(36).slice(2, 10)}`,
              name: tu.name,
              input: tu.input,
            });
          }
          const stop_reason: StopReason =
            content.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn";

          return {
            role: "assistant",
            content,
            stop_reason,
            usage: turn.usage ?? emptyUsage(),
          };
        },
      };
      return handle;
    },
  };
}

function emptyUsage(): UsageStats {
  return {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  };
}

// RealAnthropicClient — thin pass-through, lazy SDK import. -------------

export interface RealClientOpts {
  apiKey: string;
}

export async function createRealAnthropicClient(opts: RealClientOpts): Promise<AnthropicClient> {
  const mod = await import("@anthropic-ai/sdk").catch(() => null);
  if (mod === null) {
    throw new Error("@anthropic-ai/sdk is not installed");
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const Anthropic = (mod as any).default ?? mod;
  const sdk = new Anthropic({ apiKey: opts.apiKey });
  return {
    messages: {
      stream: (args: StreamArgs) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const sdkStream = sdk.messages.stream(args as any);
        const handle: StreamHandle = {
          on: (event, cb) => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            sdkStream.on(event as any, cb as any);
          },
          finalMessage: async () => {
            const m = await sdkStream.finalMessage();
            return m as AssistantMessage;
          },
        };
        return handle;
      },
    },
  };
}

// Backoff & error classification --------------------------------------

export interface BackoffState {
  attempt: number;
}

const BACKOFF_SCHEDULE = [1, 2, 4, 8, 16];

export function nextBackoffSec(state: BackoffState): number | null {
  if (state.attempt >= BACKOFF_SCHEDULE.length) return null;
  const v = BACKOFF_SCHEDULE[state.attempt]!;
  state.attempt += 1;
  return v;
}

export function resetBackoff(state: BackoffState): void {
  state.attempt = 0;
}

export function isRecoverableApiError(err: unknown): boolean {
  if (err === null || typeof err !== "object") return false;
  const e = err as { status?: unknown; code?: unknown; name?: unknown };
  if (typeof e.status === "number") {
    if (e.status >= 500 && e.status < 600) return true;
    if (e.status === 429) return true;
    return false;
  }
  if (typeof e.code === "string") {
    if (
      e.code === "ECONNRESET" ||
      e.code === "ETIMEDOUT" ||
      e.code === "ENETUNREACH" ||
      e.code === "EAI_AGAIN"
    ) {
      return true;
    }
  }
  if (typeof e.name === "string") {
    // Anthropic SDK error subclasses.
    if (e.name === "RateLimitError" || e.name === "APIConnectionError" || e.name === "APIConnectionTimeoutError") {
      return true;
    }
  }
  return false;
}
