# Linux portability for libghostty-vt

**Date:** 2026-05-06
**Author:** Murderbot (Bob a44b3fb9 / Opus 4.7 1M)
**Recon:** Scout (Bob — see `.tmp/recon-linux/REPORT.md`)
**Pin context:** ghostty `e88c6c099152dd6d2d7e517516e1f3c183c152f7`, libghostty-vt v0.5.1

## Goal

`libghostty-vt` should build and run on darwin-arm64, linux-x64, and linux-arm64 from a single public clone, with prebuilt binaries shipped in the npm tarball for every supported platform. Today the build script *attempts* Linux but the runtime resolver rejects everything except darwin-arm64 — that mismatch is the bug we are fixing.

## Non-goals

- **Windows.** The path resolver may emit a slightly more inviting error message, but no build path. Adding Windows later is roughly 1–2 days of CI plumbing on top of this design (the shim design is already calling-convention-agnostic).
- **Multiple Bun versions.** Continue to pin `1.3.13`. Multi-version testing is a future CI matrix expansion, not an architecture change.
- **Source-build flow for end users.** Prebuilds only. No `node-gyp`-style postinstall compile.
- **Public API changes.** This is a portability change; `Terminal`, `Formatter`, etc. stay byte-for-byte identical to consumers. This release is a minor (`0.6.0`) by semver.
- **Refactoring blinkyterm or the agent runner.** They consume the public API, which is unchanged.

## Confirmed findings from recon

The recon Bob (Scout) verified the following empirically by building and running the smoke suite in Docker containers across all four Linux matrix cells. Full evidence in `.tmp/recon-linux/`.

| Hypothesis | Result |
|---|---|
| Static-musl Zig builds work on both glibc and musl distros | **FALSE.** Zig's `-Dtarget=*-linux-musl` produces dynamically-linked binaries with `NEEDED libc.so` (no SO version). Fails on glibc systems with "cannot open libc.so"; glibc-target binaries fail on musl with "getcontext: symbol not found". Confirmed both directions. |
| The four-symbol C shim is sufficient for Linux portability | **TRUE.** Smoke tests pass on linux-x64 and linux-arm64 against both glibc and musl with the shim approach. |
| `bun:ffi` has no Linux-specific quirks | **TRUE.** `dlopen`, `JSCallback`, callback re-entry guards all behave identically to darwin. |
| `generated.ts` is bit-identical across platforms | **TRUE.** Probe output diff'd empty across darwin-arm64, linux-arm64, linux-x64. |
| The shim approach is portable enough to replace AAPCS64 register-split on darwin too | **TRUE.** Recommended: adopt universally. One code path, no platform-specific FFI logic remains. |

**Consequence:** we ship six prebuilds, not three. `darwin-arm64`, `linux-x64-glibc`, `linux-x64-musl`, `linux-arm64-glibc`, `linux-arm64-musl`, plus the shim alongside each.

## Architecture

### The shim

A new file `packages/libghostty-vt/native/shim.c` (~50 lines, written and verified by Scout). Wraps the four by-value entry points with pointer-taking variants:

- `ghostty_terminal_new_p`
- `ghostty_formatter_terminal_new_p`
- `ghostty_terminal_grid_ref_p`
- `ghostty_terminal_scroll_viewport_p`

Each `_p` function takes a pointer to the by-value struct argument and dereferences it before calling the upstream entry point. The shim is built per-platform into `libghostty-vt-shim.{dylib,so}`.

The binding does **two `dlopen` calls**: the main library (all entry points except the four wrapped ones) and the shim (the four `_p` variants). Both library handles are stored; FFI calls dispatch to the appropriate one.

**This is universal.** darwin-arm64, linux-x64, linux-arm64 all use the shim. The AAPCS64 register-split currently in `src/ffi.ts` is removed, including the `(opts_lo, opts_hi)` argument pair on `ghostty_terminal_new` and the platform-specific commentary at lines 22–27, 144, 199, 266–268. The `terminal.ts` code that packs options into two `u64`s simplifies to "marshal options into a `Uint8Array`, pass `ptr(bytes)`."

