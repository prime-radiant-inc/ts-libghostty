#!/usr/bin/env bun
/**
 * NetHack bot driven by an external command. The command in
 * `BLINKYTERM_LLM_COMMAND` is invoked once per frame; it receives the
 * current screen as ANSI on stdin and prints one move on stdout. Valid
 * moves: `north south east west search pickup quit`. Anything else
 * falls back to `search`.
 *
 * Skips cleanly if `nethack` is missing or `BLINKYTERM_LLM_COMMAND` is
 * unset — examples are not CI gates.
 *
 * Run:
 *   BLINKYTERM_LLM_COMMAND='your command here' bun examples/llm-bot.ts
 *
 * Quick smoke (always quits immediately):
 *   BLINKYTERM_LLM_COMMAND='printf quit' bun examples/llm-bot.ts
 */
import { Runner } from "../src/index";
import { hasNethack, nethackEnv } from "./shared/nethack-setup";
import { detectPrompt } from "./shared/prompt-detect";
import { toKeystroke, type BotMove } from "./shared/keymap";

const VALID_MOVES = new Set<BotMove>([
  "north",
  "south",
  "east",
  "west",
  "search",
  "pickup",
]);

type LlmCommand = "north" | "south" | "east" | "west" | "search" | "pickup" | "quit";

async function askLlm(command: string, screen: string): Promise<LlmCommand> {
  const proc = Bun.spawn({
    cmd: ["bash", "-lc", command],
    stdin: "pipe",
    stdout: "pipe",
    stderr: "inherit",
  });
  proc.stdin.write(screen);
  await proc.stdin.end();
  const out = await new Response(proc.stdout).text();
  await proc.exited;

  const first = out.split(/\r?\n/)[0]?.trim() ?? "";
  if (first === "quit") return "quit";
  if (VALID_MOVES.has(first as BotMove)) return first as LlmCommand;
  return "search";
}

async function main(): Promise<void> {
  if (!hasNethack()) {
    console.log(
      "[llm-bot] nethack not on PATH; skipping. Install with `brew install nethack`.",
    );
    process.exit(0);
  }
  const command = process.env.BLINKYTERM_LLM_COMMAND;
  if (command === undefined || command === "") {
    console.log(
      "[llm-bot] BLINKYTERM_LLM_COMMAND not set; skipping. See examples/README.md.",
    );
    process.exit(0);
  }

  const runner = await Runner.spawn(["nethack"], {
    env: nethackEnv(),
    frame: { minIntervalMs: 500, maxIntervalMs: 10000, quiesceMs: 100 },
  });

  console.log(`[llm-bot] spawned nethack pid=${runner.pid}`);

  let turns = 0;
  let quitting = false;
  try {
    for await (const frame of runner.frames()) {
      if (frame.reason === "exited" || frame.reason === "crashed") {
        console.log(
          `[llm-bot] child ${frame.reason}: code=${frame.exitCode ?? "?"} signal=${frame.signal ?? "?"}`,
        );
        break;
      }

      const prompt = detectPrompt(frame.snapshot);
      if (prompt === "more") {
        await runner.sendKey("Space");
        continue;
      }
      if (prompt === "yn") {
        await runner.sendText("n");
        continue;
      }
      if (prompt === "death") {
        console.log("[llm-bot] death detected; ending run");
        break;
      }

      if (turns >= 200 && !quitting) {
        quitting = true;
        console.log("[llm-bot] turn budget exhausted; sending quit dance");
        await runner.sendText("#quit\r y\r y\r");
        const result = await runner.waitExit({ timeoutMs: 3000 });
        if (!result.exited) {
          console.log("[llm-bot] clean quit timed out; escalating");
          await runner.terminate({ thenAfterMs: 1000 });
        }
        continue;
      }

      if (quitting) continue;

      const decision = await askLlm(command, frame.snapshot.toAnsi());
      if (decision === "quit") {
        quitting = true;
        console.log("[llm-bot] LLM said quit; sending quit dance");
        await runner.sendText("#quit\r y\r y\r");
        const result = await runner.waitExit({ timeoutMs: 3000 });
        if (!result.exited) {
          console.log("[llm-bot] clean quit timed out; escalating");
          await runner.terminate({ thenAfterMs: 1000 });
        }
        continue;
      }

      await runner.sendText(toKeystroke(decision));
      turns += 1;
    }
  } finally {
    await runner[Symbol.asyncDispose]();
  }

  console.log(`[llm-bot] done; turns=${turns}`);
}

await main();
