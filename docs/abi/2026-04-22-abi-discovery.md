# ts-libghostty ABI discovery

**Pinned commit:** `e88c6c099152dd6d2d7e517516e1f3c183c152f7` (tip-of-main as of 2026-04-22)
**Date:** 2026-04-22
**Author:** Hansard (Bob 26dacfa0-task3-hansard)
**Headers scanned:** every `*.h` under `vendor/ghostty/include/ghostty/` at the pinned commit. The raw list was captured in `.tmp/abi-headers.txt` during discovery; that file is not part of the artifact. Total count: **29 headers**.
**Dylib cross-check:** `prebuilds/darwin-arm64/libghostty-vt.dylib` exports 134 `_ghostty_*` symbols (see `.tmp/abi-exported-symbols.txt`). Every symbol named in this document was verified present in the dylib via `nm -gU`.
**Runtime cross-check:** `ghostty_type_json()` was invoked against the loaded dylib; the JSON output is in `.tmp/type_json.json` and every struct layout quoted in this document was copied from that output (not from header source).

---

## 1. Build target

- **Exact zig build target name:** `install` (the default step). There is **no longer** a standalone `libghostty-vt` step at this pin. `zig build --list-steps` reports only `install`, `uninstall`, `run`, `run-valgrind`, `test`, `test-lib-vt`, `test-valgrind`, `update-translations`, `dist`, `distcheck`.
- **Flag to restrict the default `install` step to the VT-only library:** `-Demit-lib-vt=true`. Without this, `install` also tries to build the macOS app, xcframework, and docs. With it, the only artifact is `libghostty-vt`.
- **Exact output path (darwin-arm64):** `vendor/ghostty/zig-out/lib/libghostty-vt.dylib` — confirmed by the existing `prebuilds/darwin-arm64/libghostty-vt.dylib` produced by Task 2.
- **Recommended command:** `zig build install -Demit-lib-vt=true -Doptimize=ReleaseFast`.
- **Zig version requirement:** `/opt/homebrew/opt/zig@0.15/bin/zig` on macOS (Zig 0.15, Tahoe-patched). Other Zig versions may fail.
- **Headers installed alongside:** after `install`, headers are in `zig-out/include/ghostty/`. Task 4's probe uses `vendor/ghostty/include/ghostty/` directly (same source; installed copy is a subset/mirror).

## 2. Build identity / commit

Ghostty **does** expose its build identity via a C API at this pin.

- **Function:** `ghostty_build_info(GhosttyBuildInfo data, void *out)` — declared in `vendor/ghostty/include/ghostty/vt/build_info.h`.
- **Result:** `GhosttyResult` (0 = success; `GHOSTTY_INVALID_VALUE` if `data` is `GHOSTTY_BUILD_INFO_INVALID` or unsupported).
- **Enum `GhosttyBuildInfo`** (from `build_info.h` lines 51–127):

  | Name | Value | Output type |
  |---|---|---|
  | `GHOSTTY_BUILD_INFO_INVALID` | 0 | (none — always returns `INVALID_VALUE`) |
  | `GHOSTTY_BUILD_INFO_SIMD` | 1 | `bool *` |
  | `GHOSTTY_BUILD_INFO_KITTY_GRAPHICS` | 2 | `bool *` |
  | `GHOSTTY_BUILD_INFO_TMUX_CONTROL_MODE` | 3 | `bool *` |
  | `GHOSTTY_BUILD_INFO_OPTIMIZE` | 4 | `GhosttyOptimizeMode *` (u32 enum) |
  | `GHOSTTY_BUILD_INFO_VERSION_STRING` | 5 | `GhosttyString *` |
  | `GHOSTTY_BUILD_INFO_VERSION_MAJOR` | 6 | `size_t *` |
  | `GHOSTTY_BUILD_INFO_VERSION_MINOR` | 7 | `size_t *` |
  | `GHOSTTY_BUILD_INFO_VERSION_PATCH` | 8 | `size_t *` |
  | `GHOSTTY_BUILD_INFO_VERSION_PRE` | 9 | `GhosttyString *` |
  | `GHOSTTY_BUILD_INFO_VERSION_BUILD` | 10 | `GhosttyString *` |

- **Enum `GhosttyOptimizeMode`:** `GHOSTTY_OPTIMIZE_DEBUG=0`, `_RELEASE_SAFE=1`, `_RELEASE_SMALL=2`, `_RELEASE_FAST=3`.
- **Live probe against the dylib** (via `bun` + `ghostty_build_info`):
  ```
  SIMD: true
  KITTY_GRAPHICS: true
  TMUX_CONTROL_MODE: false
  OPTIMIZE: 3 (GHOSTTY_OPTIMIZE_RELEASE_FAST)
  VERSION_STRING: "0.1.0-dev"
  VERSION_MAJOR: 0, MINOR: 1, PATCH: 0
  VERSION_PRE: "dev"
  VERSION_BUILD: ""
  ```

- **CRITICAL caveat on identity:** this reports the `libghostty-vt` library's own semantic version (currently `0.1.0-dev`). It does **not** return the Ghostty-repo git commit SHA that produced the dylib. At this pin the `VERSION_BUILD` metadata field is empty, so **we cannot cryptographically verify the loaded dylib was built from our pinned SHA via the C API alone.** Task 8's identity check can compare `VERSION_STRING` + major/minor/patch/pre against a pinned expected tuple, but this is a weaker guarantee than a commit-SHA check. The Task 21 README compat-claim paragraph must narrow accordingly.

- **Key function:** `ghostty_type_json(void)` — declared in `vt/types.h` line 255. Returns a null-terminated JSON string describing every C-API struct's layout (size, align, per-field offset + size + type). **This is a large additional verification surface** not contemplated by the plan's current probe design — see §5 and §7 below for the authoritative layouts.

## 3. GhosttyResult enum

Declared in `vt/types.h` lines 74–86. This enum uses **signed negative values** for errors, not the positive-`GHOSTTY_RESULT_*` shape the plan assumes.

| Name | Value | Semantic |
|---|---|---|
| `GHOSTTY_SUCCESS` | `0` | Operation succeeded |
| `GHOSTTY_OUT_OF_MEMORY` | `-1` | Allocation failed |
| `GHOSTTY_INVALID_VALUE` | `-2` | Invalid argument |
| `GHOSTTY_OUT_OF_SPACE` | `-3` | Caller-provided buffer too small |
| `GHOSTTY_NO_VALUE` | `-4` | The requested value has no value |
| `GHOSTTY_RESULT_MAX_VALUE` | `INT_MAX` | Sentinel (enum sizing only, never returned) |

