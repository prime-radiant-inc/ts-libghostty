# ts-libghostty-vt — agent notes

Bun-workspaces monorepo for the `ts-libghostty` project. The
`packages/libghostty-vt/` package (npm: `libghostty-vt`) is a
TypeScript/Bun binding over libghostty-vt — Ghostty's VT state
machine. Shipped: `v0.1.0` (Terminal + Formatter + lifecycle + ABI
safety), `v0.2.0` (effect callbacks — `onWritePty`, `onBell`,
`onTitleChanged`), `v0.3.0` (colors, scrollViewport, focus, APC
bounds, `cellAt`, `RenderState`). See
`packages/libghostty-vt/CHANGELOG.md` for per-version detail;
`docs/superpowers/specs/2026-04-22-ts-libghostty-design.md` for the
full v0 surface.

## Load-bearing gotchas

1. **Supported platforms: darwin-arm64, linux-{x64,arm64} × {glibc,musl}.** Six prebuilds total. Windows is out of scope; the build script and path resolver both reject it explicitly. See `docs/superpowers/specs/2026-05-06-linux-portability-design.md`.

2. **Ghostty pin is deliberate and tip-of-main** (see `package.json` → `ghostty.commit`). Don't bump unprompted. `bun run verify:generated` is the trip-wire: rebuilds the probe, regenerates bindings, fails on diff.

3. **Source of truth for the ABI is `docs/abi/2026-04-22-abi-discovery.md`,** not the Pass plans. Plan snippets drifted from reality in several places during execution. Trust the ABI doc and committed code over plan snippets.

4. **Toolchain: mise for bun, brew for zig.** `mise install` picks up `bun = 1.3.13`. Zig must come from brew's `zig@0.15` bottle on macOS Tahoe — ziglang.org's zig 0.15.2 hits a libSystem ABI break. This is the documented exception to the "prefer mise" rule.

5. **All by-value libghostty entry points go through the shim.** `native/shim.c` wraps four entry points (`ghostty_terminal_new`, `ghostty_formatter_terminal_new`, `ghostty_terminal_grid_ref`, `ghostty_terminal_scroll_viewport`) with `_p` pointer-taking variants. The binding dispatches the unsuffixed names through the shim via a splice in `getLib()`. **`verify:generated` (which runs in CI on every push) trips automatically if a Ghostty pin bump introduces a new by-value site.** When that happens, add the matching `_p` wrapper in `native/shim.c`, the matching dlopen entry in `SHIM_SYMBOLS`, and update `EXPECTED_BY_VALUE` in `scripts/gen-bindings.ts`. Then re-run `bun run build:bindings`.

6. **Plain formatter trims.** Empty terminal → `""`, not a rectangle of spaces. Tests assume this.

7. **Mode values are packed u16:** `rawValue | (ansi ? 1<<15 : 0)`. Unpack with `value & 0x7fff`. Defined in `src/internal/generated.ts`.

8. **`ghostty_build_info(VERSION_STRING)` returns semver (`"0.1.0-dev"`), not a commit SHA.** Override-library compatibility is best-effort — a library from a compatible-seeming commit can still diverge on enum values with undefined runtime behavior.

9. **FFI loading is lazy.** `setLibraryPath(path)` must be called *before* first Terminal/Formatter construction. `GHOSTTY_VT_LIB=""` is normalized to `undefined` (falls through to the bundled dylib).

10. **Effect-callback trampolines copy before invoking.** `onWritePty`'s `Uint8Array` and `onTitleChanged`'s `title` are JS-owned copies of libghostty's borrowed memory — mutating them does not affect libghostty. If you change the trampolines in `src/internal/callbacks.ts`, preserve the copy-before-invoke; breaking it creates use-after-free bugs in consumer code that retains the values. Also: `#assertNotInCallback` rejects mutating calls (`vtWrite`/`resize`/`reset`/`setMode`/`close`) from inside a callback — libghostty is mid-parse.

