import { describe, expect, test, afterEach, beforeEach } from "bun:test";
import { rmSync, mkdtempSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  generateRunId,
  runDirs,
  acquireRunLock,
} from "../../examples/bobbihack/paths";

let tmpRoot: string;
beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "bobbihack-paths-"));
});
afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("generateRunId", () => {
  test("matches the spec format bbh-YYYYMMDD-HHMMSS-<6 hex>", () => {
    const id = generateRunId();
    expect(id).toMatch(/^bbh-\d{8}-\d{6}-[0-9a-f]{6}$/);
  });

  test("two calls in the same second produce distinct IDs", () => {
    const a = generateRunId();
    const b = generateRunId();
    expect(a).not.toBe(b);
  });
});

describe("runDirs", () => {
  test("returns the spec directory layout", () => {
    const dirs = runDirs(tmpRoot, "bbh-20260426-180000-abc123");
    expect(dirs.runDir).toBe(join(tmpRoot, "bbh-20260426-180000-abc123"));
    expect(dirs.journalDir).toBe(join(dirs.runDir, "journal"));
    expect(dirs.messagesDir).toBe(join(dirs.runDir, "messages"));
    expect(dirs.runLog).toBe(join(dirs.runDir, "run.jsonl"));
    expect(dirs.runLock).toBe(join(dirs.runDir, "run.lock"));
    expect(dirs.mapJson).toBe(join(dirs.runDir, "map.json"));
  });
});

describe("acquireRunLock", () => {
  test("creates the run dir, writes pid + run-id, returns released()", () => {
    const dirs = runDirs(tmpRoot, "test-run");
    const lock = acquireRunLock(dirs);
    try {
      expect(existsSync(dirs.runLock)).toBe(true);
      const content = readFileSync(dirs.runLock, "utf8");
      expect(content).toContain(`${process.pid}`);
      expect(content).toContain("test-run");
    } finally {
      lock.released();
    }
  });

  test("second acquire on same dir throws with PID-and-run-id message", () => {
    const dirs = runDirs(tmpRoot, "test-run");
    const a = acquireRunLock(dirs);
    try {
      expect(() => acquireRunLock(dirs)).toThrow(/another bobbihack is running/i);
    } finally {
      a.released();
    }
  });

  test("released() removes the lock file so a subsequent acquire succeeds", () => {
    const dirs = runDirs(tmpRoot, "test-run");
    const a = acquireRunLock(dirs);
    a.released();
    const b = acquireRunLock(dirs);
    b.released();
  });
});
