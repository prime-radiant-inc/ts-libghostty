# ts-libghostty — Design Spec

**Status:** Approved for implementation planning
**Date:** 2026-04-22
**Author:** Dax (Bob session `0fdf1cc4`)
**Contributors:** Scribly-317 (upstream survey), Quillwright-9 (Bun.Terminal research), Cartograph-Prime (go-libghostty + C API survey)

## 1. Summary

A public TypeScript binding, named `ts-libghostty`, over Ghostty's `libghostty-vt` C library. Exposes the VT state machine — bytes in, grid out, keystrokes encoded — so Bun programs can embed a terminal emulator without shelling out to tmux, xterm.js, or a subprocess. Apache-2.0, Bun-only, prebuilt `.dylib` bundled for `darwin-arm64` at v0.

## 2. Motivation & context

The immediate consumer is Gauntlet, a Bun-based project that currently uses tmux as a scriptable terminal. Tmux is limiting: text-only capture via `capture-pane`, no structured access to styles, cursor, modes, or OSC state. Replacing it with a direct VT library gives Gauntlet's LLM-driven run loop a real API over the terminal.

The choice of `libghostty-vt` over alternatives (xterm.js headless, `vte`, writing our own VT parser) rests on: a modern correct implementation, active upstream maintenance, a soon-to-be-stable C ABI, and an embedding story explicitly encouraged by Ghostty's author.

This binding is public because a TS binding to libghostty is greenfield — nobody has shipped one — and the work is useful beyond Gauntlet.

## 3. Architecture

### 3.1 Boundary

`ts-libghostty` owns exactly the VT state machine. It does not own PTYs, child processes, rendering, or input devices. In a typical consumer:

```
┌───────────────────────────────────────────────────────────┐
│                       Consumer (Gauntlet)                 │
│                                                           │
│   ┌───────────────┐  bytes in    ┌─────────────────┐      │
│   │ Bun.Terminal  ├─────────────▶│  ts-libghostty  │      │
│   │  (owns PTY)   │              │  (owns VT       │      │
│   │               │◀─────────────┤   state)        │      │
│   └───────────────┘  bytes out   └─────────────────┘      │
│         ▲                              │                  │
│         │ keystrokes                   │ grid reads       │
│         │                              ▼                  │
│   ┌─────┴──────────────────────────────────────────┐      │
│   │              Gauntlet run loop / LLM           │      │
│   └────────────────────────────────────────────────┘      │
└───────────────────────────────────────────────────────────┘
```

PTY management is `Bun.Terminal` (native PTY support since Bun 1.3.5, 2025-12-17). Rendering, UI, and decision-making are the consumer's responsibility.

### 3.2 v0 scope

Implemented at v0:

- `Terminal` — lifecycle, byte ingestion, geometry, state snapshot, modes, colors, viewport scrolling, one-shot `cellAt`.
- `RenderState` — the grid-reading render loop with dirty tracking.
- `Formatter` — bulk screen dump to text/VT/HTML.
- `KeyEncoder` + `KeyEvent` — keystroke → bytes.
- `encodeFocus(in|out)` — standalone focus-event encoder.
- `GhosttyError` — error type.
- Three synchronous effect callbacks: `onWritePty`, `onBell`, `onTitleChanged`.

### 3.3 Explicit non-goals at v0

Mouse encoder/event, paste helpers, query-response callbacks (ENQUIRY / XTVERSION / DEVICE_ATTRIBUTES / SIZE / COLOR_SCHEME), Kitty graphics, OSC parser, SGR parser, Selection, `build_info`, `sys` log callback. Rationale and tranche ordering in §10.

### 3.4 Runtime & platform

Bun-only, `bun >= 1.3.13`. Day-one prebuild: `darwin-arm64`. Other platforms added as demand materializes (see §9).

## 4. Public API

All classes implement `Disposable` (`Symbol.dispose` → `close()`). Handles are private. All strings are UTF-8 TS `string` at the boundary.

### 4.1 `Terminal`

