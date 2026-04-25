import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { childFixture } from "../helpers/fixture-path";

test("child fixture paths resolve from package and workspace roots", () => {
  const result = spawnSync(childFixture("echo-and-exit.sh"), { encoding: "utf8" });
  expect(result.status).toBe(0);
  expect(result.stdout).toContain("hello from child");
});
