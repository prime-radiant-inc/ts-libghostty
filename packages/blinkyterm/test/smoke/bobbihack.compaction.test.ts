// Compaction tests — exercises the five sub-functions of compaction.ts
// (summarizeOldToolResult, placeBreakpoints, injectCompactionMarker,
// writeSnapshot, maybeCompact) plus the aggregate orchestrator
// triggering rules. All sub-functions are pure where possible; the
// orchestrator is async because it touches the snapshot writer.

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  summarizeOldToolResult,
  placeBreakpoints,
  injectCompactionMarker,
  writeSnapshot,
  maybeCompact,
  estimateInputTokens,
  COMPACTION_MARKER_PREFIX,
  type CompactionMessage,
  type CompactionRunState,
  type MaybeCompactCtx,
} from "../../examples/bobbihack/compaction";
import { RunLog } from "../../examples/bobbihack/observability";

const ORIGINAL_KEEP = process.env.BOBBIHACK_KEEP_SNAPSHOTS;
const ORIGINAL_TAIL = process.env.BOBBIHACK_LIVE_TAIL;

beforeEach(() => {
  delete process.env.BOBBIHACK_KEEP_SNAPSHOTS;
  delete process.env.BOBBIHACK_LIVE_TAIL;
});
afterEach(() => {
  if (ORIGINAL_KEEP === undefined) delete process.env.BOBBIHACK_KEEP_SNAPSHOTS;
  else process.env.BOBBIHACK_KEEP_SNAPSHOTS = ORIGINAL_KEEP;
  if (ORIGINAL_TAIL === undefined) delete process.env.BOBBIHACK_LIVE_TAIL;
  else process.env.BOBBIHACK_LIVE_TAIL = ORIGINAL_TAIL;
});

// -------- summarizeOldToolResult --------

describe("summarizeOldToolResult", () => {
  test("byte-stable format for move", () => {
    const stub = summarizeOldToolResult(
      12,
      { type: "tool_use", id: "tu_1", name: "move", input: { direction: "east" } },
      "== bobbihack tool_result v1 ==\nmove(east): walked into a wall\nFloor: D1...\n",
    );
    expect(stub).toBe("<turn 12 — move(east): walked into a wall>");
  });

  test("autopilot_to with multi-arg", () => {
    const stub = summarizeOldToolResult(
      73,
      {
        type: "tool_use",
        id: "tu_2",
        name: "autopilot_to",
        input: { floor: "D1", x: 29, y: 7 },
      },
      "== bobbihack tool_result v1 ==\nautopilot_to(D1,29,7) arrived; HP 14→14\nFloor: D1...\n",
    );
    expect(stub).toBe(
      "<turn 73 — autopilot_to(D1,29,7): autopilot_to(D1,29,7) arrived; HP 14→14>",
    );
  });

  test("journal_read shows section arg", () => {
    const stub = summarizeOldToolResult(
      5,
      { type: "tool_use", id: "tu_3", name: "journal_read", input: { section: "Knowledge" } },
      "== bobbihack tool_result v1 ==\nread Knowledge.md (412 bytes)\n",
    );
    expect(stub).toBe("<turn 5 — journal_read(Knowledge): read Knowledge.md (412 bytes)>");
  });

  test("respond_prompt with control char shows escaped form", () => {
    const stub = summarizeOldToolResult(
      8,
      { type: "tool_use", id: "tu_4", name: "respond_prompt", input: { keys: " " } },
      "== bobbihack tool_result v1 ==\ndismissed --More--\n",
    );
    expect(stub).toBe("<turn 8 — respond_prompt(' '): dismissed --More-->");
  });

  test("zero-arg tool", () => {
    const stub = summarizeOldToolResult(
      3,
      { type: "tool_use", id: "tu_5", name: "search", input: {} },
      "== bobbihack tool_result v1 ==\nsearched: nothing found\n",
    );
    expect(stub).toBe("<turn 3 — search(): searched: nothing found>");
  });

  test("tool_result missing header — falls back to first non-empty line", () => {
    const stub = summarizeOldToolResult(
      99,
      { type: "tool_use", id: "tu_6", name: "move", input: { direction: "north" } },
      "raw text without header\nsecond line\n",
    );
    expect(stub).toBe("<turn 99 — move(north): raw text without header>");
  });

  test("error tool_result content (JSON-shaped) is summarized", () => {
    const stub = summarizeOldToolResult(
      4,
      { type: "tool_use", id: "tu_7", name: "move", input: { direction: "east" } },
      JSON.stringify({ error: "no path" }),
    );
    expect(stub).toContain("<turn 4 — move(east): ");
    expect(stub).toContain("no path");
  });

  test("identical inputs produce byte-identical output", () => {
    const a = summarizeOldToolResult(
      12,
      { type: "tool_use", id: "tu_a", name: "move", input: { direction: "east" } },
      "== bobbihack tool_result v1 ==\nmove(east): walked into a wall\n",
    );
    const b = summarizeOldToolResult(
      12,
      { type: "tool_use", id: "tu_b", name: "move", input: { direction: "east" } },
      "== bobbihack tool_result v1 ==\nmove(east): walked into a wall\n",
    );
    // Note: the tool_use_id is intentionally NOT part of the stub, so
    // two different ids must still produce identical stubs (only
    // turnIdx, name, args, and outcome matter).
    expect(a).toBe(b);
  });
});

