// Per-run directory layout, run-id derivation, single-instance lock.

import {
  existsSync,
  mkdirSync,
  openSync,
  closeSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

export interface RunDirs {
  rootDir: string;
  runDir: string;
  journalDir: string;
  messagesDir: string;
  runLog: string;
  runLock: string;
  mapJson: string;
}

export function generateRunId(): string {
  const now = new Date();
  const pad = (n: number, w = 2): string => n.toString().padStart(w, "0");
  const datePart =
    `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}`;
  const timePart =
    `${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`;
  const rand = randomBytes(3).toString("hex");
  return `bbh-${datePart}-${timePart}-${rand}`;
}

export function runDirs(rootDir: string, runId: string): RunDirs {
  const runDir = join(rootDir, runId);
  return {
    rootDir,
    runDir,
    journalDir: join(runDir, "journal"),
    messagesDir: join(runDir, "messages"),
    runLog: join(runDir, "run.jsonl"),
    runLock: join(runDir, "run.lock"),
    mapJson: join(runDir, "map.json"),
  };
}

export interface RunLock {
  released: () => void;
}

export function acquireRunLock(dirs: RunDirs): RunLock {
  // Create run-dir tree.
  mkdirSync(dirs.runDir, { recursive: true });
  mkdirSync(dirs.journalDir, { recursive: true });
  mkdirSync(dirs.messagesDir, { recursive: true });

  // Atomic exclusive create on the lock file. If it already exists, throw.
  let fd: number;
  try {
    fd = openSync(dirs.runLock, "wx");  // O_EXCL
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      const existing = existsSync(dirs.runLock)
        ? readFileSync(dirs.runLock, "utf8").trim()
        : "(unknown)";
      throw new Error(
        `another bobbihack is running (lock at ${dirs.runLock}; holder: ${existing}); refusing to start`,
      );
    }
    throw err;
  }
  closeSync(fd);

  // Write PID + run-id for debugging.
  const runId = dirs.runDir.split("/").pop() ?? "unknown";
  writeFileSync(dirs.runLock, `pid=${process.pid} runId=${runId}\n`);

  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    try {
      unlinkSync(dirs.runLock);
    } catch {
      // already gone — fine
    }
  };

  // Best-effort cleanup on process exit.
  process.once("exit", release);

  return { released: release };
}
