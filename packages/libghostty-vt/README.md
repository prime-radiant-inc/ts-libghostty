# libghostty-vt

**Unofficial community TypeScript binding** over [libghostty-vt](https://github.com/ghostty-org/ghostty), the VT state machine from [Ghostty](https://ghostty.org). For Bun.

> **Status:** pre-1.0, API unstable. This binding tracks a pinned Ghostty commit
> and is published for experimentation. There is no guarantee of semver across
> 0.x releases. This package is not affiliated with or endorsed by the Ghostty
> project.

## Install

```bash
bun add libghostty-vt
```

## Supported platforms

- macOS arm64 (Apple Silicon)
- Linux x64 (glibc and musl)
- Linux arm64 (glibc and musl)

All five prebuilds ship in the npm tarball. The library auto-detects glibc vs musl on Linux at runtime.

**Override the bundled binary** by setting `GHOSTTY_VT_LIB` (the main library) and/or `GHOSTTY_VT_SHIM_LIB` (the portability shim) before importing. The two libraries must be co-located in the same directory if either is overridden — the shim's runtime dependency on `libghostty-vt` is resolved relative to the shim's own directory.

Windows is not supported.

## Minimal example

```typescript
import { Terminal, Formatter } from "libghostty-vt";

using term = new Terminal({ cols: 80, rows: 24 });
term.vtWrite(new TextEncoder().encode("hello, world\r\n"));

using fmt = new Formatter({ format: "plain" });
console.log(fmt.formatString(term));
```

## Effect callbacks

Three synchronous effect callbacks are exposed as `Terminal` constructor options. They are invoked inside `vtWrite()` when libghostty processes the corresponding VT sequence.

```typescript
import { Terminal } from "libghostty-vt";

using term = new Terminal({
  cols: 80,
  rows: 24,
  onWritePty: (bytes) => { /* query responses to send back to the pty */ },
  onBell: () => { /* BEL (0x07) */ },
  onTitleChanged: (title) => { /* OSC 0 / OSC 2 */ },
});
```

**Constraints:**

- Callbacks MUST NOT call any **mutating** method on the same Terminal from inside the callback: `vtWrite`, `resize`, `reset`, `setMode`, `close`, `[Symbol.dispose]`. libghostty is mid-parse; mutating the same Terminal corrupts or frees state the parser still references. The binding detects this and throws a typed `GhosttyError` with code `"invalid_value"` naming the forbidden method — defer with `queueMicrotask` or `setTimeout` to perform the mutation after `vtWrite()` returns. Read-only methods (`snapshot`, `mode`) are explicitly allowed. If your callback doesn't catch this throw, it's logged via `console.error` and swallowed like any other uncaught callback exception, and `vtWrite` returns normally. Catch it in your callback if you want a hard failure instead.
- Callbacks MUST NOT throw. Exceptions are caught at the FFI boundary and logged via `console.error`; they cannot cross the C frame.
- Callbacks SHOULD NOT block. The call is synchronous inside `vtWrite()`.

**Data ownership** — values handed to your callback are JS-owned copies:

- `onWritePty`: the `bytes` Uint8Array is a fresh copy of libghostty's borrowed buffer. Safe to retain.
- `onTitleChanged`: the `title` string is a JS string. Safe to retain.

The other five effect-shaped callbacks exposed by the C API (`ENQUIRY`, `XTVERSION`, `SIZE`, `COLOR_SCHEME`, `DEVICE_ATTRIBUTES`) are query-response shapes that return data into libghostty's allocator — deferred until the allocator-callback pattern is established.

## API surface

- `Terminal` — construction, `vtWrite`, `resize`, `reset`, `snapshot`, `mode`/`setMode`, lifecycle (`close`, `using`), effect callbacks (`onWritePty`, `onBell`, `onTitleChanged`), `scrollViewport`, `colors`/`setColors`, `cellAt`, APC bounds (`apcMaxBytes`, `apcMaxBytesKitty`), `renderToAnsiRect`.
- `RenderState` — `update(term)` snapshot then iterate rows/cells. Dual iterator shape:
  - Ergonomic: `rows()`, `row.cells()`, `forEachDirtyRow(cb)` allocate fresh objects per iteration, snapshot lifetime valid until next `update()`.
  - Hot path: `forEachCell(row, cb)` / `forEachDirtyCell(cb)` reuse a single mutable `RenderCell` across the walk — the callback **must not retain the reference**. Mutate your own buffer if you need to retain cell data past the callback.
  - `dirty()` / `markClean()` — dirty tracking (both libghostty-native and JS-cached). `markClean()` performs a native clear (one call) then mirrors to JS; multiple consumers can each call it on independent cadences.
  - `colors()` — view of libghostty's current render-state colors.
  - `cursor()` — viewport cursor position (`x`, `y`, `visible`, `wideTail`), distinct from `Terminal.snapshot().cursor` (which tracks the live cursor regardless of viewport scroll).
  - `toAnsiRect(dest, opts)` / `cursorInRect(dest)` / `size()` — composition surface for painting the cell grid into a destination rectangle on a host terminal.
- `KeyEncoder` + `KeyEvent` — keystroke encoding (Kitty keyboard protocol, application/normal cursor-key modes). Bound or standalone. See *Keyboard input encoding* below.
- `encodeFocus("in" | "out")` — standalone function, returns fresh `Uint8Array`.
- `Formatter` — `plain`/`vt`/`html` dumps of a Terminal's current screen.
- `GhosttyError` + subclasses: `LibraryNotFoundError`, `UnsupportedPlatformError`, `LibraryCompatibilityError`, `UseAfterCloseError`, `RectSizeMismatch`, `EncodeError`.
- `setLibraryPath` / `setShimLibraryPath` / `isLoaded` / `libraryInfo` for diagnostics and out-of-tree library paths. `libraryInfo()` reports both `path` (main) and `shimPath`.

Remaining roadmap items (mouse encoder, paste helpers, Kitty graphics, query-response callbacks) are tranched post-v0.

### `cellAt` coord-space cost

`Terminal.cellAt({x, y, coordinateSpace?})` supports four coord spaces with different costs. Out-of-bounds returns `undefined`, not a throw.

| coord space | cost | notes |
|---|---|---|
| `"active"` (default) | O(1) | cells visible in the active screen |
| `"viewport"` | O(1) | cells visible in the current viewport (= active if not scrolled) |
| `"screen"` | O(row) | full screen including wrapped rows |
| `"history"` | O(depth) | scrollback only; touches storage |

### `RenderState` iterator contract

Objects returned from `rows()`, `row.cells()`, `forEachDirtyRow(cb)`, and the `RenderRow` passed to `forEachDirtyCell(cb)` are **snapshots valid until the next `update()` call**. The mutable `RenderCell` passed to `forEachCell(row, cb)` and `forEachDirtyCell(cb)` is valid **only for the duration of the single callback invocation** — fields mutate before the next cell iteration.

Retaining either past its window is undefined behavior.

### `markClean()` semantics

libghostty tracks dirty state at both a global and per-row level. `markClean()` clears both native layers in one `ghostty_render_state_set(OPTION_DIRTY, FALSE)` call, then mirrors the clear into the JS-side cache. Multiple consumers (renderer + log-tailer, etc.) can call `markClean()` on independent cadences — double-clearing libghostty's internal flags is harmless. If you skip `markClean()` after processing a frame, subsequent `update()` calls will continue to report the previous dirty state.

### OSC color-override behavior

OSC 10/11/12 color overrides set by the running program **are preserved across `Terminal.setColors(patch)` calls**. Consumers relying on OSC overrides do not need to re-emit them after `setColors`.

## Keyboard input encoding

`KeyEncoder` converts structured `KeyEvent` objects into VT byte
sequences. Encoder output is mode-aware — it respects DECCKM
cursor-key mode, Kitty keyboard protocol flags, and other state.

````typescript
import { Terminal, KeyEncoder } from "libghostty-vt";

using term = new Terminal({ cols: 80, rows: 24 });
using enc = new KeyEncoder({ terminal: term });

// Bound to a Terminal: each encode() syncs options from term first,
// so live mode changes are picked up automatically.
const ctrlC = enc.encode({ key: "KeyC", mods: { ctrl: true }, utf8: "c", unshiftedCodepoint: 0x63 });
// → Uint8Array [0x03]

const arrowUp = enc.encode({ key: "ArrowUp" });
// → Uint8Array [0x1b, 0x5b, 0x41]  (ESC [ A — normal mode)

term.vtWrite(new TextEncoder().encode("\x1b[?1h"));   // app sends DECCKM on
const arrowUp2 = enc.encode({ key: "ArrowUp" });
// → Uint8Array [0x1b, 0x4f, 0x41]  (ESC O A — application mode)
````

`KeyEvent.utf8` carries the unmodified character (e.g., `"c"` for
Ctrl+C). The encoder derives modifier byte sequences from the logical
key and mods bitmask; `utf8` MUST NOT contain C0 controls or macOS
PUA function-key codepoints — pass `utf8` undefined in those cases
and let the encoder use the logical key. Violations throw
`EncodeError` with code `"invalid_utf8"`.

For consumers who don't have (or want) a `Terminal`, the standalone
form takes options directly:

````typescript
using enc = new KeyEncoder({
  options: {
    cursorKeyMode: "application",
    kittyFlags: 0b00001,
  },
});
````

## License

- `libghostty-vt` code: Apache-2.0 — see [LICENSE](./LICENSE).
- Redistributed `libghostty-vt.dylib` binary in `prebuilds/`: MIT, per upstream Ghostty at the pinned commit — see [LICENSE_GHOSTTY](./LICENSE_GHOSTTY).

## Pinned Ghostty

The installed package is bound to a specific Ghostty commit. You can inspect it programmatically:

```typescript
import { pinnedCommit, libraryInfo } from "libghostty-vt";
console.log("pinned commit:", pinnedCommit);
console.log("library info:", libraryInfo());
```

## Overriding the library path

Point the binding at a local libghostty-vt build:

```bash
export GHOSTTY_VT_LIB=/path/to/libghostty-vt.dylib
```

Or at runtime before first native use:

```typescript
import { setLibraryPath } from "libghostty-vt";
setLibraryPath("/path/to/libghostty-vt.dylib");
```

**The loaded library's ABI must be compatible with the pinned Ghostty commit.** The binding verifies compatibility through three channels: (1) every required FFI symbol must resolve at load time or `LibraryCompatibilityError` is thrown; (2) the checked-in struct layouts (`src/internal/generated.ts`) must match the probe output for the pinned headers, and the ABI smoke test additionally cross-checks them against `ghostty_type_json()` at runtime; (3) `ghostty_build_info(GHOSTTY_BUILD_INFO_VERSION_STRING)` must return the expected semver string (e.g. `0.1.0-dev`) — mismatch raises `LibraryCompatibilityError`. Note that `ghostty_build_info` returns **semver, not a git commit SHA** at this pin; we cannot cryptographically verify the dylib was built from our pinned commit via the C API alone. If upstream later exposes a commit SHA via `ghostty_build_info` or similar, this guarantee narrows accordingly. Until then, override libraries are best-effort — a library built from a compatible commit that happens to resolve all required symbols and match the expected semver can still disagree on enum values or callback shapes, with undefined runtime behavior.

## About

Copyright 2026 Prime Radiant  
[https://primeradiant.com](https://primeradiant.com)
