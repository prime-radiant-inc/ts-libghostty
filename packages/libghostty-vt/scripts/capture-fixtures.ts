#!/usr/bin/env bun
/*
 * Capture real-application VT byte streams for test/differential/corpus/.
 *
 * Each fixture runs under a PTY via Bun.Terminal + Bun.spawn({ terminal }).
 * The terminal's data callback collects every byte the child writes to its
 * pty, which is then dumped to a fixture file. Some fixtures send scheduled
 * input chunks (vim/less/tmux need timing between keystrokes); others just
 * let the child run and exit.
 *
 * Vim and less captures intentionally do not send a quit command — quitting
 * emits the alt-screen-exit sequence (ESC [ ? 1049 l), which restores the
 * empty main screen and erases all the rendered content from the fixture.
 * Instead we let a SIGKILL timeout fire, freezing the displayed state.
 *
 * Captured fixtures are not byte-reproducible across re-runs (output depends
 * on tool version, process list, current time) but they exercise realistic
 * sequence combinations that atomic fuzz seeds don't. Regenerate when:
 *   - a tool's output format changes materially
 *   - the Ghostty pin bumps and a fixture starts emitting sequences the new
 *     VT interpreter handles differently
 *
 * Usage (from repo root):
 *   bun scripts/capture-fixtures.ts
 */
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), "..");
const CORPUS = path.join(REPO_ROOT, "test", "differential", "corpus");

mkdirSync(CORPUS, { recursive: true });

interface InputChunk {
  /** Milliseconds after the previous chunk (or start) to wait before sending. */
  delayMs: number;
  /** Bytes to write to the child's pty (typically scripted keystrokes). */
  data: string | Uint8Array;
}

interface CaptureOptions {
  cmd: string[];
  /** Extra env vars merged into the child env. TERM defaults to xterm-256color. */
  env?: Record<string, string>;
  cols?: number;
  rows?: number;
  /** Scheduled input chunks (keystrokes etc.). */
  inputs?: InputChunk[];
  /** Hard kill the child after this many ms. */
  timeoutMs: number;
  /** Wait this many ms after child exits before closing the pty (drain output). */
  settleMs?: number;
  /** Output fixture path. */
  output: string;
}

async function capture(opts: CaptureOptions): Promise<void> {
  const cols = opts.cols ?? 80;
  const rows = opts.rows ?? 24;
  const settleMs = opts.settleMs ?? 100;

  const captured: Uint8Array[] = [];
  // When proc.kill fires, Bun closes the slave fd. Programs with a SIGHUP
  // handler (notably tmux) run cleanup in response — clearing the screen,
  // exiting alt-screen, resetting modes — which would erase the rendered
  // state we care about. Those cleanup bytes arrive on the master side AFTER
  // kill. We set `frozen` right before kill and drop any chunk that arrives
  // after that, preserving exactly the state that was displayed at the
  // moment we decided to stop.
  let frozen = false;
  const term = new Bun.Terminal({
    cols,
    rows,
    data(_t: unknown, chunk: Uint8Array) {
      if (frozen) return;
      // chunk is a Buffer (Uint8Array subclass). Copy is unnecessary —
      // the pty write loop produces fresh allocations per read.
      captured.push(chunk);
    },
  });

  const proc = Bun.spawn({
    cmd: opts.cmd,
    env: {
      ...process.env,
      TERM: "xterm-256color",
      LC_ALL: "en_US.UTF-8",
      LANG: "en_US.UTF-8",
      COLUMNS: String(cols),
      LINES: String(rows),
      ...(opts.env ?? {}),
    },
    // `terminal:` wires stdin/stdout/stderr to the pty's slave end.
    terminal: term,
  } as Parameters<typeof Bun.spawn>[0]);

  // Schedule the input chunks. They run independently of the exit watcher.
  const inputPromise = (async () => {
    for (const chunk of opts.inputs ?? []) {
      await Bun.sleep(chunk.delayMs);
      if (proc.killed) return;
      try {
        term.write(chunk.data);
      } catch {
        // pty closed — child probably exited
        return;
      }
    }
  })();

  // Whichever fires first: child exits, or timeout kills it.
  const timeoutPromise = Bun.sleep(opts.timeoutMs).then(() => "timeout" as const);
  const exitPromise = proc.exited.then(() => "exited" as const);
  const why = await Promise.race([timeoutPromise, exitPromise]);
  if (why === "timeout") {
    frozen = true;  // drop any post-kill cleanup bytes (see data callback)
    proc.kill("SIGKILL");
    await proc.exited;
  }

  // Let any tail bytes the kernel still owes us land before we close.
  // (Only relevant for natural exits — the `frozen` flag already ignores
  // anything that arrives after a timeout-kill.)
  await Bun.sleep(settleMs);
  await inputPromise;
  term.close();

  // Concatenate captured chunks and write to disk.
  const total = captured.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of captured) {
    out.set(c, off);
    off += c.length;
  }
  writeFileSync(opts.output, out);
  process.stderr.write(
    `capture: wrote ${total} bytes to ${path.relative(REPO_ROOT, opts.output)} ` +
      `(cmd=${opts.cmd[0]}, ${why})\n`,
  );
}

// ---- Fixtures ---------------------------------------------------------------

