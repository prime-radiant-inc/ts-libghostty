# ts-libghostty-vt

**Unofficial community TypeScript binding** over [libghostty-vt](https://github.com/ghostty-org/ghostty), the VT state machine from [Ghostty](https://ghostty.org). For Bun.

> **Status:** pre-1.0, API unstable. This binding tracks a pinned Ghostty commit
> and is published for experimentation. There is no guarantee of semver across
> 0.x releases. This package is not affiliated with or endorsed by the Ghostty
> project.

## Install

```bash
bun add ts-libghostty-vt
```

**Platforms (Pass 1):** `darwin-arm64` only. The current FFI layer relies on AAPCS64 register-split rules for passing Ghostty's by-value struct arguments without a C shim. Other platforms (Linux x64, darwin-x64, Windows) are on the roadmap — adding them will likely require a small C shim to bridge the struct-by-value boundary. See the design spec in the [source repository](https://github.com/prime-radiant-inc/ts-libghostty-vt) under `docs/superpowers/specs/`.

**APC tuning (Pass 1):** this release does not expose `apc_max_bytes` / `apc_max_bytes_kitty` tuning. The terminal uses upstream libghostty-vt defaults. Pass 2+ will add post-construction setters — `Terminal.setApcMaxBytes(n)` and `Terminal.setApcMaxBytesKitty(n)` — wrapping `ghostty_terminal_set(term, GHOSTTY_TERMINAL_OPT_APC_MAX_BYTES, ...)` if user demand surfaces.

## Minimal example

```typescript
import { Terminal, Formatter } from "ts-libghostty-vt";

using term = new Terminal({ cols: 80, rows: 24 });
term.vtWrite(new TextEncoder().encode("hello, world\r\n"));

using fmt = new Formatter({ format: "plain" });
console.log(fmt.formatString(term));
```

## Effect callbacks

Pass 2 adds three synchronous effect callbacks as `Terminal` constructor options. They are invoked inside `vtWrite()` when libghostty processes the corresponding VT sequence.

```typescript
import { Terminal } from "ts-libghostty-vt";

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

## API surface (Pass 1 + 2)

- `Terminal` — construction, `vtWrite`, `resize`, `reset`, `snapshot`, `mode`/`setMode`, lifecycle (`close`, `using`), **effect callbacks (`onWritePty`, `onBell`, `onTitleChanged`)**.
- `Formatter` — `plain`/`vt`/`html` dumps of a Terminal's current screen.
- `GhosttyError` + subclasses (`LibraryNotFoundError`, `UnsupportedPlatformError`, `LibraryCompatibilityError`, `UseAfterCloseError`).
- `setLibraryPath` / `isLoaded` / `libraryInfo` for diagnostics and out-of-tree library paths.

`RenderState` (per-cell grid reading), `KeyEncoder`, and polish features (modes beyond the simple get/set, color get/set, viewport scroll, `cellAt`) are on the roadmap for Passes 3–5.

## License

- `ts-libghostty-vt` code: Apache-2.0 — see [LICENSE](./LICENSE).
- Redistributed `libghostty-vt.dylib` binary in `prebuilds/`: MIT, per upstream Ghostty at the pinned commit — see [LICENSE_GHOSTTY](./LICENSE_GHOSTTY).

## Pinned Ghostty

The installed package is bound to a specific Ghostty commit. You can inspect it programmatically:

```typescript
import { pinnedCommit, libraryInfo } from "ts-libghostty-vt";
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
import { setLibraryPath } from "ts-libghostty-vt";
setLibraryPath("/path/to/libghostty-vt.dylib");
```

**The loaded library's ABI must be compatible with the pinned Ghostty commit.** Pass 1 verifies compatibility through three channels: (1) every required FFI symbol must resolve at load time or `LibraryCompatibilityError` is thrown; (2) the checked-in struct layouts (`src/internal/generated.ts`) must match the probe output for the pinned headers, and the ABI smoke test additionally cross-checks them against `ghostty_type_json()` at runtime; (3) `ghostty_build_info(GHOSTTY_BUILD_INFO_VERSION_STRING)` must return the expected semver string (e.g. `0.1.0-dev`) — mismatch raises `LibraryCompatibilityError`. Note that `ghostty_build_info` returns **semver, not a git commit SHA** at this pin; we cannot cryptographically verify the dylib was built from our pinned commit via the C API alone. If upstream later exposes a commit SHA via `ghostty_build_info` or similar, this guarantee narrows accordingly. Until then, override libraries are best-effort — a library built from a compatible commit that happens to resolve all required symbols and match the expected semver can still disagree on enum values or callback shapes, with undefined runtime behavior.
