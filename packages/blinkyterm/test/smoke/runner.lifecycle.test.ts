import { expect, test } from "bun:test";
import { ExitedError, Runner } from "../../src";
import { childFixture } from "../helpers/fixture-path";

test("waitExit returns false on timeout and true after exit", async () => {
  const runner = await Runner.spawn([childFixture("infinite-loop.sh")]);
  expect(await runner.waitExit({ timeoutMs: 20 })).toEqual({ exited: false });
  await runner.terminate();
  const result = await runner.waitExit();
  expect(result.exited).toBe(true);
  await runner[Symbol.asyncDispose]();
});

test("terminate escalates to SIGKILL", async () => {
  const runner = await Runner.spawn([childFixture("signal-ignorant.sh")]);
  await runner.terminate({ thenAfterMs: 50 });
  const result = await runner.waitExit();
  expect(result.exited).toBe(true);
  expect(result.signal).toBe("SIGKILL");
  await runner[Symbol.asyncDispose]();
});

test("resize updates VT geometry and throws after exit", async () => {
  const runner = await Runner.spawn([childFixture("infinite-loop.sh")]);
  await runner.resize(100, 40);
  expect(runner.terminal.snapshot().cols).toBe(100);
  await runner.terminate();
  await expect(runner.resize(80, 24)).rejects.toThrow(ExitedError);
  await runner[Symbol.asyncDispose]();
});
