import { expect, test } from "bun:test";
import { streamToAgentEvents, type RawStreamEvent } from "../../examples/bobbihack/agents/anthropic";
import type { AgentEvent } from "../../examples/bobbihack/agent";

const collect = async (raw: RawStreamEvent[]): Promise<AgentEvent[]> => {
  const out: AgentEvent[] = [];
  async function* source() {
    for (const e of raw) yield e;
  }
  for await (const ev of streamToAgentEvents(source())) out.push(ev);
  return out;
};

test("text deltas pass through as thinking events; missing action terminates with error", async () => {
  const events = await collect([
    { type: "content_block_delta", delta: { type: "text_delta", text: "hello " } },
    { type: "content_block_delta", delta: { type: "text_delta", text: "world" } },
  ]);
  expect(events.slice(0, 2)).toEqual([
    { kind: "thinking", delta: "hello " },
    { kind: "thinking", delta: "world" },
  ]);
  expect(events[2]).toEqual({ kind: "error", message: "stream ended without a move" });
});

test("tool_use input emits an action with the move", async () => {
  const events = await collect([
    { type: "content_block_delta", delta: { type: "text_delta", text: "I'll go east. " } },
    { type: "content_block_start", content_block: { type: "tool_use", name: "move", id: "abc" } },
    { type: "content_block_delta", delta: { type: "input_json_delta", partial_json: '{"move":"east"}' } },
    { type: "content_block_stop" },
  ]);
  expect(events).toEqual([
    { kind: "thinking", delta: "I'll go east. " },
    { kind: "action", move: "east" },
  ]);
});

test("invalid tool input emits an error event", async () => {
  const events = await collect([
    { type: "content_block_start", content_block: { type: "tool_use", name: "move", id: "abc" } },
    { type: "content_block_delta", delta: { type: "input_json_delta", partial_json: "{not-json" } },
    { type: "content_block_stop" },
  ]);
  expect(events.length).toBe(1);
  expect(events[0]?.kind).toBe("error");
});

test("unknown move value emits an error event", async () => {
  const events = await collect([
    { type: "content_block_start", content_block: { type: "tool_use", name: "move", id: "abc" } },
    { type: "content_block_delta", delta: { type: "input_json_delta", partial_json: '{"move":"dance"}' } },
    { type: "content_block_stop" },
  ]);
  expect(events[0]?.kind).toBe("error");
});

test("tool input split across multiple deltas reassembles correctly", async () => {
  const events = await collect([
    { type: "content_block_start", content_block: { type: "tool_use", name: "move", id: "abc" } },
    { type: "content_block_delta", delta: { type: "input_json_delta", partial_json: '{"mov' } },
    { type: "content_block_delta", delta: { type: "input_json_delta", partial_json: 'e":"north"}' } },
    { type: "content_block_stop" },
  ]);
  expect(events).toEqual([{ kind: "action", move: "north" }]);
});
