// The conductor: one long-running messages.stream() call that drives the
// game via tool use. Implements the documented Anthropic SDK tool-use
// loop with retry/backoff, persisted messages, and well-formed
// tool_use/tool_result invariants under interruption.

import { writeFileSync } from "node:fs";
import {
  type AnthropicClient,
  type AssistantMessage,
  type ContentBlock,
  type StreamArgs,
  type ToolSchema,
  type ToolUseBlock,
  type UsageStats,
  isRecoverableApiError,
  nextBackoffSec,
  resetBackoff,
  type BackoffState,
} from "./client";
import type { ToolContext } from "./tool-context";
import { type RunLog } from "./observability";
import { accumulate, newCostState } from "./cost";

export type ToolHandler = (args: unknown, ctx: ToolContext) => Promise<string>;

// Event callbacks let the UI layer (main.ts) react to conductor lifecycle
// without coupling state.ts to the conductor's internal types.
export interface ConductorEvents {
  onAssistantMessageStart?: () => void;
  onTextDelta?: (delta: string) => void;
  onToolStart?: (name: string, args: unknown, turn: number) => void;
  onToolComplete?: (name: string, summary: string, turn: number) => void;
  onRunEnd?: (reason: string) => void;
}

export interface ConductorDeps {
  client: AnthropicClient;
  toolCtx: ToolContext;
  toolHandlers: Record<string, ToolHandler>;
  runLog: RunLog;
  systemPrompt: string;
  toolSchemas: ToolSchema[];
  messagesPath: string;
  model: string;
  // First user message — required by Anthropic's API; empty messages
  // arrays are rejected with HTTP 400. Typically the formatted starting
  // screen ("Game start. Here's what you see: ...").
  initialUserMessage: string;
  // Optional; tests inject a no-op sleeper. Production uses a real sleep.
  backoffSleeper?: (sec: number) => Promise<void>;
  events?: ConductorEvents;
}

interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

type Message =
  | { role: "user"; content: unknown[] | string }
  | { role: "assistant"; content: ContentBlock[] };

const SYSTEM_PROMPT_HASH_PREFIX = "sha256:";

function hashStringSync(s: string): string {
  // Simple synchronous hash via crypto
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { createHash } = require("node:crypto") as typeof import("node:crypto");
  return SYSTEM_PROMPT_HASH_PREFIX + createHash("sha256").update(s).digest("hex").slice(0, 16);
}

const defaultSleeper = (sec: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, sec * 1000));

