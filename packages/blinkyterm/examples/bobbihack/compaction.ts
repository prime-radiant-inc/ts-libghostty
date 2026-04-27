// Compaction module — Phase 8.
//
// Layered defense against unbounded message-array growth in long
// runs. Five small composable units plus an orchestrator:
//
//   summarizeOldToolResult — replace a verbose tool_result.content
//     with a one-line stub.
//   placeBreakpoints       — set cache_control on the post-compaction
//     boundary message (B2). The system-prompt block (B1) is set by
//     the conductor at the StreamArgs level, not here.
//   injectCompactionMarker — synthetic user message at the boundary;
//     idempotent.
//   writeSnapshot          — atomic full-snapshot writer; honors
//     BOBBIHACK_KEEP_SNAPSHOTS retention.
//   maybeCompact           — orchestrator: triggers, sub-function
//     composition, RunLog event emission.
//
// The Message type here intentionally tolerates the union-of-shapes
// the conductor uses (string content for plain user messages, array
// content for tool_result-bearing user messages, ContentBlock[] for
// assistant messages). Compaction operates structurally — it doesn't
// need to know about every possible block kind.

import {
  writeFileSync,
  renameSync,
  unlinkSync,
  existsSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";
import type { RunLog } from "./observability";

// -------- Types --------

export interface ToolUseLike {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
}

export interface ToolResultLike {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

export interface TextBlockLike {
  type: "text";
  text: string;
}

export type CompactionContentBlock = ToolUseLike | ToolResultLike | TextBlockLike;

// Optional internal annotations (cache_control marker for B2). These
// are NOT part of the Anthropic API surface — the conductor maps them
// to the SDK's per-block cache_control option when assembling
// StreamArgs.
export interface CompactionMessage {
  role: "user" | "assistant";
  content: string | CompactionContentBlock[];
  // _cacheControl: B2 marker. Stripped before sending if your wire
  // serialization disallows extras. Anthropic's SDK ignores unknown
  // top-level message fields in practice.
  _cacheControl?: { type: "ephemeral"; ttl: "5m" | "1h" };
}

export interface CompactionRunState {
  turn: number;
  lastCompactionTurn: number;
  compactionSeq: number;
}

export interface MaybeCompactCtx {
  runDir: string;
  runLog: RunLog;
  contextWindow: number; // tokens; default 200_000 for haiku-4-5/sonnet-4-6
}

export interface MaybeCompactOptions {
  force?: boolean;
}

// Public constants used by tests + main.ts.
export const COMPACTION_MARKER_PREFIX =
  "NOTE: turns 1–";

const PERIODIC_INTERVAL = 50;
const TOKEN_BUDGET_RATIO = 0.8;
const DEFAULT_LIVE_TAIL = 20;
const FORCE_LIVE_TAIL = 5;

// -------- summarizeOldToolResult --------

// Build the args-summary that goes inside the parens. Designed to
// produce stable, short, human-readable strings for the common tool
// shapes the agent uses. For unknown shapes, falls back to a
// JSON.stringify (truncated).
function summarizeArgs(name: string, input: unknown): string {
  if (input === null || typeof input !== "object") return "";
  const obj = input as Record<string, unknown>;
  // Tool-specific shapes:
  switch (name) {
    case "move":
    case "kick":
    case "force_fight":
    case "throw": {
      const dir = obj["direction"];
      const count = obj["count"];
      const slot = obj["slot"];
      const parts: string[] = [];
      if (typeof slot === "string") parts.push(slot);
      if (typeof dir === "string") parts.push(dir);
      if (typeof count === "number" && count > 1) parts.push(`x${count}`);
      return parts.join(",");
    }
    case "autopilot_to": {
      const f = obj["floor"];
      const x = obj["x"];
      const y = obj["y"];
      return [f, x, y]
        .filter((v): v is string | number => v !== undefined && v !== null)
        .join(",");
    }
    case "autopilot_explore": {
      const f = obj["floor"];
      return typeof f === "string" ? f : "";
    }
    case "journal_read":
    case "journal_write": {
      const section = obj["section"];
      return typeof section === "string" ? section : "";
    }
    case "query_terrain": {
      const f = obj["floor"];
      return typeof f === "string" ? f : "";
    }
    case "respond_prompt":
    case "command":
    case "extended_command": {
      const keys = obj["keys"];
      const cmdName = obj["name"];
      const target = typeof cmdName === "string" ? cmdName : keys;
      if (typeof target === "string") {
        // Show escaped representation so spaces and control chars are
        // visible but the line stays short.
        return `'${escapeForStub(target)}'`;
      }
      return "";
    }
    case "eat":
    case "quaff":
    case "read":
    case "wear":
    case "puton":
    case "takeoff":
    case "remove":
    case "wield":
    case "drop":
    case "apply":
    case "zap": {
      const slot = obj["slot"];
      const dir = obj["direction"];
      const parts: string[] = [];
      if (typeof slot === "string") parts.push(slot);
      if (typeof dir === "string") parts.push(dir);
      return parts.join(",");
    }
    default: {
      // Generic fallback: stringify keys+values, cap to ~32 chars.
      try {
        const json = JSON.stringify(input);
        if (json.length <= 40) return json.slice(1, -1); // strip outer braces
        return json.slice(0, 36) + "...";
      } catch {
        return "?";
      }
    }
  }
}

function escapeForStub(s: string): string {
  // Render whitespace + control chars visibly; otherwise pass through.
  return s
    .replace(/\\/g, "\\\\")
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n")
    .replace(/\t/g, "\\t")
    .replace(/\x1b/g, "\\e");
}

function extractOutcomeSummary(oldContent: string, toolName: string): string {
  if (oldContent === "") return "";
  const lines = oldContent.split("\n");
  if (lines[0]?.startsWith("== bobbihack tool_result v1 ==") && lines[1] !== undefined) {
    let summary = lines[1].trim();
    // Heuristic: many handlers prefix their summary line with
    // "name(args): outcome" (e.g. "move(east): walked into a wall").
    // The stub already shows "name(args)" right before the colon, so
    // stripping that prefix avoids duplication. Only strip when the
    // prefix matches the tool name AND the line uses the colon form.
    const rx = new RegExp(`^${toolName}\\([^)]*\\):\\s*`);
    summary = summary.replace(rx, "");
    return summary;
  }
  // Try to parse JSON-shaped error contents.
  const trimmed = oldContent.trim();
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      if (typeof parsed["error"] === "string") return `error: ${parsed["error"]}`;
      if (typeof parsed["summary"] === "string") return parsed["summary"];
    } catch {
      // fall through
    }
  }
  for (const l of lines) {
    const t = l.trim();
    if (t.length > 0) return t;
  }
  return "";
}

