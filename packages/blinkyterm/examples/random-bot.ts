#!/usr/bin/env bun
/**
 * NetHack random-walk bot. Spawns nethack via blinkyterm's Runner, reads the
 * frame iterator, dismisses `--More--` and `(y/n)` prompts, and otherwise
 * picks a random move from a fixed vocabulary. Quits cleanly after a
 * 200-turn budget.
 *
 * Skips with exit code 0 if `nethack` is not on PATH — examples are not CI
 * gates.
 *
 * Run: `bun examples/random-bot.ts`
 */
import { Runner } from "../src/index";
import { hasNethack, nethackEnv } from "./shared/nethack-setup";
import { detectPrompt } from "./shared/prompt-detect";
import { toKeystroke, type BotMove } from "./shared/keymap";
import { mulberry32 } from "./shared/mulberry32";

const MOVES: readonly BotMove[] = [
  "north",
  "south",
  "east",
  "west",
  "search",
  "pickup",
] as const;

async function main(): Promise<void> {
  if (!hasNethack()) {
    console.log(
      "[random-bot] nethack not on PATH; skipping. Install with `brew install nethack`.",
    );
    process.exit(0);
  }

  const rand = mulberry32(42);
  const runner = await Runner.spawn(["nethack"], {
    env: nethackEnv(),
    frame: { minIntervalMs: 500, maxIntervalMs: 10000, quiesceMs: 100 },
  });

  console.log(`[random-bot] spawned nethack pid=${runner.pid}`);

  let turns = 0;
  let quitting = false;
  try {
    for await (const frame of runner.frames()) {
      if (frame.reason === "exited" || frame.reason === "crashed") {
        console.log(
          `[random-bot] child ${frame.reason}: code=${frame.exitCode ?? "?"} signal=${frame.signal ?? "?"}`,
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
        console.log("[random-bot] death detected; ending run");
        break;
      }

      if (turns >= 200 && !quitting) {
        quitting = true;
        console.log("[random-bot] turn budget exhausted; sending quit dance");
        await runner.sendText("#quit\r y\r y\r");
        const result = await runner.waitExit({ timeoutMs: 3000 });
        if (!result.exited) {
          console.log("[random-bot] clean quit timed out; escalating");
          await runner.terminate({ thenAfterMs: 1000 });
        }
        continue;
      }

      if (quitting) continue;

      const move = MOVES[Math.floor(rand() * MOVES.length)]!;
      await runner.sendText(toKeystroke(move));
      turns += 1;
    }
  } finally {
    await runner[Symbol.asyncDispose]();
  }

  console.log(`[random-bot] done; turns=${turns}`);
}

await main();