// 20-bash-prompt: bash session with colored PS1 + a couple of commands.
{
  const tmp = mkdtempSync(path.join(tmpdir(), "cap-bash-"));
  writeFileSync(
    path.join(tmp, "bashrc"),
    `PS1='\\[\\033[1;34m\\]user@host\\[\\033[0m\\]:\\[\\033[1;36m\\]~/work\\[\\033[0m\\]$ '\n`,
  );
  await capture({
    cmd: ["bash", "--noprofile", "--rcfile", path.join(tmp, "bashrc"), "-i"],
    inputs: [
      { delayMs: 200, data: "echo hello world\n" },
      { delayMs: 200, data: 'printf "\\033[1;31mred\\033[0m \\033[32mgreen\\033[0m\\n"\n' },
      { delayMs: 200, data: "exit\n" },
    ],
    timeoutMs: 5000,
    output: path.join(CORPUS, "20-bash-prompt.vt"),
  });
  rmSync(tmp, { recursive: true, force: true });
}

// 21-vim-edit: vim insert + write to a tmp file, no quit (let timeout kill).
await capture({
  cmd: ["vim", "--clean", "-N"],
  inputs: [
    { delayMs: 250, data: "iHello world\nLine two\nLine three\x1b" },
    { delayMs: 250, data: ":w! /tmp/vim-edit-cap.txt\n" },
  ],
  timeoutMs: 3000,
  output: path.join(CORPUS, "21-vim-edit.vt"),
});
try { rmSync("/tmp/vim-edit-cap.txt", { force: true }); } catch {}

// 22-vim-syntax: vim with syntax highlighting on a Python file. Verifies
// SGR coloring round-trips through the binding (html-format diff catches
// any color-payload corruption).
{
  const tmp = mkdtempSync(path.join(tmpdir(), "cap-vim-"));
  const sample = path.join(tmp, "sample.py");
  writeFileSync(
    sample,
    [
      `#!/usr/bin/env python3`,
      `"""A small colored-syntax sample."""`,
      ``,
      `def greet(name: str) -> str:`,
      `    # comment line with "string in comment" and a number 42`,
      `    return f"Hello, {name}!"`,
      ``,
      `if __name__ == "__main__":`,
      `    for i in range(3):`,
      `        print(greet(f"world {i}"))`,
      ``,
    ].join("\n"),
  );
  await capture({
    cmd: ["vim", "--clean", "-N", "-c", "syntax on", "-c", "set background=dark", sample],
    inputs: [{ delayMs: 600, data: ":redraw\n" }],
    timeoutMs: 3000,
    output: path.join(CORPUS, "22-vim-syntax.vt"),
  });
  rmSync(tmp, { recursive: true, force: true });
}

// 23-less-pager: less paging a 50-line file, page down twice, no quit.
{
  const tmp = mkdtempSync(path.join(tmpdir(), "cap-less-"));
  const file = path.join(tmp, "lines.txt");
  const lines: string[] = [];
  for (let i = 1; i <= 50; i++) {
    lines.push(`Line ${String(i).padStart(3, "0")}: the quick brown fox jumps over the lazy dog.`);
  }
  writeFileSync(file, lines.join("\n") + "\n");
  await capture({
    cmd: ["less", "-R", file],
    inputs: [
      { delayMs: 400, data: " " },
      { delayMs: 400, data: " " },
    ],
    timeoutMs: 3000,
    output: path.join(CORPUS, "23-less-pager.vt"),
  });
  rmSync(tmp, { recursive: true, force: true });
}

// 24-tmux-splits: fresh tmux server (-L isolated), start session, split, echo
// in each pane. Server is killed at the end so we don't leave dangling state.
{
  const sock = `cap-fixture-${process.pid}`;
  // Use `bash -i` (interactive) inside the pane so bash doesn't exit on
  // stdin EOF after our scripted commands finish. If bash exits, tmux
  // reaps the pane, ends the session, and runs the alt-screen-exit +
  // clear-screen cleanup before we can capture the rendered state.
  Bun.spawnSync({
    cmd: ["tmux", "-L", sock, "-f", "/dev/null", "new-session", "-d", "-s", "s",
          "-x", "80", "-y", "24", "bash --noprofile --norc -i"],
  });
  await capture({
    cmd: ["tmux", "-L", sock, "-f", "/dev/null", "attach-session", "-t", "s"],
    inputs: [
      { delayMs: 400, data: "\x02\"" },              // Ctrl-B " : horizontal split
      { delayMs: 400, data: "echo pane one; read\n" },
      { delayMs: 400, data: "\x02o" },                // Ctrl-B o : focus other pane
      { delayMs: 400, data: "echo pane two\n" },
    ],
    timeoutMs: 4000,
    output: path.join(CORPUS, "24-tmux-splits.vt"),
  });
  Bun.spawnSync({ cmd: ["tmux", "-L", sock, "kill-server"] });
}

// 25-top-snapshot: macOS top, two 1-second samples then exit. Used in lieu
// of htop (not on macOS by default). Renders without alt-screen so the
// final state survives even though top exits cleanly.
await capture({
  cmd: ["top", "-l", "2", "-s", "1", "-n", "10", "-o", "cpu"],
  timeoutMs: 8000,
  output: path.join(CORPUS, "25-top-snapshot.vt"),
});

process.stderr.write("\nCaptured fixtures:\n");
const fs = await import("node:fs/promises");
const entries = (await fs.readdir(CORPUS))
  .filter((e) => /^2\d-.*\.vt$/.test(e))
  .sort();
for (const e of entries) {
  const st = await fs.stat(path.join(CORPUS, e));
  process.stderr.write(`  ${e}  ${st.size}B\n`);
}
