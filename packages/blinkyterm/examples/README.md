# blinkyterm examples

End-to-end demos that drive a real NetHack process through `Runner`.
These examples are **not** part of CI — they exist to make the runner's
behavior tangible and to give downstream users a starting template.

## Install

```bash
brew install nethack
```

The examples skip cleanly with exit code `0` when `nethack` is missing,
so it's safe to run them on a machine without it.

## random-bot.ts

A deterministic random-walk bot. Spawns NetHack, dismisses `--More--`
and `(y/n)` prompts, picks a random move from
`{north, south, east, west, search, pickup}` each turn, and quits via
`#quit y y` after a 200-turn budget. Seed is fixed at 42 so runs are
reproducible.

```bash
bun examples/random-bot.ts
```

## llm-bot.ts

Same shape as the random bot, but the move comes from an external
command instead of a PRNG. Each frame, blinkyterm passes the current
screen (as ANSI) to the command on stdin; the command must print one
move on stdout. Valid replies:

```
north south east west search pickup quit
```

Anything else falls back to `search`. Sending `quit` triggers the same
quit dance the random bot uses on budget exhaustion.

`BLINKYTERM_LLM_COMMAND` is the contract — set it to whatever you like:
a real LLM CLI, a hand-rolled script, even a one-liner. The bot skips
cleanly when the variable is unset.

```bash
# Smoke (immediately quits):
BLINKYTERM_LLM_COMMAND='printf quit' bun examples/llm-bot.ts

# Random move via Ruby — no extra dependencies:
BLINKYTERM_LLM_COMMAND='ruby -e "STDIN.read; puts %[north south east west search pickup].sample"' \
  bun examples/llm-bot.ts
```

The command receives the ANSI screen on stdin and must print one move
on stdout. stderr is forwarded unchanged so errors are visible.

## bobbihack

Full-screen TUI that watches an LLM agent play NetHack — NetHack runs
in an embedded 80×25 pane, with the agent's reasoning streaming live
in a second pane. Ships a built-in `MockAgent` (no API key) and an
`AnthropicAgent` (Messages API + tool use).

```bash
# Mock agent — no API key:
BOBBIHACK_AGENT=mock bun examples/bobbihack/main.ts

# Anthropic — auto-selected when ANTHROPIC_API_KEY is set:
ANTHROPIC_API_KEY=sk-ant-... bun examples/bobbihack/main.ts
```

Or via the script: `bun run bobbihack`. See
[`bobbihack/README.md`](./bobbihack/README.md) for layout, controls,
and agent details.
