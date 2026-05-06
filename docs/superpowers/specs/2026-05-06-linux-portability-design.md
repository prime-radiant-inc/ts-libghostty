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

CLAUDE.md gotcha #5 (register-split is AAPCS64-specific) is deleted; gotcha #1 (darwin-arm64 only) is updated to list all six supported triples.

### Six prebuild slots

`packages/libghostty-vt/prebuilds/` gains five new directories:

```
prebuilds/
  darwin-arm64/
    libghostty-vt.dylib
    libghostty-vt-shim.dylib
  linux-x64-glibc/
    libghostty-vt.so          → libghostty-vt.so.0
    libghostty-vt.so.0        → libghostty-vt.so.0.1.0
    libghostty-vt.so.0.1.0
    libghostty-vt-shim.so
  linux-x64-musl/
    (same shape)
  linux-arm64-glibc/
    (same shape)
  linux-arm64-musl/
    (same shape)
```

The Linux symlink chain (`.so → .so.0 → .so.0.1.0`) must be preserved — the shim's `NEEDED` entry resolves `libghostty-vt.so.0`, not the bare `.so`. Scout confirmed this is a real failure mode if the build script's `cp` dereferences the symlink (which the current darwin-only script does).

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

`detectPlatform()` gains a `detectLibc()` step on Linux:

```ts
function detectLibc(): "glibc" | "musl" {
  // Bun exposes glibc version via process.report. Empty/missing → musl.
  const report = (process as any).report?.getReport?.();
  const glibc = report?.header?.glibcVersionRuntime;
  return glibc ? "glibc" : "musl";
}
```

This is the documented mechanism; it's how Node.js's `detect-libc` package works under the hood. Scout's recon confirmed it returns the expected values inside Debian and Alpine containers.

A new resolver function `resolveShimLibraryPath()` mirrors the existing `resolveLibraryPath()` for the shim binary. `setLibraryPath()` gets a parallel `setShimLibraryPath()`; `GHOSTTY_VT_LIB` gets a parallel `GHOSTTY_VT_SHIM_LIB`. We do **not** auto-derive one from the other when an override is set — explicit is better than clever, and a user with a custom build will know to set both.

`src/ffi.ts` splits its symbol table into `MAIN_SYMBOLS` and `SHIM_SYMBOLS`, dlopened from the two libraries respectively. The four `_p` symbols replace the existing entries; their FFI signatures simplify to standard `[FFIType.ptr, FFIType.ptr, FFIType.ptr]` shapes with `FFIType.i32` returns (or `void` for `_scroll_viewport_p`).

## Build pipeline

### Build script changes

`packages/libghostty-vt/scripts/build-libghostty.sh` is restructured to support cross-compilation and per-libc Linux variants. The new shape:

1. **Detect host platform** (unchanged) for darwin-arm64 native builds.
2. **For Linux jobs**, accept a target triple parameter (`x86_64-linux-gnu`, `x86_64-linux-musl`, etc.) and pass it to `zig build install -Dtarget=<triple>`. Cross-compilation works because Zig is a cross-compiler.
3. **Locate the produced `.so` robustly** — Zig's output path varies between native and cross builds (`zig-out/lib/libghostty-vt.so` vs `zig-out/lib/<triple>/libghostty-vt.so`). Scout's reference script (`.tmp/recon-linux/build-libghostty.sh`) iterates candidate paths.
4. **Preserve the symlink chain** when copying the .so to `prebuilds/<platform>/`. Use `cp` with the actual `.so.0.1.0` file and `ln -sf` to recreate the chain.
5. **Build the shim** via `zig cc -O2 -fPIC -shared -target <triple>` against the just-built libghostty-vt with `-Wl,-rpath,'$ORIGIN'` so the shim finds its dependency at runtime.

The shim build uses `zig cc` rather than the host's `cc` so the same toolchain handles cross-compilation transparently. (Recon used `zig cc` and confirmed it produces correct binaries for all four Linux triples.)

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

