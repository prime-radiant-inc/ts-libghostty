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

  // Memory bounds for parser buffers. Default to bounded values to protect
  // against hostile/large escape payloads even though Kitty graphics is
  // not exposed at v0. See §5.9.
  apcMaxBytes?: number;                            // default 1 MiB
  apcMaxBytesKitty?: number;                       // default 0 (disabled)

  // Synchronous effect callbacks; invoked inside vtWrite().
  // MUST NOT re-enter vtWrite() on this Terminal.
  // MUST NOT throw (exceptions are caught at the FFI boundary and logged).
  onWritePty?: (bytes: Uint8Array) => void;        // bytes are copied before callback; safe to retain
  onBell?: () => void;
  onTitleChanged?: (title: string) => void;        // title string is copied before callback
}

interface TerminalSnapshot {
  cols: number;
  rows: number;
  pixelWidth: number;                              // cols × cellPx.width, if cellPx configured
  pixelHeight: number;                             // rows × cellPx.height, if cellPx configured
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

  cellAt(pt: {
    x: number;
    y: number;
    coordinateSpace?: "active" | "viewport" | "screen" | "history";  // default "active"
  }): CellInfo | undefined;

  close(): void;
  [Symbol.dispose](): void;
}
```

Individual getters (`term.cols`, `term.title`, …) are deliberately **not** provided. Consumers use `snapshot()`. Rationale: avoid the footgun of per-iteration FFI calls in hot loops. Reconsider if real-world ergonomics suffer.

`cellAt` coordinate spaces differ in cost. `"active"` and `"viewport"` are O(1) lookups against the current screen/viewport; `"screen"` may walk wrapped rows; `"history"` touches scrollback and can be slow for deep scrollback. Document in README.

`onWritePty` and `onTitleChanged` receive data **copied** before the callback runs, so consumers can retain the values without coordination. A zero-copy borrowed variant may be offered post-v0 if the copy cost becomes measurable (it will not for typical query-response traffic).

### 4.2 `RenderState`, `RenderRow`, `RenderCell`

```ts
class RenderState implements Disposable {
  constructor();

  update(term: Terminal): void;                     // cheap; read-only on term
  dirty(): "none" | "rows" | "all";
  markClean(): void;                                // clear dirty state; update() does NOT clear
  colors(): TerminalColors;

  // Ergonomic path — one object allocation per row and cell per frame.
  rows(): IterableIterator<RenderRow>;
  forEachDirtyRow(cb: (row: RenderRow) => void): void;

  // Hot path — reuses one RenderCell object per invocation, fields mutated
  // per iteration. Callback must not retain the cell reference.
  forEachCell(
    row: RenderRow | number,
    cb: (cell: RenderCell) => void
  ): void;
  forEachDirtyCell(cb: (row: RenderRow, cell: RenderCell) => void): void;

  close(): void;
  [Symbol.dispose](): void;
}

interface RenderRow {
  y: number;
  wrapped: boolean;
  dirty: boolean;
  cells(): IterableIterator<RenderCell>;            // allocating iterator
}

