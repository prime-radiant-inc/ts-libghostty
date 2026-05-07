# blinkyterm

Agent-facing TUI runner built on `Bun.Terminal` and `libghostty-vt`.
`Runner.spawn` boots a child process attached to a pty, parses its
output through Ghostty's VT engine, and yields stable frames you can
`for await`. Send helpers cover text, keys, and raw bytes.

`libghostty-vt` ships prebuilds for darwin-arm64 and Linux x64/arm64
(glibc and musl). CI smoke-tests blinkyterm only on darwin-arm64;
the TS code is not platform-locked, but Linux usage is unverified —
file an issue if it bites.

## Install

Inside this monorepo:

```json
{
  "dependencies": {
    "blinkyterm": "workspace:*"
  }
}
```

Downstream:

```bash
bun add blinkyterm
```

## Spawn a child and read frames

```ts
import { Runner } from "blinkyterm";

await using runner = await Runner.spawn(["bash", "-l"], {
  cols: 80,
  rows: 24,
});

for await (const frame of runner.frames()) {
  console.log(`[${frame.reason}]`);
  console.log(frame.snapshot.text);
  if (frame.snapshot.text.includes("$ ")) break;
  if (frame.reason === "exited" || frame.reason === "crashed") break;
}
```

`await using` ensures the child is terminated and FFI resources are
released when the block exits, even on throw.

## Send text, keys, and bytes

```ts
await runner.sendText("ls -la\n");
await runner.sendKey("Enter");
await runner.sendBytes(new Uint8Array([0x03])); // Ctrl-C
```

`sendKey` accepts modifier flags as the second arg
(`{ ctrl: true }`, etc.) and encodes through libghostty's keyboard
encoder, so things like arrow keys and function keys come out
correct under both legacy and Kitty keyboard modes.

## Clean quit vs terminate

Try a clean exit first; fall back to signals only if the child
won't go quietly:

```ts
await runner.sendText("exit\n");
const result = await runner.waitExit({ timeoutMs: 2_000 });
if (!result.exited) {
  await runner.terminate({ thenAfterMs: 500 });
}
```

`terminate` sends `SIGTERM`, then `SIGKILL` after `thenAfterMs` if
the child is still alive.

## Frozen snapshot semantics

Each `Frame` finalizes its `text`, `vt`, `html`, and per-cell views
eagerly at emission time. Holding on to an old frame is safe: later
writes to the terminal cannot mutate it, and the underlying VT
buffer is free to scroll, repaint, or reset without disturbing
frames you've already pulled off the iterator. Cost is paid up
front, not on access.

## Frame timing options

```ts
await Runner.spawn(argv, {
  frame: {
    minIntervalMs: 16,    // earliest a new frame may emit after the last
    maxIntervalMs: 250,   // hard cap — emit even if the stream is busy
    quiesceMs: 8,         // wait this long after the last write before emitting
    yieldOn: ["bell", "titleChange"],  // also emit on these reasons
  },
});
```

`minIntervalMs` rate-limits chatter; `quiesceMs` collapses bursts
into a single frame after the writes settle; `maxIntervalMs`
guarantees forward progress on a continuously busy pty;
`yieldOn` adds VT effects as additional emit triggers.

## Advanced: live Terminal and RenderState access

The `Runner` exposes `runner.terminal` and `runner.renderState` for
consumers that need direct access to the underlying `libghostty-vt`
objects — for example, to call `runner.renderState.toAnsiRect(dest)`
when compositing the child's screen into a host TUI. The cached
`renderState` follows the upstream-canonical "one `RenderState` per
`Terminal`, used forever" pattern; multi-consumer rules from
`libghostty-vt` apply.

`runner.sendKeyEvent(event)` is the lower-level send for a fully
populated `KeyEvent` (e.g., when you have your own keymap and don't
want blinkyterm's US-layout helper).

## Examples

End-to-end NetHack demos under `examples/` (not in CI). See
[`examples/README.md`](./examples/README.md) for details, including
[`examples/bobbihack/`](./examples/bobbihack/) — a full-screen TUI
that watches an LLM agent play NetHack in an embedded pane.
