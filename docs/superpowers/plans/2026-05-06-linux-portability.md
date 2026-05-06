# Linux Portability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the design specified in `docs/superpowers/specs/2026-05-06-linux-portability-design.md`. Add darwin-arm64 + linux-{x64,arm64} × {glibc,musl} support to `libghostty-vt` via a portable C shim that replaces platform-specific FFI register-splitting tricks. Ship six prebuilds in the v0.6.0 npm tarball.

**Architecture:** A 50-line C shim (`native/shim.c`) wraps four by-value libghostty-vt entry points with pointer-taking variants, eliminating AAPCS64-vs-SystemV calling-convention divergence. The binding does two `dlopen` calls (main library + shim) and dispatches the four wrapped symbols through the shim. Linux Zig builds use `-Dtarget=*-linux-{gnu,musl}` to produce per-libc binaries. CI matrix expands from one runner to three.

**Tech stack:** Bun 1.3.13, TypeScript 5.x, Zig 0.15.x, Docker (OrbStack on macOS local dev), GitHub Actions.

**Phases:**
- **Phase 1 (Tasks 1.1–1.8):** Darwin shim migration in isolation. Highest-risk single migration; must be fully green before Phase 2.
- **Phase 2 (Tasks 2.1–2.16):** Linux fan-out — build pipeline, runtime detection, CI matrix, release workflow.

**Reference:** spec at `docs/superpowers/specs/2026-05-06-linux-portability-design.md`. Recon evidence at `.tmp/recon-linux/REPORT.md`. Scout's pre-built shim source at `.tmp/recon-linux/shim/ghostty-vt-shim.c` (copy into `native/shim.c` verbatim).

**Worktree:** Recommended — branch from `main` into `.worktrees/linux-portability` per `superpowers:using-git-worktrees`. Phase 1 can land independently if you'd prefer to ship darwin-shim first as v0.5.2 and Linux as v0.6.0 — that's a sequencing call, not a design change.

**Reporting checkpoints to Matt:** end of Phase 1 (Task 1.8 verifies darwin-arm64 still ships clean with the shim), and end of Phase 2 (Task 2.16, ready to tag v0.6.0).

---

## File map

**New files:**
```
packages/libghostty-vt/native/shim.c
packages/libghostty-vt/scripts/test-linux.sh
packages/libghostty-vt/test/smoke/shim-presence.test.ts
.github/workflows/release.yml
```

**Modified files:**
```
packages/libghostty-vt/src/ffi.ts
packages/libghostty-vt/src/internal/path.ts
packages/libghostty-vt/src/index.ts
packages/libghostty-vt/src/terminal.ts
packages/libghostty-vt/scripts/build-libghostty.sh
packages/libghostty-vt/scripts/gen-bindings.ts
packages/libghostty-vt/scripts/run-tarball-smoke.sh
packages/libghostty-vt/test/smoke/path.test.ts
packages/libghostty-vt/test/smoke/errors.test.ts
packages/libghostty-vt/test/smoke/ffi.test.ts
packages/libghostty-vt/CHANGELOG.md
packages/libghostty-vt/package.json
packages/libghostty-vt/README.md
.github/workflows/ci.yml
CLAUDE.md
```

---

## Phase 1 — Darwin shim migration (in isolation)

The goal of Phase 1 is to introduce the shim alongside libghostty-vt on darwin-arm64, dispatch the four wrapped entry points through it, and verify the existing test suite + tarball smoke test stay green. **No Linux work begins until Phase 1 is green.**

### Task 1.1: Add the shim source file

**Files:**
- Create: `packages/libghostty-vt/native/shim.c`

The source has already been written and verified by the recon Bob; copy it in verbatim.

- [ ] **Step 1: Create the directory and copy the file**

```bash
mkdir -p packages/libghostty-vt/native
cp .tmp/recon-linux/shim/ghostty-vt-shim.c packages/libghostty-vt/native/shim.c
```

- [ ] **Step 2: Verify the contents**

The file should be ~55 lines with four `EXPORT GhosttyResult` (or `EXPORT void` for `_scroll_viewport_p`) functions. Each wraps an upstream by-value entry point with a pointer-taking variant.

```bash
wc -l packages/libghostty-vt/native/shim.c
grep -c '^EXPORT' packages/libghostty-vt/native/shim.c
```

Expected: ~55 lines, 4 EXPORT declarations.

- [ ] **Step 3: Add `native/` to package.json `files`**

The shim source ships in the tarball so source consumers can rebuild it if they ever need to. Edit `packages/libghostty-vt/package.json`:

```json
"files": [
  "src/",
  "dist/",
  "prebuilds/",
  "native/",
  "LICENSE",
  "LICENSE_GHOSTTY",
  "README.md",
  "CHANGELOG.md"
],
```

- [ ] **Step 4: Commit**

```bash
git add packages/libghostty-vt/native/shim.c packages/libghostty-vt/package.json
git commit -m "feat(shim): add native/shim.c (4 by-value entry-point wrappers)

Source verified by recon Bob (Scout) — wraps ghostty_terminal_new,
ghostty_formatter_terminal_new, ghostty_terminal_grid_ref, and
ghostty_terminal_scroll_viewport with pointer-taking _p variants.
Universal across AAPCS64 and SystemV-amd64 calling conventions."
```

---

### Task 1.2: Extend build script to build the shim on darwin

**Files:**
- Modify: `packages/libghostty-vt/scripts/build-libghostty.sh`

Add a shim-build step at the end of the existing darwin path. SONAME discovery via `otool -D`; install_name set so consumers can find the shim through `@rpath`.

- [ ] **Step 1: Read the current script to locate the insertion point**

```bash
sed -n '70,90p' packages/libghostty-vt/scripts/build-libghostty.sh
```

You're inserting the shim build immediately after the existing `cp "$SRC" "prebuilds/$PLATFORM/libghostty-vt.$EXT"` line (around line 84) and before the LICENSE_GHOSTTY copy.

- [ ] **Step 2: Add the shim build block**

Append (after the existing libghostty-vt copy, before the LICENSE_GHOSTTY copy):

```bash
# Build the portability shim. Wraps four by-value entry points with pointer-
# taking variants so the binding can use a single FFI strategy across
# platforms. See docs/superpowers/specs/2026-05-06-linux-portability-design.md.
echo "==> building libghostty-vt-shim for $PLATFORM"
SHIM_OUT="prebuilds/$PLATFORM/libghostty-vt-shim.$EXT"
case "$PLATFORM" in
  darwin-*)
    "$ZIG" cc -O2 -fPIC -shared \
      -I vendor/ghostty/include \
      -Wl,-install_name,@rpath/libghostty-vt-shim.$EXT \
      -Wl,-rpath,@loader_path \
      -L "prebuilds/$PLATFORM" -lghostty-vt \
      -o "$SHIM_OUT" \
      native/shim.c
    ;;
  linux-*)
    # Linux shim build is parameterized by target triple; handled in Task 2.1.
    echo "(linux shim build deferred to Task 2.1)" >&2
    ;;
esac
echo "installed $SHIM_OUT"
```

- [ ] **Step 3: Run the build and verify the shim is produced**

```bash
cd packages/libghostty-vt
bun run build:libghostty
ls -la prebuilds/darwin-arm64/
```

Expected: both `libghostty-vt.dylib` and `libghostty-vt-shim.dylib` present. Shim is small (<50 KB).

- [ ] **Step 4: Verify the shim exports the four symbols**

```bash
nm -gU prebuilds/darwin-arm64/libghostty-vt-shim.dylib | grep _p$
```

Expected: four lines, ending in `_ghostty_terminal_new_p`, `_ghostty_formatter_terminal_new_p`, `_ghostty_terminal_grid_ref_p`, `_ghostty_terminal_scroll_viewport_p`.

- [ ] **Step 5: Verify the shim's load command points to libghostty-vt via `@rpath`**

```bash
otool -L prebuilds/darwin-arm64/libghostty-vt-shim.dylib
```

Expected output includes a line referencing `libghostty-vt.dylib` (resolved via `@rpath`).

- [ ] **Step 6: Commit**

```bash
git add packages/libghostty-vt/scripts/build-libghostty.sh
git commit -m "build: build libghostty-vt-shim alongside libghostty-vt (darwin)

Linux shim build is stubbed; will be wired in Task 2.1 once Linux
cross-compile is in place."
```

---

### Task 1.3: Add the shim symbol table and dlopen logic to ffi.ts

**Files:**
- Modify: `packages/libghostty-vt/src/ffi.ts`

Split the symbol table into `MAIN_SYMBOLS` (everything that stays in libghostty-vt.dylib) and `SHIM_SYMBOLS` (the four `_p` variants). Add a second dlopen for the shim. Replace the four wrapped entries' invocation paths to dispatch through the shim.

- [ ] **Step 1: Locate the four entries to relocate**

```bash
grep -n "ghostty_terminal_new\|ghostty_formatter_terminal_new\|ghostty_terminal_grid_ref\b\|ghostty_terminal_scroll_viewport" packages/libghostty-vt/src/ffi.ts
```