// -------- placeBreakpoints --------

function mkSystemPlusMessages(): CompactionMessage[] {
  return [
    { role: "user", content: "initial user msg" },
    {
      role: "assistant",
      content: [
        { type: "tool_use", id: "tu_1", name: "move", input: { direction: "east" } },
      ],
    },
    {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "tu_1", content: "stub for tu_1" },
      ],
    },
    {
      role: "assistant",
      content: [
        { type: "tool_use", id: "tu_2", name: "move", input: { direction: "south" } },
      ],
    },
    {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "tu_2", content: "live result tu_2" },
      ],
    },
  ];
}

describe("placeBreakpoints", () => {
  test("returns a NEW array (immutable input)", () => {
    const msgs = mkSystemPlusMessages();
    const before = JSON.stringify(msgs);
    const result = placeBreakpoints(msgs, 3);
    expect(result).not.toBe(msgs);
    // Input untouched.
    expect(JSON.stringify(msgs)).toBe(before);
  });

  test("B2 placed at first message at or after liveTailStart", () => {
    const msgs = mkSystemPlusMessages();
    const result = placeBreakpoints(msgs, 3); // index 3 = assistant for tu_2
    const m3 = result[3] as { _cacheControl?: unknown };
    expect(m3._cacheControl).toEqual({ type: "ephemeral", ttl: "1h" });
  });

  test("only one B2 set — no other messages get cache_control", () => {
    const msgs = mkSystemPlusMessages();
    const result = placeBreakpoints(msgs, 3);
    let count = 0;
    for (const m of result) {
      if ((m as { _cacheControl?: unknown })._cacheControl !== undefined) count += 1;
    }
    expect(count).toBe(1);
  });

  test("re-compaction moves B2 forward", () => {
    const msgs = mkSystemPlusMessages();
    const first = placeBreakpoints(msgs, 1); // B2 at idx 1
    const second = placeBreakpoints(first, 3); // B2 at idx 3, idx 1 cleared
    const m1 = second[1] as { _cacheControl?: unknown };
    const m3 = second[3] as { _cacheControl?: unknown };
    expect(m1._cacheControl).toBeUndefined();
    expect(m3._cacheControl).toEqual({ type: "ephemeral", ttl: "1h" });
  });

  test("byte-exact prefix invariant: prefix up to and including B2 stable across compactions", () => {
    // Build two arrays where the first 4 messages are identical and
    // the second array adds a 5th. Place B2 at idx 3 in both. The
    // prefix [0..3] must be byte-identical so cache hits can occur.
    const baseA = mkSystemPlusMessages().slice(0, 4);
    const baseB = mkSystemPlusMessages().slice(0, 5); // one extra message
    const a = placeBreakpoints(baseA, 3);
    const b = placeBreakpoints(baseB, 3);
    const prefixA = JSON.stringify(a.slice(0, 4));
    const prefixB = JSON.stringify(b.slice(0, 4));
    expect(prefixA).toBe(prefixB);
  });

  test("liveTailStart out of range — no B2 set", () => {
    const msgs = mkSystemPlusMessages();
    const result = placeBreakpoints(msgs, 999);
    for (const m of result) {
      expect((m as { _cacheControl?: unknown })._cacheControl).toBeUndefined();
    }
  });
});