export async function runConductor(deps: ConductorDeps): Promise<void> {
  const {
    client,
    toolCtx,
    toolHandlers,
    runLog,
    systemPrompt,
    toolSchemas,
    messagesPath,
    model,
    initialUserMessage,
    backoffSleeper = defaultSleeper,
    events,
  } = deps;
  const messages: Message[] = [
    { role: "user", content: initialUserMessage },
  ];
  const backoff: BackoffState = { attempt: 0 };
  const cost = newCostState();
  const runId = `run-${Date.now()}`;

  runLog.append({
    event: "run_start",
    runId,
    model,
    systemPromptHash: hashStringSync(systemPrompt),
    specVersion: "v4",
    toolSchemaHash: hashStringSync(JSON.stringify(toolSchemas)),
  });

  let turnCounter = 0;

  try {
    while (
      !toolCtx.signal.aborted &&
      !toolCtx.runState.gameOver
    ) {
      let final: AssistantMessage;
      try {
        events?.onAssistantMessageStart?.();
        const args: StreamArgs = {
          model,
          max_tokens: 1024,
          system: [
            {
              type: "text",
              text: systemPrompt,
              cache_control: { type: "ephemeral", ttl: "1h" },
            },
          ],
          tools: toolSchemas,
          messages: messages as unknown[],
        };
        const stream = client.messages.stream(args);
        stream.on("text", (delta) => events?.onTextDelta?.(delta));
        final = await stream.finalMessage();
        resetBackoff(backoff);
      } catch (err) {
        if (!isRecoverableApiError(err)) {
          runLog.append({
            event: "error",
            errorClass: "non_recoverable",
            message: (err as Error).message ?? String(err),
            fatal: true,
          });
          throw err;
        }
        const sec = nextBackoffSec(backoff);
        if (sec === null) {
          runLog.append({
            event: "error",
            errorClass: "retry_exhausted",
            message: (err as Error).message ?? String(err),
            fatal: true,
          });
          throw err;
        }
        const status = (err as { status?: number }).status;
        runLog.append({
          event: "retry",
          attempt: backoff.attempt,
          delaySec: sec,
          errorClass: status === 429 ? "rate_limit" : "server_error",
          ...(status !== undefined ? { statusCode: status } : {}),
        });
        await backoffSleeper(sec);
        continue;
      }

      // Append assistant message verbatim.
      messages.push({ role: "assistant", content: final.content });
      accumulate(cost, model, final.usage);

      const toolUses: ToolUseBlock[] = final.content.filter(
        (b): b is ToolUseBlock => b.type === "tool_use",
      );

      if (toolUses.length === 0) {
        // Model emitted only text → graceful end.
        toolCtx.runState.gameOver = true;
        toolCtx.runState.endReason = "model_stopped_without_tool_use";
        await persistMessages(messagesPath, messages);
        break;
      }

      // Execute every tool_use. INVARIANT: every tool_use needs a matching
      // tool_result. If we abort or the game ends mid-batch, synthesize
      // stub results for the unexecuted tools so the persisted log stays
      // well-formed (Anthropic API requires this).
      const toolResults: ToolResultBlock[] = [];
      let stopBatchEarly = false;

      for (const tu of toolUses) {
        if (stopBatchEarly) {
          toolResults.push({
            type: "tool_result",
            tool_use_id: tu.id,
            content: "[skipped: prior tool ended the run or aborted]",
            is_error: true,
          });
          continue;
        }
        if (toolCtx.signal.aborted) {
          toolResults.push({
            type: "tool_result",
            tool_use_id: tu.id,
            content: "[skipped: user aborted]",
            is_error: true,
          });
          stopBatchEarly = true;
          continue;
        }
        const handler = toolHandlers[tu.name];
        if (handler === undefined) {
          toolResults.push({
            type: "tool_result",
            tool_use_id: tu.id,
            content: JSON.stringify({ error: `unknown tool: ${tu.name}` }),
            is_error: true,
          });
          continue;
        }
        try {
          turnCounter += 1;
          events?.onToolStart?.(tu.name, tu.input, turnCounter);
          const content = await handler(tu.input, toolCtx);
          toolResults.push({
            type: "tool_result",
            tool_use_id: tu.id,
            content,
          });
          const summary = extractSummary(content);
          events?.onToolComplete?.(tu.name, summary, turnCounter);
          runLog.append({
            event: "turn",
            turn: turnCounter,
            tool: tu.name,
            args: tu.input,
            summary,
            screenHash: "",  // populated in Phase 8 (compaction also uses it)
            usage: final.usage,
          });
          if (toolCtx.runState.gameOver) stopBatchEarly = true;
          if (toolCtx.signal.aborted) stopBatchEarly = true;
        } catch (err) {
          toolResults.push({
            type: "tool_result",
            tool_use_id: tu.id,
            content: JSON.stringify({
              error: `tool ${tu.name} threw: ${(err as Error).message ?? String(err)}`,
            }),
            is_error: true,
          });
        }
      }

      messages.push({ role: "user", content: toolResults });
      await persistMessages(messagesPath, messages);

      // (Phase 8 inserts maybeCompact here.)
    }
  } finally {
    const endReason = toolCtx.runState.endReason ?? (toolCtx.signal.aborted ? "aborted" : "exited");
    events?.onRunEnd?.(endReason);
    runLog.append({
      event: "run_end",
      reason: endReason,
      totalTurns: turnCounter,
      totalCostUsd: cost.totalUsd,
    });
    runLog.close();
  }
}

async function persistMessages(path: string, messages: Message[]): Promise<void> {
  // Atomic-ish: write directly. Phase 8 may upgrade to temp+rename.
  writeFileSync(path, JSON.stringify(messages, null, 2));
}

function extractSummary(content: string): string {
  // The conventional layout: header on line 1, summary on line 2.
  const lines = content.split("\n");
  if (lines[0]?.startsWith("== bobbihack tool_result v1 ==") && lines[1] !== undefined) {
    return lines[1];
  }
  // Fall back to the first non-empty line.
  for (const l of lines) {
    const t = l.trim();
    if (t.length > 0) return t;
  }
  return "";
}