Expected: entries near lines 27, 145, 200, 269.

- [ ] **Step 2: Remove the four entries from `SYMBOLS` and rewrite the comment headers**

In `packages/libghostty-vt/src/ffi.ts`, **remove**:
- The `ghostty_terminal_new` entry (lines ~22–30) and its register-split commentary
- The `ghostty_terminal_grid_ref` entry (lines ~143–148) and its hidden-pointer commentary
- The `ghostty_terminal_scroll_viewport` entry (lines ~198–203)
- The `ghostty_formatter_terminal_new` entry (lines ~266–272) and its 56-byte commentary

Replace each with a single comment line: `// Moved to SHIM_SYMBOLS — wrapped by ghostty_terminal_new_p in the shim.` (with the appropriate `_p` name).

- [ ] **Step 3: Add `SHIM_SYMBOLS` constant**

After the existing `SYMBOLS` declaration (find the closing `} as const;` and the `type Symbols = typeof SYMBOLS;` line), add:

```ts
/**
 * Shim symbol table — pointer-taking wrappers for libghostty-vt's four
 * by-value entry points. Lives in libghostty-vt-shim.{dylib,so}, which is
 * dlopen'd alongside the main library.
 *
 * Why a shim rather than register-split or hidden-pointer tricks: bun:ffi
 * doesn't support struct-by-value, and the workarounds (AAPCS64 register-
 * split for 16-byte structs, "pass pointer to bytes" for >16-byte AAPCS64
 * hidden-reference) don't translate to SystemV x64. The shim makes every
 * platform's call shape uniform: pass pointer, callee dereferences.
 *
 * Signatures are the C signatures with each by-value struct replaced by
 * `const T *`.
 */
const SHIM_SYMBOLS = {
  ghostty_terminal_new_p: {
    args: [FFIType.ptr, FFIType.ptr, FFIType.ptr],  // (alloc, &out, &options)
    returns: FFIType.i32,
  },
  ghostty_formatter_terminal_new_p: {
    args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr],  // (alloc, &out, term, &options)
    returns: FFIType.i32,
  },
  ghostty_terminal_grid_ref_p: {
    args: [FFIType.ptr, FFIType.ptr, FFIType.ptr],  // (term, &point, &out_ref)
    returns: FFIType.i32,
  },
  ghostty_terminal_scroll_viewport_p: {
    args: [FFIType.ptr, FFIType.ptr],   // (term, &behavior)
    returns: FFIType.void,
  },
} as const;

type ShimSymbols = typeof SHIM_SYMBOLS;
type ShimDlopenResult = {
  symbols: { [K in keyof ShimSymbols]: (...args: any[]) => any };
  close: () => void;
};

export const requiredShimSymbols = Object.keys(SHIM_SYMBOLS) as readonly (keyof ShimSymbols)[];
```

- [ ] **Step 4: Add module-level state for the shim**

After the existing `let loaded: DlopenResult | null = null;` block (around line 318), add:

```ts
let shimOverridePath: string | undefined;
let loadedShim: ShimDlopenResult | null = null;
let loadedShimPath: string | null = null;
```

- [ ] **Step 5: Add `setShimLibraryPath` public API**

After the existing `setLibraryPath()` function (~line 325), add:

```ts
/**
 * Override the shim library path. Must be called before first native use.
 * The shim's runtime dependency on libghostty-vt is resolved via the
 * loader's rpath pointing at the shim's own directory ($ORIGIN on Linux,
 * @loader_path on darwin) — meaning: a custom shim must be co-located
 * with a matching libghostty-vt(.so chain | .dylib) in the same directory.
 */
export function setShimLibraryPath(path: string): void {
  if (loadedShim) {
    throw new LibraryCompatibilityError(
      `setShimLibraryPath called after shim already loaded from ${loadedShimPath}`,
      {
        details: `already loaded from ${loadedShimPath}`,
        expectedCommit: pinnedCommit,
      },
    );
  }
  shimOverridePath = path;
}
```

- [ ] **Step 6: Update `getLib()` to also dlopen the shim and merge symbols**

Find the section that loads the main library and verifies symbols. After the missing-symbols check passes (around line 415, before the build-identity check), insert:

```ts
  // Load the portability shim. Wraps four by-value entry points; symbol
  // names match the original C names with a `_p` suffix. We merge the
  // shim's symbols onto the main library's symbol object so the rest of
  // the binding can call them through `lib.symbols` uniformly under the
  // un-suffixed names.
  const shimPath = resolveShimLibraryPath({
    override: shimOverridePath,
    env: process.env["GHOSTTY_VT_SHIM_LIB"],
    packageRoot,
  });
  let openedShim: ShimDlopenResult;
  try {
    openedShim = dlopen(shimPath, SHIM_SYMBOLS) as ShimDlopenResult;
  } catch (e) {
    opened.close();
    const msg = (e as Error).message ?? String(e);
    throw new LibraryCompatibilityError(
      `Failed to open shim ${shimPath}: ${msg}`,
      { details: msg, expectedCommit: pinnedCommit, cause: e },
    );
  }
  // Verify the four shim symbols are present.
  const shimMissing: string[] = [];
  for (const name of requiredShimSymbols) {
    if (typeof (openedShim.symbols as any)[name] !== "function") shimMissing.push(name as string);
  }
  if (shimMissing.length > 0) {
    opened.close();
    openedShim.close();
    throw new LibraryCompatibilityError(
      `Shim at ${shimPath} is missing ${shimMissing.length} required _p symbols`,
      {
        details: `missing: ${shimMissing.join(", ")}`,
        expectedCommit: pinnedCommit,
      },
    );
  }
  // Splice shim symbols into the main symbols object under their un-
  // suffixed C names. The rest of the binding (terminal.ts, formatter.ts,
  // render-state.ts) calls these as if they were normal libghostty-vt
  // entry points.
  (opened.symbols as any).ghostty_terminal_new = openedShim.symbols.ghostty_terminal_new_p;
  (opened.symbols as any).ghostty_formatter_terminal_new = openedShim.symbols.ghostty_formatter_terminal_new_p;
  (opened.symbols as any).ghostty_terminal_grid_ref = openedShim.symbols.ghostty_terminal_grid_ref_p;
  (opened.symbols as any).ghostty_terminal_scroll_viewport = openedShim.symbols.ghostty_terminal_scroll_viewport_p;

  loadedShim = openedShim;
  loadedShimPath = shimPath;
```

- [ ] **Step 7: Update `_resetForTest` to also reset shim state**

Find the existing `_resetForTest` (~line 475) and update its body:

```ts
export function _resetForTest(): void {
  if (loaded) loaded.close();
  if (loadedShim) loadedShim.close();
  loaded = null;
  loadedPath = null;
  loadedIdentity = null;
  loadedShim = null;
  loadedShimPath = null;
  overridePath = undefined;
  shimOverridePath = undefined;
}
```

- [ ] **Step 8: Update `libraryInfo()` to expose shim path**

Update the `LibraryInfo` interface (~line 343) and `libraryInfo()` function (~line 357):

```ts
export interface LibraryInfo {
  loaded: boolean;
  path: string | null;
  shimPath: string | null;
  pinnedCommit: string;
  actualIdentity: string | null;
}

export function libraryInfo(): LibraryInfo {
  return {
    loaded: loaded !== null,
    path: loadedPath,
    shimPath: loadedShimPath,
    pinnedCommit,
    actualIdentity: loadedIdentity,
  };
}
```

- [ ] **Step 9: Add the import for `resolveShimLibraryPath`**

At the top of the file (~line 1), update the import from `./internal/path`:

```ts
import { resolveLibraryPath, resolveShimLibraryPath } from "./internal/path";
```

This will fail typecheck until Task 1.4 lands `resolveShimLibraryPath`. Run typecheck now to confirm the expected failure — it confirms you're touching the right places:

```bash
cd packages/libghostty-vt && bun run typecheck
```

Expected: TS error pointing at the missing `resolveShimLibraryPath` export. Move to Task 1.4 to fix.

- [ ] **Step 10: Stage but don't commit yet**

```bash
git add packages/libghostty-vt/src/ffi.ts
git status
```

Continue to Task 1.4 before committing — the typecheck has to pass.

---

### Task 1.4: Add shim path resolver and `setShimLibraryPath` plumbing

**Files:**
- Modify: `packages/libghostty-vt/src/internal/path.ts`
- Modify: `packages/libghostty-vt/src/index.ts`

Add `resolveShimLibraryPath()` mirroring `resolveLibraryPath()`. Re-export `setShimLibraryPath` from the public surface.

- [ ] **Step 1: Add the resolver function to `path.ts`**

Append to `packages/libghostty-vt/src/internal/path.ts`:

