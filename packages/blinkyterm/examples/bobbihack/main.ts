#!/usr/bin/env bun
// bobbihack — stateful conductor-based agent playing NetHack.
// The legacy per-turn-Agent entry is preserved at main-legacy.ts during
// Phase 3; a future cleanup pass deletes it.

import { readFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { Runner } from "../../src/index";
import type { FrameReason } from "../../src/types";
import { hasNethack, nethackEnv } from "../shared/nethack-setup";
import {
  acquireRunLock,
  generateRunId,
  runDirs,
  type RunLock,
} from "./paths";
import {
  type AnthropicClient,
  MockAnthropicClient,
  createRealAnthropicClient,
  type ScriptedTurn,
  type ToolSchema,
} from "./client";
import { GameMap } from "./game-map";
import { parseStatusLine, parseMessageLine } from "./parsers";
import { runConductor, type ToolHandler, type ConductorEvents } from "./conductor";
import { handleMove, handleSearch, handlePickup } from "./tools/move";
import { handleRespondPrompt } from "./tools/respond-prompt";
import { handleInventory } from "./tools/inventory";
import { RunLog } from "./observability";
import type { ToolContext, RunState } from "./tool-context";
import {
  initialState,
  onAgentEvent,
  onChildExited,
  onChildFrame,
  onResize,
  onTurnEnd,
  onTurnStart,
  type ViewState,
} from "./state";
import { render } from "./render";
import type { AgentDecision } from "./agent";

const ENTER_ALT = "\x1b[?1049h";
const EXIT_ALT = "\x1b[?1049l";
const SHOW_CURSOR = "\x1b[?25h";

const TOOL_SCHEMAS: ToolSchema[] = [
  {
    name: "move",
    description:
      "Move one or more steps in a compass direction. Use 'up'/'down' to ascend/descend stairs (you must be standing on '<' or '>'). Walking into a closed door opens it; walking into a monster attacks it.",
    input_schema: {
      type: "object",
      properties: {
        direction: {
          type: "string",
          enum: [
            "north", "south", "east", "west",
            "northeast", "northwest", "southeast", "southwest",
            "up", "down",
          ],
        },
        count: { type: "number", minimum: 1, maximum: 50 },
      },
      required: ["direction"],
    },
  },
  {
    name: "search",
    description:
      "Search adjacent walls and floor for hidden passages and traps.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "pickup",
    description: "Pick up whatever is on your current tile.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "respond_prompt",
    description:
      "Send a literal short keystroke sequence (≤8 chars) to NetHack to answer a modal prompt. Use this for `--More--` (send ' '), [yn] questions ('y'/'n'), letter-selection menus, direction prompts, etc. Read the screen to determine what response the prompt expects.",
    input_schema: {
      type: "object",
      properties: {
        keys: {
          type: "string",
          description:
            "Literal characters to send (≤8 chars). Use \\r for return, ' ' for space.",
          minLength: 1,
          maxLength: 8,
        },
      },
      required: ["keys"],
    },
  },
  {
    name: "inventory",
    description:
      "Read your current carried inventory. FREE action — does NOT consume a NetHack turn. Returns {items: [{slot, description, category}]}.",
    input_schema: { type: "object", properties: {} },
  },
];

function loadSystemPrompt(): string {
  try {
    return readFileSync(join(import.meta.dir, "system-prompt.txt"), "utf8");
  } catch {
    return "You are an LLM agent playing NetHack. Use the available tools to act.";
  }
}

function loadDryRunPlan(): ScriptedTurn[] {
  const path = process.env.BOBBIHACK_DRY_RUN_PLAN;
  if (path === undefined || path === "") {
    console.error(
      "[bobbihack] BOBBIHACK_DRY_RUN=1 requires BOBBIHACK_DRY_RUN_PLAN=<path-to-fixture.json>",
    );
    process.exit(1);
  }
  return JSON.parse(readFileSync(path, "utf8")) as ScriptedTurn[];
}

async function pickClient(): Promise<{ client: AnthropicClient; label: string }> {
  if (process.env.BOBBIHACK_DRY_RUN === "1") {
    return { client: new MockAnthropicClient(loadDryRunPlan()), label: "mock (dry-run)" };
  }
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (apiKey === undefined || apiKey === "") {
    console.error(
      "[bobbihack] ANTHROPIC_API_KEY required (or set BOBBIHACK_DRY_RUN=1 with BOBBIHACK_DRY_RUN_PLAN)",
    );
    process.exit(1);
  }
  return {
    client: await createRealAnthropicClient({ apiKey }),
    label: process.env.BOBBIHACK_MODEL ?? "claude-haiku-4-5",
  };
}

async function main(): Promise<void> {
  if (!hasNethack()) {
    console.log("[bobbihack] nethack not on PATH; skipping. Install with `brew install nethack`.");
    process.exit(0);
  }

  const rootDir = process.env.BOBBIHACK_ROOT ?? join(process.cwd(), ".bobbihack");
  if (!existsSync(rootDir)) mkdirSync(rootDir, { recursive: true });
  const runId = generateRunId();
  const dirs = runDirs(rootDir, runId);
  let lock: RunLock | null = null;
  try {
    lock = acquireRunLock(dirs);
  } catch (err) {
    console.error("[bobbihack]", (err as Error).message);
    process.exit(1);
  }

  const { client, label } = await pickClient();

  // Spawn nethack pinned to 80x24 — same as the legacy entry. NetHack
  // 3.6 only paints 24 rows even with a 25-row pty.
  const runner = await Runner.spawn(["nethack"], {
    cols: 80,
    rows: 24,
    env: nethackEnv(),
    frame: { minIntervalMs: 100, maxIntervalMs: 5_000, quiesceMs: 100 },
  });

  // Layered TUI state.
  const hostCols = process.stdout.columns ?? 200;
  const hostRows = process.stdout.rows ?? 60;
  let state: ViewState = initialState({
    hostCols,
    hostRows,
    agentLabel: label,
    pid: runner.pid,
  });

  let writePending: NodeJS.Immediate | null = null;
  const requestPaint = (): void => {
    if (writePending !== null) return;
    writePending = setImmediate(() => {
      writePending = null;
      let nethackContent = "";
      if (state.layout.kind !== "tooSmall") {
        const box = state.layout.nethack;
        try {
          nethackContent = runner.renderState.toAnsiRect({
            row: box.row + 1,
            col: box.col + 2,
            cols: 80,
            rows: 24,
          });
        } catch {
          // disposed mid-paint
        }
      }
      process.stdout.write(render(state, nethackContent));
    });
  };

  const onWinch = (): void => {
    state = onResize(state, process.stdout.columns ?? hostCols, process.stdout.rows ?? hostRows);
    requestPaint();
  };

  process.stdout.write(ENTER_ALT);
  process.on("SIGWINCH", onWinch);

  let restored = false;
  const restoreTerminal = (): void => {
    if (restored) return;
    restored = true;
    process.removeListener("SIGWINCH", onWinch);
    process.stdout.write(SHOW_CURSOR + EXIT_ALT);
  };

  const ac = new AbortController();
  const map = new GameMap();
  const runState: RunState = { gameOver: false, endReason: null };
  const runLog = new RunLog(dirs.runLog);

  // Wire sendKeysAndWait to the runner's frame iterator.
  const frameIter = runner.frames()[Symbol.asyncIterator]();
  let lastFrameReason: FrameReason = "initial";

  // Drain initial frame.
  const firstFrame = await frameIter.next();
  if (!firstFrame.done) {
    state = onChildFrame(state, firstFrame.value);
    lastFrameReason = firstFrame.value.reason;
    const rows = firstFrame.value.snapshot.text.split("\n");
    const stat = parseStatusLine(rows[rows.length - 2] ?? "", rows[rows.length - 1] ?? "");
    const msg = parseMessageLine(rows[0] ?? "");
    map.updateFromFrame(rows, stat, msg);
  }
  requestPaint();

  let currentToolForLogging: { tool: string; args: unknown } | undefined;

  const ctx: ToolContext = {
    map,
    runState,
    signal: ac.signal,
    sendKeysAndWait: async (keys: string) => {
      if (runner.exited) {
        runState.gameOver = true;
        runState.endReason = "runner_exited";
        throw new Error("runner exited");
      }
      await runner.sendText(keys);
      const next = await frameIter.next();
      if (next.done || next.value === undefined) {
        runState.gameOver = true;
        runState.endReason = "runner_frame_iterator_ended";
        const blank = Array.from({ length: 24 }, () => " ".repeat(80));
        return {
          rows: blank,
          status: parseStatusLine("", ""),
          message: "",
          frameReason: "exited" as const,
          screenAnsi: "",
        };
      }
      const frame = next.value;
      lastFrameReason = frame.reason;
      state = onChildFrame(state, frame);
      const screenAnsi = frame.snapshot.toAnsi();
      const rows = frame.snapshot.text.split("\n");
      const message = parseMessageLine(rows[0] ?? "");
      const status = parseStatusLine(
        rows[rows.length - 2] ?? "",
        rows[rows.length - 1] ?? "",
      );
      map.updateFromFrame(rows, status, message, currentToolForLogging);
      requestPaint();
      if (frame.reason === "exited" || frame.reason === "crashed") {
        state = onChildExited(state, frame.reason, frame.exitCode);
        runState.gameOver = true;
        runState.endReason = "runner_exited";
        requestPaint();
      }
      return { rows, status, message, frameReason: frame.reason, screenAnsi };
    },
  };

  // Wrap each tool handler to stamp the precedingAction for trapdoor
  // detection in GameMap.
  const wrap =
    (name: string, h: ToolHandler): ToolHandler =>
    async (args, c) => {
      currentToolForLogging = { tool: name, args };
      try {
        return await h(args, c);
      } finally {
        currentToolForLogging = undefined;
      }
    };

  const toolHandlers: Record<string, ToolHandler> = {
    move: wrap("move", handleMove as ToolHandler),
    search: wrap("search", handleSearch as ToolHandler),
    pickup: wrap("pickup", handlePickup as ToolHandler),
    respond_prompt: wrap("respond_prompt", handleRespondPrompt as ToolHandler),
    inventory: wrap("inventory", handleInventory as ToolHandler),
  };

  // Conductor → state.ts event translation. The conductor's natural
  // unit is "tool call"; we treat each tool call as one TurnState.
  // Streaming text on an assistant message is buffered until the first
  // tool fires, then it goes onto that turn's streamingText.
  let pendingThinking = "";
  let conductorTurn = 0;
  const events: ConductorEvents = {
    onAssistantMessageStart: () => {
      pendingThinking = "";
    },
    onTextDelta: (delta) => {
      if (state.currentTurn !== null) {
        state = onAgentEvent(state, { kind: "thinking", delta });
        requestPaint();
      } else {
        pendingThinking += delta;
      }
    },
    onToolStart: (_name, _args, _turn) => {
      conductorTurn += 1;
      state = onTurnStart(state, { turn: conductorTurn, frameReason: lastFrameReason });
      if (pendingThinking.length > 0) {
        state = onAgentEvent(state, { kind: "thinking", delta: pendingThinking });
        pendingThinking = "";
      }
      requestPaint();
    },
    onToolComplete: (name, summary, _turn) => {
      // Use the tool name as the "decision" — render.ts displays it as
      // a string in formatHistoryLine. Append the summary so the
      // history line carries useful context.
      const decisionLabel = summary.length > 0 ? `${name} → ${summary.slice(0, 60)}` : name;
      state = onAgentEvent(state, { kind: "action", move: decisionLabel as AgentDecision });
      state = onTurnEnd(state);
      requestPaint();
    },
    onRunEnd: (reason) => {
      // Surface the end reason in the error banner if it wasn't a
      // graceful end.
      if (reason !== "model_stopped_without_tool_use" && reason !== "exited") {
        state = { ...state, errorBanner: `run ended: ${reason}` };
        requestPaint();
      }
    },
  };

  const onSig = (): void => ac.abort();
  process.on("SIGINT", onSig);
  process.on("SIGTERM", onSig);

  console.log(`[bobbihack] run-id: ${runId}; client: ${label}`);
  console.log(`[bobbihack] artifacts: ${dirs.runDir}`);

  try {
    await runConductor({
      client,
      toolCtx: ctx,
      toolHandlers,
      runLog,
      systemPrompt: loadSystemPrompt(),
      toolSchemas: TOOL_SCHEMAS,
      messagesPath: join(dirs.runDir, "messages.json"),
      model: label,
      events,
    });
  } finally {
    if (!runner.exited) {
      try {
        await runner.sendText("\x1b\x1b #quit\r y\r y\r");
        const r = await runner.waitExit({ timeoutMs: 3000 });
        if (!r.exited) await runner.terminate({ thenAfterMs: 1000 });
      } catch {
        /* best-effort */
      }
    }
    await runner[Symbol.asyncDispose]();
    restoreTerminal();
    lock?.released();
    process.removeListener("SIGINT", onSig);
    process.removeListener("SIGTERM", onSig);
  }

  console.log(`[bobbihack] done. run-id: ${runId}. reason: ${runState.endReason ?? "exited"}`);
  console.log(`[bobbihack] artifacts: ${dirs.runDir}`);
}

const restoreOnUnhandled = (): void => {
  process.stdout.write("\x1b[?25h\x1b[?1049l");
};
process.on("uncaughtException", (err) => {
  restoreOnUnhandled();
  console.error(err);
  process.exit(1);
});
process.on("unhandledRejection", (err) => {
  restoreOnUnhandled();
  console.error(err);
  process.exit(1);
});

await main();
