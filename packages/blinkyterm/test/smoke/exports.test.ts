import { expect, test } from "bun:test";
import { Runner } from "../../src";
import type { FrameReason, FrameSnapshot, SpawnOptions } from "../../src";

test("Runner export exists", () => {
  expect(typeof Runner).toBe("function");
});

test("public type surface has expected shapes", () => {
  const reasons: FrameReason[] = [
    "initial",
    "cellChange",
    "titleChange",
    "bell",
    "cursorMove",
    "heartbeat",
    "exited",
    "crashed",
  ];
  const snapshot: FrameSnapshot = {
    text: "",
    title: "",
    cursor: { x: 0, y: 0, visible: true },
    bellsSinceLast: 0,
    titleChangesSinceLast: [],
    toAnsi: () => "",
    toHtml: () => "",
    toVt: () => "",
    cellAt: () => null,
  };
  const opts: SpawnOptions = { cols: 80, rows: 24 };
  expect(reasons).toHaveLength(8);
  expect(snapshot.cursor.visible).toBe(true);
  expect(opts.cols).toBe(80);
});