```ts
interface TerminalOptions {
  cols: number;
  rows: number;
  maxScrollback?: number;                           // default 1000
  cellPx?: { width: number; height: number };      // for pixel-accurate resize

  // Synchronous effect callbacks; invoked inside vtWrite().
  // MUST NOT re-enter vtWrite() on this Terminal.
  // MUST NOT throw (exceptions are caught at the FFI boundary and logged).
  onWritePty?: (bytes: Uint8Array) => void;        // bytes view valid only during callback
  onBell?: () => void;
  onTitleChanged?: (title: string) => void;
}

interface TerminalSnapshot {
  cols: number;
  rows: number;
  cursor: { x: number; y: number; visible: boolean; style: CursorStyle };
  activeScreen: "primary" | "alternate";
  title?: string;
  pwd?: string;
  scrollbackRows: number;
  mouseTracking: MouseTracking;
}

class Terminal implements Disposable {
  constructor(opts: TerminalOptions);

  vtWrite(bytes: Uint8Array): void;
  resize(cols: number, rows: number, cellPx?: { width: number; height: number }): void;
  reset(): void;

  snapshot(): TerminalSnapshot;                     // single FFI call via _get_multi

  mode(name: ModeName): boolean;
  setMode(name: ModeName, value: boolean): void;

  scrollViewport(pos: "top" | "bottom" | number): void;  // number = signed row delta

  colors(): TerminalColors;
  setColors(patch: Partial<TerminalColors>): void;

  cellAt(pt: { x: number; y: number; viewport?: "active" | "screen" }): CellInfo | undefined;

  close(): void;
  [Symbol.dispose](): void;
}
```

Individual getters (`term.cols`, `term.title`, …) are deliberately **not** provided. Consumers use `snapshot()`. Rationale: avoid the footgun of per-iteration FFI calls in hot loops. Reconsider if real-world ergonomics suffer.

### 4.2 `RenderState`, `RenderRow`, `RenderCell`

```ts
class RenderState implements Disposable {
  constructor();

  update(term: Terminal): void;                     // cheap; read-only on term
  dirty(): "none" | "rows" | "all";
  colors(): TerminalColors;

  rows(): IterableIterator<RenderRow>;
  forEachDirtyRow(cb: (row: RenderRow) => void): void;

  close(): void;
  [Symbol.dispose](): void;
}

interface RenderRow {
  y: number;
  wrapped: boolean;
  dirty: boolean;
  cells(): IterableIterator<RenderCell>;
}

interface RenderCell {
  x: number;
  codepoint: number;                                // 0 if blank
  wide: boolean;
  hasText: boolean;
  style?: CellStyle;                                // undefined = default style
  hyperlinkUri?: string;
  protected: boolean;
}
```

`RenderRow` and `RenderCell` objects are snapshots valid until the next `update()`. Retaining them past that is undefined behavior. Document prominently in README.

### 4.3 `Formatter`

```ts
interface FormatterOptions {
  format: "plain" | "vt" | "html";
  palette?: boolean;
  modes?: boolean;
  scrollingRegion?: boolean;
  tabStops?: boolean;
  pwd?: boolean;
  keyboard?: boolean;
  cursor?: boolean;
  style?: boolean;
  hyperlink?: boolean;
  protection?: boolean;
  charsets?: boolean;
}

class Formatter implements Disposable {
  constructor(opts: FormatterOptions);
  format(term: Terminal): Uint8Array;
  formatString(term: Terminal): string;             // UTF-8 decode of format()
  close(): void;
  [Symbol.dispose](): void;
}
```

Formatter instances are reusable across multiple Terminals and repeated calls. The `include-*` flags map 1:1 to `GhosttyFormatterExtra*` toggles in the C API.

### 4.4 `KeyEncoder` + `KeyEvent`

```ts
class KeyEncoder implements Disposable {
  constructor();

  syncFrom(term: Terminal): void;                   // recommended default

  // Advanced — bypass syncFrom() to set a single option directly.
  // Rare; only use when a consumer knows a mode the Terminal doesn't track.
  setKittyFlags(flags: KittyFlags): void;           // Kitty *keyboard* protocol, not graphics
  setOptionAsAlt(mode: "none" | "left" | "right" | "both"): void;
  setCursorKeyApplication(on: boolean): void;
  setKeypadApplication(on: boolean): void;
  setModifyOtherKeys(level: 0 | 1 | 2): void;
  setAutorepeat(on: boolean): void;
  setBackarrowKey(on: boolean): void;

  encode(event: KeyEvent): Uint8Array | undefined;

  close(): void;
  [Symbol.dispose](): void;
}

interface KeyEvent {
  action: "press" | "release" | "repeat";
  key: Key;                                         // union enum; values generated from vt.h
  mods?: Mods;
  consumedMods?: Mods;                              // mods already handled by IME/compose; usually omit
  utf8?: string;
  unshiftedCodepoint?: number;
  composing?: boolean;
}

interface Mods {
  shift?: boolean;
  ctrl?: boolean;
  alt?: boolean;
  super?: boolean;
  hyper?: boolean;
  meta?: boolean;
  capsLock?: boolean;
  numLock?: boolean;
}
```

