// Cost monitoring tests — full Phase 8 impl.
//
// These exercise the rates table for known models, the per-call
// computeCost math (accounting for cache_read_input_tokens at the
// cheaper rate and cache_creation_input_tokens at the more expensive
// rate), running-total accumulation, the BOBBIHACK_MAX_USD kill
// switch, and the cost-line formatter consumed by the agent-pane
// title.

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import {
  computeCost,
  accumulate,
  newCostState,
  shouldStopForBudget,
  formatCostLine,
  __resetCostWarnings,
  KNOWN_MODEL_RATES,
  type CostState,
} from "../../examples/bobbihack/cost";
import type { UsageStats } from "../../examples/bobbihack/client";

function usage(over: Partial<UsageStats> = {}): UsageStats {
  return {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
    ...over,
  };
}

const ORIGINAL_MAX_USD = process.env.BOBBIHACK_MAX_USD;

beforeEach(() => {
  __resetCostWarnings();
  delete process.env.BOBBIHACK_MAX_USD;
});

afterEach(() => {
  if (ORIGINAL_MAX_USD === undefined) {
    delete process.env.BOBBIHACK_MAX_USD;
  } else {
    process.env.BOBBIHACK_MAX_USD = ORIGINAL_MAX_USD;
  }
});

describe("computeCost — known models", () => {
  test("haiku-4-5: 1M base input tokens cost $1.00", () => {
    const cost = computeCost(
      "claude-haiku-4-5",
      usage({ input_tokens: 1_000_000 }),
    );
    expect(cost).toBeCloseTo(1.0, 6);
  });

  test("haiku-4-5: 1M output tokens cost $5.00", () => {
    const cost = computeCost(
      "claude-haiku-4-5",
      usage({ output_tokens: 1_000_000 }),
    );
    expect(cost).toBeCloseTo(5.0, 6);
  });

  test("haiku-4-5: 1M cache_read tokens cost $0.10 (10× cheaper than base)", () => {
    const cost = computeCost(
      "claude-haiku-4-5",
      usage({ cache_read_input_tokens: 1_000_000 }),
    );
    expect(cost).toBeCloseTo(0.1, 6);
  });

  test("haiku-4-5: 1M cache_creation tokens cost $1.25 (25% premium)", () => {
    const cost = computeCost(
      "claude-haiku-4-5",
      usage({ cache_creation_input_tokens: 1_000_000 }),
    );
    expect(cost).toBeCloseTo(1.25, 6);
  });

  test("sonnet-4-6: 1M base input tokens cost $3.00", () => {
    const cost = computeCost(
      "claude-sonnet-4-6",
      usage({ input_tokens: 1_000_000 }),
    );
    expect(cost).toBeCloseTo(3.0, 6);
  });

  test("sonnet-4-6: 1M output tokens cost $15.00", () => {
    const cost = computeCost(
      "claude-sonnet-4-6",
      usage({ output_tokens: 1_000_000 }),
    );
    expect(cost).toBeCloseTo(15.0, 6);
  });

  test("sonnet-4-6: 1M cache_read tokens cost $0.30", () => {
    const cost = computeCost(
      "claude-sonnet-4-6",
      usage({ cache_read_input_tokens: 1_000_000 }),
    );
    expect(cost).toBeCloseTo(0.3, 6);
  });

  test("realistic mix sums correctly", () => {
    const cost = computeCost(
      "claude-haiku-4-5",
      usage({
        input_tokens: 1200,
        output_tokens: 56,
        cache_read_input_tokens: 8000,
        cache_creation_input_tokens: 0,
      }),
    );
    // 1200 * 1e-6 + 56 * 5e-6 + 8000 * 0.1e-6
    const expected = 1200 * 1e-6 + 56 * 5e-6 + 8000 * 0.1e-6;
    expect(cost).toBeCloseTo(expected, 9);
  });
});

