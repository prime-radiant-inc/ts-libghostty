import { expect, test } from "bun:test";
import { Runner, SpawnError } from "../../src";
import { childFixture } from "../helpers/fixture-path";

test("Runner.spawn allocates a running runner", async () => {
  await using runner = await Runner.spawn([childFixture("echo-and-exit.sh")], {
    firstFrameTimeoutMs: 1000,
  });
  expect(runner.pid).toBeGreaterThan(0);
  expect(runner.terminal.snapshot().cols).toBe(80);
});

test("missing command rejects with SpawnError", async () => {
  await expect(Runner.spawn(["/definitely/not/a/command"])).rejects.toThrow(SpawnError);
});

test("async dispose is idempotent", async () => {
  const runner = await Runner.spawn([childFixture("infinite-loop.sh")]);
  await runner[Symbol.asyncDispose]();
  await runner[Symbol.asyncDispose]();
  expect(runner.disposed).toBe(true);
});

test("silent child rejects with FirstFrameTimeoutError", async () => {
  await expect(Runner.spawn(["bash", "-lc", "sleep 1"], {
    firstFrameTimeoutMs: 50,
  })).rejects.toThrow("initial frame");
});

test("child that exits before output also rejects with FirstFrameTimeoutError", async () => {
  await expect(Runner.spawn(["bash", "-lc", "exit 0"], {
    firstFrameTimeoutMs: 50,
  })).rejects.toThrow("initial frame");
});