`syncFrom(term)` is the recommended path — mirrors `ghostty_key_encoder_set_opt_from_terminal`. Call after `vtWrite` if the child may have switched modes. `encode()` returning `undefined` means the key is not mapped by this encoder; the consumer decides how to handle.

### 4.5 Standalone

```ts
function encodeFocus(direction: "in" | "out"): Uint8Array;
```

### 4.6 `GhosttyError`

```ts
class GhosttyError extends Error {
  readonly code: GhosttyErrorCode;                  // generated from GhosttyResult
  readonly functionName?: string;                   // which FFI function failed
}
```

### 4.7 Supporting types

```ts
type RGB = readonly [r: number, g: number, b: number];
type PaletteIndex = { palette: number };            // 0..255

type CursorStyle = "block" | "underline" | "bar";
type MouseTracking = "none" | "x10" | "normal" | "button" | "any";
type UnderlineStyle = "none" | "single" | "double" | "curly" | "dotted" | "dashed";

// ModeName and Key are string-literal unions generated at build time
// from vt.h (ModeTag and Key enums respectively). Enumerated in
// src/internal/generated.ts; re-exported via types.ts. Partial examples
// shown below for shape only — the authoritative list is the generated file.
type ModeName = "bracketed_paste" | "autorepeat" | "cursor_keys" /* ...generated */ ;
type Key      = "backspace" | "enter" | "char" /* ...generated */ ;

// Kitty keyboard protocol progressive-enhancement flags (CSI > ... u).
// Bits per the Kitty keyboard protocol spec.
interface KittyFlags {
  disambiguate?: boolean;
  reportEvents?: boolean;
  reportAlternates?: boolean;
  reportAllKeysAsEscapes?: boolean;
  reportAssociatedText?: boolean;
}

interface TerminalColors {
  fg: RGB;
  bg: RGB;
  cursor: RGB;
  palette: RGB[];                                   // length 256
}

interface CellStyle {
  fg?: RGB | PaletteIndex;
  bg?: RGB | PaletteIndex;
  bold: boolean;
  italic: boolean;
  underline: UnderlineStyle;
  underlineColor?: RGB;
  strikethrough: boolean;
  blink: boolean;
  inverse: boolean;
  invisible: boolean;
}

interface CellInfo {
  codepoint: number;
  wide: boolean;
  hasText: boolean;
  style?: CellStyle;
  hyperlinkUri?: string;
  protected: boolean;
}
```

`RGB` is a tuple rather than an object: lighter to pass across the FFI boundary, compact when marshaling a 256-entry palette, destructures naturally.

## 5. Internals

### 5.1 FFI layer

- `src/ffi.ts` calls `dlopen()` once on module load. All `ghostty_*` symbols the binding uses are declared in a single static symbol table.
- Library path resolution: `${packageDir}/prebuilds/${platform}/libghostty-vt.dylib` by default. Overridable by `GHOSTTY_VT_LIB` env var or `setLibraryPath()` before first class construction.
- Opaque C handles are `bun:ffi` pointers (`FFIType.ptr`), stored on classes as private `#handle` fields. Never exposed.

### 5.2 String marshaling

Inbound strings from libghostty (title, pwd, hyperlink_uri, etc.) are copied into JS `string` at the FFI boundary. The C API documents these as valid only until the next mutating call on the terminal; we never hand a borrowed pointer to the consumer.

### 5.3 Sized-struct ABI

libghostty's options structs use a sized-struct convention (`GHOSTTY_INIT_SIZED` macro): the first field is `size = sizeof(struct)`, used for forward-compatibility. A private helper `writeSizedStruct(tag, fields) → Uint8Array` encapsulates this. Consumers never see it.