// -------- injectCompactionMarker --------

describe("injectCompactionMarker", () => {
  test("inserts a synthetic user message at the boundary", () => {
    const msgs = mkSystemPlusMessages();
    const result = injectCompactionMarker(msgs, 3, 12);
    expect(result.length).toBe(msgs.length + 1);
    const marker = result[3] as { role: string; content: unknown };
    expect(marker.role).toBe("user");
    expect(typeof marker.content).toBe("string");
    expect(marker.content).toContain(COMPACTION_MARKER_PREFIX);
    expect(marker.content).toContain("turns 1–12");
  });

  test("idempotent: re-injecting at the same idx replaces, not stacks", () => {
    const msgs = mkSystemPlusMessages();
    const once = injectCompactionMarker(msgs, 3, 12);
    const twice = injectCompactionMarker(once, 3, 12);
    expect(twice.length).toBe(once.length);
    // The marker text should be at idx 3 in both.
    expect((twice[3] as { content: unknown }).content).toEqual(
      (once[3] as { content: unknown }).content,
    );
  });

  test("idempotent with updated turn count: replaces in place with new text", () => {
    const msgs = mkSystemPlusMessages();
    const once = injectCompactionMarker(msgs, 3, 12);
    const twice = injectCompactionMarker(once, 3, 50);
    expect(twice.length).toBe(once.length);
    expect((twice[3] as { content: string }).content).toContain("turns 1–50");
  });

  test("input array is not mutated", () => {
    const msgs = mkSystemPlusMessages();
    const before = JSON.stringify(msgs);
    injectCompactionMarker(msgs, 3, 12);
    expect(JSON.stringify(msgs)).toBe(before);
  });
});

// -------- writeSnapshot --------

describe("writeSnapshot", () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "bobbihack-snapshot-"));
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("first call writes 0001.json with the messages array", async () => {
    const msgs = mkSystemPlusMessages();
    const path = await writeSnapshot(tmpDir, 1, msgs);
    expect(path.endsWith("0001.json")).toBe(true);
    const round = JSON.parse(readFileSync(path, "utf8")) as CompactionMessage[];
    expect(round.length).toBe(msgs.length);
  });

  test("zero-pads the seqNum to 4 digits", async () => {
    const path = await writeSnapshot(tmpDir, 42, []);
    expect(path.endsWith("0042.json")).toBe(true);
  });

  test("monotonic sequence advances", async () => {
    const a = await writeSnapshot(tmpDir, 1, []);
    const b = await writeSnapshot(tmpDir, 2, []);
    const c = await writeSnapshot(tmpDir, 3, []);
    expect(a).not.toBe(b);
    expect(b).not.toBe(c);
    const files = readdirSync(tmpDir).sort();
    expect(files).toEqual(["0001.json", "0002.json", "0003.json"]);
  });

  test("BOBBIHACK_KEEP_SNAPSHOTS=2 — third snapshot deletes the first", async () => {
    process.env.BOBBIHACK_KEEP_SNAPSHOTS = "2";
    await writeSnapshot(tmpDir, 1, []);
    await writeSnapshot(tmpDir, 2, []);
    await writeSnapshot(tmpDir, 3, []);
    const files = readdirSync(tmpDir).sort();
    expect(files).toEqual(["0002.json", "0003.json"]);
  });

  test("default retention (no env var) keeps all", async () => {
    for (let i = 1; i <= 5; i++) {
      await writeSnapshot(tmpDir, i, []);
    }
    const files = readdirSync(tmpDir).sort();
    expect(files.length).toBe(5);
  });

  test("atomic write: no partial file visible (no trailing temp file remains)", async () => {
    await writeSnapshot(tmpDir, 1, mkSystemPlusMessages());
    const files = readdirSync(tmpDir);
    // Only the final 0001.json should exist; no .tmp or .partial leftovers.
    expect(files).toEqual(["0001.json"]);
  });
});

// -------- estimateInputTokens (helper, tested for sanity) --------

