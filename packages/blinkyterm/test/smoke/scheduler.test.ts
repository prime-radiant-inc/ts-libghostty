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
