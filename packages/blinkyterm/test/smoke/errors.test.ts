import { expect, test } from "bun:test";
import {
  BlinkyTermError,
  DisposedError,
  ExitedError,
  FirstFrameTimeoutError,
  IteratorInUseError,
  SpawnError,
} from "../../src";

test("errors have stable names and codes", () => {
  expect(new SpawnError("nope").code).toBe("spawn_failed");
  expect(new FirstFrameTimeoutError(25)).toBeInstanceOf(SpawnError);
  expect(new FirstFrameTimeoutError(25).code).toBe("first_frame_timeout");
  expect(new ExitedError("sendText").code).toBe("exited");
  expect(new DisposedError("Runner").code).toBe("disposed");
  expect(new IteratorInUseError().code).toBe("iterator_in_use");
});

test("all blinkyterm errors share one base", () => {
  expect(new ExitedError("sendText")).toBeInstanceOf(BlinkyTermError);
});
