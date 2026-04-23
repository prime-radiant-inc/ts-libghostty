# ts-libghostty design feedback

**Reviewed spec:** `docs/superpowers/specs/2026-04-22-ts-libghostty-design.md`
**Date:** 2026-04-22
**Reviewer:** Codex

## Executive overview

The design is pointed in the right direction. Keeping `ts-libghostty` scoped to "VT state machine only" is the right boundary: it matches `libghostty-vt`, lets Bun own PTYs, and keeps rendering/UI policy out of the binding. The public TypeScript surface is also mostly sympathetic to JS users: `Terminal`, `RenderState`, `Formatter`, and `KeyEncoder` are the right top-level concepts.

The parts I would tighten before implementation are the native boundary and the render/data model. Bun FFI is still officially experimental, and this binding will sit directly on borrowed pointers, callbacks, struct layout, and dynamic libraries. That can work, but the design should treat ABI verification, lazy loading, callback lifetimes, and packaging smoke tests as v0 requirements, not later polish.

The largest API concern is `RenderCell`. A single `codepoint` cannot represent real terminal text because Ghostty supports grapheme clusters, combining marks, and emoji. If the binding exposes only `codepoint`, consumers will build against a lossy API that is hard to repair later. The render traversal should also avoid per-cell object allocation as the only path; it needs a lower-allocation or bulk path for the hot loop.

The other significant concern is semantic fidelity around colors, style, and effects. Ghostty distinguishes effective colors from default colors, supports unset foreground/background/cursor values, and has borrowed string lifetimes. The TypeScript API should reflect those semantics instead of flattening them into always-present `RGB` values or eagerly passing a title string from a callback if upstream only guarantees it after the callback returns.

Finally, a few items marked post-v0 should either move into v0 internally or be deliberately neutralized: runtime `build_info`/compatibility checks for override libraries, APC/Kitty storage limits if Kitty graphics are not exposed, and enough query-response testing to prove common TUIs do not stall on ignored responses.

## What is strong

- The core boundary is sound. Separating PTY ownership (`Bun.Terminal`) from VT state (`ts-libghostty`) avoids a large class of lifecycle and platform problems.
- The public objects mirror the upstream conceptual model well: terminal state, render state, formatter, key encoder, focus encoder.
- Avoiding individual hot-loop getters on `Terminal` is a good TypeScript-specific choice. `snapshot()` via `ghostty_terminal_get_multi` is a better default than many tiny FFI calls.
- Explicit `close()` plus `Symbol.dispose` is the right lifecycle default for C-backed resources.
- Pinning Ghostty by commit and checking generated bindings into source is the right direction for an unstable upstream C API.
- Fixture tests based on byte streams and formatter output are useful and easy to grow.

## Highest-priority recommendations

### 1. Make library loading lazy, not module-load eager

The spec says `src/ffi.ts` calls `dlopen()` once on module load, while also allowing `setLibraryPath()` before first class construction. Those two choices conflict: if importing the module opens the library, user code cannot override the path after import.

Recommended change:

- Resolve and `dlopen()` lazily on first native use.
- Allow `setLibraryPath()` until that first native use.
- After load, make `setLibraryPath()` throw a clear error that includes the path already loaded.
- Export a cheap `libraryInfo()` or `isLoaded()` for diagnostics.

This also gives unsupported platforms a better error path. Importing types or pure helpers should not immediately fail because `darwin-arm64` is the only bundled binary.

### 2. Treat ABI compatibility as a v0 safety requirement

The spec has good ideas around generated enums, struct sizes, and symbol manifests, but it should go further because `GHOSTTY_VT_LIB` lets users point at arbitrary native code. A mismatched library can crash the process before TypeScript can recover.

Recommended change:

- Keep the symbol manifest, but add a startup compatibility check before constructing any object.
- Include the expected Ghostty commit in generated metadata.
- Use `build_info` internally if upstream exposes enough identity/version data, even if public `build_info` remains out of scope.
- Verify every required symbol exists before exposing a usable binding.
- Fail with a typed `GhosttyError` or `LibraryCompatibilityError`, not an opaque FFI crash where possible.

I would consider internal `build_info` critical even if public `build_info()` is not in v0.

### 3. Generate struct layout with a compiler-backed probe

The spec proposes a focused TypeScript parser over `vt.h` that emits enum values, struct sizes, and expected symbols. That is acceptable for enum names and symbol manifests, but it is risky for ABI layout. C layout depends on target ABI rules, enum width, `size_t`, `bool`, unions, padding, and alignment.

Recommended change:

- Use a tiny C or Zig probe compiled against the pinned headers to emit `sizeof`, `alignof`, and `offsetof` for every struct/union the FFI writes or reads.
- Keep the TS parser for names if desired, but do not hand-compute struct layout in TypeScript.
- Generate layout per target triple, not globally.

