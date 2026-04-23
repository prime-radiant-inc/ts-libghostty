# ts-libghostty Pass 1 plan feedback

**Reviewed plan:** `docs/superpowers/plans/2026-04-22-ts-libghostty-pass-1.md`
**Reviewed spec:** `docs/superpowers/specs/2026-04-22-ts-libghostty-design.md`
**Date:** 2026-04-22
**Reviewer:** Codex

## Executive overview

The plan is directionally good and the pass boundary is sensible: Pass 1 should prove byte-in to formatter-output with the native boundary, lifecycle, errors, packaging, and CI in place before the more interesting render/key/effect surfaces arrive. The task sequence is also mostly right: scaffold, pin/build Ghostty, generate ABI metadata, implement errors/path/FFI, then Terminal/Formatter, then smoke/tarball/CI.

I would not implement it as written yet. The plan still contains too many "verify at pin time", placeholder enum names, guessed C signatures, and TODO field lists in the exact places where a wrong assumption can crash the Bun process. This is the main issue. Add an explicit early "Pin + ABI discovery" gate that inspects the pinned headers and updates the plan/code templates with exact function signatures, enum names, struct fields, ownership rules, and formatter/get_multi ABI before any FFI implementation task starts.

There are also a few concrete correctness bugs that will bite immediately: `build:probe` writes into `.tmp` before creating it; the generated `symbolManifest` is described inconsistently and the loader appears to verify every header symbol even though `dlopen()` only declares the subset in `SYMBOLS`; missing override paths are tested as `LibraryNotFoundError` but implemented as `UnsupportedPlatformError`; `.ts` import specifiers plus `tsc` output will likely produce broken `dist` imports; and `ModeName` is still just `string`, despite the spec requiring generated string-literal unions.

The plan also claims some safety gates that are not actually enforced in Pass 1: runtime build/commit compatibility for override libraries, APC memory-bound testing, pixel dimensions in `snapshot()`, and real struct-layout ABI verification beyond "generated file exists." These should either become real Pass 1 tasks or be removed from the Pass 1 success claim.

My recommendation: keep the pass structure, but insert an ABI discovery/checkpoint task after pinning Ghostty and before writing `ffi.ts`; fix the packaging/TypeScript build issues; make the symbol manifest model precise; add a small APC-bound test if APC options are part of the Pass 1 goal; and tag only after the final release commit.

## What is strong

- The pass goal is the right first slice: `Terminal` + `Formatter` plus native-boundary safety gives an end-to-end value path without waiting for the full v0 surface.
- The task order is mostly healthy. Building and generating ABI metadata before authoring runtime code is the right instinct.
- The plan includes the right categories of tests: smoke, ABI, tarball install, formatter fixtures, and CI.
- The error hierarchy is now explicit and useful.
- `setLibraryPath()` lifecycle and lazy load are clearly represented.
- Tarball smoke testing is a very good addition. This package can easily work inside the repo and fail once packed.

## Highest-priority changes

### 1. Add a hard ABI discovery gate before FFI implementation

The plan repeatedly tells the executor to verify exact names and signatures at the pinned Ghostty commit:

- `scripts/build-libghostty.sh` says to verify the Zig build target.
- `probe-layout.c` contains `TODO executor: add any other fields present at the pin`.
- `ffi.ts` says concrete C signatures must be verified, and warns that wrong signatures can crash.
- `Terminal.snapshot()` uses placeholder `GHOSTTY_TERMINAL_GET_*` names and an assumed 16-byte slot layout.
- `modeTagFromName()` guesses the enum prefix.
- `Formatter` guesses `ghostty_formatter_new` and `ghostty_formatter_format` ownership/signatures.

Those notes are honest, but they make the plan unsafe as an implementation recipe. A worker following the snippets can land code that compiles, passes weak tests, and still has undefined FFI behavior.

Recommended fix:

- Insert a new task immediately after Task 2: **"ABI discovery and plan lock."**
- In that task, read the pinned headers and produce a short checked-in note or generated manifest containing:
  - exact Ghostty commit SHA,
  - exact build target and output path,
  - exact C signatures for every Pass 1 function,
  - exact struct fields for `GhosttyTerminalOptions` and `GhosttyFormatterOptions`,
  - exact enum names for result OK, terminal get keys, formatter tags, mode tags,
  - ownership/freeing rules for formatter output,
  - whether build info/commit identity is available from C.
