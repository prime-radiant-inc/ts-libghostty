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
  isRecoverableApiError,
  nextBackoffSec,
  resetBackoff,
  type BackoffState,
} from "./client";
import type { ToolContext } from "./tool-context";
import { type RunLog } from "./observability";
import { accumulate, newCostState, formatCostLine, shouldStopForBudget, type CostState } from "./cost";
import {
  maybeCompact,
  type CompactionMessage,
  type CompactionRunState,
  type MaybeCompactCtx,
} from "./compaction";

export type ToolHandler = (args: unknown, ctx: ToolContext) => Promise<string>;

// Event callbacks let the UI layer (main.ts) react to conductor lifecycle
// without coupling state.ts to the conductor's internal types.
export interface ConductorEvents {
  onAssistantMessageStart?: () => void;
  onTextDelta?: (delta: string) => void;
  onToolStart?: (name: string, args: unknown, turn: number) => void;
  // In-progress detail from a tool that opted into progress reporting
  // (autopilot_explore etc.). Fires zero or more times between the
  // matching onToolStart and onToolComplete. UI surfaces this as the
  // agent-pane status detail.
  onToolProgress?: (name: string, detail: string, turn: number) => void;
  onToolComplete?: (name: string, summary: string, turn: number) => void;
  onRunEnd?: (reason: string) => void;
  // Phase 8: per-turn cost summary line, e.g.
  //   "tokens: in 1.2k (cache 8.0k) / out 56 — turn cost ~$0.003 — total $0.42"
  // The UI surfaces this in the agent-pane title.
  onCostUpdate?: (line: string, state: CostState) => void;
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
  // Phase 8 — compaction is enabled when messagesDir is supplied.
  // Tests that don't care about compaction can omit this; production
  // (main.ts) always passes the per-run snapshot directory.
  messagesDir?: string;
  // Optional override for the model's context window in tokens.
  // Defaults to 200_000 (haiku-4-5 / sonnet-4-6 effective window).
  contextWindow?: number;
}

interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

type Message = CompactionMessage;