**Consequences for the generator (Task 5):**
- The `RESULT_CODE_MAP` in the plan uses names like `GHOSTTY_RESULT_OK`, `GHOSTTY_RESULT_OUT_OF_MEMORY`, etc. Those names **do not exist** in the pinned header. The real names have no `_RESULT_` infix.
- The enum is declared with the typedef tag `GhosttyResult` (not `GhosttyResultCode` or similar).
- Values are negative — the generator's parser must accept `-?\d+` (it does) but the downstream `resultCodeByValue: Record<number, string>` is keyed by negative numbers for errors.
- At the FFI boundary, the return type in `SYMBOLS` must be a **signed 32-bit int** (`FFIType.i32`), not `FFIType.u32` as currently specified in the plan. If a -1 (OOM) is returned through a `u32` channel it becomes `4294967295`, which will miss every entry in `resultCodeByValue` and fall through to "unknown".

## 4. GhosttyTerminal functions

All signatures below are quoted verbatim from `vendor/ghostty/include/ghostty/vt/terminal.h`. Line numbers are inclusive source ranges.

| Symbol | Signature (source lines) |
|---|---|
| `ghostty_terminal_new` | `GhosttyResult ghostty_terminal_new(const GhosttyAllocator* allocator, GhosttyTerminal* terminal, GhosttyTerminalOptions options)` (terminal.h:884-886) |
| `ghostty_terminal_free` | `void ghostty_terminal_free(GhosttyTerminal terminal)` (terminal.h:898) |
| `ghostty_terminal_reset` | `void ghostty_terminal_reset(GhosttyTerminal terminal)` (terminal.h:911) |
| `ghostty_terminal_resize` | `GhosttyResult ghostty_terminal_resize(GhosttyTerminal terminal, uint16_t cols, uint16_t rows, uint32_t cell_width_px, uint32_t cell_height_px)` (terminal.h:934-938) |
| `ghostty_terminal_set` | `GhosttyResult ghostty_terminal_set(GhosttyTerminal terminal, GhosttyTerminalOption option, const void* value)` (terminal.h:960-962) |
| `ghostty_terminal_vt_write` | `void ghostty_terminal_vt_write(GhosttyTerminal terminal, const uint8_t* data, size_t len)` (terminal.h:985-987) — **returns void, not GhosttyResult**; documented to never fail |
| `ghostty_terminal_scroll_viewport` | `void ghostty_terminal_scroll_viewport(GhosttyTerminal terminal, GhosttyTerminalScrollViewport behavior)` (terminal.h:1002-1003) |
| `ghostty_terminal_mode_get` | `GhosttyResult ghostty_terminal_mode_get(GhosttyTerminal terminal, GhosttyMode mode, bool* out_value)` (terminal.h:1019-1021) |
| `ghostty_terminal_mode_set` | `GhosttyResult ghostty_terminal_mode_set(GhosttyTerminal terminal, GhosttyMode mode, bool value)` (terminal.h:1036-1038) |
| `ghostty_terminal_get` | `GhosttyResult ghostty_terminal_get(GhosttyTerminal terminal, GhosttyTerminalData data, void *out)` (terminal.h:1056-1058) |
| `ghostty_terminal_get_multi` | `GhosttyResult ghostty_terminal_get_multi(GhosttyTerminal terminal, size_t count, const GhosttyTerminalData* keys, void** values, size_t* out_written)` (terminal.h:1087-1091) |

### Type notes

