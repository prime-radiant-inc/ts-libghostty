# bobbihack system prompt variants

Each `*.txt` here is a complete system prompt the conductor can hand to
the model. Use the `BOBBIHACK_SYSTEM_PROMPT` env var to pick one:

    BOBBIHACK_SYSTEM_PROMPT=strategy-rich bun run packages/blinkyterm/examples/bobbihack/main.ts
    BOBBIHACK_SYSTEM_PROMPT=default       bun run packages/blinkyterm/examples/bobbihack/main.ts

The name maps to `prompts/<name>.txt`. If unset, defaults to `default`.
Allowed name characters: `[a-zA-Z0-9_-]`. Missing files fall back to
`default` with a warning.

The conductor logs the prompt's SHA-256 hash per run (in `run.jsonl`),
so head-to-head variant comparisons can group runs by hash.

## Variants

| Name             | Size        | Purpose |
|------------------|-------------|---------|
| `default`        | ~180 lines  | Original baseline. Tools, glyphs, modal prompts, brief strategy. Counts on the model's training data for nethack knowledge. |
| `strategy-rich`  | ~290 lines  | Default + ~110 lines of explicit strategy: pacing, HP/retreat, hunger heuristics, prayer rules, identification (BUC-test, pet check), dangerous-melee monsters (floating eye etc.), Elbereth engraving, fountain warning, Mines/Sokoban branches, Valkyrie playbook (5.0-aware: no Excalibur dipping). |

## Adding a variant

1. Drop `prompts/myvariant.txt` into this directory.
2. Run with `BOBBIHACK_SYSTEM_PROMPT=myvariant`.
3. Compare run-jsonl hashes to group runs by variant.

## Sources for `strategy-rich`

- [Standard strategy](https://nethackwiki.com/wiki/Standard_strategy) (NetHack Wiki)
- [Mikko Saari's Absolute Beginner's Guide](https://www.melankolia.net/nethack/nethack.guide.html)
- [Floating eye](https://nethack.fandom.com/wiki/Floating_eye), [YASD](https://nethackwiki.com/wiki/Yet_Another_Stupid_Death) (search snippets)
- 5.0-specific Valkyrie change (no starting long sword) confirmed via wiki search.
