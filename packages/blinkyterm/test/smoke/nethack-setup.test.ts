// Regression tests for the NetHack data-dir lock-file regex.
// Production trace bbh-20260511-202947-7d8afd hit a "tricked death"
// at turn 191 because `cleanupNetHackLocks` was using `/lock/i` which
// matches `block.N` (level data, NOT a lock) as a substring. The
// concurrent smoke-test cleanup nuked the live run's `block.0`,
// NetHack got ENOENT on its next level transition, and ran its
// end-of-game cleanup.

import { describe, expect, test } from "bun:test";
import { _LOCK_FILE_RE_FOR_TEST } from "../../examples/shared/nethack-setup";

describe("cleanupNetHackLocks regex", () => {
  test("matches real NetHack lock-file patterns", () => {
    const re = _LOCK_FILE_RE_FOR_TEST;
    expect(re.test("alock.0")).toBe(true);
    expect(re.test("alock.1")).toBe(true);
    expect(re.test("alock.20")).toBe(true);
    expect(re.test("lock.0")).toBe(true);
    expect(re.test("nhlock.5")).toBe(true);
    expect(re.test("xlock")).toBe(true);
  });

  test("REGRESSION: does NOT match block.N (level data, not a lock)", () => {
    // The exact files that bit run bbh-20260511-202947-7d8afd.
    const re = _LOCK_FILE_RE_FOR_TEST;
    expect(re.test("block.0")).toBe(false);
    expect(re.test("block.1")).toBe(false);
    expect(re.test("block.2")).toBe(false);
    expect(re.test("block.42")).toBe(false);
  });

  test("does NOT match other NetHack data files", () => {
    const re = _LOCK_FILE_RE_FOR_TEST;
    // Game-wide logs and state — must never be deleted by cleanup.
    expect(re.test("logfile")).toBe(false);
    expect(re.test("paniclog")).toBe(false);
    expect(re.test("perm")).toBe(false);
    expect(re.test("record")).toBe(false);
    expect(re.test("xlogfile")).toBe(false);
    expect(re.test("save")).toBe(false);
  });

  test("does NOT match arbitrary unrelated files", () => {
    const re = _LOCK_FILE_RE_FOR_TEST;
    expect(re.test("README")).toBe(false);
    expect(re.test("notalock")).toBe(false);
    expect(re.test("locked.txt")).toBe(false);
    expect(re.test("alock")).toBe(false); // missing .N
    expect(re.test("alock.")).toBe(false); // missing N
    expect(re.test("alock.abc")).toBe(false); // non-numeric
  });
});
