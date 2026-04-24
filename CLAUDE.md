# ts-libghostty-vt — agent notes

TypeScript/Bun binding over libghostty-vt (Ghostty's VT state machine). Pass 1 shipped as v0.1.0 on 2026-04-23 (Terminal + Formatter + lifecycle + ABI safety). Pass 2 shipped as v0.2.0 on 2026-04-23 (effect callbacks — `onWritePty`, `onBell`, `onTitleChanged`). Passes 3–5 are unplanned. For status and carry-forward notes see `CONFIRM_WITH_MATT.md`; for the full v0 surface see `docs/superpowers/specs/2026-04-22-ts-libghostty-design.md`.

## Load-bearing gotchas

1. **darwin-arm64 only.** Don't add Linux/Windows/x64 code paths. FFI relies on AAPCS64 register-split for struct-by-value; cross-platform is a Pass 2+ decision.

2. **Ghostty pin is deliberate and tip-of-main** (see `package.json` → `ghostty.commit`). Don't bump unprompted. `bun run verify:generated` is the trip-wire: rebuilds the probe, regenerates bindings, fails on diff.

3. **Source of truth for the ABI is `docs/abi/2026-04-22-abi-discovery.md`,** not the Pass 1 plan. The plan's header snippets drifted in six documented places (catalogued in `CONFIRM_WITH_MATT.md` §"Known plan/code drift"). Trust the ABI doc and committed code over plan snippets.

4. **Toolchain: mise for bun, brew for zig.** `mise install` picks up `bun = 1.3.13`. Zig must come from brew's `zig@0.15` bottle on macOS Tahoe — ziglang.org's zig 0.15.2 hits a libSystem ABI break. This is the documented exception to the "prefer mise" rule.

5. **Register-split is AAPCS64-specific.** 16-byte structs → two u64 args; 56-byte structs → hidden pointer. If you're touching `src/ffi.ts` or adding a new struct-taking FFI call, read `docs/abi/2026-04-22-abi-discovery.md` §12 before improvising.

6. **Plain formatter trims.** Empty terminal → `""`, not a rectangle of spaces. Tests assume this.

7. **Mode values are packed u16:** `rawValue | (ansi ? 1<<15 : 0)`. Unpack with `value & 0x7fff`. Defined in `src/internal/generated.ts`.

8. **`ghostty_build_info(VERSION_STRING)` returns semver (`"0.1.0-dev"`), not a commit SHA.** Override-library compatibility is best-effort — a library from a compatible-seeming commit can still diverge on enum values with undefined runtime behavior.

9. **FFI loading is lazy.** `setLibraryPath(path)` must be called *before* first Terminal/Formatter construction. `GHOSTTY_VT_LIB=""` is normalized to `undefined` (falls through to the bundled dylib).

10. **Effect-callback trampolines copy before invoking.** `onWritePty`'s `Uint8Array` and `onTitleChanged`'s `title` are JS-owned copies of libghostty's borrowed memory — mutating them does not affect libghostty. If you change the trampolines in `src/internal/callbacks.ts`, preserve the copy-before-invoke; breaking it creates use-after-free bugs in consumer code that retains the values. Also: `#assertNotInCallback` rejects mutating calls (`vtWrite`/`resize`/`reset`/`setMode`/`close`) from inside a callback — libghostty is mid-parse.

## Commands

- `bun test test/smoke` — 112 FFI tests against the real libghostty-vt (no mocks at the FFI boundary). Fast.
- `bun run test` — smoke + tarball. Slow (packs + installs into a temp project).
- `bun run verify:generated` — ABI trip-wire.
- `bun run build` — full native + ts rebuild. ~25s clean.
- `bun run build:ts` — ts only (skips native rebuild).
- `bash scripts/run-tarball-smoke.sh` — publish gate.
- `bun run typecheck` — `tsc --noEmit`.

## Where stuff lives

- `src/index.ts` — public re-exports.
- `src/internal/generated.ts` — GENERATED, do not hand-edit. Regen via `bun run build:bindings`.
- `src/ffi.ts` — dlopen + symbol table + build-identity check.
- `scripts/probe-layout.c`, `scripts/gen-bindings.ts` — struct probe + codegen.
- `vendor/ghostty/` — pinned Ghostty checkout; headers consumed at build time.
- `prebuilds/darwin-arm64/libghostty-vt.dylib` — bundled binary.
- `test/smoke/` — FFI tests. `test/fixtures/` — VT fixture harness.
- `CONFIRM_WITH_MATT.md` — Pass 1 handoff + publish todo + Pass 2 carry-forward.

## Dispatching review subagents

Code-quality reviewer Bobs default to a terse "Signed off" response. Prompts dispatching them must explicitly demand: *"return a structured report with these exact sections: …"* or the review comes back without findings.
