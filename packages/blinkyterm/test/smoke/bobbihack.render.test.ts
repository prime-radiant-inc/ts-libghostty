import { expect, test } from "bun:test";
import { render } from "../../examples/bobbihack/render";
import { initialState, onAgentEvent, onChildFrame, onTurnEnd, onTurnStart } from "../../examples/bobbihack/state";
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

const frame = (text: string): Frame => ({
  reason: "cellChange",
  snapshot: fakeSnapshot(text) as Frame["snapshot"],
});

const initSide = () => initialState({ hostCols: 200, hostRows: 60, agentLabel: "mock", pid: 999 });
const initStacked = () => initialState({ hostCols: 100, hostRows: 40, agentLabel: "mock", pid: 999 });
const initTooSmall = () => initialState({ hostCols: 30, hostRows: 10, agentLabel: "mock", pid: 999 });

test("render emits alt-screen-safe SGR resets and hides cursor", () => {
  const out = render(initSide());
  expect(out).toContain("\x1b[?25l");      // hide cursor
  expect(out).toContain("\x1b[0m");        // SGR reset
});

test("render side-by-side layout includes both pane title bars", () => {
  const out = render(initSide());
  expect(out).toContain("NetHack");        // NetHack pane title
  expect(out).toContain("Agent (mock)");   // Agent pane title
});

test("render places NetHack content row by row at the right offsets", () => {
  let s = initSide();
  s = onChildFrame(s, frame("ABCDEFG\nHIJKLMN"));
  const out = render(s);
  expect(out).toContain("ABCDEFG");
  expect(out).toContain("HIJKLMN");
  // Cursor positioning to (row=2, col=2) — first content row, inside left border
  expect(out).toContain("\x1b[2;2H");
});

test("render strips CR so trailing \\r in toAnsi() rows doesn't clobber the left border", () => {
  // libghostty separates rows with "\r\n"; splitting on "\n" leaves the
  // "\r" trailing each line. A naive render sends that "\r" through to
  // the host terminal, jumping the cursor to column 1 and letting
  // subsequent padding overwrite the left pane border.
  let s = initSide();
  s = onChildFrame(s, frame("ABCDEFG\r\nHIJKLMN\r"));
  const out = render(s);
  expect(out).toContain("ABCDEFG");
  expect(out).toContain("HIJKLMN");
  expect(out).not.toContain("\r");
});

test("render shows current turn streaming text in live area", () => {
  let s = initSide();
  s = onTurnStart(s, { turn: 7, frameReason: "cellChange" });
  s = onAgentEvent(s, { kind: "thinking", delta: "looking around" });
  const out = render(s);
  expect(out).toContain("turn 7");
  expect(out).toContain("looking around");
});

test("render shows history entries newest-first with decision and summary", () => {
  let s = initSide();
  s = onTurnStart(s, { turn: 1, frameReason: "cellChange" });
  s = onAgentEvent(s, { kind: "thinking", delta: "going east now" });
  s = onAgentEvent(s, { kind: "action", move: "east" });
  s = onTurnEnd(s);
  s = onTurnStart(s, { turn: 2, frameReason: "bell" });
  s = onAgentEvent(s, { kind: "action", move: "north" });
  s = onTurnEnd(s);
  const out = render(s);
  // newest first
  const idxTurn2 = out.indexOf("#2");
  const idxTurn1 = out.indexOf("#1");
  expect(idxTurn2).toBeGreaterThan(-1);
  expect(idxTurn1).toBeGreaterThan(-1);
  expect(idxTurn2).toBeLessThan(idxTurn1);
  expect(out).toContain("→ north");
  expect(out).toContain("→ east");
});

test("render stacked layout still emits both pane titles", () => {
  const out = render(initStacked());
  expect(out).toContain("NetHack");
  expect(out).toContain("Agent (mock)");
});

test("render tooSmall shows a single resize message and no boxes", () => {
  const out = render(initTooSmall());
  expect(out).toContain("Resize");
  expect(out).toContain("126");  // side-by-side minimum cols
  expect(out).toContain("84");   // stacked minimum cols
});