- Require the implementation snippets/tasks to be updated from that discovery before Task 7 begins.

This is the most important change. The rest of the plan becomes much easier to execute once this uncertainty is front-loaded.

### 2. Fix the symbol manifest model

Task 4's generator parses every `ghostty_*` function in the headers into `symbolManifest`. Task 7's loader then calls `dlopen(path, SYMBOLS)`, where `SYMBOLS` is only the subset the binding declares. After that, `getLib()` loops over every name in `symbolManifest` and expects each to exist in `opened.symbols`.

That cannot work if `symbolManifest` means "all header symbols"; Bun only exposes symbols declared in the `dlopen()` table. The plan later says the binding may use a subset of the header manifest, which contradicts the loader.

Recommended fix:

- Generate two separate lists:
  - `declaredHeaderSymbols`: all `ghostty_*` declarations found in headers, for diagnostics.
  - `requiredSymbols`: exactly the symbols the binding uses in this pass.
- `ffi.ts` should `dlopen()` exactly `requiredSymbols`.
- ABI tests should assert every `requiredSymbol` appears in `declaredHeaderSymbols`.
- Loader verification should only inspect `requiredSymbols`, because those are the functions Bun has declared.

Also export `REQUIRED_SYMBOLS` or a typed helper from `ffi.ts` so Task 17 does not maintain a second static list that can drift.

### 3. Make runtime compatibility real, or narrow the claim

The revised spec calls ABI verification a v0 gate. The plan verifies generated headers and required symbol presence, but it does not clearly verify that the loaded library is actually the same Ghostty commit as `generated.ts`. This matters most for `GHOSTTY_VT_LIB`.

Recommended fix:

- If upstream exposes build identity, wire it into `libraryInfo()` and compare it during load.
- Populate `LibraryCompatibilityError.actualCommit` when there is a mismatch.
- If upstream does not expose build identity, say so explicitly and downgrade the guarantee to "symbol and generated-layout compatibility for bundled builds; override libraries are best-effort."

Right now `LibraryCompatibilityError` advertises actual/expected commit detail that the plan never produces.

### 4. Fix the TypeScript package build before coding against it

The plan uses source imports such as `import { Terminal } from "./terminal.ts"` while compiling with `tsc` to `dist/`. With the shown TypeScript 5.4 config, `.ts` import specifiers are likely to either fail typecheck or emit `dist/index.js` that imports `./terminal.ts`, which will not exist in `dist`.

Recommended fix:

- Either use a Bun bundling step for distribution, or
- use `.js` relative import specifiers in TypeScript source with a Node-compatible module mode, or
- use a TypeScript version/config that rewrites relative `.ts` extensions and verify the emitted `dist` with tarball smoke.

This should be settled in Task 1, not discovered at Task 18.

### 5. Make generated public types real

Task 9 defines:

```ts
export type ModeName = string;
```

The comment says it will be narrowed by a conditional re-export later, but Task 20 simply re-exports `ModeName` from `types.ts`. That violates the spec's generated string-literal-union goal and removes compile-time protection from `mode()`/`setMode()`.

Recommended fix:

- Have `gen-bindings.ts` emit `modeNames` and `export type ModeName = typeof modeNames[number]`.
- Export that generated type through the public index.
- Generate a `modeTagByName` map rather than deriving enum names by prefix guessing.

Do the same pattern later for `Key`, but `ModeName` is already part of Pass 1.

### 6. Align errors and path resolution

`resolveLibraryPath()` throws `UnsupportedPlatformError` when an explicit override or `GHOSTTY_VT_LIB` path does not exist. `ffi.test.ts` expects `LibraryNotFoundError` for a missing explicit path. The spec also distinguishes "unsupported platform" from "library could not be located."

Recommended fix:

- Missing explicit override -> `LibraryNotFoundError`.
- Missing `GHOSTTY_VT_LIB` path -> `LibraryNotFoundError`.
- No bundled prebuild for detected platform and no override/env -> `UnsupportedPlatformError`.
- Bundled path expected but absent on supported platform -> `LibraryNotFoundError`.

