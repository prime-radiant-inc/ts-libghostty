#!/usr/bin/env bun
// Probe: spawn nethack with rows:25, wait for the first stable frame,
// dump frame.snapshot.toAnsi() to stdout so we can see exactly what
// the bobbihack renderer is given.
import { Runner } from "../src/index";
import { hasNethack, nethackEnv } from "../examples/shared/nethack-setup";

if (!hasNethack()) {
  console.log("nethack not on PATH; skipping");
  process.exit(0);
}

const runner = await Runner.spawn(["nethack"], {
  cols: 80,
  rows: 25,
  env: nethackEnv(),
  frame: { minIntervalMs: 100, maxIntervalMs: 5000, quiesceMs: 200 },
});

let frames = 0;
const start = Date.now();
for await (const frame of runner.frames()) {
  frames++;
  // dismiss any prompts so the game proceeds to a stable state
  const text = frame.snapshot.text;
  if (text.includes("(y/n)")) { await runner.sendText("n"); continue; }
  if (text.includes("--More--")) { await runner.sendKey("Space"); continue; }
  if (frames < 10 && Date.now() - start < 5000) continue;

  // Dump the snapshot
  const ansi = frame.snapshot.toAnsi();
  const lines = ansi.split("\n");
  console.log(`=== frame ${frames}, lines.length=${lines.length} ===`);
  for (let i = 0; i < lines.length; i++) {
    const visible = lines[i]!.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
    console.log(`row ${String(i).padStart(2)} (vis=${String(visible.length).padStart(3)}): ${JSON.stringify(visible)}`);
  }
  break;
}

await runner.sendText("#quit\r y\r y\r");
await runner.waitExit({ timeoutMs: 3000 }).catch(() => {});
await runner[Symbol.asyncDispose]();
