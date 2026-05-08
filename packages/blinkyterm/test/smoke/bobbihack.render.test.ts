import { expect, test } from "bun:test";
import { render } from "../../examples/bobbihack/render";
import {
  initialState,
  onAgentEvent,
  onConductorStatus,
  onToolPendingProgress,
  onToolPendingStart,
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

test("tool history word-wraps long entries instead of truncating", () => {
  let s = initTri();
  s = onTurnStart(s, { turn: 1, frameReason: "cellChange" });
  // Long streamed text → long summary on the tool record.
  s = onAgentEvent(s, {
    kind: "thinking",
    delta:
      "Heading east through a long corridor that should make this entry word-wrap onto a continuation line so the user can read the whole thing rather than seeing a truncated tail",
  });
  s = onAgentEvent(s, { kind: "action", move: "east" });
  s = onTurnEnd(s);
  const out = render(s, "", 1000);
  // The summary truncates at SUMMARY_LEN (60) on the state side, so the
  // visible tool line is "#1 cellChange → east  \"<60 chars>\"" — which
  // exceeds the 80-ish col width of the tools pane and must wrap. Look
  // for both the head and a fragment of the summary so we know neither
  // got truncated away.
  expect(out).toContain("#1");
  expect(out).toContain("→ east");
  expect(out).toContain("Heading east");
});

test("tool history shows the pending tool as a dim '…'-prefixed last row", () => {
  let s = initTri();
  // One completed turn so we have a baseline non-pending row above.
  s = onTurnStart(s, { turn: 1, frameReason: "cellChange" });
  s = onAgentEvent(s, { kind: "action", move: "east" });
  s = onTurnEnd(s);
  // Now mark a new tool as pending.
  s = onToolPendingStart(s, {
    number: 2,
    name: "autopilot_explore",
    argsSummary: "(stepCap:150)",
    progress: "",
  });
  const out = render(s, "", 1000);
  expect(out).toContain("…");
  expect(out).toContain("autopilot_explore(stepCap:150)");
});

test("pending tool row shows progress detail when reported", () => {
  let s = initTri();
  s = onToolPendingStart(s, {
    number: 1,
    name: "autopilot_explore",
    argsSummary: "(stepCap:150)",
    progress: "",
  });
  s = onToolPendingProgress(s, "47/150");
  const out = render(s, "", 1000);
  expect(out).toContain("47/150");
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
