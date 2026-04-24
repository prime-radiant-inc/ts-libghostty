# Changelog

All notable changes to `ts-libghostty-vt` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.0] — 2026-04-23

Pass 3 closes the v0 grid-reading surface. With Pass 2's effect callbacks and Pass 3's `RenderState` + four new `Terminal` methods, a consumer can now replace tmux-style terminal capture with structured grid reads, cell-level style access, and dynamic color state. Pass 4 (keystroke encoding via `KeyEncoder`) is the last remaining pass before v1 targets upstream API stability.

### Added — Pass 3: RenderState + Terminal finish

- **`RenderState` class** — grid reader with dual iterator shape and native-dirty lifecycle.
  - Ergonomic path: `rows()` / `row.cells()` / `forEachDirtyRow()` allocate fresh `RenderRow` / `RenderCell` objects per iteration, snapshot lifetime valid until the next `update()`.
  - Hot path: `forEachCell(row, cb)` / `forEachDirtyCell(cb)` reuse a single mutable `RenderCell` object across the walk; the callback must not retain the reference.
  - `update(term)` refreshes native state and rebuilds the JS cache; `markClean()` is a two-step operation clearing both libghostty's internal dirty flags (one call via `ghostty_render_state_set(OPTION_DIRTY, FALSE)`) and the mirrored JS state. Multiple consumers can each call `markClean()` on independent cadences.
  - `dirty()` returns `"none" | "rows" | "all"` reflecting the global redraw signal.
  - `colors()` returns a `TerminalColors` object populated from `ghostty_render_state_colors_get`.
  - `cursor()` returns a `ViewportCursor` (`x` / `y` / `visible` / `wideTail`) distinct from `Terminal.snapshot().cursor`, tracking the viewport rather than the live terminal cursor. Cursor style is deferred (the 72-byte `GhosttyStyle` decode is Pass-5-or-later).
- **`Terminal.scrollViewport(pos)`** — `"top" | "bottom" | number` (signed row delta). libghostty clamps out-of-range deltas.
- **`Terminal.colors()` / `Terminal.setColors(patch)`** — read `{effective, defaults, palette[256]}`, write defaults. `effective` applies OSC 10/11/12 overrides; `defaults` reflects the configured baseline; palette preserves semantic index order. **OSC 10/11/12 overrides are preserved across `setColors` calls** — consumers relying on OSC overrides do not need to re-emit them after a `setColors` invocation.
- **`Terminal.cellAt({x, y, coordinateSpace?})`** — one-shot cell query across all four coord spaces. Costs: `"active"` / `"viewport"` O(1), `"screen"` O(row) walking wrapped rows, `"history"` O(depth) touching scrollback. Out-of-bounds returns `undefined`.
- **`encodeFocus("in" | "out")`** — standalone function returning fresh `Uint8Array` (no Terminal required).
- **APC bounds wiring.** `apcMaxBytes` (default 1 MiB) and `apcMaxBytesKitty` (default 0) return to `TerminalOptions`, applied post-construct via `ghostty_terminal_set`. The internal `KITTY_IMAGE_STORAGE_LIMIT` also wires to 0 at construction (not user-configurable at v0; Kitty image storage stays disabled until the graphics surface lands in a later tranche). Hilbert's Pass-1 contract fix removed these options because they were silently dropped; Pass 3 puts them back with honest wiring.
- **Render-metadata fixture infrastructure.** `.expected.json` companions to `.bin` fixtures capture full grid + cursor + color state; harness at `test/helpers/metadata-harness.ts`, driver at `test/smoke/fixture-metadata.test.ts`. `UPDATE_FIXTURES=1` regenerates. Per-fixture geometry in `test/fixtures/fixtures.json`. Three fixtures land at v0.3.0: `hello-world`, `sgr-basic`, `utf8-emoji`.
- **Resilience tests.** 20 seeded-random-bytes fuzz tests (128 KiB each, ESC-biased) and 10 MiB APC stress tests under default and custom bounds. All verify no exception bubbles out and `snapshot()` still works post-stress; RSS growth stays bounded.
- **Public types.** `CellInfo`, `CellStyle`, `UnderlineStyle`, `TerminalColors`, `CellAtPoint`, `ViewportCursor`, `RenderRow`, `RenderCell`.

### Platforms

- `darwin-arm64` only. Cross-platform support remains a Pass-4+-or-later decision.

### Pinned to

- Ghostty `e88c6c099152dd6d2d7e517516e1f3c183c152f7` (unchanged from `v0.2.0`).

## [0.2.0] — 2026-04-23

