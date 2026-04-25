#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";

if (spawnSync("bash", ["-lc", "command -v nethack"], { stdio: "ignore" }).status !== 0) {
  console.log("nethack not on PATH; skipped");
  process.exit(0);
}

mkdirSync(".tmp", { recursive: true });
const chunks: Uint8Array[] = [];
const term = new Bun.Terminal({
  cols: 80,
  rows: 24,
  data(_terminal, chunk) {
    chunks.push(new Uint8Array(chunk));
  },
});

const proc = Bun.spawn({
  cmd: ["nethack"],
  env: {
    ...process.env,
    TERM: "xterm-256color",
    LC_ALL: "en_US.UTF-8",
    LANG: "en_US.UTF-8",
    COLUMNS: "80",
    LINES: "24",
    NETHACKOPTIONS: "name:agent,role:valkyrie,race:human,gender:female,align:lawful",
  },
  terminal: term,
} as unknown as Parameters<typeof Bun.spawn>[0]);

await Bun.sleep(3000);
proc.kill("SIGTERM");
await proc.exited;
term.close();

const bytes = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
await Bun.write(".tmp/probe-nethack-startup.log", bytes.toString("utf8"));
console.log(`wrote .tmp/probe-nethack-startup.log (${bytes.length} bytes)`);