// Project the compaction module's _cacheControl annotation onto
// the wire format. Anthropic's API accepts cache_control on a content
// BLOCK (not on the message itself), so we tag the LAST content block
// of the marked message. For messages with string content, we wrap
// the string in a single text block so we can attach the marker.
function projectMessagesForWire(messages: Message[]): unknown[] {
  return messages.map((m) => {
    if (m._cacheControl === undefined) {
      // Strip private annotations even if absent — keeps downstream
      // shape stable.
      return { role: m.role, content: m.content };
    }
    const cc = m._cacheControl;
    if (typeof m.content === "string") {
      return {
        role: m.role,
        content: [
          { type: "text", text: m.content, cache_control: cc },
        ],
      };
    }
    // Array content: clone and stamp cache_control on the LAST block.
    const blocks = m.content.map((b) => ({ ...b }));
    if (blocks.length > 0) {
      const last = blocks[blocks.length - 1] as Record<string, unknown>;
      last["cache_control"] = cc;
    }
    return { role: m.role, content: blocks };
  });
}

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
  let messages: Message[] = [
    { role: "user", content: initialUserMessage },
  ];
  const backoff: BackoffState = { attempt: 0 };
  const cost = newCostState();
  const runId = `run-${Date.now()}`;
  const compactionRunState: CompactionRunState = {
    turn: 0,
    lastCompactionTurn: 0,
    compactionSeq: 0,
  };
  const compactionEnabled = deps.messagesDir !== undefined;
  const compactionCtx: MaybeCompactCtx | null = compactionEnabled
    ? {
        runDir: deps.messagesDir!,
        runLog,
        contextWindow: deps.contextWindow ?? 200_000,
      }
    : null;

  runLog.append({
    event: "run_start",
    runId,
    model,
    systemPromptHash: hashStringSync(systemPrompt),
    specVersion: "v4",
    toolSchemaHash: hashStringSync(JSON.stringify(toolSchemas)),
  });

  let turnCounter = 0;
  // Tracks consecutive turns where the model emitted text but no
  // tool_use because it hit the max_tokens cap mid-thought. We
  // recover by injecting a corrective user message and retrying;
  // capped at 2 consecutive recoveries so a stuck model can't burn
  // budget forever in a "think → truncate → retry" loop.
  let consecutiveMaxTokensRecoveries = 0;

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
          // 4096 gives the model room to think (a few hundred
          // tokens of reasoning) AND emit a tool_use without
          // truncating. Production run bbh-20260508-195541-f530f3
          // hit the prior 1024 cap mid-monologue at turn 116 and
          // ended the run prematurely. max_tokens is an UPPER
          // bound, not a target — typical turns use 100-700.
          max_tokens: 4096,
          system: [
            {
              type: "text",
              text: systemPrompt,
              cache_control: { type: "ephemeral", ttl: "1h" },
            },
          ],
          tools: toolSchemas,
          messages: projectMessagesForWire(messages),
        };
        const stream = client.messages.stream(args);
        stream.on("text", (delta) => events?.onTextDelta?.(delta));
        final = await stream.finalMessage();
        resetBackoff(backoff);
      } catch (err) {
        // Phase 8: 400 invalid_request_error (typically context-length
        // overflow) → force-compact aggressively (K=5) and retry once
        // before falling through to the normal recoverable-error path.
        if (compactionCtx !== null && isContextOverflow400(err)) {
          runLog.append({
            event: "error",
            errorClass: "context_overflow",
            message: (err as Error).message ?? String(err),
            fatal: false,
          });
          compactionRunState.turn = turnCounter;
          messages = (await maybeCompact(
            messages,
            compactionRunState,
            compactionCtx,
            { force: true },
          )) as Message[];
          continue; // retry the stream call with the compacted history
        }
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
      messages.push({ role: "assistant", content: final.content as ContentBlock[] });
      accumulate(cost, model, final.usage);
      events?.onCostUpdate?.(formatCostLine(cost), cost);

      // Hard budget kill switch (BOBBIHACK_MAX_USD).
      if (shouldStopForBudget(cost)) {
        toolCtx.runState.gameOver = true;
        toolCtx.runState.endReason = "budget_exhausted";
        await persistMessages(messagesPath, messages);
        break;
      }

      const toolUses: ToolUseBlock[] = final.content.filter(
        (b): b is ToolUseBlock => b.type === "tool_use",
      );

      if (toolUses.length === 0) {
        // Two cases. (a) stop_reason === "max_tokens": model was
        // mid-thought and got truncated before reaching a
        // tool_use. Inject a corrective user message and continue;
        // capped to prevent infinite loops. (b) stop_reason ===
        // "end_turn": model genuinely decided to stop. Treat as a
        // graceful end (typically only happens after a `quit` or
        // similar tool call has already executed).
        if (final.stop_reason === "max_tokens") {
          if (consecutiveMaxTokensRecoveries >= 2) {
            // Repeated truncation → likely a runaway monologue.
            // Surface as a distinct end reason so it shows up in
            // run.jsonl and the user knows to look at the prompt.
            toolCtx.runState.gameOver = true;
            toolCtx.runState.endReason = "max_tokens_recoveries_exhausted";
            await persistMessages(messagesPath, messages);
            break;
          }
          consecutiveMaxTokensRecoveries += 1;
          runLog.append({
            event: "max_tokens_recovery",
            attempt: consecutiveMaxTokensRecoveries,
          });
          messages.push({
            role: "user",
            content: [
              {
                type: "text",
                text: "Your previous response was truncated before you could call a tool. Be concise — at most 2-3 sentences of reasoning, then end with a tool call.",
              },
            ],
          });
          continue;
        }
        toolCtx.runState.gameOver = true;
        toolCtx.runState.endReason = "model_stopped_without_tool_use";
        await persistMessages(messagesPath, messages);
        break;
      }
      // Reset the recovery counter on any successful tool_use turn.
      consecutiveMaxTokensRecoveries = 0;

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

          // Hand the tool a per-call progress reporter that relays to
          // events.onToolProgress with the current tool name + turn.
          // Cleared after the handler returns so callbacks from a
          // previously-running tool can't race onto the next call.
          const turnAtStart = turnCounter;
          toolCtx.reportProgress = (detail: string): void => {
            events?.onToolProgress?.(tu.name, detail, turnAtStart);
          };
          let content: string;
          try {
            content = await handler(tu.input, toolCtx);
          } finally {
            delete toolCtx.reportProgress;
          }
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

      // Phase 8: compaction check after each tool batch + persist.
      // Returns the same array reference if no trigger fired.
      if (compactionCtx !== null) {
        compactionRunState.turn = turnCounter;
        messages = (await maybeCompact(
          messages,
          compactionRunState,
          compactionCtx,
        )) as Message[];
      }
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

// Detect Anthropic's "context_length_exceeded" / 400 invalid_request_error
// shape so the conductor can force-compact before retrying. The SDK
// surfaces these as 400-status errors with a message that mentions the
// context window. Be conservative: only return true if status is 400
// AND the message hints at a length problem.
function isContextOverflow400(err: unknown): boolean {
  if (err === null || typeof err !== "object") return false;
  const e = err as { status?: unknown; message?: unknown; type?: unknown };
  if (e.status !== 400) return false;
  const msg = typeof e.message === "string" ? e.message.toLowerCase() : "";
  if (
    msg.includes("context") ||
    msg.includes("too long") ||
    msg.includes("max_tokens") ||
    msg.includes("token") ||
    msg.includes("invalid_request_error")
  ) {
    return true;
  }
  // Some SDK shapes carry the structured 'type' field.
  if (typeof e.type === "string" && e.type === "invalid_request_error") return true;
  return false;
}