describe("computeCost — unknown model", () => {
  test("returns 0 and warns once", () => {
    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]): void => {
      warnings.push(args.map(String).join(" "));
    };
    try {
      const a = computeCost("totally-fake-model", usage({ input_tokens: 1000 }));
      const b = computeCost("totally-fake-model", usage({ input_tokens: 1000 }));
      expect(a).toBe(0);
      expect(b).toBe(0);
      // Warned only once for the same unknown model.
      expect(warnings.filter((w) => w.includes("totally-fake-model")).length).toBe(1);
    } finally {
      console.warn = origWarn;
    }
  });
});

describe("KNOWN_MODEL_RATES — table sanity", () => {
  test("includes haiku-4-5 and sonnet-4-6", () => {
    expect(KNOWN_MODEL_RATES["claude-haiku-4-5"]).toBeDefined();
    expect(KNOWN_MODEL_RATES["claude-sonnet-4-6"]).toBeDefined();
  });

  test("rates are positive numbers", () => {
    for (const [_model, r] of Object.entries(KNOWN_MODEL_RATES)) {
      expect(r.input).toBeGreaterThan(0);
      expect(r.output).toBeGreaterThan(0);
      expect(r.cacheRead).toBeGreaterThan(0);
      expect(r.cacheCreate).toBeGreaterThan(0);
    }
  });
});

describe("accumulate", () => {
  test("running totals advance and totalUsd increments", () => {
    const s: CostState = newCostState();
    accumulate(s, "claude-haiku-4-5", usage({ input_tokens: 1000, output_tokens: 100 }));
    expect(s.inputTokens).toBe(1000);
    expect(s.outputTokens).toBe(100);
    const oneCallUsd = s.totalUsd;
    expect(oneCallUsd).toBeGreaterThan(0);

    accumulate(s, "claude-haiku-4-5", usage({ input_tokens: 500, output_tokens: 50 }));
    expect(s.inputTokens).toBe(1500);
    expect(s.outputTokens).toBe(150);
    expect(s.totalUsd).toBeGreaterThan(oneCallUsd);
  });

  test("accumulate also tracks lastTurnUsage and lastTurnUsd", () => {
    const s: CostState = newCostState();
    accumulate(s, "claude-haiku-4-5", usage({ input_tokens: 1000, cache_read_input_tokens: 8000 }));
    expect(s.lastTurnInput).toBe(1000);
    expect(s.lastTurnCacheRead).toBe(8000);
    expect(s.lastTurnUsd).toBeCloseTo(1000 * 1e-6 + 8000 * 0.1e-6, 9);
  });
});

describe("shouldStopForBudget", () => {
  test("no env var → never stops", () => {
    const s: CostState = newCostState();
    s.totalUsd = 100;
    expect(shouldStopForBudget(s)).toBe(false);
  });

  test("under cap → false", () => {
    process.env.BOBBIHACK_MAX_USD = "1.00";
    const s: CostState = newCostState();
    s.totalUsd = 0.5;
    expect(shouldStopForBudget(s)).toBe(false);
  });

  test("at or over cap → true", () => {
    process.env.BOBBIHACK_MAX_USD = "1.00";
    const s: CostState = newCostState();
    s.totalUsd = 1.0;
    expect(shouldStopForBudget(s)).toBe(true);
    s.totalUsd = 1.5;
    expect(shouldStopForBudget(s)).toBe(true);
  });

  test("invalid env var → false (safe default, no crash)", () => {
    process.env.BOBBIHACK_MAX_USD = "not-a-number";
    const s: CostState = newCostState();
    s.totalUsd = 100;
    expect(shouldStopForBudget(s)).toBe(false);
  });
});

describe("formatCostLine", () => {
  test("formats expected pattern", () => {
    const s = newCostState();
    s.lastTurnInput = 1234;
    s.lastTurnCacheRead = 8000;
    s.lastTurnOutput = 56;
    s.lastTurnUsd = 0.003;
    s.totalUsd = 0.42;
    const line = formatCostLine(s);
    expect(line).toContain("in 1.2k");
    expect(line).toContain("cache 8.0k");
    expect(line).toContain("out 56");
    expect(line).toContain("turn cost ~$0.003");
    expect(line).toContain("total $0.42");
  });

  test("handles zero/empty cost state", () => {
    const s = newCostState();
    const line = formatCostLine(s);
    expect(typeof line).toBe("string");
    expect(line.length).toBeGreaterThan(0);
  });
});
