import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  runConductor,
  type ConductorDeps,
} from "../../examples/bobbihack/conductor";
import {
  MockAnthropicClient,
  type ScriptedTurn,
} from "../../examples/bobbihack/client";
import { GameMap } from "../../examples/bobbihack/game-map";
import { RunLog } from "../../examples/bobbihack/observability";
import type { ToolContext, RunState } from "../../examples/bobbihack/tool-context";
import type { StatusLine } from "../../examples/bobbihack/parsers";

function status(overrides: Partial<StatusLine> = {}): StatusLine {
  return {
    name: "Hero",
    title: "the Stripling",
    attrs: { st: "18", dx: 11, co: 14, in: 11, wi: 13, ch: 7 },
    alignment: "Lawful",
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
    hunger: "ok",
    conditions: [],
    ...overrides,
  };
}

interface MockHandlerCall {
  name: string;
  args: unknown;
}

function setup(plan: ScriptedTurn[]): {
  deps: ConductorDeps;
  ctx: ToolContext;
  client: MockAnthropicClient;
  calls: MockHandlerCall[];
  runState: RunState;
  ac: AbortController;
  tmpDir: string;
  messagesPath: string;
  runLogPath: string;
} {
  const tmpDir = mkdtempSync(join(tmpdir(), "bobbihack-conductor-"));
  const messagesPath = join(tmpDir, "messages.json");
  const runLogPath = join(tmpDir, "run.jsonl");
  const ac = new AbortController();
  const map = new GameMap();
  const runState: RunState = { gameOver: false, endReason: null };
  const calls: MockHandlerCall[] = [];

  const ctx: ToolContext = {
    map,
    runState,
    signal: ac.signal,
    journalDir: "",
    sendKeysAndWait: async (_keys: string) => {
      const rows = Array.from({ length: 24 }, () => " ".repeat(80));
      const s = status({ turn: calls.length + 1 });
      return {
        rows,
        glyphClass: rows.map(() => []),
        status: s,
        message: "",
        frameReason: "cellChange",
        screenAnsi: rows.join("\n"),
      };
    },
  };

  const handlers: Record<string, (args: unknown, ctx: ToolContext) => Promise<string>> = {
    move: async (args, _c) => {
      calls.push({ name: "move", args });
      return "== bobbihack tool_result v1 ==\nmove: ok\n";
    },
    quit_game: async (args, c) => {
      calls.push({ name: "quit_game", args });
      c.runState.gameOver = true;
      c.runState.endReason = "quit";
      return "GAME OVER";
    },
  };

  const client = new MockAnthropicClient(plan);
  const runLog = new RunLog(runLogPath);

  const deps: ConductorDeps = {
    client,
    toolCtx: ctx,
    toolHandlers: handlers,
    runLog,
    systemPrompt: "you are testing.",
    toolSchemas: [],
    messagesPath,
    model: "test-model",
    initialUserMessage: "Test run start.",
    backoffSleeper: async (_sec) => {
      // No real sleeping in tests.
    },
  };

  return { deps, ctx, client, calls, runState, ac, tmpDir, messagesPath, runLogPath };
}

describe("runConductor — happy path", () => {
  test("scripted plan: tool_use(move) then text-only graceful end", async () => {
    const plan: ScriptedTurn[] = [
      { text: "going east.", toolUses: [{ name: "move", input: { direction: "east" } }] },
      { text: "I'm done." },
    ];
    const { deps, calls, runState, runLogPath, messagesPath, tmpDir } = setup(plan);
    await runConductor(deps);
    expect(calls).toEqual([{ name: "move", args: { direction: "east" } }]);
    expect(runState.gameOver).toBe(true);
    expect(runState.endReason).toBe("model_stopped_without_tool_use");

    // run.jsonl exists with run_start + turn + run_end events.
    const log = readFileSync(runLogPath, "utf8")
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as { event: string });
    const events = log.map((e) => e.event);
    expect(events).toContain("run_start");
    expect(events).toContain("turn");
    expect(events).toContain("run_end");

    // messages persisted to disk.
    expect(existsSync(messagesPath)).toBe(true);
    rmSync(tmpDir, { recursive: true, force: true });
  });
});

describe("runConductor — multiple tool_uses per assistant turn", () => {
  test("batched tool_use blocks all execute and produce one user-message of tool_results", async () => {
    const plan: ScriptedTurn[] = [
      {
        toolUses: [
          { name: "move", input: { direction: "north" } },
          { name: "move", input: { direction: "east" } },
        ],
      },
      { text: "done." },
    ];
    const { deps, calls, messagesPath, tmpDir } = setup(plan);
    await runConductor(deps);
    expect(calls.length).toBe(2);
    expect(calls[0]?.args).toEqual({ direction: "north" });
    expect(calls[1]?.args).toEqual({ direction: "east" });

    // Inspect the persisted messages array. The user message after the
    // assistant turn should have BOTH tool_results.
    const messages = JSON.parse(readFileSync(messagesPath, "utf8")) as {
      role: string;
      content: { type: string; tool_use_id?: string }[];
    }[];
    const assistantMsg = messages.find((m) => m.role === "assistant");
    const userMsg = messages.findLast((m) => m.role === "user");
    expect(assistantMsg?.content.filter((b) => b.type === "tool_use").length).toBe(2);
    expect(userMsg?.content.filter((b) => b.type === "tool_result").length).toBe(2);
    rmSync(tmpDir, { recursive: true, force: true });
  });
});

