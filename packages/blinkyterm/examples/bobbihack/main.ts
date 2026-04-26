#!/usr/bin/env bun
import { Runner } from "../../src/index";
import { hasNethack, nethackEnv } from "../shared/nethack-setup";
import { detectPrompt } from "../shared/prompt-detect";
import { toKeystroke, type BotMove } from "../shared/keymap";
import type { Agent, AgentDecision } from "./agent";
import { MockAgent } from "./agents/mock";
import { AnthropicAgent } from "./agents/anthropic";
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
import { openKeyStream } from "./events";

const ENTER_ALT = "\x1b[?1049h";
const EXIT_ALT = "\x1b[?1049l";
const SHOW_CURSOR = "\x1b[?25h";

async function main(): Promise<void> {
  if (!hasNethack()) {
    console.log("[bobbihack] nethack not on PATH; skipping. Install with `brew install nethack`.");
    process.exit(0);
  }

  const agent = pickAgent();
  console.log(`[bobbihack] using agent: ${agent.name}`);

  // Pin to 80x24 — NetHack 3.6 only paints 24 rows even when given a
  // 25-row pty (probe confirmed lines.length=24 either way). The pane
  // is sized to match exactly, so there's no blank row before the
  // bottom border.
  const runner = await Runner.spawn(["nethack"], {
    cols: 80,
    rows: 24,
    env: nethackEnv(),
    frame: { minIntervalMs: 500, maxIntervalMs: 10_000, quiesceMs: 100 },
  });

  const hostCols = process.stdout.columns ?? 200;
  const hostRows = process.stdout.rows ?? 60;
  let state: ViewState = initialState({
    hostCols,
    hostRows,
    agentLabel: agent.name,
    pid: runner.pid,
  });

  const ac = new AbortController();
  const keyStream = openKeyStream();

  let writePending: NodeJS.Immediate | null = null;
  const requestPaint = (): void => {
    if (writePending !== null) return;
    writePending = setImmediate(() => {
      writePending = null;
      let nethackContent = "";
      if (state.layout.kind !== "tooSmall") {
        const box = state.layout.nethack;
        try {
          nethackContent = runner.terminal.renderToAnsiRect({
            row: box.row + 1,
            col: box.col + 2,
            cols: 80,
            rows: 24,
          });
        } catch {
          // Runner disposed mid-paint, or strict size match failed.
          // Render with empty pane; next paint catches up.
        }
      }
      process.stdout.write(render(state, nethackContent));
    });
  };

  const onWinch = (): void => {
    state = onResize(state, process.stdout.columns ?? hostCols, process.stdout.rows ?? hostRows);
    requestPaint();
  };

  let restored = false;
  const restoreTerminal = (): void => {
    if (restored) return;
    restored = true;
    keyStream.close();
    process.removeListener("SIGWINCH", onWinch);
    process.stdout.write(SHOW_CURSOR + EXIT_ALT);
  };

  process.stdout.write(ENTER_ALT);
  process.on("SIGWINCH", onWinch);

  const userKeyTask = (async () => {
    for await (const key of keyStream.keys()) {
      if (key === "quit") { ac.abort(); return; }
    }
  })();

  let turnCounter = 0;
  let cleanQuitSent = false;

  try {
    requestPaint();
    for await (const frame of runner.frames()) {
      if (frame.reason === "exited" || frame.reason === "crashed") {
        state = onChildExited(state, frame.reason, frame.exitCode);
        requestPaint();
        break;
      }

      state = onChildFrame(state, frame);
      requestPaint();

      const prompt = detectPrompt(frame.snapshot);
      if (prompt === "more") { if (!runner.exited) await runner.sendKey("Space"); continue; }
      if (prompt === "yn") { if (!runner.exited) await runner.sendText("n"); continue; }
      if (prompt === "death") { break; }

      if (ac.signal.aborted) {
        if (!cleanQuitSent && !runner.exited) {
          cleanQuitSent = true;
          await runner.sendText("#quit\r y\r y\r");
        }
        continue;
      }

      const turn = ++turnCounter;
      state = onTurnStart(state, { turn, frameReason: frame.reason });
      requestPaint();

      let decision: AgentDecision = "search";
      try {
        for await (const event of agent.decide(
          { turn, frameReason: frame.reason, screenAnsi: frame.snapshot.toAnsi() },
          ac.signal,
        )) {
          state = onAgentEvent(state, event);
          requestPaint();
          if (event.kind === "action") decision = event.move;
          if (event.kind === "error") { decision = "search"; break; }
        }
      } catch (err) {
        if (!ac.signal.aborted) throw err;
      }

      state = onTurnEnd(state);
      requestPaint();

      if (ac.signal.aborted) continue;
      if (runner.exited) continue;

      if (decision === "quit") {
        cleanQuitSent = true;
        await runner.sendText("#quit\r y\r y\r");
        const r = await runner.waitExit({ timeoutMs: 3000 });
        if (!r.exited) await runner.terminate({ thenAfterMs: 1000 });
        continue;
      }

      await runner.sendText(toKeystroke(decision as BotMove));
    }
  } finally {
    restoreTerminal();
    await runner[Symbol.asyncDispose]();
    await userKeyTask.catch(() => {});
  }

  console.log(`[bobbihack] done; turns=${turnCounter}`);
}

function pickAgent(): Agent {
  const choice = process.env.BOBBIHACK_AGENT;
  const model = process.env.BOBBIHACK_MODEL;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (choice === "mock") return new MockAgent();
  if (choice === "anthropic") {
    if (apiKey === undefined || apiKey === "") {
      console.error("[bobbihack] BOBBIHACK_AGENT=anthropic requires ANTHROPIC_API_KEY");
      process.exit(1);
    }
    return new AnthropicAgent(model === undefined ? { apiKey } : { apiKey, model });
  }
  if (apiKey !== undefined && apiKey !== "") {
    return new AnthropicAgent(model === undefined ? { apiKey } : { apiKey, model });
  }
  return new MockAgent();
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