One current upstream detail to double-check: `GhosttyTerminalOptions` in current `main` does not appear to use a first-field sized-struct convention; it has `cols`, `rows`, and `max_scrollback`, with a TODO about ABI padding. Other APIs may use sized structs. The generator should describe each concrete struct rather than assuming a universal pattern.

### 4. Fix the render cell text model before API freeze

`RenderCell.codepoint: number` is not enough. Real terminal cells may contain grapheme clusters, combining marks, variation selectors, and emoji sequences. Ghostty's own value proposition includes Unicode correctness, so the TypeScript binding should not reduce rendered text to one scalar.

Recommended change:

- Add a text/grapheme accessor to `RenderCell`, for example `text?: string`, `grapheme?: string`, or `content(): string`.
- Keep `codepoint` only as a fast-path for simple single-codepoint cells if upstream makes that cheap.
- Add fixtures for combining marks, emoji ZWJ sequences, East Asian wide characters, and zero-width joiners.
- Define what `wide` means for continuation cells and how consumers should skip them.

This is the one API issue I would not defer. A lossy cell API becomes user-visible immediately.

### 5. Provide a lower-allocation render traversal path

The current `rows(): IterableIterator<RenderRow>` and `cells(): IterableIterator<RenderCell>` API is ergonomic, but it risks making the hot render loop allocate one JS object per row and cell. That can erase the performance benefit of using `RenderState`.

Recommended change:

- Keep the iterator API for ergonomics.
- Add a hot-path API such as `forEachCell(cb)`, `forEachDirtyCell(cb)`, `copyDirtyRows()`, or reusable row/cell cursor objects.
- Consider a bulk snapshot format for LLM consumers: packed cell buffers plus string table for graphemes/hyperlinks.
- Document that the iterator API is the convenient path, not necessarily the fastest path.

Also clarify the dirty lifecycle. Upstream render state has explicit dirty-state concepts, and the Go binding exposes `SetDirty`. The TS API needs a clear `markClean()`/`setDirty()` story or a documented guarantee that `update()` consumes/clears dirty state.

### 6. Model colors with default/effective/unset semantics

The spec exposes:

```ts
interface TerminalColors {
  fg: RGB;
  bg: RGB;
  cursor: RGB;
  palette: RGB[];
}
```

Upstream distinguishes default colors from effective colors after OSC overrides, and foreground/background/cursor can be unset while palette always has a value. An always-present `fg/bg/cursor` loses that distinction.

Recommended change:

- Split `effectiveColors()` and `defaultColors()`, or add `{ effective, defaults }`.
- Represent unset colors as `undefined`.
- Document that `setColors()` changes defaults and whether it preserves OSC overrides.
- Consider exposing palette as a packed `Uint8Array`/`Uint32Array` internally or through an additional fast path. `RGB[]` of 256 tuples is ergonomic, but it is not actually compact in JS.

### 7. Align effect callbacks to upstream lifetime guarantees

`onWritePty`, `onBell`, and `onTitleChanged` are the right first effects, but two details need tightening.

For `onWritePty`, a zero-copy `Uint8Array` view is fast but fragile because the bytes are only valid during the callback. Most query responses are small. Consider making the default callback receive a copied `Uint8Array`, with an explicit unsafe/borrowed callback for advanced users. If the design keeps the borrowed view, make that obvious in the option name or docs.

For `onTitleChanged`, current upstream docs say the callback receives the terminal and userdata, and the title can be queried after the callback returns. Passing `(title: string)` from inside the trampoline may require querying during the callback, which may be outside the guarantee. Safer options:

- Make it `onTitleChanged?: () => void` and let consumers call `snapshot()` after `vtWrite()`.
- Queue the title and invoke user callbacks after `vtWrite()` completes.
- Confirm upstream explicitly allows `ghostty_terminal_get(...TITLE...)` inside the callback before committing to `(title)`.

### 8. Neutralize non-exposed Kitty/APC behavior in v0

Kitty graphics is reasonably marked out of v0. But if the underlying library has Kitty/APC parsing enabled, untrusted terminal output may still allocate buffers or image storage unless configured.

Recommended change:

- Add internal defaults to disable Kitty image storage when the public API does not expose Kitty graphics.
- Expose or internally set `APC_MAX_BYTES` and `APC_MAX_BYTES_KITTY` to bounded values.
- Add a fixture that feeds large APC/Kitty-like payloads and asserts memory does not grow unexpectedly.

This is not about shipping Kitty support early. It is about making the non-goal safe.

## Other API notes

### `TerminalSnapshot`

Good idea overall. A few additions would make it more useful:

- Include pixel dimensions if `cellPx` is part of the API.
- Consider including `cursor.pendingWrap` if consumers need faithful state.
- Consider representing `mouseTracking` as either a boolean or exact modes based on what the C API can actually provide. If deriving exact mode from multiple mode flags, define precedence.