```ts
/**
 * Resolve the path to libghostty-vt-shim. Mirrors resolveLibraryPath() but
 * looks for `libghostty-vt-shim.<ext>` in the same prebuilds/ directory.
 *
 * The shim's runtime dependency on libghostty-vt is resolved by the OS
 * loader using the shim's own directory ($ORIGIN on Linux, @loader_path
 * on darwin), so the shim and the main library MUST live in the same
 * directory. If a caller uses setShimLibraryPath() to override, they
 * are responsible for ensuring the matching libghostty-vt is co-located.
 */
export function resolveShimLibraryPath(opts: ResolveOptions): string {
  const exists = opts.fileExists ?? ((p) => existsSync(p));
  const platform = opts.platform ?? detectPlatform();

  if (opts.override) {
    if (!exists(opts.override)) {
      throw new LibraryNotFoundError(
        `setShimLibraryPath: file not found at ${opts.override}`,
        { searchedPaths: [opts.override] },
      );
    }
    return opts.override;
  }

  if (opts.env) {
    if (!exists(opts.env)) {
      throw new LibraryNotFoundError(
        `GHOSTTY_VT_SHIM_LIB: file not found at ${opts.env}`,
        { searchedPaths: [opts.env] },
      );
    }
    return opts.env;
  }

  const ext = libExtension(platform);
  const bundled = join(opts.packageRoot, "prebuilds", platform, `libghostty-vt-shim.${ext}`);

  if (!isKnownPlatform(platform)) {
    throw new UnsupportedPlatformError(
      `No bundled libghostty-vt-shim for ${platform}. Supported: ${SUPPORTED_PLATFORMS.join(", ")}.`,
      {
        detectedPlatform: platform,
        supportedPlatforms: [...SUPPORTED_PLATFORMS],
      },
    );
  }

  if (!exists(bundled)) {
    throw new LibraryNotFoundError(
      `Bundled libghostty-vt-shim missing at ${bundled}. ` +
        `This usually means the package tarball is incomplete — reinstall libghostty-vt, ` +
        `or override via GHOSTTY_VT_SHIM_LIB / setShimLibraryPath().`,
      { searchedPaths: [bundled] },
    );
  }

  return bundled;
}
```

- [ ] **Step 2: Re-export `setShimLibraryPath` from the public surface**

Edit `packages/libghostty-vt/src/index.ts`. Find the existing `setLibraryPath` export and add `setShimLibraryPath` alongside:

```ts
export { setLibraryPath, setShimLibraryPath, isLoaded, libraryInfo } from "./ffi";
```

- [ ] **Step 3: Run typecheck**

```bash
cd packages/libghostty-vt && bun run typecheck
```

Expected: PASS. The Task 1.3 import error is resolved.

- [ ] **Step 4: Commit Tasks 1.3 + 1.4 together**

```bash
git add packages/libghostty-vt/src/ffi.ts \
        packages/libghostty-vt/src/internal/path.ts \
        packages/libghostty-vt/src/index.ts
git commit -m "feat(ffi): load libghostty-vt-shim alongside main library

Splits SYMBOLS into MAIN_SYMBOLS + SHIM_SYMBOLS; getLib() dlopens both
and splices shim _p symbols into the main symbols object under their
unsuffixed C names. setShimLibraryPath / GHOSTTY_VT_SHIM_LIB / shimPath
in libraryInfo all parallel the main-library plumbing.

Doesn't yet remove the AAPCS64 register-split call site in terminal.ts —
that lands next."
```

---

### Task 1.5: Drop register-split call site in terminal.ts

**Files:**
- Modify: `packages/libghostty-vt/src/terminal.ts`

`ghostty_terminal_new` is now invoked via the shim with a single pointer arg. Update the call site to match.

- [ ] **Step 1: Find the call site**

```bash
grep -n "ghostty_terminal_new\|opts_lo\|opts_hi\|u64s\[" packages/libghostty-vt/src/terminal.ts | head -20
```

Expected: ~line 219–235 contains the register-split commentary, the `BigUint64Array(optBytes.buffer, ...)` setup, and the four-arg call.

- [ ] **Step 2: Replace the register-split block with a pointer call**

Find this block (around line 219–233):

```ts
    // ghostty_terminal_new passes GhosttyTerminalOptions BY VALUE. bun:ffi has
    // ...
    const u64s = new BigUint64Array(optBytes.buffer, optBytes.byteOffset, 2);
    const outSlot = new BigUint64Array(1);

    const result = lib.symbols.ghostty_terminal_new(
      null,
      ptr(outSlot),
      u64s[0]!,
      u64s[1]!,
    );
```

Replace with:

```ts
    // Options passed via pointer; ffi.ts dispatches this through
    // ghostty_terminal_new_p in the shim, which dereferences and performs
    // the by-value call internally. This is portable across calling
    // conventions (AAPCS64 register-split vs SystemV-amd64 register pair
    // vs SystemV-arm64 register-split). See spec §"The shim".
    const outSlot = new BigUint64Array(1);

    const result = lib.symbols.ghostty_terminal_new(
      null,
      ptr(outSlot),
      ptr(optBytes),
    );
```

- [ ] **Step 3: Run the smoke tests**

```bash
cd packages/libghostty-vt && bun test test/smoke
```

Expected: all tests pass except potentially the three darwin-hardcoded ones (`path.test.ts`, `errors.test.ts`, `ffi.test.ts`) — those still pass on darwin because they hardcode darwin paths. The wrapped entry points (terminal_new, formatter_terminal_new, grid_ref, scroll_viewport) are exercised by many of these tests; if any FFI call fails in a way that suggests calling-convention mismatch, the shim integration is broken.

- [ ] **Step 4: Run the typecheck**

```bash
cd packages/libghostty-vt && bun run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/libghostty-vt/src/terminal.ts
git commit -m "feat(terminal): drop AAPCS64 register-split for ghostty_terminal_new

Replaced (alloc, &out, opts_lo, opts_hi) call with (alloc, &out, &opts).
Dispatches through the shim's _p variant via the splice in getLib().
Removes the only AAPCS64-specific call site in terminal.ts."
```

---

### Task 1.6: Add shim-presence smoke test

**Files:**
- Create: `packages/libghostty-vt/test/smoke/shim-presence.test.ts`

A focused test that the shim loads and the four `_p` symbols resolve. Catches a silent shim-build that produces an empty `.so`/`.dylib`.

- [ ] **Step 1: Write the test**

Create `packages/libghostty-vt/test/smoke/shim-presence.test.ts`:

```ts
import { describe, it, expect } from "bun:test";
import { libraryInfo } from "../../src";
import { Terminal } from "../../src";

describe("shim presence", () => {
  it("loads the shim alongside the main library", () => {
    // Construct a terminal to force lazy load.
    const t = new Terminal({ cols: 4, rows: 1 });
    try {
      const info = libraryInfo();
      expect(info.loaded).toBe(true);
      expect(info.path).toMatch(/libghostty-vt\.(dylib|so)/);
      expect(info.shimPath).toMatch(/libghostty-vt-shim\.(dylib|so)/);
    } finally {
      t.close();
    }
  });

  it("constructs a terminal via the shim's terminal_new_p path", () => {
    // If this works, the shim's ghostty_terminal_new_p wrapper succeeded.
    // The four-symbol shim is exercised by every Terminal lifecycle test;
    // this one is here to fail loud if the shim itself is broken.
    const t = new Terminal({ cols: 80, rows: 24 });
    expect(t).toBeDefined();
    t.close();
  });
});
```

- [ ] **Step 2: Run the new test**

```bash
cd packages/libghostty-vt && bun test test/smoke/shim-presence.test.ts -v
```

Expected: PASS, both tests.

- [ ] **Step 3: Commit**

```bash
git add packages/libghostty-vt/test/smoke/shim-presence.test.ts
git commit -m "test(smoke): add shim-presence test

Verifies both libraries load and the shim path is reported.
Constructs a Terminal to exercise terminal_new_p end-to-end."
```

---

### Task 1.7: Extend tarball smoke test to verify shim ships

**Files:**
- Modify: `packages/libghostty-vt/scripts/run-tarball-smoke.sh`

The publish gate must verify both the main library and the shim end up in the tarball, and the consumer-side construction works against them.

- [ ] **Step 1: Read the current script**

```bash
cat packages/libghostty-vt/scripts/run-tarball-smoke.sh
```

You'll see a small bash script that packs the package, installs into a temp project, and runs a basic Terminal construction.

- [ ] **Step 2: Add a check that the tarball contains the shim binary**

After the `bun pm pack` line (or equivalent), add:

```bash
# Verify the tarball includes both libghostty-vt and the shim.
echo "==> verifying tarball contents"
TARBALL=$(ls libghostty-vt-*.tgz | head -1)
if ! tar -tzf "$TARBALL" | grep -q "prebuilds/darwin-arm64/libghostty-vt.dylib"; then
  echo "ERROR: tarball missing libghostty-vt.dylib" >&2
  exit 1
fi
if ! tar -tzf "$TARBALL" | grep -q "prebuilds/darwin-arm64/libghostty-vt-shim.dylib"; then
  echo "ERROR: tarball missing libghostty-vt-shim.dylib" >&2
  exit 1
fi
echo "tarball contents OK"
```

