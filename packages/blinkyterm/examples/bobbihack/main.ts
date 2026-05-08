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
import {
  handleEat,
  handleQuaff,
  handleRead,
} from "./tools/items-consume";
import {
  handleWear,
  handlePuton,
  handleTakeoff,
  handleRemove,
  handleWield,
} from "./tools/items-equip";
import {
  handleZap,
  handleDrop,
  handleThrow,
  handleApply,
  handleKick,
  handlePray,
  handleForceFight,
  handleExtendedCommand,
  handleCommand,
} from "./tools/items-misc";
import {
  handleJournalRead,
  handleJournalWrite,
  JOURNAL_SECTIONS,
} from "./tools/journal";
import { handleQueryTerrain } from "./tools/query";
import { handleAutopilotTo, handleAutopilotExplore } from "./tools/autopilot";
import { RunLog } from "./observability";
import type { ToolContext, RunState } from "./tool-context";
import { buildGlyphClass } from "./glyph-class";
import {
  initialState,
  onAgentEvent,
  onChildExited,
  onChildFrame,
  onConductorStatus,
  onCostLine,
  onResize,
  onToolPendingClear,
  onToolPendingProgress,
  onToolPendingStart,
  onTurnEnd,
  onTurnStart,
  type ConductorStatus,
  type ConductorStatusKind,
  type ViewState,
} from "./state";
import { render } from "./render";
import { formatToolResult } from "./tool-result";
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
  {
    name: "eat",
    description:
      "Eat food from your inventory. If 'slot' is given, sends e<slot>; if omitted, NetHack will prompt you (use respond_prompt to answer).",
    input_schema: {
      type: "object",
      properties: {
        slot: { type: "string", pattern: "^[a-zA-Z\\-$#?*]$" },
      },
    },
  },
  {
    name: "quaff",
    description:
      "Quaff a potion (or drink from a fountain if standing on '{'). 'slot' optional — without it, NetHack may prompt.",
    input_schema: {
      type: "object",
      properties: {
        slot: { type: "string", pattern: "^[a-zA-Z\\-$#?*]$" },
      },
    },
  },
  {
    name: "read",
    description: "Read a scroll or spellbook from your inventory.",
    input_schema: {
      type: "object",
      properties: {
        slot: { type: "string", pattern: "^[a-zA-Z\\-$#?*]$" },
      },
      required: ["slot"],
    },
  },
  {
    name: "zap",
    description:
      "Zap a wand. If a 'direction' is given, NetHack uses it; otherwise NetHack may prompt for direction (answer with respond_prompt).",
    input_schema: {
      type: "object",
      properties: {
        slot: { type: "string", pattern: "^[a-zA-Z\\-$#?*]$" },
        direction: {
          type: "string",
          enum: [
            "north", "south", "east", "west",
            "northeast", "northwest", "southeast", "southwest",
          ],
        },
      },
      required: ["slot"],
    },
  },
  {
    name: "wear",
    description: "Wear an armor item from your inventory.",
    input_schema: {
      type: "object",
      properties: {
        slot: { type: "string", pattern: "^[a-zA-Z\\-$#?*]$" },
      },
      required: ["slot"],
    },
  },
  {
    name: "puton",
    description: "Put on an accessory (ring, amulet, blindfold).",
    input_schema: {
      type: "object",
      properties: {
        slot: { type: "string", pattern: "^[a-zA-Z\\-$#?*]$" },
      },
      required: ["slot"],
    },
  },
  {
    name: "takeoff",
    description:
      "Take off an armor item. 'slot' optional — NetHack auto-picks if you have a single piece.",
    input_schema: {
      type: "object",
      properties: {
        slot: { type: "string", pattern: "^[a-zA-Z\\-$#?*]$" },
      },
    },
  },
  {
    name: "remove",
    description:
      "Remove an accessory (ring, amulet). 'slot' optional — NetHack auto-picks if unambiguous.",
    input_schema: {
      type: "object",
      properties: {
        slot: { type: "string", pattern: "^[a-zA-Z\\-$#?*]$" },
      },
    },
  },
  {
    name: "wield",
    description:
      "Wield a weapon. Use slot='-' to wield bare hands.",
    input_schema: {
      type: "object",
      properties: {
        slot: { type: "string", pattern: "^[a-zA-Z\\-$#?*]$" },
      },
      required: ["slot"],
    },
  },
  {
    name: "drop",
    description: "Drop one item from your inventory.",
    input_schema: {
      type: "object",
      properties: {
        slot: { type: "string", pattern: "^[a-zA-Z\\-$#?*]$" },
      },
      required: ["slot"],
    },
  },
  {
    name: "throw",
    description: "Throw an item in a compass direction.",
    input_schema: {
      type: "object",
      properties: {
        slot: { type: "string", pattern: "^[a-zA-Z\\-$#?*]$" },
        direction: {
          type: "string",
          enum: [
            "north", "south", "east", "west",
            "northeast", "northwest", "southeast", "southwest",
          ],
        },
      },
      required: ["slot", "direction"],
    },
  },
  {
    name: "apply",
    description: "Apply a tool (pick-axe, whistle, key, lamp, etc).",
    input_schema: {
      type: "object",
      properties: {
        slot: { type: "string", pattern: "^[a-zA-Z\\-$#?*]$" },
      },
      required: ["slot"],
    },
  },
  {
    name: "kick",
    description: "Kick in a compass direction (doors, monsters, sinks).",
    input_schema: {
      type: "object",
      properties: {
        direction: {
          type: "string",
          enum: [
            "north", "south", "east", "west",
            "northeast", "northwest", "southeast", "southwest",
          ],
        },
      },
      required: ["direction"],
    },
  },
  {
    name: "pray",
    description:
      "Pray to your deity. Use sparingly — gods get annoyed by frequent praying.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "force_fight",
    description:
      "Force-fight in a compass direction. Attacks even if NetHack thinks the tile is empty (useful vs invisible monsters).",
    input_schema: {
      type: "object",
      properties: {
        direction: {
          type: "string",
          enum: [
            "north", "south", "east", "west",
            "northeast", "northwest", "southeast", "southwest",
          ],
        },
      },
      required: ["direction"],
    },
  },
  {
    name: "extended_command",
    description:
      "Run a NetHack '#' extended command (chat, dip, loot, offer, ...). Optional 'args' is sent literally after the command.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", pattern: "^[a-z]{1,16}$" },
        args: { type: "string", maxLength: 32 },
      },
      required: ["name"],
    },
  },
  {
    name: "command",
    description:
      "ESCAPE HATCH: send up to 16 literal keystrokes. Use ONLY when no other tool fits.",
    input_schema: {
      type: "object",
      properties: {
        keys: { type: "string", minLength: 1, maxLength: 16 },
      },
      required: ["keys"],
    },
  },
  {
    name: "journal_read",
    description:
      "FREE action — read one of the six fixed markdown journal sections. Returns {section, content}. Missing files return content:''. Use after a compaction marker to recover Goals and Knowledge.",
    input_schema: {
      type: "object",
      properties: {
        section: { type: "string", enum: [...JOURNAL_SECTIONS] },
      },
      required: ["section"],
    },
  },
  {
    name: "journal_write",
    description:
      "FREE action — replace one of the six fixed markdown journal sections atomically. Content must be ≤64KB. Use to record discoveries that should survive context compaction (Knowledge), running plan (Goals), per-floor features (Dungeon), open questions (Hypotheses), identity (Character), or current carry (Inventory).",
    input_schema: {
      type: "object",
      properties: {
        section: { type: "string", enum: [...JOURNAL_SECTIONS] },
        content: { type: "string", maxLength: 65536 },
      },
      required: ["section", "content"],
    },
  },
  {
    name: "query_terrain",
    description:
      "FREE action — recall a previously-explored floor's terrain. With {floor: 'D2'} returns {floor, ascii, features} where ascii is the recorded plain-ASCII map and features is a list of {glyph, x, y, kind} for stairs/altars/fountains/etc. With no args, returns {floors: [{id, firstTurn, lastTurn, tileCount}]} listing every visited floor. Use after a compaction marker to recover terrain memory.",
    input_schema: {
      type: "object",
      properties: {
        floor: { type: "string" },
      },
    },
  },
  {
    name: "autopilot_to",
    description:
      "Walk from your current tile to a known (x, y) on the same floor using A* pathfinding. Sends one keystroke per step and halts on any interrupt (monster_visible, modal_prompt, hp_drop, low_hp, entered_trap_tile, etc.). Returns 'arrived after N steps' on success, or 'stopped after N steps. interrupt: <name>'. Refuses Sokoban / Rogue level / walkability-suspect floors. Cannot cross floors — use move(up)/move(down) on stairs first. Use query_terrain to find target coordinates.",
    input_schema: {
      type: "object",
      properties: {
        floor: { type: "string", description: "Target floor id (e.g. 'D1', 'Mines:3'). Must be the current floor." },
        x: { type: "integer", minimum: 0, maximum: 79 },
        y: { type: "integer", minimum: 0, maximum: 23 },
        stepCap: {
          type: "integer",
          minimum: 1,
          maximum: 200,
          description: "Maximum steps before halting (default 50).",
        },
      },
      required: ["floor", "x", "y"],
    },
  },
  {
    name: "autopilot_explore",
    description:
      "Walk a frontier-policy exploration of the current floor. Prefers adjacent unvisited walkable tiles (corridors > rooms; continues current direction); falls back to BFS toward the nearest known frontier tile. Halts on any interrupt or when the floor is fully explored. Refuses Sokoban / Rogue level / walkability-suspect floors. Does NOT auto-descend stairs — use move(down) explicitly.",
    input_schema: {
      type: "object",
      properties: {
        stepCap: {
          type: "integer",
          minimum: 1,
          maximum: 200,
          description: "Maximum steps before halting (default 50).",
        },
      },
    },
  },
];

