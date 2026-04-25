import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

describe("tarball smoke", () => {
  it("packs, installs, imports, and runs successfully", () => {
    const result = spawnSync("bash", [join(process.cwd(), "scripts/run-tarball-smoke.sh")], {
      stdio: "pipe",
      encoding: "utf8",
    });
    if (result.status !== 0) {
      console.error("stdout:", result.stdout);
      console.error("stderr:", result.stderr);
    }
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("OK");
  }, 120_000);
});
