import { expect, test } from "bun:test";
import { render } from "../../examples/bobbihack/render";
import {
  initialState,
  onAgentEvent,
  onConductorStatus,
  onTurnEnd,
  onTurnStart,
} from "../../examples/bobbihack/state";

// 200x60 → tri (wide + tall).
// 130x28 → side (wide enough for side, not tall enough for tri).
// 100x40 → stacked (narrow but tall).
// 30x10  → tooSmall.
const initTri = () => initialState({ hostCols: 200, hostRows: 60, agentLabel: "mock", pid: 999, now: 1000 });
const initSide = () => initialState({ hostCols: 130, hostRows: 28, agentLabel: "mock", pid: 999, now: 1000 });
const initStacked = () => initialState({ hostCols: 100, hostRows: 40, agentLabel: "mock", pid: 999, now: 1000 });
const initTooSmall = () => initialState({ hostCols: 30, hostRows: 10, agentLabel: "mock", pid: 999, now: 1000 });

test("render emits alt-screen-safe SGR resets and hides cursor", () => {
  const out = render(initTri(), "", 1000);
  expect(out).toContain("\x1b[?25l");      // hide cursor
  expect(out).toContain("\x1b[0m");        // SGR reset
});

test("tri layout emits NetHack, Tool history, and Agent panes", () => {
  const out = render(initTri(), "", 1000);
  expect(out).toContain("NetHack");
  expect(out).toContain("Tool history");
  expect(out).toContain("Agent (mock)");
});

test("side layout emits NetHack and Agent panes (no separate Tool history)", () => {
  const out = render(initSide(), "", 1000);
  expect(out).toContain("NetHack");
  expect(out).toContain("Agent (mock)");
  expect(out).not.toContain("Tool history");
});

test("render splices nethackContent verbatim into the output", () => {
  const s = initTri();
  const synthetic = "\x1b[2;3HABCDEFG\x1b[3;3HHIJKLMN";
  const out = render(s, synthetic, 1000);
  expect(out).toContain("ABCDEFG");
  expect(out).toContain("HIJKLMN");
  expect(out).toContain("\x1b[2;3H");
});

test("tri chat pane shows committed turns with their streaming text", () => {
  let s = initTri();
  s = onTurnStart(s, { turn: 7, frameReason: "cellChange" });
  s = onAgentEvent(s, { kind: "thinking", delta: "looking around the room" });
  s = onAgentEvent(s, { kind: "action", move: "east" });
  s = onTurnEnd(s);
  const out = render(s, "", 1000);
  expect(out).toContain("#7");
  expect(out).toContain("looking around the room");
});

test("tool history shows entries newest-LAST (most recent at the bottom)", () => {
  let s = initTri();
  s = onTurnStart(s, { turn: 1, frameReason: "cellChange" });
  s = onAgentEvent(s, { kind: "thinking", delta: "going east now" });
  s = onAgentEvent(s, { kind: "action", move: "east" });
  s = onTurnEnd(s);
  s = onTurnStart(s, { turn: 2, frameReason: "bell" });
  s = onAgentEvent(s, { kind: "thinking", delta: "heading north" });
  s = onAgentEvent(s, { kind: "action", move: "north" });
  s = onTurnEnd(s);
  const out = render(s, "", 1000);
  // newest is BELOW oldest → in linear output, "#2" appears AFTER "#1".
  // Both panes (tool history + chat) follow newest-at-bottom. Pick the
  // tool-history occurrence (the one preceded by " " row content).
  const idxTurn1 = out.indexOf("#1");
  const idxTurn2 = out.indexOf("#2");
  expect(idxTurn1).toBeGreaterThan(-1);
  expect(idxTurn2).toBeGreaterThan(-1);
  expect(idxTurn2).toBeGreaterThan(idxTurn1);
  expect(out).toContain("→ north");
  expect(out).toContain("→ east");
});

test("agent-pane title shows colorized status — thinking", () => {
  let s = initTri();
  s = onConductorStatus(s, { kind: "thinking", since: 1000, detail: "" });
  const out = render(s, "", 5000); // 4s elapsed
  expect(out).toContain("thinking 4s");
});

test("agent-pane title flips to 'paused' after 30s", () => {
  let s = initTri();
  s = onConductorStatus(s, { kind: "thinking", since: 1000, detail: "" });
  const out = render(s, "", 1000 + 35_000); // 35s elapsed
  expect(out).toContain("paused");
  expect(out).toContain("no API response");
});

test("agent-pane title shows tool name when tool_running", () => {
  let s = initTri();
  s = onConductorStatus(s, { kind: "tool_running", since: 1000, detail: "autopilot_explore" });
  const out = render(s, "", 1000);
  expect(out).toContain("tool: autopilot_explore");
});

test("render stacked layout still emits both pane titles", () => {
  const out = render(initStacked(), "", 1000);
  expect(out).toContain("NetHack");
  expect(out).toContain("Agent (mock)");
});

test("render tooSmall shows a single resize message and no boxes", () => {
  const out = render(initTooSmall(), "", 1000);
  expect(out).toContain("Resize");
  expect(out).toContain("126");  // side-by-side minimum cols
  expect(out).toContain("84");   // stacked minimum cols
});
