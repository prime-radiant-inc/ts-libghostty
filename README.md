# ts-libghostty

Bun-workspaces monorepo for TypeScript bindings around Ghostty's VT
state machine.

## Packages

- [`packages/libghostty-vt/`](./packages/libghostty-vt/) — npm
  `libghostty-vt`. Direct binding over libghostty-vt: `Terminal`,
  `RenderState`, `Formatter`, effect callbacks, color management.
  Self-contained; usable for parsing recorded VT streams or any
  context where you need the model layer.
- *(future)* `packages/blinkyterm/` — npm `blinkyterm`. Higher-level
  Runner that pairs `libghostty-vt` with `Bun.Terminal` (pty + child
  lifecycle) and adds keystroke encoding for driving real TUI
  programs from an agent. Targets v0.1.0 after Pass 5.

## Development

Requires Bun ≥ 1.3.13 and a one-time native toolchain setup (zig 0.15
via brew). See `packages/libghostty-vt/README.md` for the binding's
build instructions.

```bash
bun install                                        # workspace install
cd packages/libghostty-vt && bun test test/smoke   # binding tests
```

## License

Apache-2.0 for ts-libghostty source. See [LICENSE](./LICENSE) at the
root and per-package licenses for any bundled third-party material
(e.g., `packages/libghostty-vt/LICENSE_GHOSTTY` for the dylib).