**Callbacks are unaffected.** The four wrapped entry points don't take callback arguments, and `JSCallback` function pointers are library-handle-agnostic — they're function pointers that the OS resolves the same way regardless of which dlopen handle they came from. The shim does not need to interact with `src/internal/callbacks.ts`, and the existing callback re-entry guards in `Terminal#assertNotInCallback` continue to work identically.

CLAUDE.md gotcha #5 (register-split is AAPCS64-specific) is deleted; gotcha #1 (darwin-arm64 only) is updated to list all six supported triples.

### Six prebuild slots

`packages/libghostty-vt/prebuilds/` gains five new directories:

```
prebuilds/
  darwin-arm64/
    libghostty-vt.dylib
    libghostty-vt-shim.dylib
  linux-x64-glibc/
    libghostty-vt.so          → libghostty-vt.so.<MAJOR>
    libghostty-vt.so.<MAJOR>  → libghostty-vt.so.<FULL-VERSION>
    libghostty-vt.so.<FULL-VERSION>
    libghostty-vt-shim.so
  linux-x64-musl/
    (same shape)
  linux-arm64-glibc/
    (same shape)
  linux-arm64-musl/
    (same shape)
```

The Linux symlink chain (`.so → .so.<MAJOR> → .so.<FULL>`) must be preserved — the shim's `NEEDED` entry resolves `libghostty-vt.so.<MAJOR>`, not the bare `.so`. Scout confirmed this is a real failure mode if the build script's `cp` dereferences the symlink (which the current darwin-only script does).

**The version components are not hardcoded.** Zig sets the SOVERSION based on libghostty-vt's internal version metadata, which can change at any pin bump. The build script reads the SONAME from the produced `.so` (via `readelf -d` on Linux, `otool -D` on darwin) and constructs the symlink chain from the discovered values. Hardcoding `.so.0.1.0` would silently break on a future pin bump.

### Path resolver and runtime

`src/internal/path.ts`:

```ts
export const SUPPORTED_PLATFORMS = [
  "darwin-arm64",
  "linux-x64-glibc",
  "linux-x64-musl",
  "linux-arm64-glibc",
  "linux-arm64-musl",
] as const;
```

`detectPlatform()` gains a `detectLibc()` step on Linux. The implementation uses two strategies in order:

```ts
function detectLibc(): "glibc" | "musl" {
  // Strategy 1: Bun reproduces Node's process.report shape. When present and
  // populated, header.glibcVersionRuntime is non-empty on glibc systems and
  // empty/missing on musl. Note: Bun's compat with this Node API is not
  // formally documented; we treat it as best-effort and fall through to
  // strategy 2 if it returns nothing useful.
  const report = (process as any).report?.getReport?.();
  const glibc = report?.header?.glibcVersionRuntime;
  if (typeof glibc === "string" && glibc.length > 0) return "glibc";

  // Strategy 2: read /proc/self/exe ELF interpreter. musl uses a path like
  // /lib/ld-musl-x86_64.so.1; glibc uses /lib64/ld-linux-x86-64.so.2. ~15
  // lines of node:fs to read the ELF header's PT_INTERP segment and string-
  // match. This is the authoritative answer when present.
  return readElfInterpreter() ?? "glibc"; // default glibc if neither works
}
```

Strategy 1 is the fast path; strategy 2 is the correctness floor. Both ship in v1 — recon-confirmed Bun behavior is encouraging but not contractual, and the ELF fallback is small enough that deferring it would just be debt. The `?? "glibc"` final fallback is conservative: glibc is the more common runtime, and if the ELF read fails for some reason (e.g., `/proc` not mounted), failing to glibc gives a load attempt rather than a hard error, with the dlopen failure providing a clear diagnostic.