interface RenderCell {
  x: number;
  text: string;                                     // the grapheme cluster; "" for blank
  wide: boolean;                                    // true for the first cell of a wide grapheme
  isWideContinuation: boolean;                      // true for the trailing cell of a wide grapheme; skip in text reconstruction
  style?: CellStyle;                                // undefined = default style
  hyperlinkUri?: string;
  protected: boolean;
}
```

**Dirty lifecycle.** `update()` refreshes the render state from the terminal but does **not** clear the dirty flags — consumers call `markClean()` after they have processed a frame. This mirrors the C API's behavior so multiple consumers (e.g., a renderer and a log-tailer) can observe independent dirty state if needed.

**Cell text model.** `text` is the full grapheme cluster at the cell, correctly handling combining marks, variation selectors, emoji ZWJ sequences, and East-Asian wide characters. A single codepoint-only view is deliberately not offered — it would be lossy in a way that's painful to fix later. If the allocation cost of per-cell strings becomes measurable, add an escape hatch (e.g., `forEachCellCodepoints` returning a `Uint32Array` view of simple single-codepoint runs) in a later tranche.

**Wide grapheme continuation.** When a grapheme is double-width (CJK, some emoji), the primary cell carries `wide: true` and `text` has the grapheme; the following cell carries `isWideContinuation: true` and empty `text`. Text reconstruction loops should skip continuation cells.

**Object lifetimes.** Objects returned from `rows()` / `cells()` / `forEachDirtyRow()` are snapshots valid until the next `update()`. The `RenderCell` passed to `forEachCell()` / `forEachDirtyCell()` is valid **only for the duration of that single callback invocation** — fields mutate before the next cell. Retaining either past its window is undefined behavior. Document prominently in README.

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

`formatString()` is a UTF-8 decode of `format()`. For `"plain"` and `"html"` this is the expected string form. For `"vt"`, the output is raw escape bytes; decoding as a JS string is a convenience (e.g., for logging) but not a structured representation. Use `format()` when you intend to replay bytes into another terminal.

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

**Mod defaults.** Any boolean field of `Mods` or `consumedMods` that is missing or `undefined` is treated as `false`. Omitted `mods` and `consumedMods` themselves are equivalent to all-false.

### 4.5 Standalone

```ts
function encodeFocus(direction: "in" | "out"): Uint8Array;
```

### 4.6 Error hierarchy

```ts
// Base class for everything ts-libghostty throws.
class GhosttyError extends Error {
  readonly code: GhosttyErrorCode;                  // generated from GhosttyResult
  readonly functionName?: string;                   // which FFI function failed
}

// Library could not be located on disk (bundled prebuild missing or
// GHOSTTY_VT_LIB points to a nonexistent path).
class LibraryNotFoundError extends GhosttyError {
  readonly searchedPaths: string[];
}

// Running on a platform we have no prebuild for, and no override set.
class UnsupportedPlatformError extends GhosttyError {
  readonly detectedPlatform: string;                // e.g. "linux-x64"
  readonly supportedPlatforms: string[];            // e.g. ["darwin-arm64"]
}

// Loaded library's ABI does not match what this ts-libghostty build
// expects: missing symbol, enum sentinel mismatch, struct-size mismatch,
// or build_info identity disagreement.
class LibraryCompatibilityError extends GhosttyError {
  readonly expectedCommit?: string;
  readonly actualCommit?: string;
  readonly details: string;
}

// Operation attempted on a closed handle. Caught in TS before FFI.
class UseAfterCloseError extends GhosttyError {
  readonly handleType: string;                      // e.g. "Terminal"
}
```

All binding-level errors extend `GhosttyError` so a single `catch (e: GhosttyError)` works. Concrete subclasses let consumers discriminate (e.g., retry logic for `LibraryNotFoundError` with an override path).

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
  // Colors currently applied after any OSC 10/11/12/104/110/111/112 overrides
  // from the running program. Entries are undefined when unset.
  effective: {
    fg?: RGB;
    bg?: RGB;
    cursor?: RGB;
  };
  // The configured defaults the terminal would use absent any OSC override.
  // Entries are undefined when unset by the consumer.
  defaults: {
    fg?: RGB;
    bg?: RGB;
    cursor?: RGB;
  };
  // The 256-entry palette used for palette-indexed cell colors. Always present.
  palette: RGB[];                                   // length 256
}

// Logical SGR state as libghostty tracks it — not render-resolved color.
// (Render-resolved output requires combining this with TerminalColors; that
// combination is the consumer's responsibility in v0.)
interface CellStyle {
  fg?: RGB | PaletteIndex;
  bg?: RGB | PaletteIndex;
  bold: boolean;
  faint: boolean;                                   // SGR 2 — distinct from bold
  italic: boolean;
  underline: UnderlineStyle;
  underlineColor?: RGB;
  overline: boolean;                                // SGR 53
  strikethrough: boolean;
  blink: boolean;
  inverse: boolean;
  invisible: boolean;
}

interface CellInfo {
  text: string;                                     // grapheme cluster; "" if blank
  wide: boolean;
  isWideContinuation: boolean;
  style?: CellStyle;
  hyperlinkUri?: string;
  protected: boolean;
}
```

`RGB` is a tuple rather than an object: lighter to pass across the FFI boundary, compact when marshaling a 256-entry palette, destructures naturally.