### `cellAt`

The coordinate model is underspecified. Upstream has active, viewport, screen, and history coordinate concepts, and some are much more expensive than others.

Recommended change:

- Rename `viewport?: "active" | "screen"` to an explicit `coordinateSpace?: "active" | "viewport" | "screen" | "history"`.
- Document cost differences.
- Return grapheme/text and full style data consistent with `RenderCell`.

### `CellStyle`

The proposed style object may be too narrow. Before freezing it, map it field-by-field against `GhosttyStyle` and render-state cell accessors. Avoid silently dropping attributes such as dim/faint, overline, resolved foreground/background behavior, or other style bits upstream exposes.

The design should also decide whether `CellStyle` is logical SGR state or render-resolved state. Those are not always the same thing.

### `Formatter`

This surface looks good. Keep `format()` as the primary API because `"vt"` output is byte-oriented. `formatString()` is convenient for `"plain"` and `"html"`, but for `"vt"` the docs should warn that decoding escape bytes into a JS string is a convenience, not a structured representation.

### `KeyEncoder`

The overall shape is right. `syncFrom(term)` should be the default path, and returning `undefined` for unmapped keys is a good JS convention.

Suggested additions:

- Validate `KeyEvent` combinations at runtime in development mode. For example, `key: "char"` should require text/codepoint fields.
- Define whether `mods` and `consumedMods` default to all false.
- Add golden tests for normal keys, Kitty keyboard protocol flags, application cursor mode, keypad application mode, Alt behavior, dead keys/IME-like consumed modifiers, and release/repeat events.

### Error model

`GhosttyError` for `GhosttyResult` failures is good. Add a separate error category for binding-level failures:

- Library not found.
- Unsupported platform.
- Missing symbol.
- ABI/commit mismatch.
- Use-after-close.
- Invalid JS input before it crosses FFI.

Use-after-close should be caught in TypeScript and throw a clear error rather than passing null or stale pointers into C.

## Build and distribution

Shipping a prebuilt dylib in the npm tarball is the right v0 distribution choice for a Bun-only, darwin-arm64-first package. The risk is mostly operational:

- Run `bun pm pack` or `npm pack` smoke tests in CI, then install the tarball into a fresh temp project and import/use it.
- Verify the dylib load path works outside the repository.
- Include Ghostty's upstream MIT license in the package/tarball alongside the package's Apache-2.0 license.
- Make the README clear whether this is an unofficial community binding unless Ghostty upstream explicitly blesses it.
- Make unsupported platform errors helpful: include detected platform/arch, supported targets, and `GHOSTTY_VT_LIB` override instructions.

Windows should remain speculative. Current Bun docs say `Bun.Terminal` PTY support is POSIX-only, so `win-x64` should not be presented as an expected platform until Bun's terminal API supports it or the package owns PTY integration differently.

## Testing recommendations

The proposed smoke and formatter-fixture tiers are a good base. I would add these v0 gates:

- ABI smoke: load the bundled dylib, check symbols, check generated sizes/offsets, construct/free each handle type.
- Tarball smoke: install the packed package in a fresh directory and run a tiny terminal/formatter test.
- Render metadata fixtures: styles, hyperlinks, wide cells, combining marks, cursor visibility/style, alternate screen, scrollback.
- Key encoder goldens: compare produced bytes for representative key/mode combinations.
- Effect tests: write_pty query responses, bell, title, thrown callback behavior, borrowed-buffer lifetime docs.
- Malformed/untrusted input test: feed random bytes and large escape/APC payloads; assert no JS exception/crash and bounded memory.
- Real-program fixtures: short captures from shell prompt, `ls --color`, `vim`/alternate screen, and a prompt or TUI that emits DA/DSR queries.

Formatter fixtures alone can hide bugs because the formatter and terminal may agree on the same wrong or lossy representation. Add direct render-state and metadata assertions.

## Sources checked

- Local design spec: `docs/superpowers/specs/2026-04-22-ts-libghostty-design.md`
- Ghostty repository and current `vt.h`: https://github.com/ghostty-org/ghostty/blob/main/include/ghostty/vt.h
- Current `terminal.h` API surface: https://raw.githubusercontent.com/ghostty-org/ghostty/main/include/ghostty/vt/terminal.h
- Ghostty project README/status text: https://github.com/ghostty-org/ghostty
- Bun FFI docs: https://bun.com/docs/runtime/ffi
- Bun PTY/Terminal docs: https://bun.sh/docs/runtime/child-process
- Go libghostty API docs for comparison: https://pkg.go.dev/github.com/mitchellh/go-libghostty

## Bottom line

Proceed with the architecture, but harden the native boundary before writing much public API, and fix the render-cell/text/color semantics before v0. The current design is close, but those choices are foundational: they determine whether the binding feels like a faithful Ghostty binding or a convenient wrapper that quietly loses terminal state.
