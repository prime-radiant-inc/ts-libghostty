import { describe, expect, test, afterEach, beforeEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { RunLog } from "../../examples/bobbihack/observability";

let tmpDir: string;
let logPath: string;
beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "bobbihack-runlog-"));
  logPath = join(tmpDir, "run.jsonl");
});
afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function readEvents(): unknown[] {
  const content = readFileSync(logPath, "utf8");
  return content
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as unknown);
}

describe("RunLog event shapes", () => {
  test("run_start has runId, model, systemPromptHash, specVersion, toolSchemaHash", () => {
    const log = new RunLog(logPath);
    log.append({
      event: "run_start",
      runId: "test-run",
      model: "claude-haiku-4-5",
      systemPromptHash: "sha256:abc",
      specVersion: "v4",
      toolSchemaHash: "sha256:def",
    });
    log.close();
    const events = readEvents() as { event: string; ts: string }[];
    expect(events.length).toBe(1);
    expect(events[0]?.event).toBe("run_start");
    expect(typeof events[0]?.ts).toBe("string");
  });

  test("turn event has tool, args, summary, screenHash, usage", () => {
    const log = new RunLog(logPath);
    log.append({
      event: "turn",
      turn: 142,
      tool: "move",
      args: { direction: "east" },
      summary: "moved east",
      screenHash: "sha256:111",
      usage: {
        input_tokens: 100,
        output_tokens: 20,
        cache_read_input_tokens: 50,
        cache_creation_input_tokens: 0,
      },
    });
    log.close();
    const events = readEvents() as Record<string, unknown>[];
    expect(events[0]?.event).toBe("turn");
    expect(events[0]?.turn).toBe(142);
    expect(events[0]?.tool).toBe("move");
    expect((events[0]?.usage as Record<string, number>).cache_read_input_tokens).toBe(50);
  });

  test("compaction, retry, interrupt, error, run_end events round-trip", () => {
    const log = new RunLog(logPath);
    log.append({
      event: "compaction",
      compactedThroughTurn: 100,
      liveTailSize: 20,
      messagesBefore: 200,
      messagesAfter: 122,
      snapshotPath: "messages/0001.json",
    });
    log.append({
      event: "retry",
      attempt: 1,
      delaySec: 1,
      errorClass: "rate_limit",
      statusCode: 429,
    });
    log.append({
      event: "interrupt",
      tool: "autopilot_explore",
      kind: "monster_visible",
      detail: "k at (8,12)",
      also: ["hp_drop"],
    });
    log.append({
      event: "error",
      errorClass: "fatal",
      message: "context overflow",
      fatal: true,
    });
    log.append({
      event: "run_end",
      reason: "model_stopped_without_tool_use",
      totalTurns: 487,
      totalCostUsd: 1.23,
    });
    log.close();
    const events = readEvents() as { event: string }[];
    expect(events.map((e) => e.event)).toEqual([
      "compaction",
      "retry",
      "interrupt",
      "error",
      "run_end",
    ]);
  });

  test("each line is a single JSON object", () => {
    const log = new RunLog(logPath);
    log.append({ event: "run_start", runId: "r", model: "m", systemPromptHash: "h", specVersion: "v", toolSchemaHash: "t" });
    log.append({ event: "run_end", reason: "done", totalTurns: 0, totalCostUsd: 0 });
    log.close();
    const raw = readFileSync(logPath, "utf8");
    const lines = raw.split("\n").filter((l) => l.length > 0);
    expect(lines.length).toBe(2);
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });
});
