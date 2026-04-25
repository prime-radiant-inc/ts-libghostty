import { expect, test } from "bun:test";
import { DisposedError, IteratorInUseError, Runner } from "../../src";
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

// Regression: a child that writes bytes then exits within quiesceMs leaves
// both `initial` and `exited`/`crashed` pending when the iterator runs.
// priorityPick ranks exited > initial, so without the firstFrameDelivered
// guard the first frame would steal the terminal slot. Spec §3.5 requires
// the first frame be `reason: "initial"`.
test("fast-exit child still yields initial frame before terminal frame", async () => {
  await using runner = await Runner.spawn(
    ["bash", "-lc", "printf 'fast hello'; exit 0"],
    { frame: { minIntervalMs: 0, quiesceMs: 200, maxIntervalMs: 60000 } },
  );
  const it = runner.frames()[Symbol.asyncIterator]();
  const first = await it.next();
  expect(first.done).toBe(false);
  expect(first.value.reason).toBe("initial");
  expect(first.value.snapshot.text).toContain("fast hello");
  const second = await it.next();
  expect(second.done).toBe(false);
  expect(["exited", "crashed"]).toContain(second.value.reason);
  expect(second.value.exitCode).toBe(0);
  const third = await it.next();
  expect(third.done).toBe(true);
});

// Regression: after a terminal frame is delivered, the iterator must
// release its hold so a new frames() call does not throw IteratorInUseError.
test("frames() works again after a previous iterator runs to completion", async () => {
  await using runner = await Runner.spawn([childFixture("echo-and-exit.sh")]);
  const it = runner.frames()[Symbol.asyncIterator]();
  for (;;) {
    const r = await it.next();
    if (r.done) break;
    if (r.value.reason === "exited" || r.value.reason === "crashed") {
      const done = await it.next();
      expect(done.done).toBe(true);
      break;
    }
  }
  // Lock should be released — calling frames() again must not throw
  // IteratorInUseError. (The new iterator's next() may hang because the
  // child has long since exited, but the synchronous frames() call itself
  // must succeed.)
  expect(() => runner.frames()).not.toThrow();
});

// Regression: frames() must honor the runner-level disposed guard.
test("frames() throws DisposedError after asyncDispose", async () => {
  const runner = await Runner.spawn([childFixture("infinite-loop.sh")]);
  await runner[Symbol.asyncDispose]();
  expect(() => runner.frames()).toThrow(DisposedError);
});
