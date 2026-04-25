import { expect, test } from "bun:test";
import { createFakeClock } from "../../src/internal/clock";
import { Scheduler, priorityPick } from "../../src/internal/scheduler";

test("scheduler accumulates reasons and consume resets with fresh deferred", async () => {
  const scheduler = new Scheduler({ clock: createFakeClock() });
  scheduler.noteBell();
  scheduler.noteTitleChange("one");
  scheduler.markReady();
  await scheduler.awaitReady();
  expect(scheduler.snapshot().bellsSinceLast).toBe(1);
  expect(scheduler.snapshot().titleChangesSinceLast).toEqual(["one"]);
  scheduler.consume();
  expect(scheduler.snapshot().bellsSinceLast).toBe(0);
  expect(scheduler.snapshot().pendingReasons).toEqual([]);
});

test("priorityPick follows spec order", () => {
  expect(priorityPick(new Set(["heartbeat"]))).toBe("heartbeat");
  expect(priorityPick(new Set(["cellChange", "bell"]))).toBe("bell");
  expect(priorityPick(new Set(["cellChange", "titleChange", "exited"]))).toBe("exited");
  expect(priorityPick(new Set(["crashed", "exited"]))).toBe("crashed");
});

test("quiesce callback runs after quiet period and can mark ready", async () => {
  const clock = createFakeClock();
  const scheduler = new Scheduler({
    clock,
    frame: { quiesceMs: 100, minIntervalMs: 0, maxIntervalMs: 30000 },
  });
  scheduler.onQuiesce(() => scheduler.noteCellChange());
  scheduler.notePtyChunk();
  clock.advance(50);
  expect(scheduler.readyToYield).toBe(false);
  scheduler.notePtyChunk();
  clock.advance(99);
  expect(scheduler.readyToYield).toBe(false);
  clock.advance(1);
  await scheduler.awaitReady();
  expect(scheduler.snapshot().pendingReasons).toContain("cellChange");
});

test("heartbeat bypasses yieldOn", async () => {
  const clock = createFakeClock();
  const scheduler = new Scheduler({
    clock,
    frame: { quiesceMs: 100, minIntervalMs: 1000, maxIntervalMs: 3000, yieldOn: [] },
  });
  clock.advance(3000);
  await scheduler.awaitReady();
  expect(scheduler.snapshot().pendingReasons).toEqual(["heartbeat"]);
});

test("terminal reason bypasses min interval", async () => {
  const clock = createFakeClock();
  const scheduler = new Scheduler({
    clock,
    frame: { quiesceMs: 100, minIntervalMs: 10000, maxIntervalMs: 30000 },
  });
  scheduler.noteExit({ exitCode: 0 });
  await scheduler.awaitReady();
  expect(priorityPick(scheduler.pendingReasonSet())).toBe("exited");
});
