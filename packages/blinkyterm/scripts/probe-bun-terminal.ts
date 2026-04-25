#!/usr/bin/env bun

const decoder = new TextDecoder();
const events: string[] = [];

const term = new Bun.Terminal({
  cols: 20,
  rows: 5,
  data(_terminal, chunk) {
    events.push(`data:${decoder.decode(chunk).replace(/\r/g, "\\r").replace(/\n/g, "\\n")}`);
  },
  exit(_terminal, code, signal) {
    events.push(`pty-exit:${code}:${signal ?? "null"}`);
  },
  drain() {
    events.push("drain");
  },
});

const proc = Bun.spawn({
  cmd: ["bash", "-lc", "stty size; read line; printf 'got:%s\\n' \"$line\""],
  env: { ...process.env, TERM: "xterm-256color" },
  terminal: term,
  onExit(
    subprocess: Bun.Subprocess,
    exitCode: number | null,
    signalCode: NodeJS.Signals | number | null,
    error: Error | null,
  ) {
    events.push(`proc-exit:${exitCode ?? "null"}:${signalCode ?? "null"}:${error ? "error" : "ok"}:${subprocess.pid}`);
  },
} as unknown as Parameters<typeof Bun.spawn>[0]);

const writeReturn = term.write("hello\n");
events.push(`write-return:${String(writeReturn)}:${typeof writeReturn}`);

try {
  term.resize(30, 7);
  events.push("resize:ok");
} catch (error) {
  events.push(`resize:error:${(error as Error).message}`);
}

const exitCode = await proc.exited;
events.push(`exited-promise:${exitCode}`);
events.push(`proc-fields:${proc.exitCode ?? "null"}:${proc.signalCode ?? "null"}:${proc.killed}`);

let postExitWrite = "no-throw";
try {
  term.write("after\n");
} catch (error) {
  postExitWrite = `throw:${(error as Error).message}`;
}
events.push(`post-exit-write:${postExitWrite}`);

term.close();
events.push(`term-closed:${term.closed}`);

for (const event of events) console.log(event);

export {};
