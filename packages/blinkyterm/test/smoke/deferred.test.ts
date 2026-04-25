import { expect, test } from "bun:test";
import { makeDeferred } from "../../src/internal/deferred";

test("deferred resolves only when resolve is called", async () => {
  const d = makeDeferred<void>();
  let done = false;
  d.promise.then(() => { done = true; });
  await Bun.sleep(0);
  expect(done).toBe(false);
  d.resolve();
  await d.promise;
  expect(done).toBe(true);
});

test("distinct deferreds do not share state", async () => {
  const a = makeDeferred<void>();
  const b = makeDeferred<void>();
  let bDone = false;
  b.promise.then(() => { bDone = true; });
  a.resolve();
  await a.promise;
  await Bun.sleep(0);
  expect(bDone).toBe(false);
});
