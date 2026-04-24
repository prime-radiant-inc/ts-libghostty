# Agent-drives-TUI architecture — layer boxes

Working diagram for the design conversation. Will be incorporated into the
full spec once brainstorming completes.

## Layers and ownership

```
┌─────────────────────────────────────────────────────────────┐
│  Agent                                                      │
│  (LLM, test harness, user code)                             │
└────────────────┬────────────────────────────────────────────┘
                 │ .snapshot(), .sendKeys(), .quit(),
                 │ .frames(), .exited
                 ▼
┌─────────────────────────────────────────────────────────────┐
│  Runner (Pass 5)                                            │
│  ── pure TypeScript, NO FFI ──                              │
│   • owns a Bun.Terminal (pty + child lifecycle)             │
│   • owns a vt.Terminal (VT model)                           │
│   • owns a vt.KeyEncoder (keystroke → bytes)                │
│   • wires pty.data  → vt.vtWrite                            │
│   • wires vt.onWritePty → pty.write  (DA1/cursor replies)   │
│   • keeps resize in sync on both                            │
│   • quit protocol + exit-code + dispose                     │
└─────┬──────────────────┬─────────────────────────────┬──────┘
      │                  │                             │
      ▼                  ▼                             ▼
┌──────────────┐  ┌────────────────────────────────────────────┐
│ Bun.Terminal │  │  libghostty-vt binding  (Pass 1–4)         │
│  built-in    │  │  ── FFI wrappers over libghostty-vt.dylib ─│
│  pty+spawn   │  │   • Terminal                               │
│              │  │   • KeyEncoder         ← Pass 4            │
│              │  │   • RenderState, Formatter, cellAt, ...    │
└──────┬───────┘  └────────────────────┬───────────────────────┘
       │                               │ dlopen
       ▼                               ▼
┌──────────────┐            ┌──────────────────────────────────┐
│ child proc   │            │  libghostty-vt.dylib             │
│ (nethack,    │            │  (C library, Ghostty pin)        │
│  vim, top)   │            │                                  │
└──────────────┘            └──────────────────────────────────┘
```

## Key properties

1. **Runner has no FFI.** Pure TypeScript composition. All dylib calls go
   through the binding.
2. **Both `Terminal` and `KeyEncoder` are binding-layer.** Both are FFI
   wrappers over C functions in `libghostty-vt.dylib`, and `KeyEncoder` is
   paired with a `Terminal` — the encoder reads the terminal's mode state
   (e.g. DECCKM cursor-keys mode changes what arrow keys emit).
3. **The binding is usable without Runner.** Differential tests already
   feed captured `.vt` bytes straight into `Terminal` without any child
   process.
4. **Runner is unusable without the binding.** One-way dependency.
5. **Bun.Terminal is a Runner-only dependency.** The binding stays
   Bun-runtime-agnostic (modulo FFI loader). Consumers parsing recorded
   VT streams don't pay for pty code they don't use.

## Packaging implication

The binding and the runner are two conceptual layers with a one-way
dependency. Monorepo with two packages:

- `packages/libghostty-vt` — binding + KeyEncoder (Pass 1–4)
- `packages/libghostty-runner` — Runner + NetHack example (Pass 5)

Shared vendor/ (Ghostty pin is a single source of truth), shared CI,
independent npm versioning.