### New tests worth adding

- **`shim-presence.test.ts`** (all platforms): verify both libraries load and that the four `_p` symbols exist in the shim. Catches a silent shim build that produces an empty `.so`.
- **`musl-portability.test.ts`** (Linux jobs): runs a subset of smoke tests inside `alpine:3.20` to confirm musl prebuilds work. Already implicitly covered by the CI matrix; this is just a documented entry point.

## Risks

The recon eliminated most of the speculative risks. Real residuals:

### Risk 1: Future libghostty pin adds new by-value entry points

**Detection**: `verify:generated` only checks struct layouts, not function signatures. New gotcha to add to CLAUDE.md: *when bumping `ghostty.commit`, grep `vendor/ghostty/include/**/*.h` for new function declarations whose arg lists contain a non-pointer struct type. Any matches need a `_p` wrapper added to `native/shim.c`.*

### Risk 2: GitHub's free arm64 Linux runners change pricing or availability

GitHub announced `ubuntu-24.04-arm` as GA in 2024, free for public repos. If that changes, fallback options: BuildJet hosted runners (paid), self-hosted runner, or cross-compile linux-arm64 on linux-x64 CI and skip the smoke test on arm64 (worse outcome but not blocking).

### Risk 3: A future Bun version breaks `process.report.getReport().header.glibcVersionRuntime`

This is undocumented Node.js API exposed by Bun. If Bun ever stops populating it, libc detection breaks. **Fallback**: read `/proc/self/exe` ELF interpreter directly (musl binaries have an interpreter like `/lib/ld-musl-x86_64.so.1`; glibc binaries use `/lib64/ld-linux-x86-64.so.2`). About 20 lines of Node `fs` code. Worth keeping in mind but not pre-building.

### Risk 4: Symlink preservation on Windows-formatted volumes

Some developers may have the repo checked out on a volume that doesn't preserve symlinks (e.g., a synced Dropbox folder). The `.so → .so.0 → .so.0.1.0` chain breaks. Detection: the shim fails to load with "cannot find libghostty-vt.so.0". Mitigation: the build script can fall back to copying the file three times under different names if symlink creation fails. Not solving in v1; documenting in CLAUDE.md.

## Implementation roadmap

The implementation plan (separate doc, written next via the writing-plans skill) will sequence the work roughly as:

1. Add the shim source file and integrate into the darwin-arm64 build (no functional change yet — just adopt the universal pattern locally and verify all existing tests still pass).
2. Update `src/ffi.ts` to load both libraries and dispatch to the shim for the four wrapped entry points. Remove the AAPCS64 register-split code.
3. Update `terminal.ts` and any other call sites that currently pack options for register-split.
4. Rewrite the three darwin-hardcoded smoke tests to be platform-aware.
5. Extend the build script to support cross-compilation and per-libc Linux variants.
6. Update the path resolver: six platforms, `detectLibc()`, shim path resolution.
7. Update the CI workflow to a three-runner matrix with per-libc sub-targets on Linux jobs.
8. Add `scripts/test-linux.sh` for local Docker-based testing.
9. Update CLAUDE.md, README, and CHANGELOG.
10. Set up the release workflow that aggregates prebuild artifacts.

Each step is independently testable. Steps 1–4 keep the darwin-arm64 build green; step 5 unblocks the Linux CI jobs in step 7.

## Open questions for plan-writing

None blocking. A few minor decisions to defer to the implementation plan:

- Whether to use `zig cc` or the host's `cc` for the shim on darwin (probably `zig cc` for consistency, but darwin's clang works fine).
- Whether the release workflow should auto-publish on tag push or produce a GitHub release with prebuilds attached for human-triggered `npm publish` (Murderbot's preference: auto-publish; this is decidable when writing the plan).
- Exact symlink-preservation strategy in the build script's `cp` + `ln -sf` sequence — Scout's reference script does this correctly and can be adapted.
