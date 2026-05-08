import { expect, test } from "bun:test";
import {
  initialState,
  onAgentEvent,
  onChildExited,
  onConductorStatus,
  onResize,
  onTurnEnd,
  onTurnStart,
} from "../../examples/bobbihack/state";

test("initialState has empty histories and an idle conductor", () => {
  const s = initialState({ hostCols: 200, hostRows: 60, agentLabel: "mock", pid: 999, now: 1000 });
  expect(s.status).toBe("running");
  expect(s.toolHistory).toEqual([]);
  expect(s.chatHistory).toEqual([]);
  expect(s.currentTurn).toBeNull();
  expect(s.agentLabel).toBe("mock");
  expect(s.layout.kind).toBe("tri");
  expect(s.conductorStatus).toEqual({ kind: "idle", since: 1000, detail: "" });
});

test("onTurnStart sets currentTurn with empty streamingText", () => {
  let s = initialState({ hostCols: 200, hostRows: 60, agentLabel: "mock", pid: 1 });
  s = onTurnStart(s, { turn: 1, frameReason: "cellChange" });
  expect(s.currentTurn).toEqual({
    number: 1,
    frameReason: "cellChange",
    streamingText: "",
    committed: null,
  });
});

test("onAgentEvent thinking appends delta to streamingText", () => {
  let s = initialState({ hostCols: 200, hostRows: 60, agentLabel: "mock", pid: 1 });
  s = onTurnStart(s, { turn: 1, frameReason: "cellChange" });
  s = onAgentEvent(s, { kind: "thinking", delta: "hello " });
  s = onAgentEvent(s, { kind: "thinking", delta: "world" });
  expect(s.currentTurn?.streamingText).toBe("hello world");
});

test("onAgentEvent action sets committed", () => {
  let s = initialState({ hostCols: 200, hostRows: 60, agentLabel: "mock", pid: 1 });
  s = onTurnStart(s, { turn: 1, frameReason: "cellChange" });
  s = onAgentEvent(s, { kind: "action", move: "east" });
  expect(s.currentTurn?.committed).toBe("east");
});

test("onAgentEvent thinking is ignored when no current turn", () => {
  const s0 = initialState({ hostCols: 200, hostRows: 60, agentLabel: "mock", pid: 1 });
  const s1 = onAgentEvent(s0, { kind: "thinking", delta: "stray" });
  expect(s1).toBe(s0);
});

test("onTurnEnd appends to histories and clears currentTurn", () => {
  let s = initialState({ hostCols: 200, hostRows: 60, agentLabel: "mock", pid: 1 });
  s = onTurnStart(s, { turn: 1, frameReason: "cellChange" });
  s = onAgentEvent(s, { kind: "thinking", delta: "going east " });
  s = onAgentEvent(s, { kind: "thinking", delta: "to fight goblin" });
  s = onAgentEvent(s, { kind: "action", move: "east" });
  s = onTurnEnd(s);

  // currentTurn must clear so the next assistant message's text deltas
  // get buffered (not appended to the just-completed turn). See the
  // comment in state.ts onTurnEnd for the bug history.
  expect(s.currentTurn).toBeNull();

  expect(s.toolHistory.length).toBe(1);
  expect(s.toolHistory[0]).toMatchObject({
    number: 1,
    frameReason: "cellChange",
    decision: "east",
  });
  expect(s.toolHistory[0]?.summary).toContain("going east");

  expect(s.chatHistory.length).toBe(1);
  expect(s.chatHistory[0]).toEqual({ number: 1, text: "going east to fight goblin" });
});

test("onTurnEnd skips chatHistory when there's no streaming text", () => {
  let s = initialState({ hostCols: 200, hostRows: 60, agentLabel: "mock", pid: 1 });
  s = onTurnStart(s, { turn: 1, frameReason: "cellChange" });
  s = onAgentEvent(s, { kind: "action", move: "east" });
  s = onTurnEnd(s);
  expect(s.toolHistory.length).toBe(1);
  expect(s.chatHistory.length).toBe(0);
});

test("onTurnStart replaces a sticky completed turn", () => {
  let s = initialState({ hostCols: 200, hostRows: 60, agentLabel: "mock", pid: 1 });
  s = onTurnStart(s, { turn: 1, frameReason: "cellChange" });
  s = onAgentEvent(s, { kind: "action", move: "east" });
  s = onTurnEnd(s);
  s = onTurnStart(s, { turn: 2, frameReason: "bell" });
  expect(s.currentTurn).toEqual({
    number: 2,
    frameReason: "bell",
    streamingText: "",
    committed: null,
  });
});

test("onTurnEnd records error decision when committed is null", () => {
  let s = initialState({ hostCols: 200, hostRows: 60, agentLabel: "mock", pid: 1 });
  s = onTurnStart(s, { turn: 7, frameReason: "bell" });
  s = onAgentEvent(s, { kind: "error", message: "rate limited" });
  s = onTurnEnd(s);
  expect(s.toolHistory[0]?.decision).toBe("error");
});

test("toolHistory is newest-LAST and bounded by capacity", () => {
  let s = initialState({ hostCols: 200, hostRows: 60, agentLabel: "mock", pid: 1, historyCapacity: 3 });
  for (let i = 1; i <= 5; i++) {
    s = onTurnStart(s, { turn: i, frameReason: "cellChange" });
    s = onAgentEvent(s, { kind: "action", move: "north" });
    s = onTurnEnd(s);
  }
  // Newest at the END now (the renderer takes a tail slice).
  expect(s.toolHistory.map((h) => h.number)).toEqual([3, 4, 5]);
});

test("onConductorStatus updates the status field", () => {
  let s = initialState({ hostCols: 200, hostRows: 60, agentLabel: "mock", pid: 1, now: 1000 });
  s = onConductorStatus(s, { kind: "thinking", since: 2000, detail: "" });
  expect(s.conductorStatus).toEqual({ kind: "thinking", since: 2000, detail: "" });
  s = onConductorStatus(s, { kind: "tool_running", since: 3000, detail: "autopilot_explore" });
  expect(s.conductorStatus).toEqual({ kind: "tool_running", since: 3000, detail: "autopilot_explore" });
});

test("onResize recomputes layout", () => {
  let s = initialState({ hostCols: 200, hostRows: 60, agentLabel: "mock", pid: 1 });
  expect(s.layout.kind).toBe("tri");
  s = onResize(s, 100, 40);
  expect(s.layout.kind).toBe("stacked");
  s = onResize(s, 130, 28);   // wide but short — falls back to side
  expect(s.layout.kind).toBe("side");
});

test("onChildExited freezes status and stores exit info", () => {
  let s = initialState({ hostCols: 200, hostRows: 60, agentLabel: "mock", pid: 1 });
  s = onChildExited(s, "exited", 0);
  expect(s.status).toBe("exited");
  expect(s.errorBanner).toContain("exited");
});