- `GhosttyTerminal` is itself a **typedef for `struct GhosttyTerminalImpl*`** (types.h:95). It is a pointer; passing `NULL` is documented as a no-op for `_free`, `_reset`, `_scroll_viewport`; as `INVALID_VALUE` for `_mode_get`, `_mode_set`, `_resize`, `_grid_ref`, `_point_from_grid_ref`; and as a no-op (or OK) for `_set`, `_get`.
- `GhosttyTerminal*` (used in `_new`'s second parameter) is a **pointer-to-pointer** — the caller allocates space for one pointer; the library writes the opaque handle to that slot.
- `ghostty_terminal_new` passes `GhosttyTerminalOptions` **by value**, not by pointer. At the FFI layer in bun:ffi this requires either passing the struct bytes via a struct FFIType (not supported in Bun today) or indirecting through a helper C thunk. **This is a blocking issue for the plan's current FFI strategy — see §12 Surprise 5.**
- `GhosttyMode` is `uint16_t` (modes.h:105). Bun:ffi's typical ABI for a 16-bit integer argument is `FFIType.u16`.
- `GhosttyTerminalOption` is a `c_int`-backed enum (types.h:62–68); for bun:ffi use `FFIType.i32`.

### `ghostty_terminal_get_multi` details (this drives `Terminal.snapshot()`)

- **Keys array element type:** `const GhosttyTerminalData*` — `GhosttyTerminalData` is a `c_int`-backed enum (see §9), so each key is a signed 32-bit integer. The keys array is read-only.
- **Values array element type:** `void**` — **an array of N output pointers, where each pointer points to a caller-allocated slot of the per-key output type documented in the enum.** This is NOT a flat byte buffer with uniform slot size.
- **Per-key output types** (from the `GhosttyTerminalData` enum comments in terminal.h):
  - `COLS`, `ROWS`, `CURSOR_X`, `CURSOR_Y`: `uint16_t*` (2 bytes each)
  - `CURSOR_PENDING_WRAP`, `CURSOR_VISIBLE`, `MOUSE_TRACKING`, `KITTY_IMAGE_MEDIUM_*`: `bool*` (1 byte each)
  - `ACTIVE_SCREEN`: `GhosttyTerminalScreen*` (c_int enum, 4 bytes)
  - `KITTY_KEYBOARD_FLAGS`: `GhosttyKittyKeyFlags*` (u8)
  - `SCROLLBAR`: `GhosttyTerminalScrollbar*` (24 bytes, struct with u64 total/offset/len)
  - `CURSOR_STYLE`: `GhosttyStyle*` (72 bytes, sized struct)
  - `TITLE`, `PWD`: `GhosttyString*` (16 bytes: `uint8_t* ptr; size_t len`)
  - `TOTAL_ROWS`, `SCROLLBACK_ROWS`: `size_t*` (8 bytes)
  - `WIDTH_PX`, `HEIGHT_PX`: `uint32_t*` (4 bytes)
  - `COLOR_FOREGROUND`/`_BACKGROUND`/`_CURSOR` + `_DEFAULT` variants: `GhosttyColorRgb*` (3 bytes, u8 r/g/b)
  - `COLOR_PALETTE` + `_DEFAULT`: `GhosttyColorRgb[256]*` (768 bytes)
  - `KITTY_IMAGE_STORAGE_LIMIT`: `uint64_t*`
  - `KITTY_GRAPHICS`: `GhosttyKittyGraphics*` (opaque handle)
- **Sizeof one value slot:** **variable per key.** There is no single "slot size"; the caller sizes each slot independently.
- **String representation for `TITLE` / `PWD`:** the caller passes a pointer to a caller-allocated `GhosttyString` struct (16 bytes: `ptr @ 0`, `len @ 8`). The library writes into that struct. The resulting `ptr` aliases into the terminal's own memory — **it is a borrowed pointer valid only until the next mutating terminal call** (e.g., `vt_write`, `reset`, `resize`). `snapshot()` MUST copy the bytes into JS-owned memory before returning.
- **Allowed return codes:** `GHOSTTY_SUCCESS` (all keys succeeded), `GHOSTTY_INVALID_VALUE` (terminal NULL or a key is invalid). On error, `*out_written` receives the index of the first failing key.
- **Implication for Task 14:** the plan's current approach of "allocate a single `Uint8Array(n * 16)` and read each slot at offset `i * SLOT_SIZE`" does not match the actual ABI. The correct implementation allocates N independent typed slots in JS (one `Uint8Array` or `BigInt64Array` per key whose size matches the per-key output type), builds a `BigUint64Array(n)` of pointers to those slots via `ptr()`, and passes that pointer array as `values`.

### `ghostty_terminal_set` — option identifiers

`ghostty_terminal_set` is how APC max bytes, title, pwd, colors, and callbacks are wired. It is **not covered by the plan's current SYMBOLS list.** Key options:

| Option (enum val) | Name | Input type |
|---|---|---|
| 19 | `GHOSTTY_TERMINAL_OPT_APC_MAX_BYTES` | `size_t*` |
| 20 | `GHOSTTY_TERMINAL_OPT_APC_MAX_BYTES_KITTY` | `size_t*` |
| 9 | `GHOSTTY_TERMINAL_OPT_TITLE` | `GhosttyString*` |
| 10 | `GHOSTTY_TERMINAL_OPT_PWD` | `GhosttyString*` |

Full list in terminal.h:399–595 (21 entries total).

**APC max bytes are set via `ghostty_terminal_set()` AFTER construction, not via fields on `GhosttyTerminalOptions`.** This contradicts the plan's Task 4 probe and Task 11 constructor snippets, which treat `apc_max_bytes` as struct fields to probe and write into `GhosttyTerminalOptions`.

## 5. GhosttyTerminalOptions struct

**Declared in:** `terminal.h:163-176`.
**Authoritative layout from `ghostty_type_json()`:** `size=16, align=8`.

| Field | C type | Offset | Size | Kind | Source |
|---|---|---|---|---|---|
| `cols` | `uint16_t` | 0 | 2 | uint | terminal.h:165 |
| `rows` | `uint16_t` | 2 | 2 | uint | terminal.h:168 |
| `max_scrollback` | `size_t` | 8 | 8 | uint | terminal.h:171 |

**Sized-struct convention:** **NO.** The first field is `cols` (u16 @ offset 0), not `size_t size`. The header's comment at lines 173–175 explicitly says "TODO: Consider ABI compatibility implications of this struct. We may want to artificially pad it significantly to support future options." — so future pins may change this. At **this** pin, it is not sized.

**`apc_max_bytes` / `apc_max_bytes_kitty`:** **NOT FIELDS IN THIS STRUCT AT PIN.** They are set post-construction via `ghostty_terminal_set(term, GHOSTTY_TERMINAL_OPT_APC_MAX_BYTES, &limit)` and `..._APC_MAX_BYTES_KITTY`. The plan's Task 11 constructor snippet (lines 2400–2410) is wrong on this point.

**Padding note:** the struct has 4 bytes of padding at offset 4–7 to align `max_scrollback` to 8. The probe in Task 4 doesn't need to emit this — offsets are sufficient — but it's worth noting for the struct-writer.

## 6. GhosttyFormatter functions

**Declared in:** `vendor/ghostty/include/ghostty/vt/formatter.h`.

| Symbol | Signature (source lines) |
|---|---|
| `ghostty_formatter_terminal_new` | `GhosttyResult ghostty_formatter_terminal_new(const GhosttyAllocator* allocator, GhosttyFormatter* formatter, GhosttyTerminal terminal, GhosttyFormatterTerminalOptions options)` (formatter.h:151-155) |
| `ghostty_formatter_format_buf` | `GhosttyResult ghostty_formatter_format_buf(GhosttyFormatter formatter, uint8_t* buf, size_t buf_len, size_t* out_written)` (formatter.h:178-181) |
| `ghostty_formatter_format_alloc` | `GhosttyResult ghostty_formatter_format_alloc(GhosttyFormatter formatter, const GhosttyAllocator* allocator, uint8_t** out_ptr, size_t* out_len)` (formatter.h:201-204) |
| `ghostty_formatter_free` | `void ghostty_formatter_free(GhosttyFormatter formatter)` (formatter.h:216) |

### Critical corrections vs. the plan

1. **There is no `ghostty_formatter_new` symbol at this pin.** The constructor is `ghostty_formatter_terminal_new` — it formats a terminal's active screen. `nm -gU` on the dylib confirms: only `_ghostty_formatter_terminal_new`, `_ghostty_formatter_format_buf`, `_ghostty_formatter_format_alloc`, `_ghostty_formatter_free` are exported (no bare `_ghostty_formatter_new`).
2. **There is no `ghostty_formatter_format` symbol at this pin.** The plan references it; reality has two separate entry points: `_format_buf` (caller-provided buffer, with size-query mode when `buf == NULL`) and `_format_alloc` (library allocates). The binding must choose which to use.
3. **Constructor signature is allocator-first.** Shape: `(const GhosttyAllocator* alloc, GhosttyFormatter* out, GhosttyTerminal term, GhosttyFormatterTerminalOptions opts)`. Terminal is passed by value (it's itself a pointer). Options is passed by value.
4. **Format tag (plain/vt/html) is NOT a constructor argument.** It is the `emit` field on `GhosttyFormatterTerminalOptions` (offset 8, u32 enum). See §7 and §10.

### Output ownership

- **`ghostty_formatter_format_buf`:** caller owns the buffer. Library writes into it. If the buffer is too small returns `GHOSTTY_OUT_OF_SPACE` and sets `*out_written` to the required size. Pass `buf == NULL` to query the required size (returns `OUT_OF_SPACE` and writes required size to `*out_written`). No free call needed.
- **`ghostty_formatter_format_alloc`:** library allocates using the passed allocator (or default if NULL). Writes the buffer pointer to `*out_ptr` and length to `*out_len`. **The caller MUST free this buffer with `ghostty_free(allocator, out_ptr, out_len)`** — passing the **same allocator** (or NULL) used for allocation, and the length returned in `*out_len`. `ghostty_free` requires the length; it is NOT a libc-style `free(ptr)`.

### Recommended path for Pass 1 `Formatter.format()`

`_format_alloc` is simpler (no two-phase size-query dance) and aligns with the plan's intent. The implementation path is:
1. Call `ghostty_formatter_format_alloc(formatter, NULL, &out_ptr, &out_len)`.
2. Check result code.
3. Copy `out_len` bytes from `out_ptr` into a JS-owned `Uint8Array`.
4. In a `finally` block, call `ghostty_free(NULL, out_ptr, out_len)`.

Alternative (size-query + caller buffer) via `_format_buf` avoids the extra copy but needs two FFI calls and JS-side buffer growth. Pass 1 can use `_format_alloc`; Pass 2+ can reconsider.

## 7. GhosttyFormatterTerminalOptions struct

Note: the type is named `GhosttyFormatterTerminalOptions` (not `GhosttyFormatterOptions` as the plan assumes). Declared in `formatter.h:116-135`.

**Authoritative layout from `ghostty_type_json()`:** `size=56, align=8`.

| Field | C type | Offset | Size | Kind | Source |
|---|---|---|---|---|---|
| `size` | `size_t` | 0 | 8 | uint | formatter.h:118 |
| `emit` | `GhosttyFormatterFormat` | 8 | 4 | uint (enum) | formatter.h:121 |
| `unwrap` | `bool` | 12 | 1 | bool | formatter.h:124 |
| `trim` | `bool` | 13 | 1 | bool | formatter.h:127 |
| `extra` | `GhosttyFormatterTerminalExtra` | 16 | 32 | struct | formatter.h:130 |
| `selection` | `const GhosttySelection *` | 48 | 8 | ptr | formatter.h:134 |

(Padding at offsets 14–15 to align `extra` to 8.)

**Sized-struct convention: YES.** First field is `size_t size`. Use the `GHOSTTY_INIT_SIZED(GhosttyFormatterTerminalOptions)` macro pattern — set `size = sizeof(GhosttyFormatterTerminalOptions) = 56` in the struct writer.

### Nested `GhosttyFormatterTerminalExtra` (offset 16, size 32)

Declared in `formatter.h:85-109`. Also sized.

| Field | C type | Offset (in extra) | Size | Kind |
|---|---|---|---|---|
| `size` | `size_t` | 0 | 8 | uint |
| `palette` | `bool` | 8 | 1 | bool |
| `modes` | `bool` | 9 | 1 | bool |
| `scrolling_region` | `bool` | 10 | 1 | bool |
| `tabstops` | `bool` | 11 | 1 | bool |
| `pwd` | `bool` | 12 | 1 | bool |
| `keyboard` | `bool` | 13 | 1 | bool |
| `screen` | `GhosttyFormatterScreenExtra` | 16 | 16 | struct |

Note: plan's Task 16 references `tab_stops` — the real field name is `tabstops` (no underscore between `tab` and `stops`).

### Nested `GhosttyFormatterScreenExtra` (inside `extra`, offset 16, size 16)

Declared in `formatter.h:57-78`. Also sized.

| Field | C type | Offset (in screen) | Size | Kind |
|---|---|---|---|---|
| `size` | `size_t` | 0 | 8 | uint |
| `cursor` | `bool` | 8 | 1 | bool |
| `style` | `bool` | 9 | 1 | bool |
| `hyperlink` | `bool` | 10 | 1 | bool |
| `protection` | `bool` | 11 | 1 | bool |
| `kitty_keyboard` | `bool` | 12 | 1 | bool |
| `charsets` | `bool` | 13 | 1 | bool |

### Format selection

**Format (plain/vt/html) is selected via the `emit` field on the outer options struct, NOT via a separate constructor argument.** Set `options.emit = GHOSTTY_FORMATTER_FORMAT_PLAIN` (0), `_VT` (1), or `_HTML` (2). See §10.

**Implication for Task 5 generator:** `formatterTagByName` should map to the `GhosttyFormatterFormat` enum values (0/1/2), and Task 16's `Formatter` constructor should set the `emit` field in the options struct rather than passing a separate tag argument.

## 8. Modes (NOT an enum — `#define` macros)

**This is the single biggest structural mismatch between the plan and reality.** Declared in `vendor/ghostty/include/ghostty/vt/modes.h`.

### What the plan assumes

The plan refers to a `ModeTag` enum with entries like `GHOSTTY_MODE_BRACKETED_PASTE` each having an integer value, and the generator strips a constant `MODE_TAG_PREFIX` to derive TS names.

### What reality is

- **`GhosttyMode` is not an enum.** It is `typedef uint16_t GhosttyMode;` (modes.h:105).
- **There are no `enum ModeTag { ... }` declarations anywhere in the headers.**
- Modes are exposed as **41 `#define` macros**, each of the form:
  ```c
  #define GHOSTTY_MODE_BRACKETED_PASTE  (ghostty_mode_new(2004, false))
  ```
  where `ghostty_mode_new(value, ansi)` is an inline function that packs `(value & 0x7FFF) | ((ansi ? 1 : 0) << 15)` into a `uint16_t`.
- **The prefix is `GHOSTTY_MODE_`.** (That part of the plan is correct.)
- Derivation of the TS name: strip `GHOSTTY_MODE_` prefix, lowercase. So `GHOSTTY_MODE_BRACKETED_PASTE` → `bracketed_paste`. **However, some names start with digits** — `GHOSTTY_MODE_132_COLUMN` → `132_column` — which is not a valid TS identifier. The generator must handle this (e.g. `_132_column` or `col_132_column`; pick a convention and document it).

### Complete mode list (41 entries)

The generator cannot parse this as an enum. It must parse `#define GHOSTTY_MODE_<NAME>  (ghostty_mode_new(<VALUE>, <ANSI>))` lines and compute the packed `uint16_t` via the formula `(value & 0x7FFF) | (ansi << 15)`.

**ANSI modes (ansi=true, bit 15 set):**

| C name | value arg | ansi | Packed uint16 | TS name |
|---|---:|---|---:|---|
| `GHOSTTY_MODE_KAM` | 2 | true | 32770 (0x8002) | `kam` |
| `GHOSTTY_MODE_INSERT` | 4 | true | 32772 (0x8004) | `insert` |
| `GHOSTTY_MODE_SRM` | 12 | true | 32780 (0x800C) | `srm` |
| `GHOSTTY_MODE_LINEFEED` | 20 | true | 32788 (0x8014) | `linefeed` |

**DEC private modes (ansi=false, bit 15 clear; packed value = value arg):**

| C name | value arg | ansi | Packed uint16 | TS name |
|---|---:|---|---:|---|
| `GHOSTTY_MODE_DECCKM` | 1 | false | 1 | `deckm` (or `deckm`) |
| `GHOSTTY_MODE_132_COLUMN` | 3 | false | 3 | `132_column` (needs convention) |
| `GHOSTTY_MODE_SLOW_SCROLL` | 4 | false | 4 | `slow_scroll` |
| `GHOSTTY_MODE_REVERSE_COLORS` | 5 | false | 5 | `reverse_colors` |
| `GHOSTTY_MODE_ORIGIN` | 6 | false | 6 | `origin` |
| `GHOSTTY_MODE_WRAPAROUND` | 7 | false | 7 | `wraparound` |
| `GHOSTTY_MODE_AUTOREPEAT` | 8 | false | 8 | `autorepeat` |
| `GHOSTTY_MODE_X10_MOUSE` | 9 | false | 9 | `x10_mouse` |
| `GHOSTTY_MODE_CURSOR_BLINKING` | 12 | false | 12 | `cursor_blinking` |
| `GHOSTTY_MODE_CURSOR_VISIBLE` | 25 | false | 25 | `cursor_visible` |
| `GHOSTTY_MODE_ENABLE_MODE_3` | 40 | false | 40 | `enable_mode_3` |
| `GHOSTTY_MODE_REVERSE_WRAP` | 45 | false | 45 | `reverse_wrap` |
| `GHOSTTY_MODE_ALT_SCREEN_LEGACY` | 47 | false | 47 | `alt_screen_legacy` |
| `GHOSTTY_MODE_KEYPAD_KEYS` | 66 | false | 66 | `keypad_keys` |
| `GHOSTTY_MODE_BACKARROW_KEY_MODE` | 67 | false | 67 | `backarrow_key_mode` |
| `GHOSTTY_MODE_LEFT_RIGHT_MARGIN` | 69 | false | 69 | `left_right_margin` |
| `GHOSTTY_MODE_NORMAL_MOUSE` | 1000 | false | 1000 | `normal_mouse` |
| `GHOSTTY_MODE_BUTTON_MOUSE` | 1002 | false | 1002 | `button_mouse` |
| `GHOSTTY_MODE_ANY_MOUSE` | 1003 | false | 1003 | `any_mouse` |
| `GHOSTTY_MODE_FOCUS_EVENT` | 1004 | false | 1004 | `focus_event` |
| `GHOSTTY_MODE_UTF8_MOUSE` | 1005 | false | 1005 | `utf8_mouse` |
| `GHOSTTY_MODE_SGR_MOUSE` | 1006 | false | 1006 | `sgr_mouse` |
| `GHOSTTY_MODE_ALT_SCROLL` | 1007 | false | 1007 | `alt_scroll` |
| `GHOSTTY_MODE_URXVT_MOUSE` | 1015 | false | 1015 | `urxvt_mouse` |
| `GHOSTTY_MODE_SGR_PIXELS_MOUSE` | 1016 | false | 1016 | `sgr_pixels_mouse` |
| `GHOSTTY_MODE_NUMLOCK_KEYPAD` | 1035 | false | 1035 | `numlock_keypad` |
| `GHOSTTY_MODE_ALT_ESC_PREFIX` | 1036 | false | 1036 | `alt_esc_prefix` |
| `GHOSTTY_MODE_ALT_SENDS_ESC` | 1039 | false | 1039 | `alt_sends_esc` |
| `GHOSTTY_MODE_REVERSE_WRAP_EXT` | 1045 | false | 1045 | `reverse_wrap_ext` |
| `GHOSTTY_MODE_ALT_SCREEN` | 1047 | false | 1047 | `alt_screen` |
| `GHOSTTY_MODE_SAVE_CURSOR` | 1048 | false | 1048 | `save_cursor` |
| `GHOSTTY_MODE_ALT_SCREEN_SAVE` | 1049 | false | 1049 | `alt_screen_save` |
| `GHOSTTY_MODE_BRACKETED_PASTE` | 2004 | false | 2004 | `bracketed_paste` |
| `GHOSTTY_MODE_SYNC_OUTPUT` | 2026 | false | 2026 | `sync_output` |
| `GHOSTTY_MODE_GRAPHEME_CLUSTER` | 2027 | false | 2027 | `grapheme_cluster` |
| `GHOSTTY_MODE_COLOR_SCHEME_REPORT` | 2031 | false | 2031 | `color_scheme_report` |
| `GHOSTTY_MODE_IN_BAND_RESIZE` | 2048 | false | 2048 | `in_band_resize` |

**Implications for Task 5 (generator):**

- The current `parseEnums` / `ModeTag` lookup will find nothing (no enum named `ModeTag` or `GhosttyModeTag` exists).
- The generator needs a dedicated `parseModeDefines` function that matches `#define GHOSTTY_MODE_<NAME>\s+\(ghostty_mode_new\(<value>,\s*(true|false)\)\)` and computes packed `uint16_t`.
- `modeTagByName` maps TS name → packed `uint16_t` value. This is what `ghostty_terminal_mode_get`/`_set` expect as their `GhosttyMode` argument.
- The 4 ANSI modes and 37 DEC private modes share the 16-bit namespace via the packing; there's no "tag enum value" to emit — the packed integer is the argument.
- Names starting with digits (`132_column`) need a convention: prefix with underscore (`_132_column`) or a letter. The Task 5 generator must handle this and emit it consistently.

**Implication for Task 15 (`Terminal.mode`/`setMode`):** `modeTagByName` is still the right abstraction, but its values are packed `uint16_t`s, and the FFI argument types for `ghostty_terminal_mode_get`/`_set` must be `FFIType.u16` (not `FFIType.u32` as in the plan's current SYMBOLS).

## 9. GhosttyTerminalData enum (for `ghostty_terminal_get_multi`)

The plan calls this `GhosttyTerminalGetKey`. The real name at this pin is **`GhosttyTerminalData`**. Declared in `terminal.h:606-872`. All values are `c_int`; the enum has 31 entries (0–30 + sentinel).

| Name | Value | Snapshot field (plan) | Output type at pin |
|---|---:|---|---|
| `GHOSTTY_TERMINAL_DATA_INVALID` | 0 | (never used) | — |
| `GHOSTTY_TERMINAL_DATA_COLS` | 1 | `cols` | `uint16_t *` |
| `GHOSTTY_TERMINAL_DATA_ROWS` | 2 | `rows` | `uint16_t *` |
| `GHOSTTY_TERMINAL_DATA_CURSOR_X` | 3 | `cursor.x` | `uint16_t *` |
| `GHOSTTY_TERMINAL_DATA_CURSOR_Y` | 4 | `cursor.y` | `uint16_t *` |
| `GHOSTTY_TERMINAL_DATA_CURSOR_PENDING_WRAP` | 5 | (not in plan) | `bool *` |
| `GHOSTTY_TERMINAL_DATA_ACTIVE_SCREEN` | 6 | `activeScreen` | `GhosttyTerminalScreen *` (i32) |
| `GHOSTTY_TERMINAL_DATA_CURSOR_VISIBLE` | 7 | `cursor.visible` | `bool *` |
| `GHOSTTY_TERMINAL_DATA_KITTY_KEYBOARD_FLAGS` | 8 | (not in plan) | `GhosttyKittyKeyFlags *` (u8) |
| `GHOSTTY_TERMINAL_DATA_SCROLLBAR` | 9 | (not in plan) | `GhosttyTerminalScrollbar *` (24B) |
| `GHOSTTY_TERMINAL_DATA_CURSOR_STYLE` | 10 | `cursor.style` | `GhosttyStyle *` (72B sized struct) |
| `GHOSTTY_TERMINAL_DATA_MOUSE_TRACKING` | 11 | `mouseTracking` | `bool *` |
| `GHOSTTY_TERMINAL_DATA_TITLE` | 12 | `title` | `GhosttyString *` (16B, borrowed) |
| `GHOSTTY_TERMINAL_DATA_PWD` | 13 | `pwd` | `GhosttyString *` (16B, borrowed) |
| `GHOSTTY_TERMINAL_DATA_TOTAL_ROWS` | 14 | (not in plan) | `size_t *` |
| `GHOSTTY_TERMINAL_DATA_SCROLLBACK_ROWS` | 15 | `scrollbackRows` | `size_t *` (8B, NOT u32) |
| `GHOSTTY_TERMINAL_DATA_WIDTH_PX` | 16 | (computed in plan from cellPx) | `uint32_t *` |
| `GHOSTTY_TERMINAL_DATA_HEIGHT_PX` | 17 | (computed in plan from cellPx) | `uint32_t *` |
| `GHOSTTY_TERMINAL_DATA_COLOR_FOREGROUND` | 18 | (Pass 2+) | `GhosttyColorRgb *` |
| `GHOSTTY_TERMINAL_DATA_COLOR_BACKGROUND` | 19 | (Pass 2+) | `GhosttyColorRgb *` |
| `GHOSTTY_TERMINAL_DATA_COLOR_CURSOR` | 20 | (Pass 2+) | `GhosttyColorRgb *` |
| `GHOSTTY_TERMINAL_DATA_COLOR_PALETTE` | 21 | (Pass 2+) | `GhosttyColorRgb[256] *` |
| `GHOSTTY_TERMINAL_DATA_COLOR_FOREGROUND_DEFAULT` | 22 | (Pass 2+) | `GhosttyColorRgb *` |
| `GHOSTTY_TERMINAL_DATA_COLOR_BACKGROUND_DEFAULT` | 23 | (Pass 2+) | `GhosttyColorRgb *` |
| `GHOSTTY_TERMINAL_DATA_COLOR_CURSOR_DEFAULT` | 24 | (Pass 2+) | `GhosttyColorRgb *` |
| `GHOSTTY_TERMINAL_DATA_COLOR_PALETTE_DEFAULT` | 25 | (Pass 2+) | `GhosttyColorRgb[256] *` |
| `GHOSTTY_TERMINAL_DATA_KITTY_IMAGE_STORAGE_LIMIT` | 26 | (Pass 2+) | `uint64_t *` |
| `GHOSTTY_TERMINAL_DATA_KITTY_IMAGE_MEDIUM_FILE` | 27 | (Pass 2+) | `bool *` |
| `GHOSTTY_TERMINAL_DATA_KITTY_IMAGE_MEDIUM_TEMP_FILE` | 28 | (Pass 2+) | `bool *` |
| `GHOSTTY_TERMINAL_DATA_KITTY_IMAGE_MEDIUM_SHARED_MEM` | 29 | (Pass 2+) | `bool *` |
| `GHOSTTY_TERMINAL_DATA_KITTY_GRAPHICS` | 30 | (Pass 2+) | `GhosttyKittyGraphics *` |

**Implications for Task 14 (`SNAPSHOT_KEYS`):**
- The plan names `GHOSTTY_TERMINAL_GET_*`. The real prefix is `GHOSTTY_TERMINAL_DATA_`. Every key name in `SNAPSHOT_KEYS` must be rewritten.
- The plan's `GhosttyTerminalGetKeyValues` import name should be `GhosttyTerminalDataValues`.
- `MOUSE_TRACKING` returns a single `bool*`, not the rich string the plan expects (`"none" | "normal" | ...`). Pass 1 should either:
  - (a) Report `"active" | "inactive"` (boolean → string), or
  - (b) Drop `mouseTracking` from Pass 1 snapshot until Pass 2+ wires richer data.
- `CURSOR_STYLE` returns a 72-byte `GhosttyStyle` struct, not a small enum. Pass 1 probably wants to defer this (the current plan already hardcodes `style: "block"` so this isn't a blocker).
- `SCROLLBACK_ROWS` is `size_t*` (8 bytes), not `u32`. The plan currently labels it `size: "u32"`.
- `WIDTH_PX`/`HEIGHT_PX` ARE exposed by the library and are more accurate than `cols * cellPx.width` (they're what `ghostty_terminal_resize` was called with). The plan computes them in JS from cellPx; either approach works, but using the library-reported values is safer.
- "NOT AT PIN" keys: none — every key the plan assumes exists. The issue is name-prefix + output-type mismatches, not missing functionality.

## 10. GhosttyFormatterFormat enum

The plan calls this `GhosttyFormatterTag`. Real name: **`GhosttyFormatterFormat`** (formatter.h:40-50).

| Name | Value |
|---:|---:|
| `GHOSTTY_FORMATTER_FORMAT_PLAIN` | 0 |
| `GHOSTTY_FORMATTER_FORMAT_VT` | 1 |
| `GHOSTTY_FORMATTER_FORMAT_HTML` | 2 |
| `GHOSTTY_FORMATTER_FORMAT_MAX_VALUE` | `INT_MAX` (sentinel) |

The enum is underlying-type `c_int` (4 bytes). These values go in the `emit` field (offset 8) of `GhosttyFormatterTerminalOptions`.

**Implication for Task 5 generator:** the `formatterTagByName` snippet looks up enum names `GHOSTTY_FORMATTER_PLAIN`, `_VT`, `_HTML`. The real names include the `_FORMAT_` infix: `GHOSTTY_FORMATTER_FORMAT_PLAIN`. Update the three string literals in the generator.

## 11. Allocator protocol

Declared in `vendor/ghostty/include/ghostty/vt/allocator.h`.

- **`ghostty_alloc` signature** (allocator.h:226): `uint8_t* ghostty_alloc(const GhosttyAllocator* allocator, size_t len)`.
- **`ghostty_free` signature** (allocator.h:251): `void ghostty_free(const GhosttyAllocator* allocator, uint8_t* ptr, size_t len)`.
- **Passing NULL for `allocator` is LEGAL and common.** Documented at lines 30–33 and 184–186: "For the common case, you can pass NULL as the allocator for any function that accepts one, and libghostty will use a default allocator. The default allocator will be libc malloc/free if libc is linked."
- **`ghostty_free` requires `len`.** This is the critical difference from `libc` `free()` — the caller must track and pass the allocation length. Passing a wrong length is UB.
- **`ghostty_free(NULL, NULL, 0)` is safe** — "It is safe to pass a NULL pointer; the call is a no-op in that case." (line 241).
- **`GhosttyAllocator` struct** (allocator.h:198-211): `{ void *ctx; const GhosttyAllocatorVtable *vtable; }` — we don't use custom allocators in Pass 1; NULL passed everywhere.

**Implication for Task 8 SYMBOLS:** the `ghostty_free` entry is already correct (`[FFIType.ptr, FFIType.ptr, FFIType.u64]`); `ghostty_alloc` is correct (`[FFIType.ptr, FFIType.u64]` → `FFIType.ptr`).

## 12. Summary of surprises

Every surprise below corresponds to one or more required plan edits. Outcomes:
- **(a)** update plan snippet (executor will read the doc and write the right thing; but the snippet in the plan is wrong as currently written and misleads the executor).
- **(b)** narrow Pass 1 scope.
- **(c)** proceed as planned (assumption matched reality).

### Surprise 1: `GhosttyResult` uses negative error values and different names — (a) update plan

The plan's `RESULT_CODE_MAP` uses names like `GHOSTTY_RESULT_OK`, `GHOSTTY_RESULT_OUT_OF_MEMORY`, `GHOSTTY_RESULT_INVALID_ARGUMENT`, `GHOSTTY_RESULT_UNINITIALIZED`. The real names are `GHOSTTY_SUCCESS=0`, `GHOSTTY_OUT_OF_MEMORY=-1`, `GHOSTTY_INVALID_VALUE=-2`, `GHOSTTY_OUT_OF_SPACE=-3`, `GHOSTTY_NO_VALUE=-4`. Values are negative, not positive. The FFI return type must be **signed** (`FFIType.i32`) not unsigned.

### Surprise 2: `GhosttyMode` is not an enum — it's 41 `#define`s, each a `uint16_t` constant — (a) update plan

Plan's Task 5 assumes `enum ModeTag { ... }` exists and the generator parses it. Reality: modes are `#define GHOSTTY_MODE_<NAME>  (ghostty_mode_new(<value>, <ansi>))` macros producing packed `uint16_t` values. The generator needs a dedicated mode-define parser, and `modeTagByName` values are packed u16s (not enum indices). FFI signatures for `ghostty_terminal_mode_get`/`_set` must use `FFIType.u16` for the mode argument.

### Surprise 3: `ghostty_terminal_get_multi` values array is `void**`, NOT a flat byte buffer — (a) update plan

Plan assumes a single `Uint8Array(n * SLOT_SIZE=16)` where each i*16-byte slot holds the value for key i. Reality: `void** values` is an array of output pointers; each element points to a caller-allocated slot whose size matches the per-key output type (1/2/3/4/8/16/24/72/768 bytes depending on the key). The snapshot implementation must allocate N typed slots and a `BigUint64Array(n)` of pointers to those slots.

### Surprise 4: `GhosttyTerminalOptions` is NOT sized and does NOT carry APC fields — (a) update plan

Plan's Task 4 probe emits an `isSized` detection for `GhosttyTerminalOptions`. At this pin it's not sized (first field is `cols:u16`, not `size_t size`). Plan's Task 11 wires `apc_max_bytes`/`_kitty` as struct fields; at this pin they are `ghostty_terminal_set()` options (19 and 20) set post-construction.

### Surprise 5: `ghostty_terminal_new` passes options BY VALUE, not by pointer — (a) update plan + may require C shim

Plan's Task 8 SYMBOLS declares `ghostty_terminal_new: args: [FFIType.ptr, FFIType.ptr]` — i.e. `(allocator_or_null, &options_struct) → GhosttyTerminal*`. Reality's signature is `(const GhosttyAllocator* allocator, GhosttyTerminal* terminal, GhosttyTerminalOptions options)` — third argument is the 16-byte options struct **by value**, and the terminal handle is written back through the second argument (pointer-to-pointer), so the **return** is `GhosttyResult` (i32), not a handle pointer.

**bun:ffi does not support passing structs by value as of 2026-04-22.** Bun's FFI types are scalar (pointer, integer, float, etc.). Options to resolve:

- **(i)** Write a tiny C shim (ghostty-vt-shim.c) that wraps the options pointer-by-value bridge and exposes a `ghostty_terminal_new_ptr(const GhosttyAllocator*, GhosttyTerminal*, const GhosttyTerminalOptions*)` that dereferences the struct. Compile it alongside the dylib. Same pattern would also apply to `ghostty_formatter_terminal_new` (which also takes options by value).
- **(ii)** Decompose the options struct at the ABI boundary into register-sized chunks: on arm64 macOS, structs ≤ 16 bytes are passed in two 64-bit integer registers (`x2` + `x3` for the third arg position). We can declare the symbol with signature `[FFIType.ptr, FFIType.ptr, FFIType.u64, FFIType.u64]` and pack the 16 bytes of options into two u64s. **CONFIRMED WORKING on darwin-arm64**: a probe constructed a real `GhosttyTerminal` via this pattern (`.tmp/probe-terminal-new.ts` returns `result=0` and a valid handle). This is platform-specific (arm64 AAPCS64; on x86_64 SysV the register rules differ; Windows x64 always passes structs >8 bytes by hidden pointer). For `GhosttyFormatterTerminalOptions` (56 bytes), arm64 AAPCS64 passes it via a hidden pointer — so we can just declare the arg as `FFIType.ptr` and pass `ptr(optBytes)` directly.
- **(iii)** Add Bun:ffi struct-by-value support to Bun upstream. Out of scope.

**Recommendation for darwin-arm64 (Pass 1's only target):**
- `ghostty_terminal_new`: use (ii) — signature `[FFIType.ptr, FFIType.ptr, FFIType.u64, FFIType.u64] → FFIType.i32`. Pack the 16-byte options into two u64s via a DataView.
- `ghostty_formatter_terminal_new`: passes 56-byte options via hidden pointer (arm64 AAPCS64: structs > 16 bytes are passed indirectly). **CONFIRMED WORKING**: signature `[FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr] → FFIType.i32` where argv is `(alloc, &out, term, &options)`. Full end-to-end probe at `.tmp/probe-formatter2.ts` — constructs a terminal, writes "hello", creates a formatter, calls `format_alloc`, and reads back `"hello"` successfully. **This validates that Pass 1 can be implemented entirely with bun:ffi, no C shim required.**
- If Pass 2+ adds Linux x64 or Windows support, revisit with shim (i).

**This is a plan decision, not an executor decision.** The plan currently assumes a fixed-shape SYMBOLS table. Matt should decide whether to lock Pass 1 to darwin-arm64 with the register-split approach or to commit to the shim approach now. My recommendation: register-split for Pass 1 (no C shim needed; platform-gated in the CI matrix already), document the constraint in Task 21 README.

### Surprise 6: Formatter constructor is `ghostty_formatter_terminal_new`, NOT `ghostty_formatter_new` — (a) update plan

Plan Task 16 refers to `ghostty_formatter_new`. That symbol does not exist in the dylib. The real symbol is `ghostty_formatter_terminal_new` — it takes a terminal handle by value (it's already a pointer) and formats the terminal's active screen. Signature: `(const GhosttyAllocator* alloc, GhosttyFormatter* out, GhosttyTerminal term, GhosttyFormatterTerminalOptions options)`. The same by-value options issue as Surprise 5 applies here — 56 bytes passed by value is too large for register-splitting, so the C shim approach is the clearer path.

### Surprise 7: Formatter output path is `format_buf` OR `format_alloc`, NOT `format` — (a) update plan

Plan Task 16 refers to `ghostty_formatter_format`. Reality has two entry points:
- `ghostty_formatter_format_buf(fmt, buf, buf_len, out_written)` — caller-provided buffer, size-query via NULL buf.
- `ghostty_formatter_format_alloc(fmt, alloc, out_ptr, out_len)` — library-allocated, caller frees with `ghostty_free(alloc, out_ptr, out_len)`.

Recommended Pass 1 path: `_format_alloc`. Task 8's SYMBOLS needs both symbols added; Task 16's constructor + format implementation needs a full rewrite.

### Surprise 8: Formatter options type is `GhosttyFormatterTerminalOptions` (56 B, sized) with `emit` enum for format — (a) update plan

Plan refers to `GhosttyFormatterOptions`. Real type is `GhosttyFormatterTerminalOptions`. Size 56, align 8, **is sized** (first field `size_t size`). Format selection is via `emit` field (offset 8), not a separate constructor argument. Contains nested `GhosttyFormatterTerminalExtra` (at offset 16, 32 bytes) which itself contains a nested `GhosttyFormatterScreenExtra` (at offset 16 within extra, 16 bytes). Both nested structs are also sized. Field `tabstops` (not `tab_stops`).

### Surprise 9: Build identity is partially exposed (version, not commit SHA) — (a) update plan

`ghostty_build_info()` exposes version major/minor/patch/pre/build/string/SIMD/Kitty/tmux/optimize — but at this pin `VERSION_BUILD` is empty, so the git commit SHA is NOT in the library. We can verify the loaded dylib matches expected version `0.1.0-dev` + pre=`dev`, which is a much weaker guarantee than a commit-SHA match. Task 8 can wire an identity check with that weaker contract. Task 21 README must narrow the compat claim: "symbol names + struct layouts + library version string" (no cryptographic commit guarantee).

### Surprise 10: `ghostty_terminal_vt_write` returns void — (a) update plan

Plan Task 8 SYMBOLS declares `ghostty_terminal_vt_write: returns: FFIType.u32`. Reality: `void ghostty_terminal_vt_write(...)`. Documented to never fail. Drop the `checkResult` call in Task 12's implementation.

### Surprise 11: `ghostty_terminal_reset` also returns void — (a) update plan

Plan Task 8 SYMBOLS declares `ghostty_terminal_reset: returns: FFIType.u32`. Reality: `void ghostty_terminal_reset(...)`. Drop the `checkResult` call in Task 13.

### Surprise 12: `ghostty_terminal_resize` takes cols/rows AND cell_width_px/cell_height_px — (a) update plan

Plan Task 8 SYMBOLS declares `args: [FFIType.ptr, FFIType.u32, FFIType.u32]` (`term, cols, rows`). Reality: `(term, uint16_t cols, uint16_t rows, uint32_t cell_width_px, uint32_t cell_height_px)`. Five arguments total; cols/rows are u16, not u32. The `cellPx` previously captured in the Terminal constructor is consumed by `resize`, which explains why the plan's design passes `cellPx` on resize. The plan's *signature* needs updating: `args: [FFIType.ptr, FFIType.u16, FFIType.u16, FFIType.u32, FFIType.u32]`.

### Surprise 13: `GhosttyTerminalData` (not `GhosttyTerminalGetKey`) — names use `_DATA_` infix — (a) update plan

Plan Task 14's `SNAPSHOT_KEYS` uses names like `GHOSTTY_TERMINAL_GET_COLS`. The real enum is `GhosttyTerminalData` with names `GHOSTTY_TERMINAL_DATA_COLS`, etc. Task 5 generator's lookup `enums.get("GhosttyTerminalData")` works; the snapshot code in Task 14 needs all keys renamed.

### Surprise 14: `GhosttyFormatterFormat` (not `GhosttyFormatterTag`) — names use `_FORMAT_` infix — (a) update plan

Plan Task 5 generator looks up enum `GhosttyFormatterTag` and names `GHOSTTY_FORMATTER_PLAIN`/`_VT`/`_HTML`. Reality: enum is `GhosttyFormatterFormat`; names are `GHOSTTY_FORMATTER_FORMAT_PLAIN`/`_VT`/`_HTML`. Update the three string literals.

### Surprise 15: `ghostty_type_json()` exists and provides runtime struct layouts — (b)/(c) opportunistic scope narrow

Not contemplated by the plan. `ghostty_type_json(void)` returns a null-terminated JSON string describing every C-API struct's layout (size, align, per-field offset + size + type). This could replace Task 4's compile-time C probe entirely — at runtime the binding could cross-check layouts against `ghostty_type_json` output. **Not recommending a scope change for Pass 1** (the probe is already designed and will work fine), but worth a note in Task 18's ABI smoke test: add an assertion that `ghostty_type_json()` agrees with the probe's `structLayouts` for the structs we care about. That's one additional source of protection against silent ABI drift.

### Surprise 16: Mode names starting with digits need a TS-identifier escape — (a) update plan

`GHOSTTY_MODE_132_COLUMN` → `132_column` is not a valid TS identifier (cannot be a type key without quoting, cannot be an object property without quoting). The generator must emit a valid name. Suggested convention: prefix offending names with an underscore → `_132_column`. Document the rule in the generator source. Only one mode is affected at this pin.

### Surprise 17: No `GHOSTTY_SCROLL_VIEWPORT_*` enum parse needed for Pass 1 — (c) proceed as planned

Pass 1 does not expose viewport scrolling (spec §Pass 5). The `GhosttyTerminalScrollViewportTag` enum exists at the pin but is out of scope. No plan edit needed.

---

## Cross-reference: which plan tasks each surprise touches

| Surprise | Tasks affected |
|---|---|
| 1 (Result names/values) | Task 5 (RESULT_CODE_MAP), Task 6 (error codes), Task 8 (FFI return types), Task 11 (checkResult) |
| 2 (Modes = #defines, not enum) | Task 5 (generator), Task 15 (mode/setMode FFI arg types) |
| 3 (get_multi is void**) | Task 14 (snapshot implementation) |
| 4 (TerminalOptions not sized, no APC fields) | Task 4 (probe), Task 11 (constructor) |
| 5 (terminal_new passes by value) | Task 2 (build shim), Task 8 (FFI shape), Task 11 (constructor) |
| 6 (formatter_terminal_new) | Task 5 (formatterTagByName), Task 8 (SYMBOLS name), Task 16 (Formatter class) |
| 7 (format_buf/format_alloc, not format) | Task 8 (SYMBOLS names), Task 16 (format implementation) |
| 8 (FormatterTerminalOptions, sized, nested) | Task 4 (probe), Task 16 (options writer) |
| 9 (build_info partial) | Task 8 (identity check), Task 21 (README compat claim) |
| 10 (vt_write returns void) | Task 8 (return type), Task 12 (no checkResult) |
| 11 (reset returns void) | Task 8 (return type), Task 13 (no checkResult) |
| 12 (resize signature) | Task 8 (args), Task 13 (resize implementation) |
| 13 (TerminalData naming) | Task 5 (generator lookup), Task 14 (SNAPSHOT_KEYS) |
| 14 (FormatterFormat naming) | Task 5 (formatterTagByName) |
| 15 (type_json exists) | Task 18 (optional cross-check) |
| 16 (digit-prefix mode names) | Task 5 (generator) |