describe("runConductor — game-over mid-batch", () => {
  test("subsequent tool_uses get stub results; persisted log is well-formed", async () => {
    const plan: ScriptedTurn[] = [
      {
        toolUses: [
          { name: "quit_game", input: {} },
          { name: "move", input: { direction: "north" } },
          { name: "move", input: { direction: "east" } },
        ],
      },
    ];
    const { deps, calls, runState, messagesPath, tmpDir } = setup(plan);
    await runConductor(deps);
    // Only quit_game should have actually run; the rest get stubs.
    expect(calls.length).toBe(1);
    expect(calls[0]?.name).toBe("quit_game");
    expect(runState.gameOver).toBe(true);

    // Messages array still has matching tool_use / tool_result counts.
    const messages = JSON.parse(readFileSync(messagesPath, "utf8")) as {
      role: string;
      content: { type: string }[];
    }[];
    const assistantMsg = messages.find((m) => m.role === "assistant");
    const userMsg = messages.findLast((m) => m.role === "user");
    expect(assistantMsg?.content.filter((b) => b.type === "tool_use").length).toBe(3);
    expect(userMsg?.content.filter((b) => b.type === "tool_result").length).toBe(3);
    rmSync(tmpDir, { recursive: true, force: true });
  });
});

describe("runConductor — abort signal mid-batch", () => {
  test("abort produces stub tool_results for unexecuted tools", async () => {
    const plan: ScriptedTurn[] = [
      {
        toolUses: [
          { name: "move", input: { direction: "north" } },
          { name: "move", input: { direction: "east" } },
          { name: "move", input: { direction: "south" } },
        ],
      },
    ];
    const { deps, calls, ac, messagesPath, tmpDir } = setup(plan);
    // Inject an abort handler into the first move call by wrapping the
    // existing handler.
    const original = deps.toolHandlers["move"]!;
    let invocations = 0;
    deps.toolHandlers["move"] = async (args, ctx) => {
      invocations += 1;
      if (invocations === 1) ac.abort();
      return await original(args, ctx);
    };
    await runConductor(deps);
    // First move ran and aborted; subsequent two should be stubs.
    expect(calls.length).toBe(1);
    const messages = JSON.parse(readFileSync(messagesPath, "utf8")) as {
      role: string;
      content: { type: string }[];
    }[];
    const userMsg = messages.findLast((m) => m.role === "user");
    expect(userMsg?.content.filter((b) => b.type === "tool_result").length).toBe(3);
    rmSync(tmpDir, { recursive: true, force: true });
  });
});

describe("runConductor — recoverable error retry", () => {
  test("HTTP 500 then success: retries with backoff schedule", async () => {
    const plan: ScriptedTurn[] = [
      { error: { status: 500, message: "Internal Server Error" } },
      { toolUses: [{ name: "move", input: { direction: "north" } }] },
      { text: "done." },
    ];
    const { deps, calls, runLogPath, tmpDir } = setup(plan);
    let backoffsObserved = 0;
    deps.backoffSleeper = async (sec) => {
      backoffsObserved += 1;
      expect(sec).toBe(1); // first retry is 1 second
    };
    await runConductor(deps);
    expect(calls.length).toBe(1);
    expect(backoffsObserved).toBe(1);

    // run.jsonl should have a retry event.
    const log = readFileSync(runLogPath, "utf8")
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as { event: string });
    expect(log.map((e) => e.event)).toContain("retry");
    rmSync(tmpDir, { recursive: true, force: true });
  });
});

describe("runConductor — invalid tool name", () => {
  test("returns error tool_result rather than crashing", async () => {
    const plan: ScriptedTurn[] = [
      { toolUses: [{ name: "nonsense_tool", input: {} }] },
      { text: "ok done." },
    ];
    const { deps, messagesPath, tmpDir } = setup(plan);
    await runConductor(deps);
    const messages = JSON.parse(readFileSync(messagesPath, "utf8")) as {
      role: string;
      content: { type: string; content?: string; is_error?: boolean }[];
    }[];
    const userMsg = messages.findLast((m) => m.role === "user");
    const result = userMsg?.content.find((b) => b.type === "tool_result");
    expect(result?.is_error).toBe(true);
    rmSync(tmpDir, { recursive: true, force: true });
  });
});
