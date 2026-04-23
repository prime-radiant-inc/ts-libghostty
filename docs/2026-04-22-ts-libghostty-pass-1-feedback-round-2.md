# ts-libghostty Pass 1 plan feedback, round 2

**Reviewed plan:** `docs/superpowers/plans/2026-04-22-ts-libghostty-pass-1.md`
**Revision reviewed:** `14164f8 docs: revise Pass 1 plan after Codex review`
**Date:** 2026-04-22
**Reviewer:** Codex

## Executive overview

The revision is much stronger. The new ABI Discovery task is the right structural fix, and the symbol-list split, generated `ModeName`, generated result-code mapping, typed struct field kinds, path-error alignment, tarball fixes, CI pinning, and tag ordering all move the plan in the right direction.

I still would not execute straight through as written. The plan now has the right gate, but several later code snippets still contain the old guessed FFI shapes. That is okay only if Task 3 Step 4 is treated as a hard stop that rewrites those snippets before any implementation worker reaches them. If the plan is meant to be runnable as-is after Task 3, Task 14 `snapshot()` and Task 16 `Formatter` still need to be converted from "assume/replace if different" snippets into ABI-discovery-specific snippets.

The biggest newly visible blocker is module resolution. The plan says TypeScript source and tests should import local files using `.js` specifiers while `bun test` runs directly against `src/*.ts`. Bun's official module-resolution docs say that when an import has an explicit extension, Bun only checks that exact file. So `import "../../src/terminal.js"` from a test will not resolve to `src/terminal.ts`. The NodeNext/`.js` pattern is good for emitted Node ESM, but it conflicts with source-level Bun tests unless tests run against `dist`, a bundler emits JS first, or the project uses extensionless/Bun-native imports.

There are also a few cleanup bugs left: the ABI discovery task writes `.tmp/...` files without creating `.tmp`; the top module-format prose still says `moduleResolution: "bundler"` while the actual `tsconfig` is `NodeNext`; the architecture prose still says every declared symbol is verified even though the corrected model verifies `requiredSymbols`; and the claimed replacement of `require("bun:ffi")` is incomplete in `Terminal.vtWrite()` and `Terminal.snapshot()`.

Recommendation: accept the revised structure, but do one small round of plan cleanup before execution. The only hard decision is module format/test strategy.

## Remaining blockers

### 1. Resolve the `.js` source import vs `bun test` conflict

The plan now uses `.js` relative import specifiers in TypeScript source and tests. That is the canonical NodeNext source pattern for emitted ESM, but Bun's runtime resolution says explicit extensions are exact. In other words, from a `.ts` test:

```ts
import { Terminal } from "../../src/terminal.js";
```

will look for `src/terminal.js`, not `src/terminal.ts`, when running source tests directly with `bun test`.

Pick one strategy:

- Use extensionless imports and `moduleResolution: "bundler"` / `module: "ESNext"`; Bun will resolve `./terminal` to `./terminal.ts` in source and `./terminal.js` in dist.
- Keep NodeNext `.js` imports, but run tests against built `dist/` files rather than `src/`.
- Use a Bun bundling build instead of plain `tsc` for distribution.
- Add a separate test tsconfig/strategy if you want NodeNext emit and source-level Bun tests.

The tarball smoke test will catch dist import problems, but the step-by-step smoke tests will fail earlier unless this is fixed.

Source checked: Bun's module-resolution docs state that when an extension is present, Bun checks only that exact file: https://bun.com/docs/runtime/modules

### 2. Treat Task 3 Step 4 as a hard stop, not a suggestion

Task 3 now says later snippets must be reconciled with ABI discovery. Good. But later snippets still include guessed code:

- `Terminal.snapshot()` still assumes a `u32 keys[] / 16-byte slot values[]` shape and says to replace it if the ABI differs.
- `Formatter` still assumes constructor shape `(allocator, &options, &out)` while describing an alternate tag-first shape.
- `Terminal` construction still assumes `ghostty_terminal_new(null, optBytes) -> ptr`, with a note to update if the actual signature is out-param based.
- `ffi.ts` still declares guessed signatures until ABI discovery rewrites them.

That can work as a workflow only if Task 3 explicitly blocks progress until those snippets are edited and committed. I would add a checkbox: "Do not begin Task 4 until every snippet containing an ABI-discovery dependency has been reconciled or explicitly marked as unchanged by discovery."

### 3. Finish the `bun:ffi` static-import cleanup

The revision says `require("bun:ffi")` was replaced, but Task 12 and Task 14 still use:

```ts
const { ptr } = require("bun:ffi");
const { read, ptr } = require("bun:ffi");
```

Move `ptr`, `toArrayBuffer`, and any other helpers to static imports in `terminal.ts`, as already done in `formatter.ts` and `marshal.ts`.

### 4. Fix `.tmp` creation in Task 3

Task 3 Step 2 writes:

```bash
find ... > .tmp/abi-headers.txt
grep ... > .tmp/abi-symbol-decls.txt
```

but does not create `.tmp` first. Add `mkdir -p .tmp` at the start of the step.

Also, the ABI discovery document says "Headers scanned: see `.tmp/abi-headers.txt`", but `.tmp` is not committed. Either paste the relevant header list/counts into the checked-in doc or change that line to say the temp file was used during discovery and is not part of the artifact.

## Smaller fixes

- The top module-format paragraph says `moduleResolution: "bundler"` / `module: "ESNext"`, but Task 1's `tsconfig.json` uses `NodeNext` for both. Update the prose after deciding the module strategy.
- The architecture paragraph still says the library verifies every declared symbol; it should say every `requiredSymbol`.
- Task 3 Step 4 examples have stale task labels after renumbering: "Task 4 generator" should be Task 5, "Task 5 probe" should be Task 4, and "Task 7 FFI" should be Task 8.
- Task 5's sanity check imports `./src/internal/generated.js` before a `generated.js` exists. If the plan keeps `.js` source imports, this suffers from the same Bun resolution issue; otherwise change it to import the real path for the chosen module strategy.
- GitHub's current hosted runner docs do list `macos-14` as arm64, so the CI direction is fine. Keep the `uname -m` guard anyway. Source: https://docs.github.com/actions/reference/runners/github-hosted-runners

## Bottom line

This is close. The architecture and risk management are now in the right shape. Before execution, fix the module-resolution strategy and make the Task 3 reconciliation gate stricter. After that, the remaining issues are mostly cleanup-level, with Task 14 and Task 16 becoming safe once their code is rewritten from the ABI discovery artifact.
