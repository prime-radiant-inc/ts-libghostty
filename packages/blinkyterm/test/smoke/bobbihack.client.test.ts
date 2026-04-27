import { describe, expect, test } from "bun:test";
import {
  MockAnthropicClient,
  type AssistantMessage,
  type ScriptedTurn,
  isRecoverableApiError,
  nextBackoffSec,
  resetBackoff,
  type BackoffState,
} from "../../examples/bobbihack/client";

describe("MockAnthropicClient — scripted streams", () => {
  test("emits a single tool_use turn", async () => {
    const plan: ScriptedTurn[] = [
      {
        text: "I'll go east.",
        toolUses: [{ name: "move", input: { direction: "east" } }],
      },
    ];
    const client = new MockAnthropicClient(plan);
    const stream = client.messages.stream({ model: "x", max_tokens: 0, system: [], tools: [], messages: [] });
    const texts: string[] = [];
    stream.on("text", (t) => texts.push(t));
    const final: AssistantMessage = await stream.finalMessage();
    expect(texts.join("")).toBe("I'll go east.");
    expect(final.content.length).toBe(2); // text + tool_use
    expect(final.content[1]?.type).toBe("tool_use");
    if (final.content[1]?.type === "tool_use") {
      expect(final.content[1].name).toBe("move");
      expect(final.content[1].input).toEqual({ direction: "east" });
    }
  });

  test("supports multiple tool_uses in one assistant turn", async () => {
    const plan: ScriptedTurn[] = [
      {
        toolUses: [
          { name: "journal_read", input: { section: "Goals" } },
          { name: "move", input: { direction: "north" } },
        ],
      },
    ];
    const client = new MockAnthropicClient(plan);
    const stream = client.messages.stream({ model: "x", max_tokens: 0, system: [], tools: [], messages: [] });
    const final = await stream.finalMessage();
    const tools = final.content.filter((b) => b.type === "tool_use");
    expect(tools.length).toBe(2);
  });

  test("text-only turn (no tools) signals graceful end", async () => {
    const plan: ScriptedTurn[] = [{ text: "I'm done." }];
    const client = new MockAnthropicClient(plan);
    const stream = client.messages.stream({ model: "x", max_tokens: 0, system: [], tools: [], messages: [] });
    const final = await stream.finalMessage();
    const tools = final.content.filter((b) => b.type === "tool_use");
    expect(tools.length).toBe(0);
    expect(final.stop_reason).toBe("end_turn");
  });

  test("script with multiple turns advances per stream() call", async () => {
    const plan: ScriptedTurn[] = [
      { toolUses: [{ name: "move", input: { direction: "north" } }] },
      { toolUses: [{ name: "move", input: { direction: "east" } }] },
    ];
    const client = new MockAnthropicClient(plan);
    const m1 = await client.messages
      .stream({ model: "x", max_tokens: 0, system: [], tools: [], messages: [] })
      .finalMessage();
    const m2 = await client.messages
      .stream({ model: "x", max_tokens: 0, system: [], tools: [], messages: [] })
      .finalMessage();
    expect(m1.content[0]?.type).toBe("tool_use");
    expect(m2.content[0]?.type).toBe("tool_use");
    if (m1.content[0]?.type === "tool_use" && m2.content[0]?.type === "tool_use") {
      expect(m1.content[0].input).toEqual({ direction: "north" });
      expect(m2.content[0].input).toEqual({ direction: "east" });
    }
  });

  test("scripted error injection makes finalMessage reject", async () => {
    const plan: ScriptedTurn[] = [
      { error: { status: 500, message: "Internal Server Error" } },
    ];
    const client = new MockAnthropicClient(plan);
    let caught: unknown = null;
    try {
      await client.messages
        .stream({ model: "x", max_tokens: 0, system: [], tools: [], messages: [] })
        .finalMessage();
    } catch (e) {
      caught = e;
    }
    expect(caught).not.toBeNull();
    expect((caught as { status?: number }).status).toBe(500);
    expect((caught as Error).message).toBe("Internal Server Error");
  });

  test("usage data on finalMessage", async () => {
    const plan: ScriptedTurn[] = [
      {
        toolUses: [{ name: "move", input: { direction: "north" } }],
        usage: {
          input_tokens: 100,
          output_tokens: 20,
          cache_read_input_tokens: 50,
          cache_creation_input_tokens: 0,
        },
      },
    ];
    const client = new MockAnthropicClient(plan);
    const final = await client.messages
      .stream({ model: "x", max_tokens: 0, system: [], tools: [], messages: [] })
      .finalMessage();
    expect(final.usage.input_tokens).toBe(100);
    expect(final.usage.cache_read_input_tokens).toBe(50);
  });
});

describe("isRecoverableApiError", () => {
  test("matches HTTP 5xx", () => {
    expect(isRecoverableApiError({ status: 500 })).toBe(true);
    expect(isRecoverableApiError({ status: 503 })).toBe(true);
  });
  test("matches HTTP 429 rate limit", () => {
    expect(isRecoverableApiError({ status: 429 })).toBe(true);
  });
  test("matches network errors by code", () => {
    expect(isRecoverableApiError({ code: "ECONNRESET" })).toBe(true);
    expect(isRecoverableApiError({ code: "ETIMEDOUT" })).toBe(true);
  });
  test("does NOT match 4xx other than 429", () => {
    expect(isRecoverableApiError({ status: 401 })).toBe(false);
    expect(isRecoverableApiError({ status: 404 })).toBe(false);
    expect(isRecoverableApiError({ status: 400 })).toBe(false);
  });
  test("matches by error class name", () => {
    class APIError extends Error { constructor() { super("api error"); this.name = "APIError"; } }
    class RateLimitError extends Error { constructor() { super("rate"); this.name = "RateLimitError"; } }
    expect(isRecoverableApiError(new APIError())).toBe(false); // generic APIError without status: not recoverable
    expect(isRecoverableApiError(new RateLimitError())).toBe(true);
  });
});

describe("backoff", () => {
  test("returns 1, 2, 4, 8, 16 then null", () => {
    const s: BackoffState = { attempt: 0 };
    expect(nextBackoffSec(s)).toBe(1);
    expect(nextBackoffSec(s)).toBe(2);
    expect(nextBackoffSec(s)).toBe(4);
    expect(nextBackoffSec(s)).toBe(8);
    expect(nextBackoffSec(s)).toBe(16);
    expect(nextBackoffSec(s)).toBeNull();
  });
  test("resetBackoff returns to attempt 0", () => {
    const s: BackoffState = { attempt: 3 };
    resetBackoff(s);
    expect(s.attempt).toBe(0);
  });
});