Keep these semantics in both path tests and FFI tests.

## Concrete task-level issues

### Task 1: scaffolding

- `build:probe` currently compiles to `.tmp/probe-layout` before creating `.tmp`. Move `mkdir -p .tmp` before `cc`.
- `.gitignore` ignores `bun.lockb`, but Step 10 commits `bun.lockb`. Also, current Bun versions may produce `bun.lock` rather than `bun.lockb`; make the lockfile name match the actual Bun version.
- Local workspace Bun is currently `1.3.11`, below the plan's `>=1.3.13` engine requirement. Implementation needs a Bun upgrade or the plan will fail before native work begins.
- `src/internal/` is not created before Task 4 writes `src/internal/generated.ts`. Ensure directories exist in the generator or scaffolding.
- The package `files` excludes `src/`, while the revised spec says the tarball contains TypeScript source. Decide whether source should ship; if not, update the spec/README claim. If source maps are emitted, shipping `src/` is friendlier.

### Task 2: build script

- "Use tip of main at execution time" makes the reviewed plan non-reproducible. Prefer selecting and recording the exact commit before implementation starts, or make the new ABI discovery gate update the plan with the chosen SHA and exact surface.
- The script supports `darwin-x64` and Linux outputs, but runtime `SUPPORTED_PLATFORMS` only allows `darwin-arm64`. That is fine if intentional, but CI must run on a known arm64 macOS runner. `macos-latest` is too ambiguous for a darwin-arm64-only pass.

### Task 3: struct-layout probe

- The probe still has TODO field enumeration. That is exactly the work the new ABI discovery task should finish before implementation.
- The probe should include signedness/type category where the JS writer needs it, not only size/offset. Size alone works for simple integer/bool fields but will become fragile as soon as pointer, enum, signed, or sized fields matter.
- If any options struct is sized, the helper must automatically write the `size` field. Task 15 currently uses `writeStruct()` without setting a size field.

### Task 4: generator

- `parseEnums()` only handles numeric values that `Number()` can parse. Header enums may use expressions, references, shifts, or hex. Hex is fine; expressions are not. A compiler-backed probe for enum values would be more reliable, or the parser should explicitly reject unsupported values with a clear error.
- `parseSymbols()` scans every `ghostty_*(` occurrence, including comments/macros/usages, not just declarations. That is probably too broad for a compatibility manifest.
- The generator should emit normalized maps used by runtime code: `ghosttyResultOk`, `resultCodeByValue`, `modeTagByName`, `formatterTagByName`, and get-key names if `snapshot()` uses them.

### Task 5: errors

- `GhosttyErrorCode` is hardcoded, but the spec says it is generated from `GhosttyResult`. A binding-level code union can be hardcoded, but native result mapping should be generated or centrally normalized.
- `checkResult()` later maps result names by substring. That is too fuzzy for a native boundary. Generate an explicit result-code map.

### Task 7: FFI loader

- See the symbol manifest issue above.
- The missing-file handling does not match the error hierarchy.
- `libraryInfo()` only reports the pinned commit, not the actual loaded library identity. If build info is unavailable, document that limitation.
- Avoid CommonJS `require("bun:ffi")` from ESM source unless the toolchain verifies it. Prefer static ESM imports from `bun:ffi`.
- `_resetForTest()` closes the global dylib even if live `Terminal`/`Formatter` handles exist. Keep it test-only, but document that tests must not reset while handles are live.

### Task 8: helpers

- `writeStruct()` writes by field size only. Add field kind/type where needed or restrict it explicitly to Pass 1 simple fields.
- `copyBytesFromPointer()` relies on `require("bun:ffi")` and a specific `toArrayBuffer` shape. This should be verified in a tiny test against native memory, or deferred until effect callbacks in Pass 2.

### Tasks 10-14: Terminal

