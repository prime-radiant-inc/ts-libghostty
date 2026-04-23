# ts-libghostty

**Unofficial community TypeScript binding** over [libghostty-vt](https://github.com/ghostty-org/ghostty), the VT state machine from [Ghostty](https://ghostty.org). For Bun.

> **Status:** pre-1.0, API unstable. This binding tracks a pinned Ghostty commit
> and is published for experimentation. There is no guarantee of semver across
> 0.x releases. This package is not affiliated with or endorsed by the Ghostty
> project.

## Install

```bash
bun add ts-libghostty
```

**Platforms (Pass 1):** `darwin-arm64` only. The current FFI layer relies on AAPCS64 register-split rules for passing Ghostty's by-value struct arguments without a C shim. Other platforms (Linux x64, darwin-x64, Windows) are on the roadmap — adding them will likely require a small C shim to bridge the struct-by-value boundary. See the design spec in the [source repository](https://github.com/REPLACE_WITH_REPO_URL) under `docs/superpowers/specs/`.

**APC tuning (Pass 1):** this release does not expose `apc_max_bytes` / `apc_max_bytes_kitty` tuning. The terminal uses upstream libghostty-vt defaults. Pass 2+ will add post-construction setters — `Terminal.setApcMaxBytes(n)` and `Terminal.setApcMaxBytesKitty(n)` — wrapping `ghostty_terminal_set(term, GHOSTTY_TERMINAL_OPT_APC_MAX_BYTES, ...)` if user demand surfaces.

## Minimal example

```typescript
import { Terminal, Formatter } from "ts-libghostty";

using term = new Terminal({ cols: 80, rows: 24 });
term.vtWrite(new TextEncoder().encode("hello, world\r\n"));

using fmt = new Formatter({ format: "plain" });
console.log(fmt.formatString(term));
```

## Pass 1 surface

- `Terminal` — construction, `vtWrite`, `resize`, `reset`, `snapshot`, `mode`/`setMode`, lifecycle (`close`, `using`).
- `Formatter` — `plain`/`vt`/`html` dumps of a Terminal's current screen.
- `GhosttyError` + subclasses (`LibraryNotFoundError`, `UnsupportedPlatformError`, `LibraryCompatibilityError`, `UseAfterCloseError`).
- `setLibraryPath` / `isLoaded` / `libraryInfo` for diagnostics and out-of-tree library paths.

Effect callbacks (`onWritePty`, `onBell`, `onTitleChanged`), `RenderState` (per-cell grid reading), `KeyEncoder`, and polish features (modes beyond the simple get/set, color get/set, viewport scroll, `cellAt`) are on the roadmap for Passes 2–5.

## License

- `ts-libghostty` code: Apache-2.0 — see [LICENSE](./LICENSE).
- Redistributed `libghostty-vt.dylib` binary in `prebuilds/`: MIT, per upstream Ghostty at the pinned commit — see [LICENSE_GHOSTTY](./LICENSE_GHOSTTY).

## Pinned Ghostty

The installed package is bound to a specific Ghostty commit. You can inspect it programmatically:

```typescript
import { pinnedCommit, libraryInfo } from "ts-libghostty";
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
import { setLibraryPath } from "ts-libghostty";
setLibraryPath("/path/to/libghostty-vt.dylib");
```

**The loaded library's ABI must be compatible with the pinned Ghostty commit.** Pass 1 verifies compatibility through three channels: (1) every required FFI symbol must resolve at load time or `LibraryCompatibilityError` is thrown; (2) the checked-in struct layouts (`src/internal/generated.ts`) must match the probe output for the pinned headers, and the ABI smoke test additionally cross-checks them against `ghostty_type_json()` at runtime; (3) `ghostty_build_info(GHOSTTY_BUILD_INFO_VERSION_STRING)` must return the expected semver string (e.g. `0.1.0-dev`) — mismatch raises `LibraryCompatibilityError`. Note that `ghostty_build_info` returns **semver, not a git commit SHA** at this pin; we cannot cryptographically verify the dylib was built from our pinned commit via the C API alone. If upstream later exposes a commit SHA via `ghostty_build_info` or similar, this guarantee narrows accordingly. Until then, override libraries are best-effort — a library built from a compatible commit that happens to resolve all required symbols and match the expected semver can still disagree on enum values or callback shapes, with undefined runtime behavior.
