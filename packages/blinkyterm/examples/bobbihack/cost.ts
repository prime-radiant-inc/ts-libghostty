// Cost monitoring — Phase 2 stub. Phase 8 implements the full
// per-model rates table and the BOBBIHACK_MAX_USD kill switch.

import type { UsageStats } from "./client";

export interface CostState {
  totalUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
}

export function newCostState(): CostState {
  return {
    totalUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreateTokens: 0,
  };
}

// Phase 2: returns 0. Phase 8 will populate from a hard-coded rates table
// keyed by model name.
export function computeCost(_model: string, _usage: UsageStats): number {
  return 0;
}

export function accumulate(state: CostState, model: string, usage: UsageStats): void {
  state.inputTokens += usage.input_tokens;
  state.outputTokens += usage.output_tokens;
  state.cacheReadTokens += usage.cache_read_input_tokens;
  state.cacheCreateTokens += usage.cache_creation_input_tokens;
  state.totalUsd += computeCost(model, usage);
}

// Phase 2 always returns false (no kill-switch yet). Phase 8 honors
// BOBBIHACK_MAX_USD.
export function shouldStopForBudget(_state: CostState): boolean {
  return false;
}