- [ ] **Step 3: Run the tarball smoke test**

```bash
cd packages/libghostty-vt && bash scripts/run-tarball-smoke.sh
```

Expected: PASS. The tarball contains both binaries, and the consumer-side Terminal construction succeeds (which exercises the shim's `_p` variants).

- [ ] **Step 4: Commit**

```bash
git add packages/libghostty-vt/scripts/run-tarball-smoke.sh
git commit -m "build: tarball smoke verifies libghostty-vt-shim is bundled"
```

---

### Task 1.8: Phase 1 gate — full test suite + tarball smoke

**Files:** none modified.

The Phase 1 acceptance criteria. All must be green before Phase 2 begins.

- [ ] **Step 1: Run the full test suite**

```bash
cd packages/libghostty-vt && bun run test
```

Expected: PASS, including `test:tarball`.

- [ ] **Step 2: Run blinkyterm tests (consumer of libghostty-vt)**

```bash
cd packages/blinkyterm && bun run test
```

Expected: PASS. blinkyterm exercises the public API; if anything in Phase 1 broke the API contract, this catches it.

- [ ] **Step 3: Run `verify:generated`**

```bash
cd packages/libghostty-vt && bun run verify:generated
```

Expected: PASS — generated.ts unchanged.

- [ ] **Step 4: Manual sanity check — confirm shim is in the workflow**

```bash
ls packages/libghostty-vt/prebuilds/darwin-arm64/
```

Expected: both `libghostty-vt.dylib` and `libghostty-vt-shim.dylib`.

- [ ] **Step 5: If everything is green, declare Phase 1 done**

This is the natural place to ship as `v0.5.2` if you'd prefer to land darwin migration independently before Linux work. To do so:
1. Update `packages/libghostty-vt/CHANGELOG.md` with a `[0.5.2]` section noting the shim adoption (see CHANGELOG conventions in CLAUDE.md).
2. Bump `package.json` version to `0.5.2`.
3. Tag and publish.

Otherwise, proceed straight to Phase 2 — the version bump to `0.6.0` happens at Task 2.16 instead.

- [ ] **Step 6: Commit a Phase 1 marker (optional)**

```bash
git commit --allow-empty -m "chore: phase 1 (darwin shim migration) complete

All smoke tests pass; tarball smoke passes; blinkyterm regression-free.
Ready to begin Phase 2 (Linux fan-out)."
```

---

## Phase 2 — Linux fan-out

Phase 2 adds linux-{x64,arm64} × {glibc,musl} support on top of the working darwin-shim baseline. Six prebuilds total. CI matrix expands from one runner to three.

### Task 2.1: Extend build script for Linux cross-compile

**Files:**
- Modify: `packages/libghostty-vt/scripts/build-libghostty.sh`

Make Linux build paths work via Zig cross-compilation. SONAME discovery via `readelf -d`. Symlink chain preservation.

- [ ] **Step 1: Restructure the platform detection block**

Replace the existing `case "$UNAME_S-$UNAME_M"` block (~lines 18–27) with one that supports both native and cross-target builds:

```bash
# Resolve build target. Native builds infer from uname; cross-compile
# accepts a TARGET env var (used by Linux CI to build both glibc + musl
# variants from a single runner).
if [ -n "${TARGET:-}" ]; then
  case "$TARGET" in
    x86_64-linux-gnu) PLATFORM="linux-x64-glibc"; EXT="so"; ZIG_TARGET="$TARGET" ;;
    x86_64-linux-musl) PLATFORM="linux-x64-musl"; EXT="so"; ZIG_TARGET="$TARGET" ;;
    aarch64-linux-gnu) PLATFORM="linux-arm64-glibc"; EXT="so"; ZIG_TARGET="$TARGET" ;;
    aarch64-linux-musl) PLATFORM="linux-arm64-musl"; EXT="so"; ZIG_TARGET="$TARGET" ;;
    *) echo "Unsupported TARGET: $TARGET" >&2; exit 1 ;;
  esac
else
  UNAME_S=$(uname -s)
  UNAME_M=$(uname -m)
  case "$UNAME_S-$UNAME_M" in
    Darwin-arm64) PLATFORM="darwin-arm64"; EXT="dylib"; ZIG_TARGET="" ;;
    *)
      echo "Unsupported native platform: $UNAME_S-$UNAME_M. Cross-compile via TARGET env." >&2
      exit 1
      ;;
  esac
fi
```

- [ ] **Step 2: Pass the target to `zig build` when set**

Find the existing `"$ZIG" build install -Demit-lib-vt=true -Doptimize=ReleaseFast` line. Replace with:

```bash
ZIG_BUILD_ARGS=(install "-Demit-lib-vt=true" "-Doptimize=ReleaseFast")
if [ -n "$ZIG_TARGET" ]; then
  ZIG_BUILD_ARGS+=("-Dtarget=$ZIG_TARGET")
fi
"$ZIG" build "${ZIG_BUILD_ARGS[@]}"
```

- [ ] **Step 3: Replace the SRC discovery + cp with SONAME-aware logic**

The current logic is `SRC=vendor/ghostty/zig-out/lib/libghostty-vt.$EXT` plus a fallback `find`. Replace the entire copy block with:

```bash
# Discover the produced library. Cross-compile may put it under a
# triple-named subdir; native build puts it directly under zig-out/lib.
SRC=""
for cand in \
  "vendor/ghostty/zig-out/lib/libghostty-vt.$EXT" \
  "vendor/ghostty/zig-out/lib/libghostty-vt.$EXT".* \
  vendor/ghostty/zig-out/lib/*/libghostty-vt.$EXT \
  ; do
  if [ -f "$cand" ]; then SRC="$cand"; break; fi
done
if [ -z "$SRC" ]; then
  echo "build succeeded but libghostty-vt.$EXT not found" >&2
  find vendor/ghostty/zig-out -maxdepth 4 -type f >&2
  exit 1
fi

mkdir -p "prebuilds/$PLATFORM"

# Discover SONAME and construct the symlink chain. Linux uses readelf;
# darwin uses otool. The SOVERSION may change at any libghostty pin
# bump, so we never hardcode the .so.<n>.<n>.<n> filename.
case "$EXT" in
  so)
    # Read SONAME (e.g. "libghostty-vt.so.0").
    SONAME=$(readelf -d "$SRC" | awk '/SONAME/ {gsub(/[\[\]]/, "", $5); print $5}')
    if [ -z "$SONAME" ]; then
      echo "could not read SONAME from $SRC" >&2
      exit 1
    fi
    # The actual file gets the full version name. If $SRC is itself a
    # versioned name (e.g. libghostty-vt.so.0.1.0), use that; otherwise
    # name the file after the SONAME with a synthetic patch suffix.
    SRC_BASENAME=$(basename "$SRC")
    if [[ "$SRC_BASENAME" =~ ^libghostty-vt\.so\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
      FULL_NAME="$SRC_BASENAME"
    else
      FULL_NAME="$SONAME.0"  # synthetic; only matters for the symlink target
    fi
    cp "$SRC" "prebuilds/$PLATFORM/$FULL_NAME"
    (cd "prebuilds/$PLATFORM" && ln -sf "$FULL_NAME" "$SONAME")
    (cd "prebuilds/$PLATFORM" && ln -sf "$SONAME" "libghostty-vt.so")
    ;;
  dylib)
    # darwin: no SONAME chain, just copy the .dylib directly.
    cp "$SRC" "prebuilds/$PLATFORM/libghostty-vt.dylib"
    ;;
esac
echo "installed prebuilds/$PLATFORM/libghostty-vt.$EXT"
```

- [ ] **Step 4: Wire up the Linux shim build**

Replace the Task 1.2 stub (`echo "(linux shim build deferred to Task 2.1)" >&2`) with:

```bash
  linux-*)
    "$ZIG" cc -O2 -fPIC -shared \
      -target "$ZIG_TARGET" \
      -I vendor/ghostty/include \
      -Wl,-soname,libghostty-vt-shim.so \
      -Wl,-rpath,'$ORIGIN' \
      -L "prebuilds/$PLATFORM" -lghostty-vt \
      -o "$SHIM_OUT" \
      native/shim.c
    ;;
```

- [ ] **Step 5: Test the build script on darwin to confirm no regression**

```bash
cd packages/libghostty-vt && rm -rf prebuilds/darwin-arm64 && bun run build:libghostty
ls prebuilds/darwin-arm64/
```

Expected: both `libghostty-vt.dylib` and `libghostty-vt-shim.dylib` produced.

- [ ] **Step 6: Test cross-compile to linux-x64-musl from darwin**

```bash
cd packages/libghostty-vt && TARGET=x86_64-linux-musl bun run build:libghostty
ls -la prebuilds/linux-x64-musl/
```

Expected: `libghostty-vt.so` symlink chain (`.so → .so.<n> → .so.<n>.<n>.<n>`) and `libghostty-vt-shim.so`.

If this fails with "readelf: command not found" — install `binutils` on the macOS host (`brew install binutils`) or use `llvm-readelf` from Xcode. If the SONAME is empty, run `readelf -d <path>` manually to debug.

- [ ] **Step 7: Test cross-compile for the other three Linux targets**

```bash
cd packages/libghostty-vt
for t in x86_64-linux-gnu aarch64-linux-musl aarch64-linux-gnu; do
  TARGET=$t bun run build:libghostty
done
ls -la prebuilds/
```

Expected: four `linux-*` directories, each with the symlink chain and shim.

- [ ] **Step 8: Commit**

```bash
git add packages/libghostty-vt/scripts/build-libghostty.sh
git commit -m "build: cross-compile linux-{x64,arm64}-{glibc,musl} via TARGET env

zig build -Dtarget=<triple> + zig cc cross-compile of the shim.
SONAME discovered via readelf; symlink chain preserved (.so → .so.<n>
→ full version). Darwin native path is unchanged."
```

---

### Task 2.2: Extend SUPPORTED_PLATFORMS and detectPlatform

**Files:**
- Modify: `packages/libghostty-vt/src/internal/path.ts`

Six platform triples, plus `detectLibc()` for Linux.

- [ ] **Step 1: Extend the SUPPORTED_PLATFORMS list**

Replace:

```ts
export const SUPPORTED_PLATFORMS = ["darwin-arm64"] as const;
```

with:

```ts
export const SUPPORTED_PLATFORMS = [
  "darwin-arm64",
  "linux-x64-glibc",
  "linux-x64-musl",
  "linux-arm64-glibc",
  "linux-arm64-musl",
] as const;
```

- [ ] **Step 2: Add `detectLibc()` with two strategies**

After the existing `detectPlatform()` function, add:

```ts
/**
 * Detect glibc vs musl on Linux. Two strategies in priority order:
 *
 *   1. process.report.getReport().header.glibcVersionRuntime — Bun
 *      reproduces this Node.js API; on glibc systems it returns a non-
 *      empty version string, on musl it's missing or empty.
 *   2. ELF interpreter sniff — read the PT_INTERP segment from
 *      /proc/self/exe and string-match for "musl" vs "ld-linux".
 *
 * Strategy 1 is the fast path; strategy 2 is the correctness floor for
 * cases where Bun's process.report compat ever changes. If both fail
 * (e.g., /proc not mounted), we conservatively assume glibc — the more
 * common runtime — and let the dlopen failure provide a clear diagnostic.
 */
export function detectLibc(): "glibc" | "musl" {
  // Strategy 1: process.report
  try {
    const report = (process as any).report?.getReport?.();
    const v = report?.header?.glibcVersionRuntime;
    if (typeof v === "string" && v.length > 0) return "glibc";
  } catch {
    // fall through
  }
  // Strategy 2: ELF interpreter
  const interp = readElfInterpreter();
  if (interp) {
    if (interp.includes("musl")) return "musl";
    if (interp.includes("ld-linux") || interp.includes("ld-2.")) return "glibc";
  }
  return "glibc"; // conservative default
}

/**
 * Read the PT_INTERP segment of /proc/self/exe (the dynamic linker path).
 * Returns the interpreter string, or null on any failure.
 */
function readElfInterpreter(): string | null {
  try {
    // We only need the first few KB to reach PT_INTERP (Bun is very large
    // overall, but PT_INTERP is in the program-header section near the
    // start of the ELF). Read 32 KB, more than enough.
    const fs = require("node:fs") as typeof import("node:fs");
    const fd = fs.openSync("/proc/self/exe", "r");
    try {
      const buf = Buffer.alloc(32 * 1024);
      const bytesRead = fs.readSync(fd, buf, 0, buf.length, 0);
      if (bytesRead < 64) return null;
      // ELF64 header layout: e_phoff @16 (8B), e_phentsize @54 (2B),
      // e_phnum @56 (2B). Iterate program headers; PT_INTERP type = 3.
      // Each Phdr: p_type @0 (4B), p_offset @8 (8B), p_filesz @32 (8B).
      const e_ident_class = buf.readUInt8(4);
      if (e_ident_class !== 2) return null; // not ELF64
      const e_phoff = Number(buf.readBigUInt64LE(32));
      const e_phentsize = buf.readUInt16LE(54);
      const e_phnum = buf.readUInt16LE(56);
      for (let i = 0; i < e_phnum; i++) {
        const off = e_phoff + i * e_phentsize;
        if (off + 56 > bytesRead) break;
        const p_type = buf.readUInt32LE(off);
        if (p_type !== 3) continue; // PT_INTERP
        const p_offset = Number(buf.readBigUInt64LE(off + 8));
        const p_filesz = Number(buf.readBigUInt64LE(off + 32));
        if (p_offset + p_filesz > bytesRead) {
          // Need a larger read; fall through.
          const buf2 = Buffer.alloc(p_offset + p_filesz);
          fs.readSync(fd, buf2, 0, buf2.length, 0);
          return buf2.subarray(p_offset, p_offset + p_filesz - 1).toString("utf8");
        }
        return buf.subarray(p_offset, p_offset + p_filesz - 1).toString("utf8");
      }
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    // /proc not mounted, file missing, parse error — return null.
  }
  return null;
}
```

- [ ] **Step 3: Update `detectPlatform()` to combine arch + libc on Linux**

Replace the existing `detectPlatform()` with:

```ts
export function detectPlatform(): string {
  const os =
    process.platform === "darwin" ? "darwin" :
    process.platform === "linux" ? "linux" :
    process.platform === "win32" ? "win32" :
    process.platform;
  const arch =
    process.arch === "arm64" ? "arm64" :
    process.arch === "x64" ? "x64" :
    process.arch;
  if (os === "linux") {
    return `${os}-${arch}-${detectLibc()}`;
  }
  return `${os}-${arch}`;
}
```

- [ ] **Step 4: Run typecheck**

```bash
cd packages/libghostty-vt && bun run typecheck
```

Expected: PASS.

- [ ] **Step 5: Run smoke tests on darwin to confirm no regression**

```bash
cd packages/libghostty-vt && bun test test/smoke
```

Expected: same pass count as Phase 1. The three darwin-hardcoded tests (`path.test.ts`, `errors.test.ts`, `ffi.test.ts`) may now fail — they're rewritten in Tasks 2.4–2.6.

- [ ] **Step 6: Commit**

```bash
git add packages/libghostty-vt/src/internal/path.ts
git commit -m "feat(path): detect libc on Linux; six SUPPORTED_PLATFORMS

detectLibc() tries Bun's process.report.header.glibcVersionRuntime
first, falls back to reading /proc/self/exe ELF interpreter. Conservative
glibc default if both fail. Linux platform string is now os-arch-libc
(e.g. linux-x64-musl)."
```

---

### Task 2.3: Rewrite `path.test.ts` to be platform-aware

**Files:**
- Modify: `packages/libghostty-vt/test/smoke/path.test.ts`

The existing test hardcodes `darwin-arm64`. Make it platform-aware by importing `detectPlatform()` and asserting against the runtime-detected value.

- [ ] **Step 1: Read the current test**

```bash
cat packages/libghostty-vt/test/smoke/path.test.ts
```

Note the assertions that hardcode `darwin-arm64`.

- [ ] **Step 2: Rewrite using detectPlatform()**

Replace hardcoded `"darwin-arm64"` strings with `detectPlatform()` calls. Add an import:

```ts
import { detectPlatform } from "../../src/internal/path";
```

For each assertion that compared against `"darwin-arm64"`, change it to compare against `detectPlatform()`. For tests that asserted the resolver returns a specific path, update to assert the path **ends with** the appropriate basename (`libghostty-vt.dylib` or `libghostty-vt.so`) and contains the runtime platform string.

Example transformation (the exact original text varies per assertion):

```ts
// before
expect(resolved).toBe(join(packageRoot, "prebuilds/darwin-arm64/libghostty-vt.dylib"));

// after
const platform = detectPlatform();
const ext = platform.startsWith("darwin-") ? "dylib" : "so";
expect(resolved).toBe(join(packageRoot, `prebuilds/${platform}/libghostty-vt.${ext}`));
```

- [ ] **Step 3: Run the test**

```bash
cd packages/libghostty-vt && bun test test/smoke/path.test.ts -v
```

Expected: PASS on darwin.

- [ ] **Step 4: Commit**

```bash
git add packages/libghostty-vt/test/smoke/path.test.ts
git commit -m "test(smoke): make path.test.ts platform-aware

Replaces hardcoded darwin-arm64 assertions with detectPlatform()
lookups. Same coverage; passes on every supported platform."
```

---

### Task 2.4: Rewrite `errors.test.ts` to be platform-aware

**Files:**
- Modify: `packages/libghostty-vt/test/smoke/errors.test.ts`

The unsupported-platform error message will mention all six supported platforms now, not just darwin-arm64.

- [ ] **Step 1: Find the offending assertions**

```bash
grep -n "darwin-arm64\|UnsupportedPlatform" packages/libghostty-vt/test/smoke/errors.test.ts
```

- [ ] **Step 2: Rewrite assertions**

Change exact-match string assertions about the platform list to `toContain` checks. Example:

```ts
// before
expect(err.message).toBe("No bundled libghostty-vt for win32-x64. Supported: darwin-arm64. ...");

// after
expect(err.message).toContain("No bundled libghostty-vt for win32-x64");
expect(err.message).toContain("Supported: darwin-arm64, linux-x64-glibc");
```

- [ ] **Step 3: Run the test**

```bash
cd packages/libghostty-vt && bun test test/smoke/errors.test.ts -v
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/libghostty-vt/test/smoke/errors.test.ts
git commit -m "test(smoke): errors.test.ts asserts platform list non-exhaustively"
```

---

### Task 2.5: Rewrite `ffi.test.ts` to be platform-aware and use _resetForTest

**Files:**
- Modify: `packages/libghostty-vt/test/smoke/ffi.test.ts`

The test currently uses a literal `darwin-arm64` path. It also leaks a bad `setLibraryPath` override into subsequent tests in the same Bun process. Both are fixed.

- [ ] **Step 1: Find the leaky test and the hardcoded path**

```bash
grep -n "setLibraryPath\|darwin-arm64\|_resetForTest" packages/libghostty-vt/test/smoke/ffi.test.ts
```

- [ ] **Step 2: Wrap each `setLibraryPath` test in try/finally with `_resetForTest`**

Import `_resetForTest` (it's already exported from `src/ffi.ts`):

```ts
import { setLibraryPath, _resetForTest } from "../../src/ffi";
```

Wrap each test that mutates the override:

```ts
it("rejects setLibraryPath after first load", () => {
  try {
    // ... existing test body ...
  } finally {
    _resetForTest();
  }
});
```

- [ ] **Step 3: Replace hardcoded path with detectPlatform()-based path**

```ts
import { detectPlatform } from "../../src/internal/path";
// ...
const platform = detectPlatform();
const ext = platform.startsWith("darwin-") ? "dylib" : "so";
const validPath = join(packageRoot, `prebuilds/${platform}/libghostty-vt.${ext}`);
```

- [ ] **Step 4: Run the full smoke suite to confirm no leakage**

```bash
cd packages/libghostty-vt && bun test test/smoke
```

Expected: PASS, including any tests that come after `ffi.test.ts` alphabetically (which is what the leak previously corrupted).

- [ ] **Step 5: Commit**

```bash
git add packages/libghostty-vt/test/smoke/ffi.test.ts
git commit -m "test(smoke): ffi.test.ts platform-aware; cleans up overrides

setLibraryPath tests wrap in try/finally with _resetForTest so the
override doesn't bleed into subsequent tests in the same Bun process.
Hardcoded darwin-arm64 path replaced with detectPlatform()-based path."
```

---

### Task 2.6: Add by-value entry-point scanner to gen-bindings

**Files:**
- Modify: `packages/libghostty-vt/scripts/gen-bindings.ts`

Add a scanner that detects new by-value struct args in libghostty's headers. Output goes into `generated.ts` so `verify:generated` catches new shim-required entry points at every CI invocation.

- [ ] **Step 1: Locate the header-scanning section of gen-bindings.ts**

```bash
grep -n "vendor/ghostty/include\|readdirSync\|readFileSync.*\\.h" packages/libghostty-vt/scripts/gen-bindings.ts | head
```

- [ ] **Step 2: Add the scanner function**

In `gen-bindings.ts`, after the existing header-parsing helpers, add:

```ts
/**
 * Scan headers for function declarations with non-pointer struct args.
 * Returns a list of "<func-name>: <struct-type>" pairs. Used to generate
 * a static check in generated.ts so verify:generated trips on any new
 * by-value entry point that would need a shim wrapper.
 *
 * Heuristic regex; false positives are reviewed during pin-bump diff,
 * false negatives (silent miss) are the failure mode we're avoiding.
 */
function scanByValueEntryPoints(headerSrcConcat: string): string[] {
  // Match: GhosttyResult|void|... <name>(... <StructType> <argname>...)
  // Where <StructType> starts with Ghostty and the arg is NOT a pointer
  // (no `*` in the arg).
  //
  // Excludes known opaque-handle typedefs that are themselves pointer-
  // typed (passing them "by value" actually passes a pointer at the ABI
  // level; no shim needed). Excludes integer-typedef "handle" types
  // (GhosttyCell, GhosttyRow are uint64_t).
  const findings: string[] = [];
  const fnRegex = /(?:GhosttyResult|void|bool|size_t|uint\d+_t|int\d+_t)\s+(ghostty_[a-z_]+)\s*\(([^)]*)\)/g;
  const OPAQUE_OR_INTEGER_TYPEDEFS = new Set([
    // Pointer typedefs — passing "by value" passes a pointer in the C ABI.
    "GhosttyTerminal",
    "GhosttyFormatter",
    "GhosttyRenderState",
    "GhosttyRenderStateRowCells",
    "GhosttyKeyEncoder",
    "GhosttyKeyEvent",
    "GhosttyKittyGraphics",
    // Integer typedefs.
    "GhosttyCell",
    "GhosttyRow",
    "GhosttyResult",
    "GhosttyMode",
    "GhosttyKittyKeyFlags",
  ]);
  let m;
  while ((m = fnRegex.exec(headerSrcConcat))) {
    const fnName = m[1]!;
    const argList = m[2]!;
    for (const rawArg of argList.split(",")) {
      const arg = rawArg.trim();
      // Skip pointer args.
      if (arg.includes("*")) continue;
      // Match `<optional-const> Ghostty<Name> <argname>` exactly — a single
      // type word followed by an identifier, no `*`.
      const byValRe = /^(const\s+)?(Ghostty[A-Z][A-Za-z]+)\s+\w+$/;
      const mm = byValRe.exec(arg);
      if (mm && !OPAQUE_OR_INTEGER_TYPEDEFS.has(mm[2]!)) {
        findings.push(`${fnName}: ${mm[2]}`);
      }
    }
  }
  return findings;
}
```

- [ ] **Step 3: Wire the scanner into the generation step**

Find where the script writes `generated.ts`. Before the write, call the scanner over all header files:

```ts
const headerSrc = headers.map(h => h.source).join("\n\n");
const byValueEntryPoints = scanByValueEntryPoints(headerSrc);
// Sort for deterministic output across runs.
byValueEntryPoints.sort();
```

Add to the generated output (append near the existing exports):

```ts
output += `\n/** By-value entry points detected in libghostty-vt headers.\n`;
output += ` * Each must have a corresponding _p wrapper in native/shim.c.\n`;
output += ` * If this list grows on a pin bump, add the new wrapper before merging.\n`;
output += ` * Auto-generated; do not hand-edit. */\n`;
output += `export const byValueEntryPoints = [\n`;
for (const ep of byValueEntryPoints) {
  output += `  ${JSON.stringify(ep)},\n`;
}
output += `] as const;\n`;
```

- [ ] **Step 4: Run gen-bindings and inspect the output**

```bash
cd packages/libghostty-vt && bun run build:bindings
grep -A 10 "byValueEntryPoints" src/internal/generated.ts
```

Expected: a list of exactly four entries — `ghostty_terminal_new: GhosttyTerminalOptions`, `ghostty_formatter_terminal_new: GhosttyFormatterTerminalOptions`, `ghostty_terminal_grid_ref: GhosttyPoint`, `ghostty_terminal_scroll_viewport: GhosttyTerminalScrollViewport`.

If you see fewer than four — the regex is too narrow; widen it. If you see more — review whether the new entries actually take by-value structs (false positive) or whether the shim is genuinely missing wrappers (real bug).

- [ ] **Step 5: Run verify:generated**

```bash
cd packages/libghostty-vt && bun run verify:generated
```

Expected: PASS (no diff after the regen).

- [ ] **Step 6: Commit**

```bash
git add packages/libghostty-vt/scripts/gen-bindings.ts \
        packages/libghostty-vt/src/internal/generated.ts
git commit -m "build(bindings): scan headers for by-value entry points

generated.ts now emits a sorted list of detected by-value entry-point
function-name + struct-type pairs. verify:generated trips when a future
libghostty pin adds a new by-value site that would need a shim wrapper.
Currently lists the four wrapped entries in shim.c."
```

---

### Task 2.7: Add scripts/test-linux.sh for local Docker testing

**Files:**
- Create: `packages/libghostty-vt/scripts/test-linux.sh`

Local helper for running the smoke suite in all four Linux containers via OrbStack/Docker on macOS.

- [ ] **Step 1: Create the script**

```bash
mkdir -p packages/libghostty-vt/scripts
```

Create `packages/libghostty-vt/scripts/test-linux.sh`:

```bash
#!/usr/bin/env bash
# Run libghostty-vt smoke tests in Linux containers via Docker/OrbStack.
# On Apple Silicon: arm64 runs natively; x64 via Rosetta 2.
#
# Prerequisite: prebuilds/ must contain matching binaries for each target.
# Run `bun run build:linux` first, or build inside the container by passing
# BUILD=1.

set -euo pipefail
PKG_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PKG_ROOT"

BUILD="${BUILD:-0}"

run_in_container() {
  local platform="$1" image="$2" prebuild_dir="$3"
  echo "==== $platform ($image) ===="
  if [ "$BUILD" = "1" ]; then
    # Build inside the container before running tests.
    docker run --rm --platform "$platform" \
      -v "$PWD:/work" -w /work \
      "$image" \
      bash -c "apk add --no-cache build-base bash git zig 2>/dev/null || apt-get update -qq && apt-get install -y -qq bash git build-essential 2>/dev/null; bun run build:libghostty && bun test test/smoke"
  else
    if [ ! -d "prebuilds/$prebuild_dir" ]; then
      echo "prebuilds/$prebuild_dir not present; build first or pass BUILD=1" >&2
      return 1
    fi
    docker run --rm --platform "$platform" \
      -v "$PWD:/work" -w /work \
      "$image" \
      bun test test/smoke
  fi
}

run_in_container linux/arm64 oven/bun:debian linux-arm64-glibc
run_in_container linux/arm64 oven/bun:alpine  linux-arm64-musl
run_in_container linux/amd64 oven/bun:debian linux-x64-glibc
run_in_container linux/amd64 oven/bun:alpine  linux-x64-musl
echo "==== all matrix cells passed ===="
```

- [ ] **Step 2: Make it executable**

```bash
chmod +x packages/libghostty-vt/scripts/test-linux.sh
```

- [ ] **Step 3: Run it locally to verify**

(Requires OrbStack or Docker Desktop running, and Linux prebuilds in place from Task 2.1.)

```bash
cd packages/libghostty-vt && bash scripts/test-linux.sh
```

Expected: four PASS rows. On a 2026-era Mac mini M2, this takes ~3–4 minutes total.

- [ ] **Step 4: Commit**

```bash
git add packages/libghostty-vt/scripts/test-linux.sh
git commit -m "test: scripts/test-linux.sh runs smoke in 4 Linux containers

Apple Silicon: arm64 native, x64 via Rosetta 2. Requires Docker/OrbStack."
```

---

### Task 2.8: Update CI workflow with three-runner matrix

**Files:**
- Modify: `.github/workflows/ci.yml`

Three runners. Each Linux job builds both libc variants and runs smoke tests in matching Docker containers.

- [ ] **Step 1: Read the current workflow**

```bash
cat .github/workflows/ci.yml
```

- [ ] **Step 2: Replace with the matrix version**

Overwrite `.github/workflows/ci.yml`:

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  test:
    strategy:
      fail-fast: false
      matrix:
        include:
          - platform: darwin-arm64
            runner: macos-14
            targets: native
          - platform: linux-x64
            runner: ubuntu-24.04
            targets: x86_64-linux-gnu,x86_64-linux-musl
          - platform: linux-arm64
            runner: ubuntu-24.04-arm
            targets: aarch64-linux-gnu,aarch64-linux-musl
    runs-on: ${{ matrix.runner }}
    steps:
      - uses: actions/checkout@v4

      - name: Install Zig
        uses: mlugg/setup-zig@v2
        with:
          version: "0.15.2"

      - name: Install Bun
        uses: oven-sh/setup-bun@v2
        with:
          bun-version: "1.3.13"

      - name: bun install (workspace)
        run: bun install --frozen-lockfile

      - name: Build libghostty + shim (native or all targets)
        working-directory: packages/libghostty-vt
        run: |
          if [ "${{ matrix.targets }}" = "native" ]; then
            bun run build:libghostty
          else
            for t in ${{ matrix.targets }}; do
              echo "=== building $t ==="
              # Comma -> space split happens via the for loop's arg expansion
              # for the single-target case; here we use a bash pattern.
              :
            done
            IFS=',' read -ra TGTS <<< "${{ matrix.targets }}"
            for t in "${TGTS[@]}"; do
              TARGET="$t" bun run build:libghostty
            done
          fi

      - name: Build probe and regenerate bindings
        working-directory: packages/libghostty-vt
        run: bun run build:probe && bun run build:bindings

      - name: Verify generated.ts is up to date
        run: git diff --exit-code packages/libghostty-vt/src/internal/generated.ts

      - name: Typecheck
        working-directory: packages/libghostty-vt
        run: bun run typecheck

      - name: Smoke tests (darwin native)
        if: matrix.platform == 'darwin-arm64'
        working-directory: packages/libghostty-vt
        run: bun run test:smoke

      - name: Smoke tests (linux glibc + musl)
        if: startsWith(matrix.platform, 'linux-')
        working-directory: packages/libghostty-vt
        run: |
          set -e
          IFS=',' read -ra TGTS <<< "${{ matrix.targets }}"
          for t in "${TGTS[@]}"; do
            case "$t" in
              *-musl) IMAGE=oven/bun:alpine ;;
              *-gnu)  IMAGE=oven/bun:debian ;;
            esac
            echo "=== smoke for $t in $IMAGE ==="
            docker run --rm \
              -v "$GITHUB_WORKSPACE:/work" -w /work/packages/libghostty-vt \
              "$IMAGE" \
              bun test test/smoke
          done

      - name: Build TypeScript
        working-directory: packages/libghostty-vt
        run: bun run build:ts

      - name: Typecheck blinkyterm
        working-directory: packages/blinkyterm
        run: bun run typecheck

      - name: Test blinkyterm
        if: matrix.platform == 'darwin-arm64'
        working-directory: packages/blinkyterm
        run: bun run test

      - name: Upload prebuilds
        uses: actions/upload-artifact@v4
        with:
          name: prebuilds-${{ matrix.platform }}
          path: packages/libghostty-vt/prebuilds/
          retention-days: 7