11. **Public types are contracts.** If a field is declared in the public API, populate it from libghostty or remove it from the type. No stubs, hardcoded defaults, or heuristics that disagree with the engine. Three Codex-review rounds on v0.3.0 surfaced the same bug class — silently dropping fields the type advertised (`wrapped`, `palette`, `hyperlinkUri`). Shrinking the type is a legitimate fix; silent stubs are not.

## Commands

- `bun test test/smoke` — FFI tests against the real libghostty-vt (no mocks at the FFI boundary). Fast.
- `bun run test` — smoke + tarball. Slow (packs + installs into a temp project).
- `bun run verify:generated` — ABI trip-wire.
- `bun run build` — full native + ts rebuild. ~25s clean.
- `bun run build:ts` — ts only (skips native rebuild).
- `bash scripts/run-tarball-smoke.sh` — publish gate.
- `bun run typecheck` — `tsc --noEmit`.

## Where stuff lives

Workspace root:
- `package.json` — workspace root, `private: true`, `workspaces: ["packages/*"]`.
- `tsconfig.base.json` — shared compilerOptions; per-package tsconfig extends.
- `docs/` — cross-cutting design docs and plans.

Inside `packages/libghostty-vt/`:
- `src/index.ts` — public re-exports.
- `src/internal/generated.ts` — GENERATED, do not hand-edit. Regen via `bun run build:bindings`.
- `src/ffi.ts` — dlopen + symbol table + build-identity check.
- `scripts/probe-layout.c`, `scripts/gen-bindings.ts` — struct probe + codegen.
- `vendor/ghostty/` — pinned Ghostty checkout; headers consumed at build time.
- `prebuilds/darwin-arm64/libghostty-vt.dylib` — bundled binary (must live inside the package so `bun pack` includes it).
- `test/smoke/` — FFI tests. `test/fixtures/` — VT fixture harness.
- `CHANGELOG.md` — user-facing release notes for the binding.

## Release process

Every version bump updates `CHANGELOG.md` BEFORE tagging. One entry per version, [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) format (`Added` / `Changed` / `Fixed` / `Removed` / `Deprecated` / `Security` sections, only include the ones that apply). The changelog is user-facing — don't duplicate the git log.

`CHANGELOG.md` ships in the npm tarball (`package.json` → `files`), so npm users see it when they check the release.

Order of operations on a version bump:
1. Edit `CHANGELOG.md` — move any `[Unreleased]` content under the new version heading, add bracketed date.
2. Bump `package.json` → `version`.
3. Commit both together with a `docs(changelog): vX.Y.Z` or `chore(release): vX.Y.Z` prefix.
4. `git tag -a vX.Y.Z` at that commit.
5. `git push origin main vX.Y.Z` — the tag push triggers `.github/workflows/release.yml`.
6. Approve the run in GitHub → Actions (the `npm-publish` environment requires a reviewer). The workflow then publishes via OIDC trusted publishing — no NPM_TOKEN exists in the repo or org. The publish includes a SLSA provenance attestation.

The workflow refuses to publish if the tag doesn't match `package.json` → `version`, so a wrong-tag push fails fast rather than producing a mis-tagged release.

## Six-prebuild release flow

Tag push triggers `.github/workflows/release.yml`, which downloads all six prebuild artifacts from the CI run on the tagged commit, verifies they're present, runs the tarball smoke test, and publishes to npm via OIDC trusted publishing. The release job never builds native code itself — it consumes exactly what CI tested. The `npm-publish` GitHub Environment gates the publish step behind a required reviewer; trusted publisher config under `primeradianthq` on npmjs.com binds this workflow + environment to the package.

Local `bun pack` for inspection still works on darwin, but only includes the local platform's prebuild. To produce the full multi-platform tarball locally, you'd need to download the CI artifacts manually (see release.yml for the recipe).

## Dispatching review subagents

Code-quality reviewer Bobs default to a terse "Signed off" response. Prompts dispatching them must explicitly demand: *"return a structured report with these exact sections: …"* or the review comes back without findings.