Struct sizes are generated at build time from `vt.h` into `src/internal/generated.ts`.

### 5.4 Effect callbacks

Each `Terminal` instance registers three `JSCallback`s (one per enabled effect) during construction. Callbacks are synchronous and run inside `vtWrite()`.

Constraints documented in `TerminalOptions`:

- **Must not re-enter `vtWrite()`** on the same Terminal. libghostty is mid-parse; re-entry is undefined.
- **Must not throw.** Each trampoline wraps the user callback in `try/catch`. On throw, the trampoline logs via `console.error` and swallows. Exceptions cannot cross the C boundary.
- `onWritePty` receives a `Uint8Array` that is a view over libghostty-owned memory, valid only for the duration of the call. Consumers must copy if they need to retain.

Callback `JSCallback` lifetimes are bound to the Terminal; they are closed in `close()`.

### 5.5 Lifecycle

- All classes implement `Symbol.dispose`. `using term = new Terminal(...)` works.
- `close()` is idempotent: double-close is a safe no-op.
- No `FinalizationRegistry`. Its ordering guarantees are too weak for C-backed resources, and it encourages laziness about explicit cleanup.
- Dev-mode unclosed-handle leak detection is a post-v0 concern.

### 5.6 Errors

- Every FFI call whose C return is `GhosttyResult` is wrapped: on non-OK, throw `GhosttyError(code, functionName)`.
- `GhosttyErrorCode` is a string-literal union generated from `vt.h` (the `GhosttyResult` enum).
- Errors thrown from JSCallback trampolines are logged, not propagated (see §5.4).

### 5.7 Concurrency

Terminals are not thread-safe. One Terminal per Worker thread. Multiple Terminals in the same thread are independent. Documented in README.

### 5.8 Allocator

libghostty's default allocator is used (NULL → libc malloc/free on macOS). `ghostty_alloc`/`ghostty_free` are wrapped internally for future allocator-protocol callbacks; not exposed in v0.

## 6. Repo layout

```
ts-libghostty/
  package.json            # name: ts-libghostty, license: Apache-2.0, engines.bun >= 1.3.13
  tsconfig.json
  src/
    index.ts              # public re-exports
    ffi.ts                # dlopen + symbol table
    terminal.ts
    render-state.ts
    formatter.ts
    key-encoder.ts
    focus.ts
    errors.ts
    types.ts
    internal/
      sized-struct.ts
      marshal.ts
      generated.ts        # GENERATED from vt.h
  test/
    smoke/                # lifecycle + one-path-per-method
    fixtures/             # <name>.bin + <name>.expected.txt
    helpers/
  scripts/
    build-libghostty.sh   # clone ghostty @ pin, build dylib, install to prebuilds/
    gen-bindings.ts       # parse vt.h → generated.ts
    bump-ghostty.sh       # update pin + rebuild + regenerate + test + diff report
  prebuilds/
    darwin-arm64/
      libghostty-vt.dylib # shipped in npm tarball
  docs/
    superpowers/specs/    # design docs + plans
  .github/workflows/
    ci.yml
    release.yml
  README.md
  LICENSE
```

`vendor/` (Ghostty source checkout for local builds) is gitignored.

## 7. Build & distribution

### 7.1 Build pipeline

`package.json` carries a `ghostty.commit` field — the exact `ghostty-org/ghostty` SHA the current ts-libghostty version is bound to.

- `scripts/build-libghostty.sh`: clones that commit into `vendor/ghostty/`, runs Ghostty's Zig build to produce `libghostty-vt.dylib`, copies into `prebuilds/darwin-arm64/`.
- `scripts/gen-bindings.ts`: parses `vendor/ghostty/include/ghostty/vt.h` and emits `src/internal/generated.ts` containing: enum values (especially `GhosttyResult`, `ModeTag`, `Key`), struct sizes for sized-struct init, and a manifest of expected function symbols. Implementation is a focused TS parser over Ghostty's disciplined header style — not libclang.
- `generated.ts` is checked in. CI verifies it matches the pinned header by re-running the generator and failing on diff.

### 7.2 Distribution

Prebuilt `.dylib` ships in the npm tarball. `bun add ts-libghostty` gets a working install with no native build, no postinstall script.

Load-time resolution: `${packageDir}/prebuilds/${platform}/libghostty-vt.dylib` unless overridden.