```

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: matrix on darwin-arm64 + linux-{x64,arm64}

Each Linux job builds glibc+musl variants via cross-compile and runs
smoke tests in the matching Docker container. Prebuilds uploaded as
artifacts for the release workflow to consume."
```

- [ ] **Step 4: Push the branch and verify CI runs all three jobs**

```bash
git push -u origin <branch-name>
```

Expected: three jobs in GitHub Actions. All should go green if everything in Phase 1 + Phase 2 so far is correct. If a Linux job fails, debug locally with `scripts/test-linux.sh`.

---

### Task 2.9: Add release workflow

**Files:**
- Create: `.github/workflows/release.yml`

Tag-triggered. Downloads all six prebuild artifacts produced by the latest CI run on the tagged commit, lays them out, runs `bun pack` + `npm publish`.

- [ ] **Step 1: Create the release workflow**

`.github/workflows/release.yml`:

```yaml
name: Release

on:
  push:
    tags:
      - "v*"

jobs:
  publish:
    runs-on: macos-14
    steps:
      - uses: actions/checkout@v4

      - name: Install Bun
        uses: oven-sh/setup-bun@v2
        with:
          bun-version: "1.3.13"

      - name: bun install
        run: bun install --frozen-lockfile

      # Build the TS dist locally (no native rebuild needed; CI already produced
      # all prebuilds, which we pull below).
      - name: Build TypeScript
        working-directory: packages/libghostty-vt
        run: bun run build:ts

      # Pull the prebuilds from the CI run on this commit.
      - name: Download darwin-arm64 prebuild
        uses: actions/download-artifact@v4
        with:
          name: prebuilds-darwin-arm64
          path: packages/libghostty-vt/prebuilds/
          run-id: ${{ github.event.workflow_run.id || github.run_id }}
          github-token: ${{ secrets.GITHUB_TOKEN }}

      - name: Download linux-x64 prebuilds
        uses: actions/download-artifact@v4
        with:
          name: prebuilds-linux-x64
          path: packages/libghostty-vt/prebuilds/

      - name: Download linux-arm64 prebuilds
        uses: actions/download-artifact@v4
        with:
          name: prebuilds-linux-arm64
          path: packages/libghostty-vt/prebuilds/

      - name: Verify all six prebuilds present
        working-directory: packages/libghostty-vt
        run: |
          set -e
          for plat in darwin-arm64 linux-x64-glibc linux-x64-musl linux-arm64-glibc linux-arm64-musl; do
            ext=so
            [ "$plat" = "darwin-arm64" ] && ext=dylib
            test -f "prebuilds/$plat/libghostty-vt.$ext" || { echo "missing $plat lib"; exit 1; }
            test -f "prebuilds/$plat/libghostty-vt-shim.$ext" || { echo "missing $plat shim"; exit 1; }
          done
          echo "all six prebuilds present"

      - name: Tarball smoke
        working-directory: packages/libghostty-vt
        run: bash scripts/run-tarball-smoke.sh

      - name: Publish to npm
        working-directory: packages/libghostty-vt
        run: npm publish --access public
        env:
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
```