describe("estimateInputTokens", () => {
  test("returns ≥ 1 for any non-empty messages", () => {
    expect(estimateInputTokens(mkSystemPlusMessages())).toBeGreaterThan(0);
  });

  test("monotonic in array length", () => {
    const small = mkSystemPlusMessages();
    const big = [...small, ...small, ...small];
    expect(estimateInputTokens(big)).toBeGreaterThan(estimateInputTokens(small));
  });
});

// -------- maybeCompact orchestrator --------

function makeCompactionCtx(opts: {
  runDir: string;
  runLog: RunLog;
}): MaybeCompactCtx {
  return {
    runDir: opts.runDir,
    runLog: opts.runLog,
    contextWindow: 200_000,
  };
}

function makeRunState(over: Partial<CompactionRunState> = {}): CompactionRunState {
  return {
    turn: 0,
    lastCompactionTurn: 0,
    compactionSeq: 0,
    ...over,
  };
}

// Build a synthetic message log with `n` tool_use/tool_result pairs
// representing turns 1..n. Each pair: assistant(tool_use), user(tool_result).
function buildLongLog(n: number): CompactionMessage[] {
  const msgs: CompactionMessage[] = [{ role: "user", content: "initial seed" }];
  for (let i = 1; i <= n; i++) {
    msgs.push({
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: `tu_${i}`,
          name: "move",
          input: { direction: "east" },
        },
      ],
    });
    msgs.push({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: `tu_${i}`,
          content: `== bobbihack tool_result v1 ==\nmove(east): step ${i}\n[long screen ANSI dump padding to make this turn expensive]\n`.repeat(10),
        },
      ],
    });
  }
  return msgs;
}

describe("maybeCompact — no-trigger short-circuits", () => {
  let tmpDir: string;
  let runLog: RunLog;
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "bobbihack-maybecompact-"));
    runLog = new RunLog(join(tmpDir, "run.jsonl"));
  });
  afterEach(() => {
    runLog.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("turn < 50 and no token pressure: returns input unchanged", async () => {
    const msgs = buildLongLog(10);
    const before = JSON.stringify(msgs);
    const runState = makeRunState({ turn: 10 });
    const ctx = makeCompactionCtx({ runDir: tmpDir, runLog });
    const result = await maybeCompact(msgs, runState, ctx);
    expect(JSON.stringify(result)).toBe(before);
    expect(runState.lastCompactionTurn).toBe(0);
  });
});

describe("maybeCompact — periodic trigger", () => {
  let tmpDir: string;
  let runLog: RunLog;
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "bobbihack-maybecompact-"));
    runLog = new RunLog(join(tmpDir, "run.jsonl"));
  });
  afterEach(() => {
    runLog.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("turn=50: fires; logs compaction event; writes snapshot", async () => {
    const msgs = buildLongLog(50);
    const runState = makeRunState({ turn: 50 });
    const ctx = makeCompactionCtx({ runDir: tmpDir, runLog });
    const result = await maybeCompact(msgs, runState, ctx);
    // Compacted: must be smaller (in bytes) than input.
    const beforeSize = JSON.stringify(msgs).length;
    const afterSize = JSON.stringify(result).length;
    expect(afterSize).toBeLessThan(beforeSize);

    expect(runState.lastCompactionTurn).toBe(50);
    expect(runState.compactionSeq).toBe(1);

    runLog.close(); // flush
    const events = readFileSync(join(tmpDir, "run.jsonl"), "utf8")
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as { event: string });
    const compaction = events.find((e) => e.event === "compaction");
    expect(compaction).toBeDefined();

    // Snapshot file 0001.json must exist (writeSnapshot was called).
    const snapshots = readdirSync(tmpDir).filter((f) => f.match(/^\d{4}\.json$/));
    expect(snapshots).toContain("0001.json");
  });

  test("turn=49 since last compaction (lastCompactionTurn=10, turn=59): does NOT fire periodically", async () => {
    const msgs = buildLongLog(20);
    const runState = makeRunState({ turn: 59, lastCompactionTurn: 10 });
    const ctx = makeCompactionCtx({ runDir: tmpDir, runLog });
    const before = JSON.stringify(msgs);
    const result = await maybeCompact(msgs, runState, ctx);
    expect(JSON.stringify(result)).toBe(before);
    expect(runState.lastCompactionTurn).toBe(10);
  });

  test("turn=60 since last compaction (lastCompactionTurn=10, turn=60): fires", async () => {
    // Need >K=20 turns of history for compaction to actually do work;
    // otherwise it short-circuits even if the trigger fires.
    const msgs = buildLongLog(40);
    const runState = makeRunState({ turn: 60, lastCompactionTurn: 10 });
    const ctx = makeCompactionCtx({ runDir: tmpDir, runLog });
    const before = JSON.stringify(msgs).length;
    const result = await maybeCompact(msgs, runState, ctx);
    expect(JSON.stringify(result).length).toBeLessThan(before);
    expect(runState.lastCompactionTurn).toBe(60);
  });
});

