import { expect, test } from "bun:test";
import { ExitedError, Runner } from "../../src";
import { childFixture } from "../helpers/fixture-path";

test("sendText round-trips through child", async () => {
  await using runner = await Runner.spawn([childFixture("wait-for-input.sh")]);
  const it = runner.frames()[Symbol.asyncIterator]();
  const first = await it.next();
  expect(first.done).toBe(false);
  await runner.sendText("hello\n");
  let saw = false;
  for (;;) {
    const next = await it.next();
    if (next.done) break;
    if (next.value.snapshot.text.includes("input:hello")) {
      saw = true;
    }
    if (next.value.reason === "exited" || next.value.reason === "crashed") {
      break;
    }
  }
  expect(saw).toBe(true);
});

test("sendBytes after exit throws ExitedError", async () => {
  await using runner = await Runner.spawn([childFixture("echo-and-exit.sh")]);
  await runner.waitExit();
  await expect(runner.sendBytes(new Uint8Array([0x61]))).rejects.toBeInstanceOf(ExitedError);
});