**Note**: this workflow depends on the CI run for the tagged commit having completed first, which is the typical flow when a tag is pushed after a green PR merge. If you tag a commit that hasn't completed CI, the artifact download step fails — which is the desired behavior.

- [ ] **Step 2: Commit**

```bash
git add .github/workflows/release.yml
git commit -m "ci(release): tag-triggered npm publish with all six prebuilds

Downloads CI artifacts, verifies all six prebuilds present, runs
tarball smoke, then npm publish. Requires NPM_TOKEN repo secret."
```

---

### Task 2.10: Update CLAUDE.md

**Files:**
- Modify: `CLAUDE.md`

Update gotchas to reflect the new platform support.

- [ ] **Step 1: Update Gotcha #1 (darwin-arm64 only)**

Find:

```
1. **darwin-arm64 only.** Don't add Linux/Windows/x64 code paths. ...
```

Replace with:

```
1. **Supported platforms: darwin-arm64, linux-{x64,arm64} × {glibc,musl}.** Six prebuilds total. Windows is out of scope; the build script and path resolver both reject it explicitly. See `docs/superpowers/specs/2026-05-06-linux-portability-design.md`.
```

- [ ] **Step 2: Delete Gotcha #5 (register-split is AAPCS64-specific)**

The whole gotcha can go — register-split was eliminated in favor of the universal shim.