Pass 2 adds effect callbacks. This release also carries pre-Pass-2 hardening to the `v0.1.0` surface (Hilbert's contract fixes, which landed between the two tags and never shipped standalone).

### Added — Pass 2: effect callbacks

- **Three synchronous effect callbacks as `Terminal` constructor options**, invoked inside `vtWrite()` when libghostty processes the corresponding VT sequence:
  - `onWritePty(bytes: Uint8Array)` — query responses (DA1, DSR, DECRQM) that need to be sent back to the pty. Bytes are a JS-owned copy, safe to retain past the callback's return.
  - `onBell()` — BEL (`0x07`).
  - `onTitleChanged(title: string)` — OSC 0 / OSC 2 title changes. Title is a JS string, safe to retain.
- **Re-entry guard.** Calling any mutating `Terminal` method (`vtWrite`, `resize`, `reset`, `setMode`, `close`, `[Symbol.dispose]`) from inside an effect callback throws a typed `GhosttyError` with code `"invalid_value"` naming the forbidden method. Read-only methods (`snapshot`, `mode`) are explicitly allowed. libghostty is mid-parse during a callback; the guard prevents state corruption that would otherwise be undefined behavior.
- **Exception-safe trampoline.** Uncaught exceptions thrown from user callbacks — including from the re-entry guard — are caught at the FFI boundary, logged via `console.error`, and swallowed. They cannot cross the C frame.

### Added — pre-Pass-2 hardening

- **Constructor input validation.** `cols` / `rows` (`uint16_t`, 1..65535), `cellPx.{width,height}` (`uint32_t`), and `maxScrollback` (`size_t`, capped at `Number.MAX_SAFE_INTEGER`) are validated before crossing the FFI boundary. Out-of-range values throw `GhosttyError` with code `"invalid_value"` naming the offending field. Previously `cols: 70000` silently wrapped to `4464`, `cellPx: { width: -1, ... }` sign-extended to a huge `uint32`, and `maxScrollback: -1` encoded as `2^64 - 1`.

### Changed — pre-Pass-2 hardening

- `TerminalOptions` no longer declares `apcMaxBytes` / `apcMaxBytesKitty`. APC tuning is not wired at this pin and was silently dropped when passed; removing the fields turns that into a TypeScript compile error. APC tuning remains deferred.
- `TerminalSnapshot` no longer includes `cursor.style` or `mouseTracking`. `CURSOR_STYLE` returns a 72-byte struct that needs a real decode (deferred), and `MOUSE_TRACKING` returns a plain bool that doesn't map honestly to the 5-variant `MouseTracking` union. Both type aliases remain exported for later passes that wire them properly.

### Platforms

- `darwin-arm64` only. Other platforms still require a C shim to bridge AAPCS64 register-split.

### Pinned to

- Ghostty `e88c6c099152dd6d2d7e517516e1f3c183c152f7` (unchanged from `v0.1.0`).

## [0.1.0] — 2026-04-23

Initial Pass 1 surface. Superseded by `v0.2.0`, which cumulatively includes everything below plus the Pass 2 callbacks and pre-Pass-2 hardening listed above.

### Added

- `Terminal` class — `vtWrite`, `resize`, `reset`, `snapshot`, `mode` / `setMode`, lifecycle (`close`, `using` / `Symbol.dispose`).
- `Formatter` class — `plain` / `vt` / `html` dumps of a Terminal's current screen.
- `GhosttyError` hierarchy: `LibraryNotFoundError`, `UnsupportedPlatformError`, `LibraryCompatibilityError`, `UseAfterCloseError`, plus a `GhosttyErrorCode` string-literal union.
- `setLibraryPath(path)` / `isLoaded()` / `libraryInfo()` for diagnostics and out-of-tree library paths. `GHOSTTY_VT_LIB` env-var supported for the same purpose.
- Public types re-exported from the package root: `TerminalOptions`, `TerminalSnapshot`, `FormatterOptions`, `ModeName`, `RGB`, `PaletteIndex`, `CursorStyle`, `MouseTracking`, `LibraryInfo`.
- `pinnedCommit` constant exposing the Ghostty commit this build targets.
- `darwin-arm64` prebuilt `libghostty-vt.dylib` bundled under `prebuilds/`.

[0.3.0]: https://github.com/prime-radiant-inc/ts-libghostty-vt/releases/tag/v0.3.0
[0.2.0]: https://github.com/prime-radiant-inc/ts-libghostty-vt/releases/tag/v0.2.0
[0.1.0]: https://github.com/prime-radiant-inc/ts-libghostty-vt/releases/tag/v0.1.0
