# bobbihack

Full-screen TUI that watches an LLM agent play NetHack. NetHack runs in
an embedded 80×25 pane; a second pane streams the agent's reasoning live
and keeps a per-turn history.

## Install NetHack

```bash
brew install nethack
```

bobbihack exits cleanly with a message if NetHack isn't on PATH.

## Run

```bash
# With the built-in mock agent (no API key needed):
BOBBIHACK_AGENT=mock bun examples/bobbihack/main.ts

# With Anthropic (auto-selected when ANTHROPIC_API_KEY is set):
ANTHROPIC_API_KEY=sk-ant-... bun examples/bobbihack/main.ts

# Override the model:
ANTHROPIC_API_KEY=... BOBBIHACK_MODEL=claude-sonnet-4-6 bun examples/bobbihack/main.ts
```

Or via the script: `bun run bobbihack`.

## Controls

- `q` (or Ctrl-C / Ctrl-D) — quit. bobbihack sends NetHack the clean
  `#quit y y` dance, waits for it to exit, restores your terminal,
  exits 0.

## Layout

bobbihack picks one of three layouts based on host terminal size:

- **Side-by-side** when ≥ 126×26. NetHack pinned left at 84×26
  (a 1-cell horizontal margin around NetHack's 80×24 output);
  agent pane fills the remaining width and full height.
- **Stacked** when ≥ 84×39 but not wide enough for side-by-side.
  NetHack pinned top; agent pane below.
- **Resize prompt** when neither fits.

The layout updates live on terminal resize (SIGWINCH).

## Agents

bobbihack ships two agent implementations behind one `Agent` interface:

- **`MockAgent`** — built-in, no dependencies. Seeded PRNG picks moves;
  emits canned thinking text. Useful for development, smoke tests, and
  running without an API key.
- **`AnthropicAgent`** — streaming Messages API + tool-use. Requires
  `ANTHROPIC_API_KEY`. The SDK is an `optionalDependency` and is
  lazy-imported, so omitting it doesn't break `MockAgent`.

Selection: `BOBBIHACK_AGENT=anthropic|mock` overrides; otherwise
auto-prefers `anthropic` if a key is present, falls back to `mock`.
