import { expect, test } from "bun:test";
import { RenderState, Terminal } from "libghostty-vt";
import { buildFrameSnapshot } from "../../src/internal/snapshot";

const enc = new TextEncoder();

test("snapshot text and cells stay frozen after terminal mutation", () => {
  using terminal = new Terminal({ cols: 10, rows: 3 });
  using renderState = new RenderState();
  terminal.vtWrite(enc.encode("alpha"));
  renderState.update(terminal);

  const snap = buildFrameSnapshot({
    terminal,
    renderState,
    bellsSinceLast: 1,
    titleChangesSinceLast: ["first"],
  });

  terminal.vtWrite(enc.encode("\r\nbeta"));
  renderState.update(terminal);

  expect(snap.text).toContain("alpha");
  expect(snap.text).not.toContain("beta");
  expect(snap.toAnsi()).toContain("alpha");
  expect(snap.toHtml()).toContain("alpha");
  expect(snap.cellAt(0, 0)?.text).toBe("a");
  expect(snap.bellsSinceLast).toBe(1);
  expect(snap.titleChangesSinceLast).toEqual(["first"]);
  expect(Object.isFrozen(snap)).toBe(true);
  expect(Object.isFrozen(snap.cursor)).toBe(true);
});