export function summarizeOldToolResult(
  turnIdx: number,
  toolUse: ToolUseLike,
  oldContent: string,
): string {
  const args = summarizeArgs(toolUse.name, toolUse.input);
  const outcome = extractOutcomeSummary(oldContent, toolUse.name);
  return `<turn ${turnIdx} — ${toolUse.name}(${args}): ${outcome}>`;
}

// -------- placeBreakpoints --------

export function placeBreakpoints(
  messages: CompactionMessage[],
  liveTailStart: number,
): CompactionMessage[] {
  // Clone shallowly + strip prior _cacheControl, then set on the
  // first message at or after liveTailStart that exists in the
  // array. liveTailStart out of range = no B2.
  const result: CompactionMessage[] = messages.map((m) => {
    const clone: CompactionMessage = { role: m.role, content: m.content };
    // Intentionally do NOT carry over _cacheControl — placeBreakpoints
    // is the single source of truth for B2 placement.
    return clone;
  });
  if (liveTailStart >= 0 && liveTailStart < result.length) {
    const target = result[liveTailStart];
    if (target !== undefined) {
      target._cacheControl = { type: "ephemeral", ttl: "1h" };
    }
  }
  return result;
}

// -------- injectCompactionMarker --------

function buildMarkerText(throughTurn: number): string {
  return (
    `${COMPACTION_MARKER_PREFIX}${throughTurn} have been compacted. ` +
    `Their summaries remain inline. For full state, call journal_read(...) and ` +
    `query_terrain(...). Recent K turns are intact below.`
  );
}

function isCompactionMarker(m: CompactionMessage | undefined): boolean {
  if (m === undefined) return false;
  if (m.role !== "user") return false;
  if (typeof m.content !== "string") return false;
  return m.content.startsWith(COMPACTION_MARKER_PREFIX);
}

export function injectCompactionMarker(
  messages: CompactionMessage[],
  atIdx: number,
  throughTurn: number,
): CompactionMessage[] {
  const text = buildMarkerText(throughTurn);
  const marker: CompactionMessage = { role: "user", content: text };
  const out: CompactionMessage[] = messages.map((m) => ({
    role: m.role,
    content: m.content,
    ...(m._cacheControl !== undefined ? { _cacheControl: m._cacheControl } : {}),
  }));
  if (isCompactionMarker(out[atIdx])) {
    out[atIdx] = marker;
  } else {
    out.splice(atIdx, 0, marker);
  }
  return out;
}