## 8. Testing

Tier (b) from brainstorming: smoke + vendored fixtures.

- **Smoke tests**: per class, lifecycle + one positive path per public method. Fast, catches obvious regressions.
- **Fixture tests**: `test/fixtures/<scenario>.bin` byte stream + `<scenario>.expected.txt` (a `Formatter.formatString()` capture of the expected end state). Harness replays bytes through `vtWrite`, formats, diffs. On mismatch: unified diff, optional `--update-fixtures` flag.
- Initial corpus: hand-authored (hello world, cursor moves, 256-color ls, vim insert-mode, scrollback). Grows organically — every bug becomes a new fixture.
- Runner: `bun test`.

Conformance testing against `ghostty-org/ghostling` (tier c) is polish, post-v0.

## 9. Versioning & upstream pinning

- `0.x` while libghostty-vt is upstream-declared "work-in-progress." No SemVer across 0.x.
- `package.json` exposes `ghostty.commit` so consumers can see the exact pin.
- README carries a compatibility table: ts-libghostty version → Ghostty commit → Ghostty release tag.
- 1.0 triggers when libghostty-vt upstream declares API stability (Mitchell's ~6 months estimate, so likely Q4 2026). At 1.0 we adopt strict SemVer and publish typedoc'd reference.
- Platform expansion past `darwin-arm64` follows adoption signal: `linux-x64` is almost certainly tranche 1; others (`darwin-x64`, `linux-arm64`, `win-x64` on Bun's ConPTY) on demand.

## 10. Ghostty-bump process (manual at v0)

`scripts/bump-ghostty.sh <new-commit>`:

1. Update `ghostty.commit` in `package.json`.
2. Re-run `build-libghostty.sh` and `gen-bindings.ts`.
3. Report the diff in `generated.ts` (new / removed / renamed enum values, changed struct sizes, changed symbol manifest).
4. Run `bun test`.
5. Human reviews the diff, adapts binding code if needed, commits as a single "Bump ghostty to `<sha>`" commit with the generated.ts diff attached.

Semi-automation (a bot that opens a draft PR per new Ghostty commit with the diff pre-rendered) is a post-v0 nice-to-have.

## 11. Post-v0 roadmap

### Tranche 1 — after v0 ships stable (weeks)

- **Mouse encoder + event.** Triggered when a consumer needs mouse-driven TUIs. Requires deciding how Bun.Terminal surfaces mouse events from the child.
- **Paste helpers** (`ghostty_paste_is_safe`, `ghostty_paste_encode`). Triggered by verifying gap vs `Bun.Terminal`'s own paste handling.
- **`cellAt` hardening** — add `hyperlinkUri` return, tighten viewport/screen semantics based on real use.

### Tranche 2 — allocator-callback pattern (month+)

- **Query-response callbacks**: `ENQUIRY`, `XTVERSION`, `DEVICE_ATTRIBUTES`, `SIZE`, `COLOR_SCHEME`. All share a shape where libghostty invokes us and expects bytes back via its allocator. Getting one working establishes the pattern for the rest.
- Trigger criterion: a consumer needs to customize a specific response (the defaults libghostty emits via `WRITE_PTY` are adequate for most cases).

### Tranche 3 — once upstream settles

- **Kitty graphics**. Full surface: image store, placement iterator, virtual-placeholder rows. Wait until the March-2026 churn demonstrably stabilizes, likely after Ghostty's next release.

### Tranche 4 — demand-driven

- **OSC parser, SGR parser, Selection**. Only if an external consumer shows up with a real use case.
- **`build_info`, `sys` log callback**. Trivial. Ship when convenient.

### Graduating to 1.0

Triggered by libghostty-vt upstream declaring stable. Adopts strict SemVer, publishes typedoc reference, expands platforms based on demand.

## 12. Appendix — attribution

The shape of this binding is informed by:

- `ghostty-org/ghostty` — the source of `libghostty-vt`.
- `mitchellh/go-libghostty` — Mitchell's own Go binding; the primary reference for surface shape, option patterns, and effect-callback handling.
- `ghostty-org/ghostling` — a reference C consumer; canonical usage patterns.

The binding's API drops Go-specific idioms (tuple returns, opaque allocator plumbing) and favors TS-native patterns (throw, `Symbol.dispose`, options objects, iterators).