describe("maybeCompact — token-budget trigger", () => {
  let tmpDir: string;
  let runLog: RunLog;
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "bobbihack-maybecompact-"));
    runLog = new RunLog(join(tmpDir, "run.jsonl"));
  });
  afterEach(() => {
    runLog.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("with a tiny synthetic context window, large messages trigger compaction", async () => {
    const msgs = buildLongLog(30); // > default K=20 so there's something to compact
    const runState = makeRunState({ turn: 30 });
    // Tiny context window ensures even 30 turns of fluffy data exceed 80%.
    const ctx: MaybeCompactCtx = {
      runDir: tmpDir,
      runLog,
      contextWindow: 50, // tokens — laughably small to force the trigger
    };
    const result = await maybeCompact(msgs, runState, ctx);
    expect(runState.lastCompactionTurn).toBe(30);
    expect(JSON.stringify(result).length).toBeLessThan(JSON.stringify(msgs).length);
  });
});

describe("maybeCompact — force / hard fail-safe", () => {
  let tmpDir: string;
  let runLog: RunLog;
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "bobbihack-maybecompact-"));
    runLog = new RunLog(join(tmpDir, "run.jsonl"));
  });
  afterEach(() => {
    runLog.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("force=true uses K=5 instead of default K=20", async () => {
    const msgs = buildLongLog(30);
    const runState = makeRunState({ turn: 30 });
    const ctx = makeCompactionCtx({ runDir: tmpDir, runLog });
    const normal = await maybeCompact(msgs, makeRunState({ turn: 30 }), ctx, {
      force: false,
    });
    const aggressive = await maybeCompact(msgs, runState, ctx, { force: true });
    // Aggressive K=5 should keep fewer messages live than K=20.
    expect(JSON.stringify(aggressive).length).toBeLessThanOrEqual(JSON.stringify(normal).length);
  });
});

describe("maybeCompact — live tail preservation", () => {
  let tmpDir: string;
  let runLog: RunLog;
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "bobbihack-maybecompact-"));
    runLog = new RunLog(join(tmpDir, "run.jsonl"));
  });
  afterEach(() => {
    runLog.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("live tail (last K turns) is byte-stable through compaction (modulo cache_control)", async () => {
    const msgs = buildLongLog(50);
    const runState = makeRunState({ turn: 50 });
    const ctx = makeCompactionCtx({ runDir: tmpDir, runLog });
    const result = await maybeCompact(msgs, runState, ctx);

    // Default K=20 turns. Each turn = assistant(tool_use) + user(tool_result).
    // The last 40 messages of the result MUST equal the last 40 of the
    // input verbatim — except that placeBreakpoints stamps a
    // _cacheControl marker on the boundary message (the first message
    // of the live tail). Strip _cacheControl before comparing.
    const tailLen = 40; // 20 turns × 2 messages/turn
    const inputTail = msgs.slice(-tailLen);
    const resultTail = result.slice(-tailLen).map((m) => ({
      role: m.role,
      content: m.content,
    }));
    expect(resultTail).toEqual(inputTail.map((m) => ({ role: m.role, content: m.content })));
  });
});

