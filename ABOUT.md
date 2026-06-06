# ts-libghostty

> Bun-workspaces monorepo of TypeScript bindings around Ghostty's VT state machine: libghostty-vt (model layer) and blinkyterm (agent-facing terminal Runner).

**Family:** dev-tools · **Type:** library · **Lifecycle:** production · **Owner:** mhat

## What it does
This monorepo provides two npm packages. `libghostty-vt` is a direct binding over Ghostty's libghostty-vt, exposing Terminal, RenderState, Formatter, effect callbacks, and color management; it is self-contained and usable for parsing recorded VT streams or any context needing the model layer. `blinkyterm` is an agent-facing Runner built on `Bun.Terminal` plus libghostty-vt, with async frame iteration and send helpers (used in examples like an agentic terminal autopilot).

## How it fits
- Depends on: — (no internal prime-radiant-inc dependencies; root package.json has only @types/bun and typescript devDeps, binding wraps the external Ghostty dylib)
- Used by: — (published as npm `libghostty-vt` and `blinkyterm`)
- External: Ghostty (libghostty-vt dylib, bundled under Apache-2.0); Bun runtime; zig toolchain for native build

## Runtime & data
- Runs: imported TypeScript/Bun library packages (with example apps under packages/blinkyterm/examples)
- Data in: VT byte streams / terminal output
- Data out: parsed terminal model state, render frames, key encodings

<!-- Maintained by the maintaining-project-map skill. Do not hand-edit; regenerated. -->
