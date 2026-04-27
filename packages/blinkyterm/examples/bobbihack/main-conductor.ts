#!/usr/bin/env bun
// New conductor-based entry for bobbihack. Coexists with legacy main.ts
// during Phase 2; Phase 3 migrates the legacy entry once item-action
// tools land. To run:
//
//   BOBBIHACK_DRY_RUN=1 \
//   BOBBIHACK_DRY_RUN_PLAN=examples/bobbihack/test/fixtures/scripted-plan.json \
//   bun examples/bobbihack/main-conductor.ts
//
// Or with a live API:
//
//   ANTHROPIC_API_KEY=sk-... bun examples/bobbihack/main-conductor.ts

import { readFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { Runner } from "../../src/index";
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
import { runConductor, type ToolHandler } from "./conductor";
import { handleMove, handleSearch, handlePickup } from "./tools/move";
import { handleRespondPrompt } from "./tools/respond-prompt";
import { handleInventory } from "./tools/inventory";
import { RunLog } from "./observability";
import type { ToolContext, RunState } from "./tool-context";

const ENTER_ALT = "\x1b[?1049h";
const EXIT_ALT = "\x1b[?1049l";
const SHOW_CURSOR = "\x1b[?25h";

const TOOL_SCHEMAS: ToolSchema[] = [
  {
    name: "move",
    description:
      "Move one or more steps in a compass direction. Use 'up'/'down' to ascend/descend stairs; you must be standing on '<' or '>' for those.",
    input_schema: {
      type: "object",
      properties: {
        direction: {
          type: "string",
          enum: [
            "north",
            "south",
            "east",
            "west",
            "northeast",
            "northwest",
            "southeast",
            "southwest",
            "up",
            "down",
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
      "Search adjacent walls and floor for hidden passages and traps. Useful in dead ends.",
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
      "Send a literal short keystroke sequence (≤8 chars) to NetHack to answer a modal prompt. Use this for `--More--` (send ' '), [yn] questions (send 'y' or 'n'), letter-selection menus, direction prompts, etc. Read the screen to determine what response the prompt expects.",
    input_schema: {
      type: "object",
      properties: {
        keys: {
          type: "string",
          description: "Literal characters to send (≤8 chars). Use \\r for return, ' ' for space, 'y'/'n' for yes/no.",
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
      "Read your current carried inventory. This is a FREE action — does NOT consume a NetHack turn. Returns a list of items with slot letter, description, and category. Use this when you need to see what's in slot 'a', or check identification state, or count items.",
    input_schema: { type: "object", properties: {} },
  },
];

function loadSystemPrompt(): string {
  try {
    return readFileSync(join(import.meta.dir, "system-prompt.txt"), "utf8");
  } catch {
    return "You are an LLM agent playing NetHack. Use the move/search/pickup tools to act.";
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
  const raw = readFileSync(path, "utf8");
  return JSON.parse(raw) as ScriptedTurn[];
}

async function pickClient(): Promise<{ client: AnthropicClient; label: string }> {
  if (process.env.BOBBIHACK_DRY_RUN === "1") {
    return {
      client: new MockAnthropicClient(loadDryRunPlan()),
      label: "mock (dry-run)",
    };
  }
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (apiKey === undefined || apiKey === "") {
    console.error(
      "[bobbihack] ANTHROPIC_API_KEY required (or set BOBBIHACK_DRY_RUN=1 with BOBBIHACK_DRY_RUN_PLAN)",
    );
    process.exit(1);
  }
  const client = await createRealAnthropicClient({ apiKey });
  return { client, label: process.env.BOBBIHACK_MODEL ?? "claude-haiku-4-5" };
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
  console.log(`[bobbihack] run-id: ${runId}; client: ${label}`);
  console.log(`[bobbihack] artifacts: ${dirs.runDir}`);

  const runner = await Runner.spawn(["nethack"], {
    cols: 80,
    rows: 24,
    env: nethackEnv(),
    frame: { minIntervalMs: 100, maxIntervalMs: 5_000, quiesceMs: 100 },
  });

  process.stdout.write(ENTER_ALT);
  const restoreTerminal = (): void => {
    process.stdout.write(SHOW_CURSOR + EXIT_ALT);
  };

  const ac = new AbortController();
  const map = new GameMap();
  const runState: RunState = { gameOver: false, endReason: null };
  const runLog = new RunLog(dirs.runLog);

  // Wire sendKeysAndWait to the runner's frame iterator.
  const frameIter = runner.frames()[Symbol.asyncIterator]();

  // Drain the initial frame so the conductor starts after nethack settles.
  const firstFrame = await frameIter.next();
  if (!firstFrame.done) {
    const rows = firstFrame.value.snapshot.text.split("\n");
    paintRunner(runner);
    const stat = parseStatusLine(rows[rows.length - 2] ?? "", rows[rows.length - 1] ?? "");
    const msg = parseMessageLine(rows[0] ?? "");
    map.updateFromFrame(rows, stat, msg);
  }

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
      const screenAnsi = frame.snapshot.toAnsi();
      paintRunner(runner);
      const rows = frame.snapshot.text.split("\n");
      const message = parseMessageLine(rows[0] ?? "");
      const status = parseStatusLine(
        rows[rows.length - 2] ?? "",
        rows[rows.length - 1] ?? "",
      );
      const lastAction = currentToolForLogging;
      map.updateFromFrame(rows, status, message, lastAction);
      if (frame.reason === "exited" || frame.reason === "crashed") {
        runState.gameOver = true;
        runState.endReason = "runner_exited";
      }
      return { rows, status, message, frameReason: frame.reason, screenAnsi };
    },
  };

  // Tool handlers wrap the originals so we can stamp the precedingAction
  // for level_changed_unexpectedly detection.
  let currentToolForLogging: { tool: string; args: unknown } | undefined;
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

  // Best-effort cleanup if the user hits ^C.
  const onSig = (): void => {
    ac.abort();
  };
  process.on("SIGINT", onSig);
  process.on("SIGTERM", onSig);

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
    });
  } finally {
    if (!runner.exited) {
      try {
        await runner.sendText("\x1b\x1b #quit\r y\r y\r");
        const r = await runner.waitExit({ timeoutMs: 3000 });
        if (!r.exited) await runner.terminate({ thenAfterMs: 1000 });
      } catch {
        // best-effort
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

function paintRunner(runner: Runner): void {
  // Use runner.renderState.toAnsiRect() — the same primitive the legacy
  // bobbihack TUI uses. Each row gets explicit absolute positioning so
  // the screen actually repaints between frames. (An earlier version
  // used frame.snapshot.toAnsi() which doesn't position absolutely and
  // left the screen looking frozen.)
  process.stdout.write("\x1b[?25l\x1b[H\x1b[2J");
  try {
    const ansi = runner.renderState.toAnsiRect({
      row: 1,
      col: 1,
      cols: 80,
      rows: 24,
    });
    process.stdout.write(ansi);
  } catch {
    // Runner disposed mid-paint or size mismatch; skip this paint.
  }
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