**`TerminalColors` semantics.** `effective` reflects the current displayed colors after any OSC overrides from the running program; `defaults` reflects the baseline configured colors. Fields are `undefined` when upstream reports the color as unset (rather than flattening to a placeholder). `setColors(patch)` mutates `defaults`. Whether an OSC override survives a `setColors` call is **pending implementation-time verification** against the C API — document the observed behavior in the README once confirmed; fall back to "setColors clears OSC overrides" if upstream offers no way to preserve them.

**`CellStyle` semantics.** This is libghostty's logical SGR state — what escape sequences have been applied. Consumers rendering "final" colors must combine it with `TerminalColors` (palette lookup, default substitution, inverse). Field list is audited against `GhosttyStyle`; additions land via the normal Ghostty-bump process.

## 5. Internals

### 5.1 FFI layer

- **Lazy dlopen.** `src/ffi.ts` does not `dlopen()` on module import. It resolves the library path and opens the shared library on first native use (first class construction or first call into a free function like `encodeFocus`). This means importing `ts-libghostty` for type-only reasons — or on a platform we don't ship a prebuild for — does not immediately fail.
- **Library path resolution** (in priority order): explicit `setLibraryPath(path)` call made before first use; then `GHOSTTY_VT_LIB` environment variable; then the bundled `${packageDir}/prebuilds/${platform}/libghostty-vt.dylib`. If none resolves, throw `LibraryNotFoundError` with the searched paths.
- **`setLibraryPath()` lifecycle.** Settable until first native use. After load, calls throw `LibraryCompatibilityError` naming the path already loaded.
- **`libraryInfo()` / `isLoaded()`.** Cheap diagnostics returning path, whether loaded, and (once loaded) the upstream `build_info` identity. Do not trigger load.
- **Symbol manifest.** `src/internal/generated.ts` carries a complete list of every `ghostty_*` symbol the binding depends on. On load, every listed symbol is resolved up front; a missing symbol throws `LibraryCompatibilityError` naming the symbol. This converts a runtime crash ("function pointer is null") into a typed startup error.
- **Handles.** Opaque C handles are `bun:ffi` pointers (`FFIType.ptr`), stored on classes as private `#handle` fields. Never exposed.

### 5.2 String marshaling

Inbound strings from libghostty (title, pwd, hyperlink_uri, etc.) are copied into JS `string` at the FFI boundary. The C API documents these as valid only until the next mutating call on the terminal; we never hand a borrowed pointer to the consumer.

### 5.3 Struct layout & sized-struct ABI

**Layout is authored by a compiler probe, not by parsing.** C struct size, alignment, and field offsets depend on the target ABI — `size_t` width, `bool` width, enum width, alignment rules, and padding. Hand-parsing `vt.h` in TS is too fragile. Instead, `scripts/probe-layout.c` is a tiny C program compiled against the pinned Ghostty headers; it runs at build time and emits `sizeof` / `alignof` / `offsetof` for every struct and union the binding reads or writes. The output is merged into `src/internal/generated.ts` alongside the TS-parsed enum values and symbol manifest.

The probe runs per target triple. A probe built for `darwin-arm64` describes the layout for `darwin-arm64` only; each prebuild gets its own probe output.

**Sized-struct convention is not universal.** Some libghostty options structs use the `GHOSTTY_INIT_SIZED` macro (first field is `size = sizeof(struct)`, used for forward-compat versioning); others use plain struct layout. The generator describes each concrete struct individually rather than assuming a universal pattern. A private helper `writeSizedStruct(tag, fields) → Uint8Array` handles the sized variants; a different helper handles plain structs. Consumers never see either.

### 5.4 Effect callbacks

Each `Terminal` instance registers three `JSCallback`s (one per enabled effect) during construction. Callbacks are synchronous and run inside `vtWrite()`.

Constraints documented in `TerminalOptions`:

- **Must not re-enter `vtWrite()`** on the same Terminal. libghostty is mid-parse; re-entry is undefined.
- **Must not throw.** Each trampoline wraps the user callback in `try/catch`. On throw, the trampoline logs via `console.error` and swallows. Exceptions cannot cross the C boundary.

