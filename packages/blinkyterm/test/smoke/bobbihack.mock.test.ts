import { expect, test } from "bun:test";
import { MockAgent } from "../../examples/bobbihack/agents/mock";
import type { AgentEvent } from "../../examples/bobbihack/agent";

const collect = async (agent: MockAgent, signal: AbortSignal): Promise<AgentEvent[]> => {
  const out: AgentEvent[] = [];
  for await (const ev of agent.decide(
    { turn: 1, frameReason: "cellChange", screenAnsi: "" },
    signal,
  )) {
    out.push(ev);
  }
  return out;
};

test("MockAgent emits one or more thinking deltas then exactly one action", async () => {
  const agent = new MockAgent({ seed: 42, gapMs: 0 });
  const events = await collect(agent, new AbortController().signal);
  const thinkingCount = events.filter((e) => e.kind === "thinking").length;
  const actionCount = events.filter((e) => e.kind === "action").length;
  expect(thinkingCount).toBeGreaterThanOrEqual(1);
  expect(actionCount).toBe(1);
  expect(events[events.length - 1]?.kind).toBe("action");
});

test("MockAgent is deterministic for the same seed", async () => {
  const a = new MockAgent({ seed: 42, gapMs: 0 });
  const b = new MockAgent({ seed: 42, gapMs: 0 });
  const ea = await collect(a, new AbortController().signal);
  const eb = await collect(b, new AbortController().signal);
  expect(ea).toEqual(eb);
});

test("MockAgent action move is one of the valid moves", async () => {
  const agent = new MockAgent({ seed: 1, gapMs: 0 });
  const events = await collect(agent, new AbortController().signal);
  const action = events.find((e) => e.kind === "action") as Extract<AgentEvent, { kind: "action" }>;
  expect(["north", "south", "east", "west", "search", "pickup", "quit"]).toContain(action.move);
});

test("MockAgent honors abort signal mid-stream", async () => {
  const agent = new MockAgent({ seed: 42, gapMs: 50 });
  const ac = new AbortController();
  const collected: AgentEvent[] = [];
  const iter = agent.decide(
    { turn: 1, frameReason: "cellChange", screenAnsi: "" },
    ac.signal,
  )[Symbol.asyncIterator]();
  // pull one event, then abort
  const first = await iter.next();
  expect(first.done).toBe(false);
  collected.push(first.value);
  ac.abort();
  const second = await iter.next();
  expect(second.done).toBe(true);
});
