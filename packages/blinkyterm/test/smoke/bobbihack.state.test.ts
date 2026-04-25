import { expect, test } from "bun:test";
import {
  initialState,
  onAgentEvent,
  onChildExited,
  onChildFrame,
  onResize,
  onTurnEnd,
  onTurnStart,
} from "../../examples/bobbihack/state";
import type { Frame } from "../../src/types";

const fakeSnapshot = (text: string) => ({
  text,
  title: "",
  cursor: { x: 0, y: 0, visible: true },
  bellsSinceLast: 0,
  titleChangesSinceLast: [],
  toAnsi: () => text,
  toHtml: () => `<pre>${text}</pre>`,
  toVt: () => text,
  cellAt: () => null,
});

const fakeFrame = (text: string, reason = "cellChange" as const): Frame => ({
  reason,
  snapshot: fakeSnapshot(text) as Frame["snapshot"],
});

test("initialState has empty pane and history", () => {
  const s = initialState({ hostCols: 200, hostRows: 60, agentLabel: "mock", pid: 999 });
  expect(s.status).toBe("running");
  expect(s.history).toEqual([]);
  expect(s.currentTurn).toBeNull();
  expect(s.agentLabel).toBe("mock");
  expect(s.layout.kind).toBe("side");
});

test("onChildFrame updates the NetHack pane content", () => {
  const s0 = initialState({ hostCols: 200, hostRows: 60, agentLabel: "mock", pid: 1 });
  const s1 = onChildFrame(s0, fakeFrame("hello"));
  expect(s1.nethack.screenAnsi).toBe("hello");
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

test("onTurnEnd moves currentTurn into history (newest first)", () => {
  let s = initialState({ hostCols: 200, hostRows: 60, agentLabel: "mock", pid: 1 });
  s = onTurnStart(s, { turn: 1, frameReason: "cellChange" });
  s = onAgentEvent(s, { kind: "thinking", delta: "going east " });
  s = onAgentEvent(s, { kind: "thinking", delta: "to fight goblin" });
  s = onAgentEvent(s, { kind: "action", move: "east" });
  s = onTurnEnd(s);

  expect(s.currentTurn).toBeNull();
  expect(s.history.length).toBe(1);
  expect(s.history[0]).toMatchObject({
    number: 1,
    frameReason: "cellChange",
    decision: "east",
  });
  expect(s.history[0]?.summary).toContain("going east");
});

test("onTurnEnd records error decision when committed is null", () => {
  let s = initialState({ hostCols: 200, hostRows: 60, agentLabel: "mock", pid: 1 });
  s = onTurnStart(s, { turn: 7, frameReason: "bell" });
  s = onAgentEvent(s, { kind: "error", message: "rate limited" });
  s = onTurnEnd(s);
  expect(s.history[0]?.decision).toBe("error");
});

test("history is newest-first and bounded by capacity", () => {
  let s = initialState({ hostCols: 200, hostRows: 60, agentLabel: "mock", pid: 1, historyCapacity: 3 });
  for (let i = 1; i <= 5; i++) {
    s = onTurnStart(s, { turn: i, frameReason: "cellChange" });
    s = onAgentEvent(s, { kind: "action", move: "north" });
    s = onTurnEnd(s);
  }
  expect(s.history.map((h) => h.number)).toEqual([5, 4, 3]);
});

test("onResize recomputes layout", () => {
  let s = initialState({ hostCols: 200, hostRows: 60, agentLabel: "mock", pid: 1 });
  expect(s.layout.kind).toBe("side");
  s = onResize(s, 100, 40);
  expect(s.layout.kind).toBe("stacked");
});

test("onChildExited freezes status and stores exit info", () => {
  let s = initialState({ hostCols: 200, hostRows: 60, agentLabel: "mock", pid: 1 });
  s = onChildExited(s, "exited", 0);
  expect(s.status).toBe("exited");
  expect(s.errorBanner).toContain("exited");
});
