# Changelog

All notable changes to `ts-libghostty-vt` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[0.2.0]: https://github.com/prime-radiant-inc/ts-libghostty-vt/releases/tag/v0.2.0
[0.1.0]: https://github.com/prime-radiant-inc/ts-libghostty-vt/releases/tag/v0.1.0
