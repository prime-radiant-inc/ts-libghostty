// Cost monitoring — Phase 8 full impl.
//
// Hard-coded per-million-token rates table for known models. Values
// reflect Anthropic's posted pricing as of 2026-04-26; refresh against
// https://www.anthropic.com/pricing if the rates drift.
//
// computeCost is purely arithmetic: it multiplies each usage axis by
// its per-token rate and sums. accumulate updates a running CostState
// so the conductor can surface "tokens this turn / cost this turn /
// total so far" in the UI and decide whether the BOBBIHACK_MAX_USD
// kill switch has fired.

import type { UsageStats } from "./client";

export interface ModelRates {
  // All values are USD per token (i.e. the per-million-token rate
  // divided by 1_000_000). Storing the per-token form keeps
  // computeCost a single multiplication per axis.
  input: number;
  output: number;
  cacheRead: number;
  cacheCreate: number;
}

const M = 1_000_000;

// Rates as of 2026-04-26. Refresh from Anthropic's pricing page if
// they drift; the warning below covers unknown-model fallback.
export const KNOWN_MODEL_RATES: Record<string, ModelRates> = {
  "claude-haiku-4-5": {
    input: 1.0 / M,
    output: 5.0 / M,
    cacheRead: 0.1 / M,
    cacheCreate: 1.25 / M,
  },
  "claude-sonnet-4-6": {
    input: 3.0 / M,
    output: 15.0 / M,
    cacheRead: 0.3 / M,
    cacheCreate: 3.75 / M,
  },
  // Common aliases / version-stamped variants if encountered.
  "claude-haiku-4-5-20250101": {
    input: 1.0 / M,
    output: 5.0 / M,
    cacheRead: 0.1 / M,
    cacheCreate: 1.25 / M,
  },
};

const warnedModels = new Set<string>();

// Test-only hook: reset per-model warning latching between tests so
// each test that exercises the unknown-model path observes the warning
// once. Not intended for production use.
export function __resetCostWarnings(): void {
  warnedModels.clear();
}

export interface CostState {
  totalUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
  // Most-recent-call breakouts so the UI can surface "this turn".
  lastTurnInput: number;
  lastTurnOutput: number;
  lastTurnCacheRead: number;
  lastTurnCacheCreate: number;
  lastTurnUsd: number;
}

export function newCostState(): CostState {
  return {
    totalUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreateTokens: 0,
    lastTurnInput: 0,
    lastTurnOutput: 0,
    lastTurnCacheRead: 0,
    lastTurnCacheCreate: 0,
    lastTurnUsd: 0,
  };
}

export function computeCost(model: string, usage: UsageStats): number {
  const rates = KNOWN_MODEL_RATES[model];
  if (rates === undefined) {
    if (!warnedModels.has(model)) {
      warnedModels.add(model);
      console.warn(
        `[bobbihack/cost] no rate table entry for model "${model}"; reporting 0 USD. ` +
          `Add it to KNOWN_MODEL_RATES in cost.ts.`,
      );
    }
    return 0;
  }
  return (
    usage.input_tokens * rates.input +
    usage.output_tokens * rates.output +
    usage.cache_read_input_tokens * rates.cacheRead +
    usage.cache_creation_input_tokens * rates.cacheCreate
  );
}

export function accumulate(state: CostState, model: string, usage: UsageStats): void {
  const turnUsd = computeCost(model, usage);
  state.inputTokens += usage.input_tokens;
  state.outputTokens += usage.output_tokens;
  state.cacheReadTokens += usage.cache_read_input_tokens;
  state.cacheCreateTokens += usage.cache_creation_input_tokens;
  state.totalUsd += turnUsd;
  state.lastTurnInput = usage.input_tokens;
  state.lastTurnOutput = usage.output_tokens;
  state.lastTurnCacheRead = usage.cache_read_input_tokens;
  state.lastTurnCacheCreate = usage.cache_creation_input_tokens;
  state.lastTurnUsd = turnUsd;
}

export function shouldStopForBudget(state: CostState): boolean {
  const raw = process.env.BOBBIHACK_MAX_USD;
  if (raw === undefined || raw === "") return false;
  const cap = Number.parseFloat(raw);
  if (!Number.isFinite(cap) || cap <= 0) return false;
  return state.totalUsd >= cap;
}

// Format the cost line for the agent-pane title:
//   tokens: in 1.2k (cache 8.0k) / out 56 — turn cost ~$0.003 — total $0.42
//
// Token counts use a "k" suffix when ≥ 1000 (one decimal place), bare
// integers otherwise. Cost values use 3-decimal precision for the per-turn
// number (typical haiku turn is a fraction of a cent) and 2-decimal for
// totals (USD-shaped).
export function formatCostLine(state: CostState): string {
  const k = (n: number): string => {
    if (n < 1000) return n.toString();
    return (n / 1000).toFixed(1) + "k";
  };
  const turnCost = state.lastTurnUsd.toFixed(3);
  const total = state.totalUsd.toFixed(2);
  return (
    `tokens: in ${k(state.lastTurnInput)} ` +
    `(cache ${k(state.lastTurnCacheRead)}) ` +
    `/ out ${k(state.lastTurnOutput)} ` +
    `— turn cost ~$${turnCost} ` +
    `— total $${total}`
  );
}
