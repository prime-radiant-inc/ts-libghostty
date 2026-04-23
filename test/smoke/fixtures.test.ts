import { describe, expect, it } from "bun:test";
import { listFixtures, runFixture } from "../helpers/fixture-harness";
import { join } from "node:path";

const DIR = join(process.cwd(), "test/fixtures");

// Pass 1 fixtures only verify formatter plumbing — byte stream in, text out.
// They do NOT prove semantic correctness of the VT state machine. Deeper
// semantic fixtures (render-state metadata JSON, styles, wide graphemes,
// malformed input, real-program captures) land with Pass 3 when RenderState
// exists and can be directly asserted against.
describe("formatter fixtures (plumbing-only)", () => {
  it("lists at least hello-world", async () => {
    const names = await listFixtures(DIR);
    expect(names).toContain("hello-world");
  });

  it("hello-world round-trips through vtWrite → Formatter", async () => {
    const result = await runFixture(DIR, "hello-world");
    if (!result.pass) {
      console.error("--- expected ---\n" + result.expected);
      console.error("--- actual ---\n" + result.actual);
    }
    expect(result.pass).toBe(true);
  });
});