// -------- writeSnapshot --------

export async function writeSnapshot(
  runDir: string,
  seqNum: number,
  messages: CompactionMessage[],
): Promise<string> {
  const padded = seqNum.toString().padStart(4, "0");
  const finalPath = join(runDir, `${padded}.json`);
  const tmpPath = join(runDir, `.${padded}.json.tmp`);

  const data = JSON.stringify(messages, null, 2);
  writeFileSync(tmpPath, data);
  renameSync(tmpPath, finalPath);

  // Retention: respect BOBBIHACK_KEEP_SNAPSHOTS=N. Default = keep all.
  const keepRaw = process.env.BOBBIHACK_KEEP_SNAPSHOTS;
  if (keepRaw !== undefined && keepRaw !== "") {
    const keep = Number.parseInt(keepRaw, 10);
    if (Number.isFinite(keep) && keep > 0) {
      const files = readdirSync(runDir)
        .filter((f) => /^\d{4}\.json$/.test(f))
        .sort();
      const toDelete = files.slice(0, Math.max(0, files.length - keep));
      for (const f of toDelete) {
        try {
          unlinkSync(join(runDir, f));
        } catch {
          // best-effort
        }
      }
    }
  }

  return finalPath;
}

// -------- estimateInputTokens --------

// Coarse estimator: total chars in the JSON-serialized messages
// divided by 4 (the conventional "characters per token" rule of
// thumb). This is intentionally cheap; more accurate counting would
// require Anthropic's tokenizer (not bundled). The 80%-of-window
// trigger has plenty of slack — the estimator can be off by 2× in
// either direction without breaking the trigger's correctness.
export function estimateInputTokens(messages: CompactionMessage[]): number {
  return Math.ceil(JSON.stringify(messages).length / 4);
}

// -------- maybeCompact orchestrator --------

function getLiveTail(): number {
  const raw = process.env.BOBBIHACK_LIVE_TAIL;
  if (raw === undefined || raw === "") return DEFAULT_LIVE_TAIL;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  return DEFAULT_LIVE_TAIL;
}

interface CompactionTrigger {
  fired: boolean;
  reason: "periodic" | "token_budget" | "force" | null;
  liveTailTurns: number;
}

function checkTrigger(
  messages: CompactionMessage[],
  runState: CompactionRunState,
  ctx: MaybeCompactCtx,
  opts: MaybeCompactOptions,
): CompactionTrigger {
  if (opts.force === true) {
    return { fired: true, reason: "force", liveTailTurns: FORCE_LIVE_TAIL };
  }
  const turnsSinceCompact = runState.turn - runState.lastCompactionTurn;
  const periodicReady = turnsSinceCompact >= PERIODIC_INTERVAL;
  const tokens = estimateInputTokens(messages);
  const budgetReady = tokens > TOKEN_BUDGET_RATIO * ctx.contextWindow;
  if (periodicReady) {
    return { fired: true, reason: "periodic", liveTailTurns: getLiveTail() };
  }
  if (budgetReady) {
    return { fired: true, reason: "token_budget", liveTailTurns: getLiveTail() };
  }
  return { fired: false, reason: null, liveTailTurns: getLiveTail() };
}

// Walk the messages array to identify "turn N" — defined as the Nth
// tool_use block in assistant messages. Returns the index of the
// first message that is part of a turn whose number is >= cutoffTurn.
// "Part of a turn" includes the assistant message containing the
// tool_use AND the following user message bearing its tool_result(s).
function findLiveTailStartIdx(
  messages: CompactionMessage[],
  liveTailTurns: number,
): number {
  // First, count how many turns there are in total (count tool_use blocks).
  const turnIndices: number[] = []; // index in messages of each assistant msg with tool_use
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m === undefined) continue;
    if (m.role === "assistant" && Array.isArray(m.content)) {
      const hasToolUse = m.content.some((b) => (b as { type: string }).type === "tool_use");
      if (hasToolUse) turnIndices.push(i);
    }
  }
  const totalTurns = turnIndices.length;
  if (totalTurns <= liveTailTurns) return 0; // nothing to compact
  const liveStartTurn = totalTurns - liveTailTurns; // 0-indexed turn index
  const liveStartIdx = turnIndices[liveStartTurn];
  return liveStartIdx ?? 0;
}