**Data lifetime — user-facing guarantee:** everything handed to a user callback is safe to retain past the callback's return. This is achieved as follows inside each trampoline:

- `onWritePty`: the trampoline allocates a fresh `Uint8Array` and copies libghostty's borrowed buffer into it before invoking the user callback. A zero-copy variant may be added in a later tranche if the copy cost becomes measurable (unlikely — typical traffic here is small query-response bytes, not bulk output).
- `onTitleChanged`: the trampoline reads the current title via the C accessor (or the callback parameter, depending on what upstream provides — verified during Pass 1) and copies it into a JS string before invoking the user callback. The user receives a `string` they can retain.
- `onBell`: no payload.

Callback `JSCallback` lifetimes are bound to the Terminal; they are closed in `close()`.

### 5.5 Lifecycle

- All classes implement `Symbol.dispose`. `using term = new Terminal(...)` works.
- `close()` is idempotent: double-close is a safe no-op.
- **Use-after-close** is caught in TS before any FFI call. Every public method checks `#handle !== null` and throws `UseAfterCloseError` on violation. This prevents null-pointer dereferences from crashing the process.
- No `FinalizationRegistry`. Its ordering guarantees are too weak for C-backed resources, and it encourages laziness about explicit cleanup.
- Dev-mode unclosed-handle leak detection is a post-v0 concern.

### 5.6 Errors

- Every FFI call whose C return is `GhosttyResult` is wrapped: on non-OK, throw `GhosttyError(code, functionName)`.
- `GhosttyErrorCode` is a string-literal union generated from `vt.h` (the `GhosttyResult` enum).
- Errors thrown from JSCallback trampolines are logged, not propagated (see §5.4).
- Binding-level failures (library not found, symbol missing, ABI mismatch, unsupported platform, use-after-close) throw the concrete subclasses listed in §4.6. Consumers can catch the base `GhosttyError` or discriminate by subclass.

### 5.7 Concurrency

Terminals are not thread-safe. One Terminal per Worker thread. Multiple Terminals in the same thread are independent. Documented in README.

### 5.8 Allocator

libghostty's default allocator is used (NULL → libc malloc/free on macOS). `ghostty_alloc`/`ghostty_free` are wrapped internally for future allocator-protocol callbacks; not exposed in v0.

### 5.9 Memory safety for non-exposed subsystems

Even though Kitty graphics is out of scope for v0, libghostty's VT parser still recognizes Kitty/APC escape sequences when they appear in the input stream. An untrusted child process could emit a large APC payload; without bounds, libghostty may allocate proportionally.

**Defaults on `Terminal` construction:**

- `apcMaxBytes`: default 1 MiB (1 048 576). Configurable via `TerminalOptions`.
- `apcMaxBytesKitty`: default 0 (disabled). Configurable via `TerminalOptions`.
- Kitty image storage disabled until Tranche 3 exposes the public surface. The binding sets this internally at construction.