- `TerminalOptions.cellPx` is accepted, and `TerminalSnapshot` exposes pixel dimensions, but implementation returns zero dimensions and does not store/update cell size. Either implement this in Pass 1 or remove it from the Pass 1 API.
- `resize()` ignores the `cellPx` parameter.
- `snapshot()` is the riskiest single method in the plan because it assumes the `get_multi` ABI, slot size, string representation, enum names, and active-screen numeric mapping. Move this behind the ABI discovery gate.
- `modeTagFromName()` should use a generated map instead of constructing enum names by string prefix.
- Add tests that `resize()` changes `snapshot().cols/rows`, and that `cellPx` changes `pixelWidth/pixelHeight`.

### Task 15: Formatter

- `formatTag()` computes a tag, but the shown `writeStruct()` call does not put that tag into the options object unless the upstream struct happens to have a field not shown. `#tag` is stored but unused. This is likely incomplete.
- Formatter constructor and format/free ownership are explicitly guessed. That is okay as a discovery note, but not okay as the implementation snippet to follow.
- Freeing should happen in a `try/finally` after copying so an exception during copy cannot leak native memory.
- If `bufPtr` is non-null with `len === 0`, confirm whether it still needs to be freed.

### Task 16: fixtures

- Bootstrapping `expected.txt` from the implementation is okay for a smoke fixture, but keep it honest: `hello-world` only proves plumbing. It should not be treated as a semantic conformance test.
- The plan's spec-level testing section mentions metadata JSON fixtures, but Pass 1 only implements text fixtures. That is fine because `RenderState` is later, but the Pass 1 self-review should not imply the full v0 test gate is already covered.

### Task 17: ABI smoke

- The test name says struct layout match, but the shown test only checks that layouts exist and have size > 0. It does not compare against a newly run probe or against the loaded library identity.
- It should import the required-symbol list from the runtime code instead of duplicating symbol names.
- If override libraries are supported, add a negative test or a documented manual check for incompatible build identity once `build_info` is wired.

### Task 18: tarball smoke

- Ensure `.tmp` exists before `bun pm pack --destination "$ROOT/.tmp"`.
- Make the tarball path absolute before writing it into the temp project's `package.json`; otherwise `file:$TGZ` can break after `cd "$TMP"`.
- This test is the right place to catch broken `dist` import extensions. Keep it in CI.

### Task 19: CI

- `oven-sh/setup-bun` may not accept a semver range as `bun-version`; pin an exact version or use a known supported value.
- Pin the macOS runner architecture to match `darwin-arm64`, or support whatever architecture the runner actually provides.
- Add `bun run build:ts` before tarball smoke if the tarball script does not build.

### Task 20: README/re-exports

- README links to `./docs/...`, but `docs/` is excluded from the package. Use a repository URL or include the docs.
- Do not claim override libraries "typically fail with LibraryCompatibilityError" unless build-info identity is actually checked. Symbol-only mismatch detection is weaker.

### Task 21: final sanity/tag

- Tag after the final release-prep commit, not before. As written, Step 3 tags and Step 4 may create another commit, leaving `v0.1.0` pointing at a non-final state.
- The destructive clean command is appropriate as a release check, but implementation agents should be told to verify no unrelated work is present before running it.

## Suggested revised skeleton

Keep the current structure, but adjust the front half:

1. Scaffold project and settle package build style (`tsc` with valid emitted imports, or Bun bundle).
2. Pin exact Ghostty commit.
3. Build Ghostty and copy license.
4. Run ABI discovery:
   - exact headers,
   - exact symbols,
   - exact function signatures,
   - exact struct fields,
   - exact enum mappings,
   - exact ownership/freeing rules,
   - actual build identity availability.
5. Update `probe-layout.c`, `gen-bindings.ts`, `ffi.ts` `SYMBOLS`, and implementation snippets from that discovery.
6. Proceed with errors/path/FFI/Terminal/Formatter.
7. Run ABI, tarball, fixture, and CI gates.

That turns the plan from "good direction with dangerous placeholders" into an implementation recipe.

## Bottom line

The Bobs incorporated the spec feedback well, and this Pass 1 is the right slice. The plan just needs one more tightening pass before implementation: remove the native-boundary guesses, make generated mappings first-class, fix the package build mechanics, and align the tests with the safety claims. Once those are corrected, this should be a strong foundation pass.