Replace with:

```
5. **All by-value libghostty entry points go through the shim.** `native/shim.c` wraps four entry points (`ghostty_terminal_new`, `ghostty_formatter_terminal_new`, `ghostty_terminal_grid_ref`, `ghostty_terminal_scroll_viewport`) with `_p` pointer-taking variants. The binding dispatches the unsuffixed names through the shim via a splice in `getLib()`. **When bumping `ghostty.commit`, run `bun run verify:generated` — the by-value entry-point scanner catches new sites that would need wrappers.**
```

- [ ] **Step 3: Add a release-process note for the six-prebuild flow**

In the "Release process" section, after the existing steps, add:

```
## Six-prebuild release flow

Tag push triggers `.github/workflows/release.yml`, which downloads all six prebuild artifacts from the CI run on the tagged commit, verifies they're present, runs the tarball smoke test, and publishes to npm. The release job never builds native code itself — it consumes exactly what CI tested.

Local `bun pack` for inspection still works on darwin, but only includes the local platform's prebuild. To produce the full multi-platform tarball locally, you'd need to download the CI artifacts manually (see release.yml for the recipe).
```

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md
git commit -m "docs(claude): update gotchas for six-prebuild + shim universal

Gotcha #1 reflects six-platform support. Gotcha #5 rewritten — the
shim replaces the AAPCS64 register-split. Release process gains a
six-prebuild section."
```

---

### Task 2.11: Update README

**Files:**
- Modify: `packages/libghostty-vt/README.md`

Document the supported platforms and the shim presence.

- [ ] **Step 1: Read the current README**

```bash
cat packages/libghostty-vt/README.md | head -60
```

- [ ] **Step 2: Update the supported-platforms section**

Find any mention of "darwin-arm64 only" or platform support. Replace with:

```markdown
## Supported platforms