A new resolver function `resolveShimLibraryPath()` mirrors the existing `resolveLibraryPath()` for the shim binary. `setLibraryPath()` gets a parallel `setShimLibraryPath()`; `GHOSTTY_VT_LIB` gets a parallel `GHOSTTY_VT_SHIM_LIB`. We do **not** auto-derive one from the other when an override is set — explicit is better than clever, and a user with a custom build will know to set both.

**Co-location requirement for shim overrides.** The shim's runtime dependency on `libghostty-vt.so.<MAJOR>` is resolved via `$ORIGIN` (Linux) or `@loader_path` (darwin) — the loader looks in the shim's own directory. This means: if a user calls `setShimLibraryPath()` to point at a custom shim, the matching `libghostty-vt` symlink chain (or `.dylib`) **must be co-located** in the same directory as the shim. Documenting this as part of the public API contract for the override functions, not solving with a more elaborate rpath scheme.

`src/ffi.ts` splits its symbol table into `MAIN_SYMBOLS` and `SHIM_SYMBOLS`, dlopened from the two libraries respectively. The four `_p` symbols replace the existing entries; their FFI signatures simplify to standard `[FFIType.ptr, FFIType.ptr, FFIType.ptr]` shapes with `FFIType.i32` returns (or `void` for `_scroll_viewport_p`).

## Build pipeline

### Build script changes

`packages/libghostty-vt/scripts/build-libghostty.sh` is restructured to support cross-compilation and per-libc Linux variants. The new shape:

