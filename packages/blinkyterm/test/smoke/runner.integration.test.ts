import { expect, test } from "bun:test";
import { Runner } from "../../src";
import { childFixture } from "../helpers/fixture-path";

test("mini-tui agent loop", async () => {
  await using runner = await Runner.spawn([childFixture("mini-tui.sh")], {
    frame: { minIntervalMs: 0, quiesceMs: 50, maxIntervalMs: 60000 },
  });
  let sent = false;
  let sawReply = false;
  for await (const frame of runner.frames()) {
    if (!sent && frame.snapshot.text.includes("Command:")) {
      await runner.sendText("hello\n");
      sent = true;
    }
    if (frame.snapshot.text.includes("you typed:hello")) sawReply = true;
    if (frame.reason === "exited" || frame.reason === "crashed") break;
  }
  expect(sent).toBe(true);
  expect(sawReply).toBe(true);
});

test("bell and title surface on frame snapshot", async () => {
  await using runner = await Runner.spawn([childFixture("bell-and-title.sh")], {
    frame: { minIntervalMs: 0, quiesceMs: 50, maxIntervalMs: 60000 },
  });
  let saw = false;
  for await (const frame of runner.frames()) {
    if (frame.snapshot.bellsSinceLast > 0 && frame.snapshot.titleChangesSinceLast.includes("title-one")) {
      saw = true;
    }
    if (frame.reason === "exited") break;
  }
  expect(saw).toBe(true);
});

test("slow painter coalesces into latest frame", async () => {
  await using runner = await Runner.spawn([childFixture("slow-painter.sh")], {
    frame: { minIntervalMs: 0, quiesceMs: 120, maxIntervalMs: 60000 },
  });
  let count = 0;
  let finalText = "";
  for await (const frame of runner.frames()) {
    count += 1;
    finalText = frame.snapshot.text;
    if (frame.reason === "exited") break;
  }
  expect(finalText).toContain("three");
  expect(count).toBeLessThan(8);
});