// Load a system prompt from `prompts/<name>.txt`. The name comes from the
// `BOBBIHACK_SYSTEM_PROMPT` env var (default: "default"). Each variant is
// a plain text file in `prompts/`. The conductor logs the prompt's hash
// per run, so head-to-head variant comparisons can group runs by hash.
function loadSystemPrompt(): { text: string; name: string } {
  const requested = process.env.BOBBIHACK_SYSTEM_PROMPT?.trim() || "default";
  // Allow only [a-zA-Z0-9_-] in the name to avoid path traversal via env.
  if (!/^[a-zA-Z0-9_-]+$/.test(requested)) {
    console.error(
      `[bobbihack] BOBBIHACK_SYSTEM_PROMPT="${requested}" is invalid. Use [a-zA-Z0-9_-]+. Falling back to "default".`,
    );
    return loadSystemPromptByName("default");
  }
  return loadSystemPromptByName(requested);
}

function loadSystemPromptByName(name: string): { text: string; name: string } {
  const path = join(import.meta.dir, "prompts", `${name}.txt`);
  try {
    return { text: readFileSync(path, "utf8"), name };
  } catch {
    if (name !== "default") {
      console.error(
        `[bobbihack] system prompt "${name}" not found at ${path}; falling back to "default".`,
      );
      return loadSystemPromptByName("default");
    }
    return {
      text: "You are an LLM agent playing NetHack. Use the available tools to act.",
      name: "fallback-inline",
    };
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

  // Repaint once a second so the agent-pane status title updates its
  // elapsed-time display ("thinking 12s" → "paused 4m12s") without
  // needing an event to fire. Costs one render() per second; cheap.
  // Cleared during teardown.
  const statusTickHandle = setInterval(() => {
    requestPaint();
  }, 1000);

  let restored = false;
  const restoreTerminal = (): void => {
    if (restored) return;
    restored = true;
    clearInterval(statusTickHandle);
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

  // Drain the initial frame so the conductor's first message can carry
  // the starting screen as context. Anthropic's API rejects empty
  // messages arrays — we MUST seed with a user message.
  let initialUserMessage =
    "You are starting a new NetHack game. Please begin playing.";
  const firstFrame = await frameIter.next();
  if (!firstFrame.done) {
    state = onChildFrame(state, firstFrame.value);
    lastFrameReason = firstFrame.value.reason;
    const rows = firstFrame.value.snapshot.text.split("\n");
    const stat = parseStatusLine(rows[rows.length - 2] ?? "", rows[rows.length - 1] ?? "");
    const msg = parseMessageLine(rows[0] ?? "");
    map.updateFromFrame(rows, stat, msg);
    initialUserMessage = formatToolResult({
      summary: "Game start. Read the screen carefully — there may be intro --More-- prompts to dismiss.",
      screenAnsi: firstFrame.value.snapshot.toAnsi(),
      map,
      status: stat,
    });
  }
  requestPaint();

  let currentToolForLogging: { tool: string; args: unknown } | undefined;

  const ctx: ToolContext = {
    map,
    runState,
    signal: ac.signal,
    journalDir: dirs.journalDir,
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
          glyphClass: blank.map(() => []),
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
      // Classify glyphs for the autopilot interrupt detector. Uses the
      // post-frame player position from `map` (just updated above) so the
      // player's own `@` doesn't get classified.
      const glyphClass = buildGlyphClass(frame.snapshot, rows, map.currentPlayerXY);
      return { rows, glyphClass, status, message, frameReason: frame.reason, screenAnsi };
    },
    logAutopilotStep: (ev) => {
      runLog.append({ event: "autopilot_step", ...ev });
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
    eat: wrap("eat", handleEat as ToolHandler),
    quaff: wrap("quaff", handleQuaff as ToolHandler),
    read: wrap("read", handleRead as ToolHandler),
    zap: wrap("zap", handleZap as ToolHandler),
    wear: wrap("wear", handleWear as ToolHandler),
    puton: wrap("puton", handlePuton as ToolHandler),
    takeoff: wrap("takeoff", handleTakeoff as ToolHandler),
    remove: wrap("remove", handleRemove as ToolHandler),
    wield: wrap("wield", handleWield as ToolHandler),
    drop: wrap("drop", handleDrop as ToolHandler),
    throw: wrap("throw", handleThrow as ToolHandler),
    apply: wrap("apply", handleApply as ToolHandler),
    kick: wrap("kick", handleKick as ToolHandler),
    pray: wrap("pray", handlePray as ToolHandler),
    force_fight: wrap("force_fight", handleForceFight as ToolHandler),
    extended_command: wrap("extended_command", handleExtendedCommand as ToolHandler),
    command: wrap("command", handleCommand as ToolHandler),
    journal_read: wrap("journal_read", handleJournalRead as ToolHandler),
    journal_write: wrap("journal_write", handleJournalWrite as ToolHandler),
    query_terrain: wrap("query_terrain", handleQueryTerrain as ToolHandler),
    autopilot_to: wrap("autopilot_to", handleAutopilotTo as ToolHandler),
    autopilot_explore: wrap("autopilot_explore", handleAutopilotExplore as ToolHandler),
  };

  // Conductor → state.ts event translation. The conductor's natural
  // unit is "tool call"; we treat each tool call as one TurnState.
  // Streaming text on an assistant message is buffered until the first
  // tool fires, then it goes onto that turn's streamingText.
  let pendingThinking = "";
  let conductorTurn = 0;

  function setStatus(kind: ConductorStatusKind, detail = ""): void {
    const status: ConductorStatus = { kind, since: Date.now(), detail };
    state = onConductorStatus(state, status);
  }

  // Compact "(k:v, k:v)" summary of a tool's input object — used in
  // the pending tool-history row so the user can tell `autopilot_explore({stepCap:150})`
  // apart from a default `autopilot_explore({})`. Truncates after 30
  // chars so the row doesn't dominate the pane.
  function summarizeArgs(args: unknown): string {
    if (args === undefined || args === null) return "";
    if (typeof args !== "object") return `(${String(args)})`;
    const entries = Object.entries(args as Record<string, unknown>);
    if (entries.length === 0) return "({})";
    const inside = entries
      .map(([k, v]) => `${k}:${typeof v === "string" ? JSON.stringify(v) : String(v)}`)
      .join(", ");
    const out = `(${inside})`;
    return out.length > 30 ? out.slice(0, 29) + "…)" : out;
  }

  // Initial status: we're about to issue the first API request, so the
  // conductor is in a "thinking" state until the first response arrives.
  setStatus("thinking");

  const events: ConductorEvents = {
    onAssistantMessageStart: () => {
      pendingThinking = "";
      // Already "thinking"; first chunk has now arrived. Don't reset
      // since — keep the timer counting from when we started waiting,
      // which is where stalls show up.
    },
    onTextDelta: (delta) => {
      if (state.currentTurn !== null) {
        state = onAgentEvent(state, { kind: "thinking", delta });
        requestPaint();
      } else {
        pendingThinking += delta;
      }
    },
    onToolStart: (name, args, _turn) => {
      conductorTurn += 1;
      state = onTurnStart(state, { turn: conductorTurn, frameReason: lastFrameReason });
      if (pendingThinking.length > 0) {
        state = onAgentEvent(state, { kind: "thinking", delta: pendingThinking });
        pendingThinking = "";
      }
      setStatus("tool_running", name);
      state = onToolPendingStart(state, {
        number: conductorTurn,
        name,
        argsSummary: summarizeArgs(args),
        progress: "",
      });
      requestPaint();
    },
    onToolProgress: (name, detail, _turn) => {
      // Update the agent-title status detail so e.g. autopilot_explore
      // shows "tool: autopilot_explore (47/150)" instead of frozen.
      setStatus("tool_running", `${name} (${detail})`);
      state = onToolPendingProgress(state, detail);
      requestPaint();
    },
    onToolComplete: (name, summary, _turn) => {
      // Use the tool name as the "decision" — render.ts displays it
      // verbatim in the tool-history pane. Append the summary so the
      // line carries useful context.
      const decisionLabel = summary.length > 0 ? `${name} → ${summary.slice(0, 60)}` : name;
      state = onAgentEvent(state, { kind: "action", move: decisionLabel as AgentDecision });
      state = onTurnEnd(state);
      state = onToolPendingClear(state);
      // Tool finished; conductor now waits for the next API response.
      // Reset the "thinking" timer so the title shows time-since-tool,
      // which is where stalls (4-minute hangs etc.) show up.
      setStatus("thinking");
      requestPaint();
    },
    onRunEnd: (reason) => {
      setStatus("exited", reason);
      // Surface the end reason in the error banner if it wasn't a
      // graceful end.
      if (reason !== "model_stopped_without_tool_use" && reason !== "exited") {
        state = { ...state, errorBanner: `run ended: ${reason}` };
        requestPaint();
      }
    },
    onCostUpdate: (line, _cost) => {
      // Cost goes to its own state field; the renderer shows it as a
      // dim footer in the agent pane. Keeps `agentLabel` (and the agent
      // box title) just the model name so the title's status indicator
      // stays readable.
      state = onCostLine(state, line);
      requestPaint();
    },
  };

  const onSig = (): void => ac.abort();
  process.on("SIGINT", onSig);
  process.on("SIGTERM", onSig);

  console.log(`[bobbihack] run-id: ${runId}; client: ${label}`);
  console.log(`[bobbihack] artifacts: ${dirs.runDir}`);

  const sys = loadSystemPrompt();
  console.log(`[bobbihack] system prompt: ${sys.name} (${sys.text.length} chars)`);

  try {
    await runConductor({
      client,
      toolCtx: ctx,
      toolHandlers,
      runLog,
      systemPrompt: sys.text,
      toolSchemas: TOOL_SCHEMAS,
      messagesPath: join(dirs.runDir, "messages.json"),
      model: label,
      initialUserMessage,
      events,
      messagesDir: dirs.messagesDir,
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