describe("conductor integration — compaction wired end-to-end", () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "bobbihack-conductor-compact-"));
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("51-turn scripted run logs at least one compaction event + writes a snapshot", async () => {
    // Lazy-imports for types/values keep the top-of-file deps tight.
    const { runConductor } = await import("../../examples/bobbihack/conductor");
    const { MockAnthropicClient } = await import("../../examples/bobbihack/client");
    const { GameMap } = await import("../../examples/bobbihack/game-map");
    const fs = await import("node:fs");

    // Build a 51-turn plan: 50 moves + a final text-only turn so the
    // conductor exits cleanly.
    const plan: { text?: string; toolUses?: { name: string; input: unknown }[] }[] = [];
    for (let i = 1; i <= 50; i++) {
      plan.push({
        text: `step ${i}`,
        toolUses: [{ name: "move", input: { direction: "east" } }],
      });
    }
    plan.push({ text: "Done." });

    const messagesDir = join(tmpDir, "messages");
    fs.mkdirSync(messagesDir, { recursive: true });
    const messagesPath = join(tmpDir, "messages.json");
    const runLogPath = join(tmpDir, "run.jsonl");

    const ac = new AbortController();
    const map = new GameMap();
    const runState: { gameOver: boolean; endReason: string | null } = {
      gameOver: false,
      endReason: null,
    };

    // Borrow the exact StatusLine shape used by the existing
    // conductor smoke test; FrameAwaitResult is structural so the
    // sendKeysAndWait return needs to match it precisely.
    const statusLine = {
      name: "Hero",
      title: "Stripling",
      attrs: { st: "18", dx: 11, co: 14, in: 11, wi: 13, ch: 7 },
      alignment: "Lawful" as const,
      ac: 7,
      hp: 14,
      hpMax: 14,
      pw: 5,
      pwMax: 5,
      level: 1,
      xp: 0,
      dlvl: 1,
      turn: 1,
      gold: 0,
      hunger: "ok" as const,
      conditions: [] as string[],
    };

    const ctx = {
      map,
      runState,
      signal: ac.signal,
      sendKeysAndWait: async (_keys: string) => {
        const rows = Array.from({ length: 24 }, () => " ".repeat(80));
        return {
          rows,
          status: statusLine,
          message: "",
          frameReason: "cellChange",
          screenAnsi: rows.join("\n"),
        };
      },
    };

    const handlers = {
      move: async (_args: unknown, _c: unknown) =>
        "== bobbihack tool_result v1 ==\nmove(east): walked.\n[fluffy padding]\n".repeat(10),
    };

    const client = new MockAnthropicClient(plan);
    const runLog = new RunLog(runLogPath);

    // Cast deps shape: ToolContext fields match structurally.
    await runConductor({
      client,
      toolCtx: ctx as never,
      toolHandlers: handlers as never,
      runLog,
      systemPrompt: "test prompt",
      toolSchemas: [],
      messagesPath,
      model: "claude-haiku-4-5",
      initialUserMessage: "go",
      backoffSleeper: async (_s: number) => {},
      messagesDir,
    });

    runLog.close();

    const events = readFileSync(runLogPath, "utf8")
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as { event: string });
    const compactionCount = events.filter((e) => e.event === "compaction").length;
    expect(compactionCount).toBeGreaterThanOrEqual(1);

    const snapshotFiles = readdirSync(messagesDir).filter((f) => /^\d{4}\.json$/.test(f));
    expect(snapshotFiles.length).toBeGreaterThanOrEqual(1);
  });
});

describe("maybeCompact — BOBBIHACK_LIVE_TAIL env var", () => {
  let tmpDir: string;
  let runLog: RunLog;
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "bobbihack-maybecompact-"));
    runLog = new RunLog(join(tmpDir, "run.jsonl"));
  });
  afterEach(() => {
    runLog.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("BOBBIHACK_LIVE_TAIL=5 keeps fewer messages live than default 20", async () => {
    const msgsLong = buildLongLog(50);
    const ctx = makeCompactionCtx({ runDir: tmpDir, runLog });

    // Default K=20.
    const stateA = makeRunState({ turn: 50 });
    const resultDefault = await maybeCompact(msgsLong, stateA, ctx);

    // K=5 via env.
    process.env.BOBBIHACK_LIVE_TAIL = "5";
    const stateB = makeRunState({ turn: 50 });
    const resultSmall = await maybeCompact(msgsLong, stateB, ctx);

    expect(JSON.stringify(resultSmall).length).toBeLessThan(
      JSON.stringify(resultDefault).length,
    );
  });
});