These defaults apply the recently-added upstream APC limit knobs (see Cartograph-Prime's survey — landed days before this spec was written). The Pass 1 implementation verifies the exact C API name and wiring.

A fixture test feeds a ≥10 MiB APC-payload byte stream and asserts process memory does not grow proportionally. This is a v0 gate, not polish.

## 6. Repo layout

```
ts-libghostty/
  package.json            # name: ts-libghostty, license: Apache-2.0, engines.bun >= 1.3.13
  tsconfig.json
  src/
    index.ts              # public re-exports
    ffi.ts                # lazy dlopen + symbol table
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
      generated.ts        # GENERATED — enum values, symbol manifest, struct layout
  test/
    smoke/                # lifecycle + one-path-per-method
    fixtures/             # <name>.bin + <name>.expected.txt + <name>.expected.json (metadata)
    tarball/              # packed-tarball install smoke tests
    helpers/
  scripts/
    build-libghostty.sh   # clone ghostty @ pin, build dylib, install to prebuilds/
    probe-layout.c        # compile-on-target probe — emits struct sizes/offsets/alignments
    gen-bindings.ts       # parse vt.h for names/symbols + merge probe output → generated.ts
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
  LICENSE                 # Apache-2.0 — ts-libghostty's own code
  LICENSE_GHOSTTY         # MIT — upstream Ghostty, shipped with prebuilt .dylib
```

`vendor/` (Ghostty source checkout for local builds) is gitignored.

## 7. Build & distribution

### 7.1 Build pipeline

`package.json` carries a `ghostty.commit` field — the exact `ghostty-org/ghostty` SHA the current ts-libghostty version is bound to.

Build steps, in order:

1. **`scripts/build-libghostty.sh`** — clones the pinned commit into `vendor/ghostty/`, runs Ghostty's Zig build to produce `libghostty-vt.dylib`, copies into `prebuilds/darwin-arm64/`.
2. **`scripts/probe-layout.c`** — compiled against `vendor/ghostty/include/ghostty/vt.h` on the current target, executed, and its output (sizes/alignments/offsets for every struct the binding touches) captured.
3. **`scripts/gen-bindings.ts`** — parses the header for enum values (`GhosttyResult`, `ModeTag`, `Key`, etc.) and the expected function-symbol manifest, then merges in the probe output, and emits `src/internal/generated.ts`.
4. **CI verification** — re-runs steps 2 and 3 and fails if `generated.ts` has any diff against the checked-in copy.

`generated.ts` is checked in so consumers cloning the repo do not need to run the generator; CI enforces that it matches the pinned header + probe output.

### 7.2 Distribution

The npm tarball contains: TypeScript source, compiled `dist/`, `prebuilds/darwin-arm64/libghostty-vt.dylib`, `LICENSE` (Apache-2.0, for ts-libghostty's own code), and `LICENSE_GHOSTTY` (the upstream MIT license text, required because the tarball redistributes a compiled Ghostty artifact).

`bun add ts-libghostty` gets a working install with no native build and no postinstall script. Load-time resolution follows §5.1.

README framing: **unofficial community binding** until/unless Ghostty upstream explicitly blesses it. On an unsupported platform the binding throws `UnsupportedPlatformError` with: detected platform/arch, supported platforms list, and the `GHOSTTY_VT_LIB` override instruction.

## 8. Testing

Runner: `bun test`. v0 test suite has the following gates, all required for a release.

**Smoke**

- Per-class lifecycle + one positive path per public method.
- **ABI smoke**: load the bundled dylib, verify every declared symbol resolves, verify each struct size/alignment/offset matches the probe output, construct and `close()` one handle of each type.

**Tarball smoke**

- `bun pm pack` the package, install the resulting tarball into a fresh temp project outside the repo, run a minimal script that constructs a `Terminal`, feeds a byte stream through `vtWrite`, formats, and asserts output. Catches "works in repo, breaks on install" bugs (wrong file list, dylib-path resolution, etc.).

**Formatter-output fixtures**

- `test/fixtures/<scenario>.bin` byte stream + `<scenario>.expected.txt` (captured `Formatter.formatString()` output).
- Harness replays bytes through `vtWrite`, formats, diffs. Unified diff on mismatch; `--update-fixtures` regenerates.

**Render-state metadata fixtures**

- `<scenario>.expected.json` describing expected cell-level state: grapheme text, wide/continuation flags, style bits, hyperlink URIs, cursor position/visibility/style, alternate-screen state, scrollback row count.
- Harness compares `RenderState.forEachCell` output against the JSON.
- **Rationale:** formatter-text fixtures alone can hide bugs where the formatter and the terminal agree on the same wrong representation. Metadata fixtures assert directly on render-state.

**Key-encoder goldens**

- Table of `{KeyEvent, encoder mode state} → expected bytes`. Covers: ASCII keys, Alt variants, Ctrl combinations, cursor keys (normal + application), keypad (normal + application), function keys, Kitty keyboard-protocol progressive-enhancement levels, modifyOtherKeys levels, backarrow behavior, IME/compose events with consumed modifiers, release and repeat actions.

**Effect-callback behavior**

- `onWritePty` receives correct bytes for induced query responses (DA, DSR, cursor-position report, etc.).
- `onTitleChanged` receives title on OSC 0/2, `onBell` on `\a`.
- Throwing from a user callback does not crash the process; error is logged.
- After callbacks return, retained values (bytes / title) remain valid (validates the copy-before-invoke guarantee).

**Malformed-input resilience**

- Random byte fuzz (bounded, not exhaustive) through `vtWrite`: no JS exception, no crash.
- Large APC payload (≥10 MiB single escape) stays within `apcMaxBytes` bound; process memory does not grow proportionally.
- Malformed OSC, unterminated DCS, truncated CSI — no crash, process continues.

**Real-program captures**

- Short captured byte streams from: bash prompt with `ls --color`, `vim` entering alternate screen, a TUI that issues DA/DSR queries, a scrollback-heavy session. Each has both `.expected.txt` and `.expected.json`.

**Growth policy.** Every bug fixed becomes a new fixture before the fix ships. Conformance testing against `ghostty-org/ghostling` (tier c from brainstorming) remains post-v0 polish.

## 9. Versioning & upstream pinning

- `0.x` while libghostty-vt is upstream-declared "work-in-progress." No SemVer across 0.x.
- `package.json` exposes `ghostty.commit` so consumers can see the exact pin.
- README carries a compatibility table: ts-libghostty version → Ghostty commit → Ghostty release tag.
- 1.0 triggers when libghostty-vt upstream declares API stability (Mitchell's ~6 months estimate, so likely Q4 2026). At 1.0 we adopt strict SemVer and publish typedoc'd reference.
- Platform expansion past `darwin-arm64` follows adoption signal: `linux-x64` is almost certainly tranche 1; `darwin-x64` and `linux-arm64` on demand. Windows is not on the roadmap until `Bun.Terminal`'s ConPTY support stabilizes out of canary and a real consumer needs it.

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
- **KeyEvent dev-mode validation.** Throw in development when required fields are missing for a given `action`/`key` combination (e.g., `key: "char"` without `utf8` or `unshiftedCodepoint`). No-op in production. Helpful for consumers once real usage surfaces common mistakes.
- **Zero-copy `onWritePty` variant.** Only if the default-copy cost shows up in profiles.

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

## 12. Appendix — attribution & revision history

The shape of this binding is informed by:

- `ghostty-org/ghostty` — the source of `libghostty-vt`.
- `mitchellh/go-libghostty` — Mitchell's own Go binding; the primary reference for surface shape, option patterns, and effect-callback handling.
- `ghostty-org/ghostling` — a reference C consumer; canonical usage patterns.

The binding's API drops Go-specific idioms (tuple returns, opaque allocator plumbing) and favors TS-native patterns (throw, `Symbol.dispose`, options objects, iterators).

### Revision history

- **2026-04-22** — Initial spec written.
- **2026-04-22 (revision)** — Revised in response to external review (Codex). Material changes:
  - Lazy library loading with `setLibraryPath` lifecycle clarified (§5.1).
  - ABI compatibility check elevated to v0 requirement: symbol manifest verified at load, struct layout from a compiled probe rather than TS regex (§5.1, §5.3, §7.1).
  - `RenderCell.codepoint` replaced with `text: string` (grapheme cluster) + `isWideContinuation` (§4.2).
  - Render-state hot path added via `forEachCell` / `forEachDirtyCell` with reused cell objects; `markClean()` exposed (§4.2).
  - `TerminalColors` split into `effective` / `defaults` / `palette` with `undefined` for unset values (§4.7).
  - `CellStyle` gained `faint` and `overline`; documented as logical SGR state (§4.7).
  - `onWritePty` and `onTitleChanged` data copied before user callback — safe to retain (§4.1, §5.4).
  - New error subclasses: `LibraryNotFoundError`, `UnsupportedPlatformError`, `LibraryCompatibilityError`, `UseAfterCloseError` (§4.6).
  - APC/Kitty memory bounds set by default to neutralize non-exposed subsystems (§5.9).
  - `cellAt` coordinate space expanded to `"active" | "viewport" | "screen" | "history"` (§4.1).
  - Testing gates expanded to include ABI smoke, tarball smoke, render-metadata fixtures, key-encoder goldens, effect tests, malformed-input resilience, real-program captures (§8).
  - Upstream MIT license shipped alongside Apache-2.0 in the tarball (§6, §7.2).
  - Windows removed from roadmap; unofficial-community-binding framing added to README (§7.2, §9).
