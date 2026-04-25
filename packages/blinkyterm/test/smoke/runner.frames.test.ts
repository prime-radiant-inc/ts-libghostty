import { expect, test } from "bun:test";
import { IteratorInUseError, Runner } from "../../src";
import { childFixture } from "../helpers/fixture-path";

test("frames yields initial frame", async () => {
  await using runner = await Runner.spawn([childFixture("echo-and-exit.sh")]);
  const it = runner.frames()[Symbol.asyncIterator]();
  const first = await it.next();
  expect(first.done).toBe(false);
  expect(first.value.reason).toBe("initial");
  expect(first.value.snapshot.text).toContain("hello from child");
});

test("terminal frame is delivered once then iterator is done", async () => {
  await using runner = await Runner.spawn([childFixture("echo-and-exit.sh")]);
  const it = runner.frames()[Symbol.asyncIterator]();
  let sawTerminal = false;
  for (;;) {
    const next = await it.next();
    if (next.done) break;
    if (next.value.reason === "exited" || next.value.reason === "crashed") {
      sawTerminal = true;
      const done = await it.next();
      expect(done.done).toBe(true);
      break;
    }
  }
  expect(sawTerminal).toBe(true);
});

test("only one iterator may be active", async () => {
  await using runner = await Runner.spawn([childFixture("infinite-loop.sh")]);
  const iter = runner.frames()[Symbol.asyncIterator]();
  expect(() => runner.frames()).toThrow(IteratorInUseError);
  await iter.return?.();
});
