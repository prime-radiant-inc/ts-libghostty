import { expect, test } from "bun:test";
import { createFakeClock } from "../../src/internal/clock";

test("fake clock fires timers in due order", () => {
  const clock = createFakeClock();
  const fired: string[] = [];
  clock.setTimeout(() => fired.push("b"), 20);
  clock.setTimeout(() => fired.push("a"), 10);
  clock.advance(10);
  expect(fired).toEqual(["a"]);
  clock.advance(10);
  expect(fired).toEqual(["a", "b"]);
});

test("fake clock clear prevents callback", () => {
  const clock = createFakeClock();
  const timer = clock.setTimeout(() => {
    throw new Error("cleared timer fired");
  }, 10);
  timer.clear();
  clock.advance(10);
  expect(clock.now()).toBe(10);
});