- macOS arm64 (Apple Silicon)
- Linux x64 (glibc and musl)
- Linux arm64 (glibc and musl)

All six prebuilds ship in the npm tarball. The library auto-detects glibc vs musl on Linux at runtime.

**Override the bundled binary** by setting `GHOSTTY_VT_LIB` (the main library) and/or `GHOSTTY_VT_SHIM_LIB` (the portability shim) before importing. The two libraries must be co-located in the same directory if either is overridden — the shim's runtime dependency on `libghostty-vt` is resolved relative to the shim's own directory.

Windows is not supported.
```

- [ ] **Step 3: Commit**

```bash
git add packages/libghostty-vt/README.md
git commit -m "docs(readme): list six supported platforms"
```

---

### Task 2.12: Update CHANGELOG

**Files:**
- Modify: `packages/libghostty-vt/CHANGELOG.md`

Add a `[0.6.0]` entry summarizing the user-visible changes.

- [ ] **Step 1: Read the current CHANGELOG**

```bash
head -40 packages/libghostty-vt/CHANGELOG.md
```

- [ ] **Step 2: Add the v0.6.0 entry**

Insert at the top, below the `[Unreleased]` section if present:

```markdown
## [0.6.0] - 2026-05-06

### Added

- **Linux support** for x64 and arm64, on both glibc and musl distros. The npm tarball now ships six prebuilds (`darwin-arm64`, `linux-x64-{glibc,musl}`, `linux-arm64-{glibc,musl}`).
- `setShimLibraryPath()` and `GHOSTTY_VT_SHIM_LIB` for overriding the location of the portability shim binary.
- `libraryInfo().shimPath` exposes the loaded shim's path.
- New native/shim.c source ships in the tarball alongside prebuilds.

### Changed

- The binding now does two `dlopen` calls (main library + portability shim). Four by-value entry points (`ghostty_terminal_new`, `ghostty_formatter_terminal_new`, `ghostty_terminal_grid_ref`, `ghostty_terminal_scroll_viewport`) are dispatched through the shim's `_p` variants. This replaces the previous darwin-arm64-specific AAPCS64 register-split + hidden-pointer tricks with a universal pointer-passing strategy.
- Build script now supports cross-compilation via the `TARGET` env var (Linux triples).

### Removed

- Darwin-arm64-specific FFI register-splitting code paths in `src/ffi.ts` and the matching call site in `src/terminal.ts` are gone. A custom build of `libghostty-vt` on darwin-arm64 with the previous binding will not load against v0.6.0 — install the matching shim alongside.
```

- [ ] **Step 3: Commit**

```bash
git add packages/libghostty-vt/CHANGELOG.md
git commit -m "docs(changelog): v0.6.0 entry"
```

---

### Task 2.13: Bump version to 0.6.0

**Files:**
- Modify: `packages/libghostty-vt/package.json`

Final step before tagging.

- [ ] **Step 1: Bump the version**

In `packages/libghostty-vt/package.json`, change:

```json
"version": "0.5.1",
```

to:

```json
"version": "0.6.0",
```

- [ ] **Step 2: Run the full test suite one more time**

```bash
cd packages/libghostty-vt && bun run test
```

Expected: PASS on darwin-arm64. CI will verify Linux jobs once pushed.

- [ ] **Step 3: Run the local Linux smoke (if Docker is available)**

```bash
cd packages/libghostty-vt && bash scripts/test-linux.sh
```

Expected: all four matrix cells pass.

- [ ] **Step 4: Commit**

```bash
git add packages/libghostty-vt/package.json
git commit -m "chore(release): v0.6.0"
```

- [ ] **Step 5: Tag**

```bash
git tag -a v0.6.0 -m "v0.6.0 - Linux support (six prebuilds, universal shim)"
```

Don't push the tag yet. Push the branch first; merge to main; then push the tag from main:

```bash
git push -u origin <branch-name>
# Once merged via PR:
git checkout main && git pull
git push origin v0.6.0
```

The release workflow runs on the tag push.

---

## Phase 2 acceptance

After Task 2.13, all of the following must be true:

- [ ] CI passes on all three matrix runners (darwin-arm64, linux-x64, linux-arm64).
- [ ] `bash scripts/test-linux.sh` passes locally on a developer Mac (optional but recommended).
- [ ] `bun run verify:generated` passes — `byValueEntryPoints` lists exactly the four wrapped entry points.
- [ ] `bash scripts/run-tarball-smoke.sh` passes on darwin.
- [ ] `packages/libghostty-vt/prebuilds/` contains all six platform directories with both `libghostty-vt.<ext>` and `libghostty-vt-shim.<ext>` (and the Linux symlink chains).
- [ ] `package.json` version is `0.6.0` and `CHANGELOG.md` has the matching entry.
- [ ] Tag `v0.6.0` triggers `release.yml`, which publishes successfully.

When all are green: announce in the PR description, request review, merge, push the tag.

---

## Notes for implementers

- **Single tasks, single commits.** Each task ends with a commit. If a task spans multiple files, commit them together; if a step says "stage but don't commit," the next task's commit covers both. Avoid big merge-windows.
- **Phase 1 first, no exceptions.** The shim adoption on darwin-arm64 is the riskiest single migration — it's the only step that changes existing user behavior. If Phase 1 isn't fully green, do not begin Phase 2.
- **Run `verify:generated` after every task that touches the shim or the FFI surface.** The trip-wire is cheap and catches many shapes of mistake early.
- **Don't bump the Ghostty pin in this PR.** This is a portability change, not a Ghostty bump. If a pin bump is needed for unrelated reasons, do it in a separate PR before or after.
- **The `.tmp/recon-linux/` directory is reference material.** Scout's artifacts (shim source, build script, overlay patches, prebuilt .so's, smoke logs) are useful when debugging — they're a known-good baseline. Do not commit them.