1. **Detect host platform** (unchanged) for darwin-arm64 native builds.
2. **For Linux jobs**, accept a target triple parameter (`x86_64-linux-gnu`, `x86_64-linux-musl`, etc.) and pass it to `zig build install -Dtarget=<triple>`. Cross-compilation works because Zig is a cross-compiler.
3. **Locate the produced `.so` robustly** — Zig's output path varies between native and cross builds (`zig-out/lib/libghostty-vt.so` vs `zig-out/lib/<triple>/libghostty-vt.so`). Scout's reference script (`.tmp/recon-linux/build-libghostty.sh`) iterates candidate paths.
4. **Discover SONAME and preserve the symlink chain** when copying the .so to `prebuilds/<platform>/`. Read the SONAME from the produced binary (`readelf -d` on Linux output, `otool -D` on darwin output), then construct the appropriate symlink chain (`.so → .so.<MAJOR> → .so.<FULL>` on Linux, plain `.dylib` on darwin since macOS doesn't use the same versioned-soname pattern).
5. **Build the shim** with platform-appropriate rpath:
   - **Linux**: `zig cc -O2 -fPIC -shared -target <triple> -Wl,-rpath,'$ORIGIN' -Wl,-soname,libghostty-vt-shim.so` against the just-built libghostty-vt.
   - **darwin**: `zig cc -O2 -fPIC -shared -Wl,-install_name,@rpath/libghostty-vt-shim.dylib -Wl,-rpath,@loader_path` against the just-built libghostty-vt. macOS's loader uses `@loader_path` (the directory of the loading binary), not `$ORIGIN`. The `-install_name` ensures consumers can find the shim through `@rpath`.

The shim build uses `zig cc` on every platform so the same toolchain handles cross-compilation transparently. (Recon used `zig cc` and confirmed it produces correct binaries for all four Linux triples; darwin uses `zig cc` for consistency with the rest of the toolchain story.)

### CI matrix

`.github/workflows/ci.yml` gains a matrix:

```yaml
strategy:
  matrix:
    include:
      - platform: darwin-arm64
        runner: macos-14
        targets: [native]
      - platform: linux-x64
        runner: ubuntu-24.04
        targets: [x86_64-linux-gnu, x86_64-linux-musl]
      - platform: linux-arm64
        runner: ubuntu-24.04-arm
        targets: [aarch64-linux-gnu, aarch64-linux-musl]
```

**Critical**: Linux runners must be native-arch. Scout discovered that Zig 0.15.2 crashes under Rosetta 2 (`index out of bounds in Random.shuffleWithIndex`). Cross-compiling x86_64 from a native arm64 builder works fine; the runner just must not itself be an emulated environment.

Each Linux job builds both libc variants (glibc + musl) via cross-compile within the same job. Smoke tests for each variant run inside the matching Docker container (`debian:12-slim` for glibc, `alpine:3.20` for musl) — the host runner is glibc, but the test execution mounts the prebuild into the container so the dlopen happens against the matching libc.

`verify:generated` runs on every platform job. The probe should produce identical output across all three (Scout confirmed); if it ever doesn't, CI fails fast and we have a real ABI portability bug to investigate before merging.

**On divergence: do NOT auto-shard.** If platform divergence is ever detected, the binding does not auto-shard `generated.ts` into per-platform files. CI fails the merge, and the discovery doc + design must be updated to handle the divergence explicitly — most likely a focused investigation of which struct or enum diverged and why (likely a pin-bump regression upstream). Baking in latent per-platform-shard support speculatively would create a maintenance burden for a problem we don't have.

### Release flow

CI uploads each platform's `prebuilds/<platform>/` directory as an artifact. A release workflow (triggered on tag push, e.g. `v0.6.0`) downloads all six artifacts, lays them out into `packages/libghostty-vt/prebuilds/`, then runs `bun pack` + `npm publish`. The release job runs on macos-14 — convenient because that's already where the existing tarball smoke test runs, and the local darwin-arm64 build is a no-op overlay onto the CI artifact.

The publish step never builds anything itself. Prebuilds it consumes are exactly the artifacts CI just produced and tested.

## Testing strategy

### CI

The existing smoke suite (`bun test test/smoke`) runs unchanged on every matrix cell. That's the FFI verification: if the shim is right, all ~145 smoke tests pass; if it's wrong, the four wrapped entry points fail in obvious ways.

### Local Linux testing via OrbStack

A new `scripts/test-linux.sh` enables fast local iteration on a Mac:

```sh
#!/usr/bin/env bash
# Run smoke tests in Linux containers via OrbStack/Docker Desktop.
# Apple Silicon: arm64 runs natively; x64 via Rosetta 2.
docker run --rm --platform linux/arm64 -v "$PWD:/w" -w /w oven/bun:debian bun test test/smoke
docker run --rm --platform linux/arm64 -v "$PWD:/w" -w /w oven/bun:alpine bun test test/smoke
docker run --rm --platform linux/amd64 -v "$PWD:/w" -w /w oven/bun:debian bun test test/smoke
docker run --rm --platform linux/amd64 -v "$PWD:/w" -w /w oven/bun:alpine bun test test/smoke
```

Each container needs the matching prebuild present in `prebuilds/<platform>/`; the script either expects them pre-built (e.g. via `bun run build:linux`) or builds them on demand using a small builder image. The arm64 path runs natively on Apple Silicon; the x64 path uses Rosetta 2.

This is for local debugging convenience, not a contributor requirement. CI is the gate.

### Tests requiring rewrite

Three smoke tests are currently darwin-arm64-hardcoded and will fail on Linux without changes:

- `test/smoke/path.test.ts` — hardcodes the `darwin-arm64` triple.
- `test/smoke/errors.test.ts` — asserts the unsupported-platform message mentions darwin-arm64 specifically.
- `test/smoke/ffi.test.ts` — uses a literal `prebuilds/darwin-arm64/libghostty-vt.dylib` path; additionally leaks a bad `setLibraryPath` override into all subsequent tests in the same Bun process when run on Linux.

Each needs to be made platform-aware: import `detectPlatform()` and assert against the runtime-detected value, or assert generic structural properties instead of specific strings.

**Fix for the `ffi.test.ts` leak specifically**: each test that calls `setLibraryPath()` must wrap the call in `try { ... } finally { _resetForTest(); }` (or the equivalent reset hook) so the override does not persist past the test boundary. If `_resetForTest` does not exist today, add it as part of this work — it should clear the cached library handles, the override path, and any FFI symbol cache. Alternatively, run `ffi.test.ts` as a standalone bun process (separate test invocation) so process-level state doesn't bleed.

### New tests worth adding

- **`shim-presence.test.ts`** (all platforms): verify both libraries load and that the four `_p` symbols exist in the shim. Catches a silent shim build that produces an empty `.so`.
- **`musl-portability.test.ts`** (Linux jobs): runs a subset of smoke tests inside `alpine:3.20` to confirm musl prebuilds work. Already implicitly covered by the CI matrix; this is just a documented entry point.

## Risks

The recon eliminated most of the speculative risks. Real residuals:

### Risk 1: Future libghostty pin adds new by-value entry points

**Detection**: extend `verify:generated` to scan `vendor/ghostty/include/**/*.h` for function declarations whose argument list contains a non-pointer struct type, and emit the list of detected by-value entry points alongside the generated bindings. The trip-wire diff then catches new entries. This runs every CI invocation, not just on pin bumps — much harder to miss than a "remember to grep when bumping" CLAUDE.md note.

The scanner can be a simple regex pass over preprocessed headers (look for `Ghostty[A-Z][A-Za-z]*\s+[a-z_]+\s*\)` not preceded by `*` or `const`-ptr forms in function-param positions). False positives are fine — they get reviewed during the pin-bump diff. False negatives (silent miss of a new by-value site) are the failure mode we're avoiding.

A CLAUDE.md note still gets added as the human-readable description of the rule, but the scanner is the enforcement mechanism.

### Risk 2: GitHub's free arm64 Linux runners change pricing or availability

`prime-radiant-inc/ts-libghostty` is a public repo, so `ubuntu-24.04-arm` runners are currently free. GitHub announced these as GA in 2024. If pricing changes, or if the repo ever becomes private (paid arm64 minutes apply), fallback options: BuildJet hosted runners (paid), self-hosted runner, or cross-compile linux-arm64 on linux-x64 CI and skip the smoke test on arm64 (worse outcome but not blocking).

### Risk 3: A future Bun version breaks `process.report.getReport().header.glibcVersionRuntime`

This is undocumented Node.js API exposed by Bun. If Bun ever stops populating it, libc detection breaks. **Fallback**: read `/proc/self/exe` ELF interpreter directly (musl binaries have an interpreter like `/lib/ld-musl-x86_64.so.1`; glibc binaries use `/lib64/ld-linux-x86-64.so.2`). About 20 lines of Node `fs` code. Worth keeping in mind but not pre-building.

### Risk 4: Symlink preservation on Windows-formatted volumes

Some developers may have the repo checked out on a volume that doesn't preserve symlinks (e.g., a synced Dropbox folder). The `.so → .so.<MAJOR> → .so.<FULL>` chain breaks. Detection: the shim fails to load with "cannot find libghostty-vt.so.<MAJOR>". Mitigation: the build script can fall back to copying the file three times under different names if symlink creation fails. Not solving in v1; documenting in CLAUDE.md.

### Risk 5: Darwin migration regression

This is the **highest-impact** risk in the implementation, called out separately because all the speculative Linux risks are now handled. The shim adoption changes existing darwin-arm64 behavior from "single dylib loaded via the existing FFI table" to "two libraries loaded, four symbols dispatched through the shim." If the shim is missing from the tarball, mis-built, or fails to load for any reason, **darwin users on v0.6.0 break entirely** — and that's our existing user base, not new Linux adopters.

**No fallback path.** The spec wants one code path; we do not retain the AAPCS64 register-split as a backup. If the shim can't load, the binding errors out with a clear "shim library missing or failed to load" message at first use.

**Gate**: the existing tarball smoke test (`scripts/run-tarball-smoke.sh`) is the publish gate. It packs the package locally, installs into a temp project, and runs a basic smoke. We extend it to also verify both libraries load and that the four `_p` symbols are dispatched correctly. If the tarball smoke test passes on darwin-arm64, the shim is integrated correctly for shipping; if it fails, no publish.

**Mitigation order during implementation**: the roadmap (below) deliberately puts darwin shim integration first, in isolation, with the existing test suite as the verification harness. We do not begin Linux work until darwin is fully migrated and green. This is the riskiest single migration; we surface it before adding cross-platform complexity on top.

## Implementation roadmap

The implementation plan (separate doc, written next via the writing-plans skill) will sequence the work in two distinct phases. **Phase 1 must be complete and green before Phase 2 begins.**

### Phase 1: Darwin shim migration (highest-risk, in isolation)

1. Add `native/shim.c` (already written by Scout; copy in from `.tmp/recon-linux/shim/`).
2. Extend the build script to also build the shim for darwin-arm64. Update SONAME discovery (`otool -D`) and symlink/install_name handling per the build pipeline section.
3. Update `src/ffi.ts` to dlopen both libraries and dispatch the four `_p` symbols through the shim. Remove the AAPCS64 register-split code.
4. Update `terminal.ts` and any other call sites that currently pack options for register-split — they all simplify to "marshal into Uint8Array, pass `ptr(bytes)`."
5. Update the path resolver to support shim resolution alongside the main library; add `setShimLibraryPath()` and `GHOSTTY_VT_SHIM_LIB`.
6. Add the `_resetForTest` cleanup hook (or fix `ffi.test.ts` directly) so override tests don't leak into subsequent tests in the same Bun process.
7. Run the full smoke suite, the tarball smoke test, and blinkyterm tests on darwin-arm64. **Phase 1 is not complete until all three are green.**

If Phase 1 fails, revert; the design needs revisiting before continuing.

### Phase 2: Linux portability (fan-out)

8. Extend the build script to support cross-compilation and per-libc Linux variants (`zig cc -target <triple>`). Includes by-value scanner addition to `verify:generated`.
9. Update `SUPPORTED_PLATFORMS` to include the four Linux triples; implement `detectLibc()` with both Bun-process-report and ELF-interpreter strategies.
10. Rewrite the three darwin-hardcoded smoke tests to be platform-aware (`path.test.ts`, `errors.test.ts`, `ffi.test.ts`).
11. Update the CI workflow to a three-runner matrix with per-libc sub-targets on Linux jobs. Smoke tests run inside `debian:12-slim` and `alpine:3.20` containers respectively.
12. Add `scripts/test-linux.sh` for local Docker-based testing on a Mac host.
13. Set up the release workflow that aggregates the six prebuild artifacts on tag push.
14. Update CLAUDE.md (gotcha #1, gotcha #5 deletion, new Risk 1/Risk 5 notes), README (supported platforms, install matrix), and CHANGELOG (`v0.6.0` entry).

## Why six prebuilds, not fewer

Worth recording explicitly: the obvious "ship one static-musl binary that runs on both glibc and musl" approach does not work. Scout verified this empirically — Zig's `-Dtarget=*-linux-musl` produces a dynamically-linked binary with `NEEDED libc.so` (no SO version), which fails on glibc systems with "cannot open libc.so" and on glibc-target binaries fails on musl with "getcontext: symbol not found". A truly static binary using `zig build-lib -static` is theoretically possible but requires libghostty-vt to have zero glibc-versioned-symbol dependencies (the recon failure included `getcontext` from the Oniguruma path). More elaborate tricks like Cosmopolitan's APE are vastly out of scope. Six prebuilds is the right number.

## Settled implementation decisions

- **Toolchain for shim builds**: `zig cc` on every platform (darwin and Linux). Consistent with the rest of the build pipeline; recon-validated.
- **Release flow**: auto-publish on tag push, not human-triggered. CI's prebuild artifacts are exactly what the publish step consumes; the publish step does not build anything itself. If a release needs to be held, that's done at the tag-creation step (PR review, manual tag).
- **Symlink-preservation strategy**: Scout's reference script (`.tmp/recon-linux/build-libghostty.sh`) is the basis. SONAME discovery via `readelf -d` on Linux and `otool -D` on darwin; symlinks created with `ln -sf`.