// Replace tool_result content in messages prior to liveTailIdx with
// summarized stubs. Returns a NEW array. Returns also the through-turn
// number (the highest tool-call turn that was compacted).
function compactPriorToolResults(
  messages: CompactionMessage[],
  liveTailIdx: number,
): { messages: CompactionMessage[]; throughTurn: number } {
  // Build map: tool_use_id -> { turnNumber, toolUse }
  const useMap = new Map<string, { turnNumber: number; toolUse: ToolUseLike }>();
  let turnCounter = 0;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m === undefined) continue;
    if (m.role !== "assistant") continue;
    if (!Array.isArray(m.content)) continue;
    for (const block of m.content) {
      if ((block as { type: string }).type === "tool_use") {
        turnCounter += 1;
        const tu = block as ToolUseLike;
        useMap.set(tu.id, { turnNumber: turnCounter, toolUse: tu });
      }
    }
  }

  let throughTurn = 0;
  const out: CompactionMessage[] = messages.map((m, i) => {
    if (i >= liveTailIdx) {
      // Live tail — preserve exactly.
      return { role: m.role, content: m.content };
    }
    if (m.role !== "user") {
      return { role: m.role, content: m.content };
    }
    if (!Array.isArray(m.content)) {
      // string content (e.g., the seed user message) — preserve.
      return { role: m.role, content: m.content };
    }
    const newContent = m.content.map((block): CompactionContentBlock => {
      if ((block as { type: string }).type !== "tool_result") {
        return block as CompactionContentBlock;
      }
      const tr = block as ToolResultLike;
      const lookup = useMap.get(tr.tool_use_id);
      if (lookup === undefined) {
        // Orphan tool_result — just return it. Shouldn't happen in
        // well-formed logs.
        return tr;
      }
      throughTurn = Math.max(throughTurn, lookup.turnNumber);
      const stub = summarizeOldToolResult(
        lookup.turnNumber,
        lookup.toolUse,
        tr.content,
      );
      return {
        type: "tool_result",
        tool_use_id: tr.tool_use_id,
        content: stub,
        ...(tr.is_error === true ? { is_error: true } : {}),
      };
    });
    return { role: m.role, content: newContent };
  });
  return { messages: out, throughTurn };
}

export async function maybeCompact(
  messages: CompactionMessage[],
  runState: CompactionRunState,
  ctx: MaybeCompactCtx,
  opts: MaybeCompactOptions = {},
): Promise<CompactionMessage[]> {
  const trigger = checkTrigger(messages, runState, ctx, opts);
  if (!trigger.fired) return messages;

  const messagesBefore = messages.length;

  // 1) Find the live-tail boundary.
  const liveTailIdx = findLiveTailStartIdx(messages, trigger.liveTailTurns);

  // If there's nothing to compact (live tail already covers all
  // turns), bail before touching anything. This avoids spuriously
  // injecting a marker / placing B2 / writing a snapshot when a
  // trigger fires too eagerly (e.g. token-budget on a small log).
  if (liveTailIdx <= 0) return messages;

  // 2) Replace pre-tail tool_results with summary stubs.
  const { messages: condensed, throughTurn } = compactPriorToolResults(
    messages,
    liveTailIdx,
  );

  // 3) Inject the synthetic compaction marker at the boundary.
  // After injection, the marker sits AT liveTailIdx (or replaces an
  // existing marker at that position).
  const markerInjected = injectCompactionMarker(condensed, liveTailIdx, throughTurn);

  // 4) Place B2 cache_control. After marker injection, the live tail
  // has shifted by one (marker took position liveTailIdx; live tail
  // now starts at liveTailIdx + 1).
  const breakpointed = placeBreakpoints(markerInjected, liveTailIdx + 1);

  // 5) Persist snapshot + retention.
  runState.compactionSeq += 1;
  const snapshotPath = await writeSnapshot(
    ctx.runDir,
    runState.compactionSeq,
    breakpointed,
  );

  // 6) Update runState markers.
  runState.lastCompactionTurn = runState.turn;

  // 7) Log compaction event.
  ctx.runLog.append({
    event: "compaction",
    compactedThroughTurn: throughTurn,
    liveTailSize: trigger.liveTailTurns,
    messagesBefore,
    messagesAfter: breakpointed.length,
    snapshotPath,
  });
  void existsSync; // satisfy unused-import lint if compiler trims

  return breakpointed;
}
