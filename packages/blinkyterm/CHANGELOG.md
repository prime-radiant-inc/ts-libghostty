# Changelog

All notable changes to `blinkyterm` will be documented here. Format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.1.1] - 2026-05-07

### Changed

- Now published in lockstep with `libghostty-vt` from the same git
  tag. Tarball is produced via `bun pm pack` so the `workspace:*`
  dep on `libghostty-vt` is resolved to a real version. Published
  via npm trusted publishing (OIDC); no NPM_TOKEN involved.

### Added

- `repository`, `homepage`, and `bugs` fields in `package.json` —
  required by npm's sigstore provenance validation.

## [0.1.0] - 2026-04-25

### Added

- `Runner.spawn()` for pty-backed TUI children. Pairs `Bun.Terminal`
  with the `libghostty-vt@0.4.0` binding to give an agent a screen
  view of, and a keystroke channel to, a real TUI program.
- `frames()` async iterator with frozen snapshots, quiesce, rate
  limiting, heartbeat, latest-only semantics, and terminal frames.
- `sendBytes`, `sendText`, `sendKey`, and `sendKeyEvent`. `sendKey`
  uses an internal US-layout helper to populate `utf8` and
  `unshiftedCodepoint` for printable physical keys, satisfying the
  Pass 4 `KeyEncoder` contract.
- `waitExit`, `terminate` (with SIGTERM → SIGKILL escalation), and
  `resize`.
- `[Symbol.asyncDispose]` for `await using` lifecycle.
- Six error classes: `BlinkyTermError`, `SpawnError`,
  `FirstFrameTimeoutError`, `ExitedError`, `DisposedError`,
  `IteratorInUseError`. Plus re-exports `EncodeError` from
  `libghostty-vt`.
- `realClock` + `createFakeClock` for clock injection in consumer
  tests.
- Seven deterministic shell fixtures under `test/fixtures/children/`
  exercising spawn, send, exit, signal, bell+title, slow-paint, and
  end-to-end agent loop paths.
- NetHack reference examples: `examples/random-bot.ts` (seeded random
  mover, no SDK) and `examples/llm-bot.ts` (dependency-free via
  `BLINKYTERM_LLM_COMMAND` external command).
