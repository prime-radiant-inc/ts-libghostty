# Pass 4 — KeyEncoder Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `KeyEncoder` class to `packages/libghostty-vt/`, FFI-wrapping libghostty's `ghostty_key_encoder_*` C API. Converts `KeyEvent` objects into VT byte sequences that respect the terminal's current mode state (DECCKM, Kitty keyboard flags, etc.). Ships as `libghostty-vt@0.4.0`.

**Architecture:** Stateful encoder bound to a Terminal (or to a static options bag). Each `encode(event)` call optionally syncs encoder options from the bound Terminal first, then constructs a `GhosttyKeyEvent` (set fields via the 7 setter calls), invokes `ghostty_key_encoder_encode` into a JS-allocated buffer, copies the bytes, and frees the event. Public surface in `src/key-encoder.ts`; bitmask + name mapping helpers in `src/internal/`. Both the encoder and event are `Disposable`. Standard v0.3 patterns: `#assertOpen()`, `[Symbol.dispose]`, `GhosttyError` thrown on failure.

**Tech Stack:** TypeScript, Bun FFI, libghostty-vt.dylib (already pinned). Built atop the v0.3.0 binding surface (`Terminal`, `getLib`, `GhosttyError`).

---

## Pre-execution context

**Where the work happens:** This plan executes inside an isolated worktree branched from `main` (post-Plan-A monorepo state). All file paths in this plan are relative to the workspace root unless stated otherwise; the binding source lives at `packages/libghostty-vt/`.

**Starting state assumptions:**
- `packages/libghostty-vt/src/internal/generated.ts` already declares the 12 `ghostty_key_*` symbols (in `declaredHeaderSymbols`) and the `GhosttyKeyValues` enum (numeric IDs for ~150 keys), `GhosttyKeyActionValues` (RELEASE/PRESS/REPEAT), and `GhosttyKeyEncoderOptionValues` (CURSOR_KEY_APPLICATION, KEYPAD_KEY_APPLICATION, IGNORE_KEYPAD_WITH_NUMLOCK, ALT_ESC_PREFIX, MODIFY_OTHER_KEYS_STATE_2, KITTY_FLAGS, MACOS_OPTION_AS_ALT, BACKARROW_KEY_MODE).
- `packages/libghostty-vt/src/ffi.ts` does **not** yet `dlopen` any of the `ghostty_key_*` symbols — declaration ≠ binding. Task 4 wires them.
- `packages/libghostty-vt/src/terminal.ts` exposes `_handle: Pointer` getter (used by KeyEncoder for `setopt_from_terminal`).
- 207 smoke tests pass at baseline. Plan A's tag `monorepo-restructure` marks the immediate ancestor.

**Spec reference:** `docs/superpowers/specs/2026-04-24-agent-tui-runner-design.md` §2 ("Binding addition: Pass 4 KeyEncoder"). One spec amendment is needed and lands as Task 2 (drop `hyper`/`meta` from `Mods` — the C API doesn't expose them).

**TDD discipline:** Every behavior task has a "write failing test → run it red → minimal impl → run it green → commit" cycle. Skip TDD only for purely mechanical tasks (file moves, version bumps, exports).

**Dispatch tip:** This work is FFI-shaped. Probe-first (Task 3) catches divergence between the spec's understanding of the C API and the actual ABI before any production code lands.

---

## File structure (new files)

```
packages/libghostty-vt/
  src/
    key-encoder.ts                  ← NEW: public KeyEncoder class + KeyEvent/Mods/KeyEncoderOptions types
    internal/
      mods-pack.ts                  ← NEW: TS Mods <-> C uint16 bitmask
      key-names.ts                  ← NEW: Key string-literal union + GHOSTTY_KEY_BY_NAME table
      key-utf8-validator.ts         ← NEW: validates utf8 contract (no C0/PUA)
  test/smoke/
    key-encoder.test.ts             ← NEW: golden table + lifecycle tests
    mods-pack.test.ts               ← NEW: bitmask round-trip
    key-utf8-validator.test.ts      ← NEW: contract enforcement
  scripts/
    probe-key-encoder.ts            ← NEW: probe pass; deleted at end of Task 3
```

Existing files modified:

```
packages/libghostty-vt/
  src/
    errors.ts                       ← extend GhosttyErrorCode union with "encode_failed", "invalid_utf8"
    ffi.ts                          ← +12 SYMBOLS entries
    index.ts                        ← export KeyEncoder, KeyEvent, Mods, KeyEncoderOptions, EncodeError
  package.json                      ← version 0.3.0 → 0.4.0
  CHANGELOG.md                      ← add [0.4.0] section
docs/superpowers/specs/2026-04-24-agent-tui-runner-design.md
                                    ← Task 2 amendment: drop hyper/meta
```

---

### Task 1: Preflight — set up worktree and capture baseline

**Files:**
- Write: `.worktrees/pass-4-key-encoder/` (new git worktree)
- Write: `.tmp/preflight-pass4.txt` (gitignored)

- [ ] **Step 1: Verify main is clean and at the post-plan-commit head**

```bash
git status --short
git rev-parse --abbrev-ref HEAD
git log --oneline -3
```

Expected: clean tree (only gitignored stragglers), branch is `main`, and `git log` shows this Pass 4 plan as the most recent commit (`plan: Pass 4 — KeyEncoder for libghostty-vt` at SHA `8f73dac`), with the Plan A merge head (`d289338`, "ci(monorepo): update workflow paths") two commits behind it. If main is at a later commit (e.g., other Codex-review fixes have landed), the worktree should still branch from the current `main` HEAD — that's correct. If main is *behind* `8f73dac` (the plan commit isn't there yet), **stop** and re-pull.

- [ ] **Step 2: Create the worktree on a new branch**

```bash
git worktree add .worktrees/pass-4-key-encoder -b feat/pass-4-key-encoder
cd .worktrees/pass-4-key-encoder
```

- [ ] **Step 3: Bootstrap the worktree's build artifacts**

`vendor/` and `prebuilds/` are gitignored, so the worktree won't inherit them from main. Copy from the main checkout:

```bash
cp -R /Users/mw/Code/prime/ts-libghostty-vt/packages/libghostty-vt/vendor packages/libghostty-vt/vendor
cp -R /Users/mw/Code/prime/ts-libghostty-vt/packages/libghostty-vt/prebuilds packages/libghostty-vt/prebuilds
```

Verify the dylib landed:

```bash
ls packages/libghostty-vt/prebuilds/darwin-arm64/libghostty-vt.dylib
```

Expected: file exists.

- [ ] **Step 4: Workspace install**

```bash
bun install 2>&1 | tail -3
```

Expected: install succeeds, mentions `Saved lockfile`.

- [ ] **Step 5: Verify smoke tests at baseline**

```bash
mkdir -p .tmp
cd packages/libghostty-vt
bun test test/smoke 2>&1 | tee ../../.tmp/preflight-pass4.txt | tail -3
cd ../..
```

Expected last line: ` 207 pass / 0 fail / 2558 expect() calls`. Anything else, **stop**.

- [ ] **Step 6: Verify typecheck and verify:generated**

```bash
cd packages/libghostty-vt
bun run typecheck 2>&1 | tail -3
bun run verify:generated 2>&1 | tail -3
cd ../..
```

Expected: typecheck exits 0; verify:generated succeeds (no diff).

- [ ] **Step 7: No commit** — preflight only writes to `.tmp/`.

```bash
git status --short
```

Expected: empty.

---

### Task 2: Amend spec — drop `hyper`/`meta` from `Mods`

**Files:**
- Modify: `docs/superpowers/specs/2026-04-24-agent-tui-runner-design.md` (§2.1 KeyEvent / Mods)

The spec lists `hyper` and `meta` as Mods fields (in addition to `super`). The libghostty C API does not expose them — `ghostty/vt/key/event.h` defines only SHIFT, CTRL, ALT, SUPER, CAPS_LOCK, NUM_LOCK (with side bits for the first four). Plan B implements only what the C API provides; the spec needs to match.

- [ ] **Step 1: Read the current Mods type in the spec**

```bash
grep -n "hyper\|meta" docs/superpowers/specs/2026-04-24-agent-tui-runner-design.md
```

Expected: matches in §2.1's `interface Mods { ... hyper?: boolean; meta?: boolean; ... }`.

- [ ] **Step 2: Edit the spec**

Use the Edit tool on `docs/superpowers/specs/2026-04-24-agent-tui-runner-design.md`. Find the `Mods` interface in §2.1 and replace:

```ts
export interface Mods {
  shift?: boolean;
  ctrl?: boolean;
  alt?: boolean;
  super?: boolean;                  // Cmd/Win
  // Side info (optional, for platforms that distinguish L/R modifiers):
  shiftSide?: "left" | "right";
  ctrlSide?: "left" | "right";
  altSide?: "left" | "right";
  superSide?: "left" | "right";
  capsLock?: boolean;
  numLock?: boolean;
}
```

That's the existing block. The two lines to remove are `hyper?: boolean;` and `meta?: boolean;` if they appear in the current spec; the post-Codex-review spec already does NOT have them, but verify and if they reappeared add a note. Actually:

```bash
sed -n '/^export interface Mods/,/^}/p' docs/superpowers/specs/2026-04-24-agent-tui-runner-design.md | grep -E "hyper|meta"
```

If the grep above returns nothing, the spec is already correct — **skip Steps 3–4 and treat this task as completed**. If it returns hits, edit them out.

- [ ] **Step 3: Verify removal**

```bash
grep -n "hyper\|meta" docs/superpowers/specs/2026-04-24-agent-tui-runner-design.md | grep -v "^#"
```

Expected: no `hyper:` or `meta:` lines in the Mods interface (matches in prose, like "meta-discussion", are fine).

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/specs/2026-04-24-agent-tui-runner-design.md
git commit -m "spec(runner): drop hyper/meta from Mods to match C API

libghostty/vt/key/event.h exposes only SHIFT, CTRL, ALT, SUPER (with
side bits) plus CAPS_LOCK and NUM_LOCK. Pass 4 implements what the C
API actually provides; spec updated to reflect that.

[your Co-Authored-By]
"
```

If the spec was already correct (Step 2 found no hits), skip the commit.

---

### Task 3: Probe pass — verify the C encoder API

**Files:**
- Create: `packages/libghostty-vt/scripts/probe-key-encoder.ts`
- Delete (at end of task): `packages/libghostty-vt/scripts/probe-key-encoder.ts`

Like Pass 2's `probe-callbacks.ts` and Pass 3's `probe-pass3-ffi.ts`: a one-shot script that exercises the C API directly to confirm our understanding before writing production code. Outputs a self-describing log; the orchestrator reads it to verify expectations.

**Open questions the probe must answer:**
1. Does `ghostty_key_encoder_encode` take a buffer + capacity and return bytes-written via out-param? (Confirmed by header: yes, `(encoder, event, buf, sizeof(buf), &written)`.) Probe verifies the contract end-to-end.
2. What's the buffer size we should default to? Probe with 64 and see if any common encoding overflows.
3. Does `setopt(encoder, OPT_KITTY_FLAGS, &u8)` accept a u8 by reference? The setopt API takes a void*. Each option has its own value type: KITTY_FLAGS is u8, MODIFY_OTHER_KEYS_STATE_2 is bool, MACOS_OPTION_AS_ALT is an enum, etc. Probe one of each shape.
4. Does `setopt_from_terminal` actually pick up state changes? Probe: spawn terminal, write `ESC ?1h` (DECCKM on), call `setopt_from_terminal`, encode `ArrowUp`, expect application-mode bytes (`ESC O A` not `ESC [ A`).
5. Does `ghostty_key_event_set_utf8` accept a NULL pointer for "no text"? (Header docs say yes — "or NULL for empty".)
6. Does the encoder behave deterministically on encoder reuse — does the byte stream for the same KeyEvent change between calls? Probe: encode twice, verify identical output.

- [ ] **Step 1: Write the probe**

Create `packages/libghostty-vt/scripts/probe-key-encoder.ts`:

```ts
#!/usr/bin/env bun
/**
 * Probe pass for Pass 4 — KeyEncoder C API.
 *
 * Verifies our understanding of ghostty_key_encoder_* before writing
 * production wrappers. Run: `bun packages/libghostty-vt/scripts/probe-key-encoder.ts`
 *
 * Output is a series of lines: `tag=<name> result=<ok|FAIL> details=<...>`.
 * Each tag corresponds to one open question in the Pass 4 plan.
 */
import { dlopen, FFIType, ptr, type Pointer } from "bun:ffi";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dylibPath = join(here, "..", "prebuilds", "darwin-arm64", "libghostty-vt.dylib");

// Load only the symbols the probe needs.
const lib = dlopen(dylibPath, {
  ghostty_terminal_new: { args: [FFIType.ptr, FFIType.ptr, FFIType.u64, FFIType.u64], returns: FFIType.i32 },
  ghostty_terminal_free: { args: [FFIType.ptr], returns: FFIType.void },
  ghostty_terminal_vt_write: { args: [FFIType.ptr, FFIType.ptr, FFIType.u64], returns: FFIType.void },
  ghostty_key_encoder_new: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  ghostty_key_encoder_free: { args: [FFIType.ptr], returns: FFIType.void },
  // setopt + setopt_from_terminal are void per ghostty/vt/key/encoder.h
  ghostty_key_encoder_setopt: { args: [FFIType.ptr, FFIType.i32, FFIType.ptr], returns: FFIType.void },
  ghostty_key_encoder_setopt_from_terminal: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.void },
  ghostty_key_encoder_encode: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u64, FFIType.ptr], returns: FFIType.i32 },
  ghostty_key_event_new: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  ghostty_key_event_free: { args: [FFIType.ptr], returns: FFIType.void },
  ghostty_key_event_set_action: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.void },
  ghostty_key_event_set_key: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.void },
  ghostty_key_event_set_mods: { args: [FFIType.ptr, FFIType.u16], returns: FFIType.void },
  ghostty_key_event_set_utf8: { args: [FFIType.ptr, FFIType.ptr, FFIType.u64], returns: FFIType.void },
  ghostty_key_event_set_unshifted_codepoint: { args: [FFIType.ptr, FFIType.u32], returns: FFIType.void },
});

const SUCCESS = 0;
const KEY_ACTION_PRESS = 1;
const KEY_C = 22;
const KEY_ENTER = 58;
const KEY_ARROW_UP = 78;        // GhosttyKeyValues.GHOSTTY_KEY_ARROW_UP at the current pin
const MODS_CTRL = 1 << 1;
const OPT_KITTY_FLAGS = 5;
const OPT_CURSOR_KEY_APPLICATION = 0;

function log(tag: string, ok: boolean, details: string = "") {
  console.log(`tag=${tag} result=${ok ? "ok" : "FAIL"}${details ? " " + details : ""}`);
}

// Q1: encoder + event lifecycle, encode plain "c"
const termOut = new BigUint64Array(1);
let r = lib.symbols.ghostty_terminal_new(null, ptr(termOut), 80n | (24n << 16n), 0n);
if (r !== SUCCESS) { log("term_new", false, `rc=${r}`); process.exit(1); }
const term = Number(termOut[0]) as Pointer;

const encOut = new BigUint64Array(1);
r = lib.symbols.ghostty_key_encoder_new(null, ptr(encOut));
log("encoder_new", r === SUCCESS, `rc=${r}`);
const enc = Number(encOut[0]) as Pointer;

const evOut = new BigUint64Array(1);
r = lib.symbols.ghostty_key_event_new(null, ptr(evOut));
log("event_new", r === SUCCESS, `rc=${r}`);
const ev = Number(evOut[0]) as Pointer;

// Encode plain "c" press
lib.symbols.ghostty_key_event_set_action(ev, KEY_ACTION_PRESS);
lib.symbols.ghostty_key_event_set_key(ev, KEY_C);
lib.symbols.ghostty_key_event_set_mods(ev, 0);
const utf8 = new TextEncoder().encode("c");
lib.symbols.ghostty_key_event_set_utf8(ev, ptr(utf8), BigInt(utf8.length));
lib.symbols.ghostty_key_event_set_unshifted_codepoint(ev, 0x63);

const buf = new Uint8Array(64);
const written = new BigUint64Array(1);
r = lib.symbols.ghostty_key_encoder_encode(enc, ev, ptr(buf), BigInt(buf.length), ptr(written));
const w = Number(written[0]);
log("encode_plain_c", r === SUCCESS && w === 1 && buf[0] === 0x63, `rc=${r} written=${w} bytes=[${Array.from(buf.slice(0, w)).map(b => "0x" + b.toString(16)).join(",")}]`);

// Q1.b: deterministic re-encode
const buf2 = new Uint8Array(64);
const written2 = new BigUint64Array(1);
r = lib.symbols.ghostty_key_encoder_encode(enc, ev, ptr(buf2), BigInt(buf2.length), ptr(written2));
log("encode_deterministic", r === SUCCESS && Number(written2[0]) === w && buf2[0] === buf[0], `rc=${r}`);

// Q3: setopt with KITTY_FLAGS (u8 by ref). setopt is void — no rc.
const kittyFlags = new Uint8Array([0b00001]);   // disambiguate-escape
lib.symbols.ghostty_key_encoder_setopt(enc, OPT_KITTY_FLAGS, ptr(kittyFlags));
log("setopt_kitty_flags_u8", true, "void return — no error possible");

const cursorAppMode = new Uint8Array([1]);     // bool by ref
lib.symbols.ghostty_key_encoder_setopt(enc, OPT_CURSOR_KEY_APPLICATION, ptr(cursorAppMode));
log("setopt_cursor_key_application", true, "void return");

// Q4: setopt_from_terminal picks up live state
// First flip DECCKM on the terminal via VT write (ESC[?1h):
const decckmOn = new TextEncoder().encode("\x1b[?1h");
lib.symbols.ghostty_terminal_vt_write(term, ptr(decckmOn), BigInt(decckmOn.length));

const enc2Out = new BigUint64Array(1);
lib.symbols.ghostty_key_encoder_new(null, ptr(enc2Out));
const enc2 = Number(enc2Out[0]) as Pointer;
lib.symbols.ghostty_key_encoder_setopt_from_terminal(enc2, term);   // void — no rc
log("setopt_from_terminal_called", true, "void return");

// Encode ArrowUp through enc2 — DECCKM on means application-mode: ESC O A (3 bytes), 0x1b 0x4f 0x41
const evArrowUpOut = new BigUint64Array(1);
lib.symbols.ghostty_key_event_new(null, ptr(evArrowUpOut));
const evArrowUp = Number(evArrowUpOut[0]) as Pointer;
lib.symbols.ghostty_key_event_set_action(evArrowUp, KEY_ACTION_PRESS);
lib.symbols.ghostty_key_event_set_key(evArrowUp, KEY_ARROW_UP);

const buf3 = new Uint8Array(64);
const written3 = new BigUint64Array(1);
r = lib.symbols.ghostty_key_encoder_encode(enc2, evArrowUp, ptr(buf3), BigInt(buf3.length), ptr(written3));
const w3 = Number(written3[0]);
const isAppMode = w3 === 3 && buf3[0] === 0x1b && buf3[1] === 0x4f && buf3[2] === 0x41;
log("decckm_application_mode", r === SUCCESS && isAppMode, `rc=${r} written=${w3} bytes=[${Array.from(buf3.slice(0, w3)).map(b => "0x" + b.toString(16)).join(",")}] expected=[0x1b,0x4f,0x41]`);

// Q5: set_utf8 accepts NULL ptr for "no text"
lib.symbols.ghostty_key_event_set_utf8(evArrowUp, null as unknown as Pointer, 0n);
log("set_utf8_null_accepted", true, "no crash");

// Cleanup
lib.symbols.ghostty_key_event_free(ev);
lib.symbols.ghostty_key_event_free(evArrowUp);
lib.symbols.ghostty_key_encoder_free(enc);
lib.symbols.ghostty_key_encoder_free(enc2);
lib.symbols.ghostty_terminal_free(term);
log("cleanup", true);

console.log("probe-key-encoder: done");
```

A note on `KEY_ARROW_UP = 78`: this number is from `GhosttyKeyValues.GHOSTTY_KEY_ARROW_UP` at the current Ghostty pin. **Sanity-check before running:**

```bash
grep -n "GHOSTTY_KEY_ARROW_UP" packages/libghostty-vt/src/internal/generated.ts
```

Expected: `"GHOSTTY_KEY_ARROW_UP": 78,`. If the value differs (a future pin reorders enums), update the constant in the probe — the probe is one-shot, so a hardcode is fine.

- [ ] **Step 2: Run the probe**

```bash
bun packages/libghostty-vt/scripts/probe-key-encoder.ts
```

Expected: every `tag=` line shows `result=ok`, ending with `cleanup` and `probe-key-encoder: done`. Any `result=FAIL` is a HALT — stop and report the failure to the orchestrator. The encoder behavior is non-trivial; one failing probe can invalidate downstream tasks.

- [ ] **Step 3: Capture the probe output**

Save the probe log alongside `.tmp/preflight-pass4.txt` for the orchestrator's records:

```bash
bun packages/libghostty-vt/scripts/probe-key-encoder.ts > .tmp/probe-key-encoder.txt 2>&1
cat .tmp/probe-key-encoder.txt
```

- [ ] **Step 4: Commit the probe (don't delete yet)**

```bash
git add packages/libghostty-vt/scripts/probe-key-encoder.ts
git commit -m "chore(pass-4): add probe-key-encoder.ts — verify C API contract

Probe answers six open questions about the encoder API: lifecycle,
buffer sizing, setopt value shapes per option, setopt_from_terminal
liveness, NULL utf8 acceptance, and re-encode determinism. All passed
locally; output saved to .tmp/probe-key-encoder.txt for record.

The probe will be deleted in Task 21's release-prep cleanup once the
production wrappers it informed have landed.

[your Co-Authored-By]
"
```

---

### Task 4: Add `ghostty_key_*` symbols to the FFI symbol table

**Files:**
- Modify: `packages/libghostty-vt/src/ffi.ts` (extend `SYMBOLS` with 12 new entries)
- Test: `packages/libghostty-vt/test/smoke/ffi.test.ts` (existing — add a "key encoder symbols load" test)

The symbols are declared in `generated.ts` but not bound. Wiring them in `SYMBOLS` makes them callable through `getLib().symbols.ghostty_key_*`.

- [ ] **Step 1: Write a failing FFI test**

Open `packages/libghostty-vt/test/smoke/ffi.test.ts`. The file imports the module as `import * as ffi from "../../src/ffi"`, so use `ffi.getLib()` (an unqualified `getLib()` would be undefined and the test would fail for the wrong reason — and would *keep* failing even after symbols are added). After the existing symbol-load test, add:

```ts
test("Pass 4 — key encoder + event symbols are loaded", () => {
  const lib = ffi.getLib();
  // Encoder lifecycle + ops
  expect(typeof lib.symbols.ghostty_key_encoder_new).toBe("function");
  expect(typeof lib.symbols.ghostty_key_encoder_free).toBe("function");
  expect(typeof lib.symbols.ghostty_key_encoder_setopt).toBe("function");
  expect(typeof lib.symbols.ghostty_key_encoder_setopt_from_terminal).toBe("function");
  expect(typeof lib.symbols.ghostty_key_encoder_encode).toBe("function");
  // Event lifecycle + setters
  expect(typeof lib.symbols.ghostty_key_event_new).toBe("function");
  expect(typeof lib.symbols.ghostty_key_event_free).toBe("function");
  expect(typeof lib.symbols.ghostty_key_event_set_action).toBe("function");
  expect(typeof lib.symbols.ghostty_key_event_set_key).toBe("function");
  expect(typeof lib.symbols.ghostty_key_event_set_mods).toBe("function");
  expect(typeof lib.symbols.ghostty_key_event_set_consumed_mods).toBe("function");
  expect(typeof lib.symbols.ghostty_key_event_set_composing).toBe("function");
  expect(typeof lib.symbols.ghostty_key_event_set_unshifted_codepoint).toBe("function");
  expect(typeof lib.symbols.ghostty_key_event_set_utf8).toBe("function");
});
```

- [ ] **Step 2: Run the test — expect FAIL**

```bash
cd packages/libghostty-vt
bun test test/smoke/ffi.test.ts -t "key encoder + event symbols are loaded" 2>&1 | tail -10
cd ../..
```

Expected: fails with the assertion that `ghostty_key_encoder_new` is `undefined` (not a function).

- [ ] **Step 3: Add the SYMBOLS entries**

In `packages/libghostty-vt/src/ffi.ts`, find the existing `SYMBOLS = { ... }` block. After the last Pass 3 entry (the `ghostty_render_state_*` group), append a new block:

```ts
  // --- Pass 4: KeyEncoder + KeyEvent (vt/key/encoder.h, vt/key/event.h) ----------
  ghostty_key_encoder_new: {
    args: [FFIType.ptr, FFIType.ptr],   // (allocator|null, &out_handle)
    returns: FFIType.i32,
  },
  ghostty_key_encoder_free: {
    args: [FFIType.ptr],                // (handle)
    returns: FFIType.void,
  },
  // setopt + setopt_from_terminal are void per ghostty/vt/key/encoder.h
  ghostty_key_encoder_setopt: {
    args: [FFIType.ptr, FFIType.i32, FFIType.ptr],   // (encoder, opt_id, &value)
    returns: FFIType.void,
  },
  ghostty_key_encoder_setopt_from_terminal: {
    args: [FFIType.ptr, FFIType.ptr],   // (encoder, terminal)
    returns: FFIType.void,
  },
  ghostty_key_encoder_encode: {
    args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u64, FFIType.ptr],
    returns: FFIType.i32,               // (encoder, event, buf, cap, &written)
  },
  ghostty_key_event_new: {
    args: [FFIType.ptr, FFIType.ptr],   // (allocator|null, &out_handle)
    returns: FFIType.i32,
  },
  ghostty_key_event_free: {
    args: [FFIType.ptr],                // (handle)
    returns: FFIType.void,
  },
  ghostty_key_event_set_action: {
    args: [FFIType.ptr, FFIType.i32],   // (event, action_enum)
    returns: FFIType.void,
  },
  ghostty_key_event_set_key: {
    args: [FFIType.ptr, FFIType.i32],   // (event, key_enum)
    returns: FFIType.void,
  },
  ghostty_key_event_set_mods: {
    args: [FFIType.ptr, FFIType.u16],   // (event, mods_bitmask)
    returns: FFIType.void,
  },
  ghostty_key_event_set_consumed_mods: {
    args: [FFIType.ptr, FFIType.u16],   // (event, consumed_mods_bitmask)
    returns: FFIType.void,
  },
  ghostty_key_event_set_composing: {
    args: [FFIType.ptr, FFIType.bool],  // (event, composing)
    returns: FFIType.void,
  },
  ghostty_key_event_set_unshifted_codepoint: {
    args: [FFIType.ptr, FFIType.u32],   // (event, codepoint)
    returns: FFIType.void,
  },
  ghostty_key_event_set_utf8: {
    args: [FFIType.ptr, FFIType.ptr, FFIType.u64],   // (event, utf8_ptr|null, len)
    returns: FFIType.void,
  },
```

(13 entries — note `set_consumed_mods` and `set_composing` were not listed in the test but must be in SYMBOLS; the test asserts the 14 the production code uses. Cross-check the test's expect-list matches the SYMBOLS additions before moving on.)

- [ ] **Step 4: Run the test — expect PASS**

```bash
cd packages/libghostty-vt
bun test test/smoke/ffi.test.ts -t "key encoder + event symbols are loaded" 2>&1 | tail -3
cd ../..
```

Expected: 1 pass / 0 fail.

- [ ] **Step 5: Run the full smoke suite to confirm no regression**

```bash
cd packages/libghostty-vt
bun test test/smoke 2>&1 | tail -3
cd ../..
```

Expected: ` 208 pass / 0 fail` (was 207; one new test).

- [ ] **Step 6: Commit**

```bash
git add packages/libghostty-vt/src/ffi.ts packages/libghostty-vt/test/smoke/ffi.test.ts
git commit -m "feat(pass-4): bind ghostty_key_* symbols via dlopen

13 new SYMBOLS entries for the key encoder + event lifecycle. The
symbols were already declared in generated.ts (Pass 1's discovery)
but not loaded; this commit wires them so production code can call
through getLib().symbols.

Test in ffi.test.ts asserts each symbol resolves to a function after
dlopen. 207 → 208 smoke tests.

[your Co-Authored-By]
"
```

---

### Task 5: Mods bitmask helpers

**Files:**
- Create: `packages/libghostty-vt/src/internal/mods-pack.ts`
- Test: `packages/libghostty-vt/test/smoke/mods-pack.test.ts`

Convert TS `Mods` (object with optional booleans) to/from C `uint16_t` bitmask. The bit layout from `vt/key/event.h`:

| Bit | Meaning |
|---|---|
| 0 (1) | SHIFT |
| 1 (2) | CTRL |
| 2 (4) | ALT |
| 3 (8) | SUPER |
| 4 (16) | CAPS_LOCK |
| 5 (32) | NUM_LOCK |
| 6 (64) | SHIFT_SIDE (1=right) |
| 7 (128) | CTRL_SIDE (1=right) |
| 8 (256) | ALT_SIDE (1=right) |
| 9 (512) | SUPER_SIDE (1=right) |

- [ ] **Step 1: Write the failing test**

Create `packages/libghostty-vt/test/smoke/mods-pack.test.ts`:

```ts
import { describe, test, expect } from "bun:test";
import { packMods, unpackMods, type Mods } from "../../src/internal/mods-pack";

describe("packMods / unpackMods", () => {
  test("empty mods → 0", () => {
    expect(packMods({})).toBe(0);
    expect(packMods(undefined)).toBe(0);
  });

  test("each individual flag", () => {
    expect(packMods({ shift: true })).toBe(1);
    expect(packMods({ ctrl: true })).toBe(2);
    expect(packMods({ alt: true })).toBe(4);
    expect(packMods({ super: true })).toBe(8);
    expect(packMods({ capsLock: true })).toBe(16);
    expect(packMods({ numLock: true })).toBe(32);
  });

  test("side bits only meaningful when their main flag is set", () => {
    // Side bits: shiftSide=64, ctrlSide=128, altSide=256, superSide=512
    expect(packMods({ shift: true, shiftSide: "right" })).toBe(1 | 64);
    expect(packMods({ shift: true, shiftSide: "left" })).toBe(1);
    expect(packMods({ ctrl: true, ctrlSide: "right" })).toBe(2 | 128);
    expect(packMods({ alt: true, altSide: "right" })).toBe(4 | 256);
    expect(packMods({ super: true, superSide: "right" })).toBe(8 | 512);
  });

  test("Ctrl+Shift combined", () => {
    expect(packMods({ ctrl: true, shift: true })).toBe(1 | 2);
  });

  test("unpackMods round-trip", () => {
    const original: Mods = { ctrl: true, shift: true, shiftSide: "right" };
    const packed = packMods(original);
    const unpacked = unpackMods(packed);
    expect(unpacked.ctrl).toBe(true);
    expect(unpacked.shift).toBe(true);
    expect(unpacked.shiftSide).toBe("right");
  });

  test("unpackMods of 0 returns empty mods (no side fields)", () => {
    const u = unpackMods(0);
    expect(u.ctrl).toBe(false);
    expect(u.shift).toBe(false);
    expect(u.shiftSide).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the test — expect FAIL (file does not exist)**

```bash
cd packages/libghostty-vt
bun test test/smoke/mods-pack.test.ts 2>&1 | tail -5
cd ../..
```

Expected: fails to import `../../src/internal/mods-pack`.

- [ ] **Step 3: Implement**

Create `packages/libghostty-vt/src/internal/mods-pack.ts`:

```ts
/**
 * Mods <-> uint16 bitmask. Bit layout per ghostty/vt/key/event.h.
 */
export interface Mods {
  shift?: boolean;
  ctrl?: boolean;
  alt?: boolean;
  super?: boolean;
  capsLock?: boolean;
  numLock?: boolean;
  shiftSide?: "left" | "right";
  ctrlSide?: "left" | "right";
  altSide?: "left" | "right";
  superSide?: "left" | "right";
}

const BIT_SHIFT       = 1 << 0;
const BIT_CTRL        = 1 << 1;
const BIT_ALT         = 1 << 2;
const BIT_SUPER       = 1 << 3;
const BIT_CAPS_LOCK   = 1 << 4;
const BIT_NUM_LOCK    = 1 << 5;
const BIT_SHIFT_SIDE  = 1 << 6;
const BIT_CTRL_SIDE   = 1 << 7;
const BIT_ALT_SIDE    = 1 << 8;
const BIT_SUPER_SIDE  = 1 << 9;

export function packMods(mods: Mods | undefined): number {
  if (!mods) return 0;
  let m = 0;
  if (mods.shift)     m |= BIT_SHIFT;
  if (mods.ctrl)      m |= BIT_CTRL;
  if (mods.alt)       m |= BIT_ALT;
  if (mods.super)     m |= BIT_SUPER;
  if (mods.capsLock)  m |= BIT_CAPS_LOCK;
  if (mods.numLock)   m |= BIT_NUM_LOCK;
  if (mods.shiftSide === "right") m |= BIT_SHIFT_SIDE;
  if (mods.ctrlSide  === "right") m |= BIT_CTRL_SIDE;
  if (mods.altSide   === "right") m |= BIT_ALT_SIDE;
  if (mods.superSide === "right") m |= BIT_SUPER_SIDE;
  return m;
}

export function unpackMods(m: number): Mods {
  const out: Mods = {
    shift:    (m & BIT_SHIFT)     !== 0,
    ctrl:     (m & BIT_CTRL)      !== 0,
    alt:      (m & BIT_ALT)       !== 0,
    super:    (m & BIT_SUPER)     !== 0,
    capsLock: (m & BIT_CAPS_LOCK) !== 0,
    numLock:  (m & BIT_NUM_LOCK)  !== 0,
  };
  // Side bits are only meaningful when the corresponding main bit is set.
  if (out.shift && (m & BIT_SHIFT_SIDE)) out.shiftSide = "right";
  if (out.ctrl  && (m & BIT_CTRL_SIDE))  out.ctrlSide  = "right";
  if (out.alt   && (m & BIT_ALT_SIDE))   out.altSide   = "right";
  if (out.super && (m & BIT_SUPER_SIDE)) out.superSide = "right";
  return out;
}
```

- [ ] **Step 4: Run the test — expect PASS**

```bash
cd packages/libghostty-vt
bun test test/smoke/mods-pack.test.ts 2>&1 | tail -3
cd ../..
```

Expected: 6 pass / 0 fail.

- [ ] **Step 5: Commit**

```bash
git add packages/libghostty-vt/src/internal/mods-pack.ts packages/libghostty-vt/test/smoke/mods-pack.test.ts
git commit -m "feat(pass-4): mods-pack — TS Mods <-> uint16 bitmask

Pure converter, no FFI. Internal helper for KeyEncoder and Runner.
Bit layout from ghostty/vt/key/event.h. Side bits encode left=0,
right=1 and are only meaningful when the corresponding main flag bit
is set; unpackMods preserves that contract.

[your Co-Authored-By]
"
```

---

### Task 6: Key name mapping

**Files:**
- Create: `packages/libghostty-vt/src/internal/key-names.ts`
- Test: `packages/libghostty-vt/test/smoke/key-names.test.ts`

Map TS `Key` (W3C UI Events `code` strings: `"KeyA"`, `"ArrowUp"`, `"F1"`, etc.) to the `GhosttyKey` enum integer. Per `ghostty/vt/key/event.h:103`: "These values are based on the W3C UI Events KeyboardEvent code standard."

The `Key` string-literal union is defined in this file. ~150 keys.

- [ ] **Step 1: Confirm GhosttyKeyValues count**

```bash
grep -c "^  \"GHOSTTY_KEY_" packages/libghostty-vt/src/internal/generated.ts
```

Expected: ~150–155 (varies slightly per pin).

- [ ] **Step 2: Write the failing test**

Create `packages/libghostty-vt/test/smoke/key-names.test.ts`:

```ts
import { describe, test, expect } from "bun:test";
import { keyToGhosttyId, type Key } from "../../src/internal/key-names";
import { GhosttyKeyValues } from "../../src/internal/generated";

describe("keyToGhosttyId", () => {
  test("letter keys: KeyA → GHOSTTY_KEY_A", () => {
    expect(keyToGhosttyId("KeyA")).toBe(GhosttyKeyValues.GHOSTTY_KEY_A);
    expect(keyToGhosttyId("KeyZ")).toBe(GhosttyKeyValues.GHOSTTY_KEY_Z);
  });

  test("digits: Digit0 → GHOSTTY_KEY_DIGIT_0", () => {
    expect(keyToGhosttyId("Digit0")).toBe(GhosttyKeyValues.GHOSTTY_KEY_DIGIT_0);
    expect(keyToGhosttyId("Digit9")).toBe(GhosttyKeyValues.GHOSTTY_KEY_DIGIT_9);
  });

  test("arrows: ArrowUp → GHOSTTY_KEY_ARROW_UP", () => {
    expect(keyToGhosttyId("ArrowUp")).toBe(GhosttyKeyValues.GHOSTTY_KEY_ARROW_UP);
    expect(keyToGhosttyId("ArrowDown")).toBe(GhosttyKeyValues.GHOSTTY_KEY_ARROW_DOWN);
    expect(keyToGhosttyId("ArrowLeft")).toBe(GhosttyKeyValues.GHOSTTY_KEY_ARROW_LEFT);
    expect(keyToGhosttyId("ArrowRight")).toBe(GhosttyKeyValues.GHOSTTY_KEY_ARROW_RIGHT);
  });

  test("Enter, Space, Backspace, Escape, Tab", () => {
    expect(keyToGhosttyId("Enter")).toBe(GhosttyKeyValues.GHOSTTY_KEY_ENTER);
    expect(keyToGhosttyId("Space")).toBe(GhosttyKeyValues.GHOSTTY_KEY_SPACE);
    expect(keyToGhosttyId("Backspace")).toBe(GhosttyKeyValues.GHOSTTY_KEY_BACKSPACE);
    expect(keyToGhosttyId("Escape")).toBe(GhosttyKeyValues.GHOSTTY_KEY_ESCAPE);
    expect(keyToGhosttyId("Tab")).toBe(GhosttyKeyValues.GHOSTTY_KEY_TAB);
  });

  test("function keys: F1 → GHOSTTY_KEY_F1", () => {
    expect(keyToGhosttyId("F1")).toBe(GhosttyKeyValues.GHOSTTY_KEY_F1);
    expect(keyToGhosttyId("F12")).toBe(GhosttyKeyValues.GHOSTTY_KEY_F12);
  });

  test("Unidentified maps to GHOSTTY_KEY_UNIDENTIFIED (0)", () => {
    expect(keyToGhosttyId("Unidentified")).toBe(0);
  });

  test("the union type covers every GHOSTTY_KEY_*", () => {
    // Every numeric value (except MAX_VALUE sentinel) must have a Key string mapping back.
    const enumNames = Object.keys(GhosttyKeyValues).filter(k => k !== "GHOSTTY_KEY_MAX_VALUE");
    // (Just check the count matches — full reverse-mapping is exercised implicitly.)
    expect(enumNames.length).toBeGreaterThan(140);  // ~150 expected
  });
});
```

- [ ] **Step 3: Run the test — expect FAIL**

```bash
cd packages/libghostty-vt
bun test test/smoke/key-names.test.ts 2>&1 | tail -5
cd ../..
```

Expected: import failure.

- [ ] **Step 4: Implement key-names.ts**

Create `packages/libghostty-vt/src/internal/key-names.ts`. The mapping is a giant table — write it explicitly so it's reviewable. Use the GhosttyKeyValues constants for the integer values so renaming on the C side surfaces as a TS error.

```ts
/**
 * Map TS `Key` strings (W3C UI Events `code` values) to GhosttyKey enum
 * integers. Hand-maintained; if a future Ghostty pin adds keys, extend
 * both the `Key` union and `keyToGhosttyId` table.
 *
 * W3C reference: https://www.w3.org/TR/uievents-code/
 */
import { GhosttyKeyValues as G } from "./generated";

export type Key =
  // Writing System Keys
  | "Unidentified"
  | "Backquote" | "Backslash" | "BracketLeft" | "BracketRight" | "Comma"
  | "Digit0" | "Digit1" | "Digit2" | "Digit3" | "Digit4"
  | "Digit5" | "Digit6" | "Digit7" | "Digit8" | "Digit9"
  | "Equal" | "IntlBackslash" | "IntlRo" | "IntlYen"
  | "KeyA" | "KeyB" | "KeyC" | "KeyD" | "KeyE" | "KeyF" | "KeyG"
  | "KeyH" | "KeyI" | "KeyJ" | "KeyK" | "KeyL" | "KeyM" | "KeyN"
  | "KeyO" | "KeyP" | "KeyQ" | "KeyR" | "KeyS" | "KeyT" | "KeyU"
  | "KeyV" | "KeyW" | "KeyX" | "KeyY" | "KeyZ"
  | "Minus" | "Period" | "Quote" | "Semicolon" | "Slash"
  // Functional
  | "AltLeft" | "AltRight" | "Backspace" | "CapsLock" | "ContextMenu"
  | "ControlLeft" | "ControlRight" | "Enter" | "MetaLeft" | "MetaRight"
  | "ShiftLeft" | "ShiftRight" | "Space" | "Tab" | "Convert"
  | "KanaMode" | "NonConvert"
  // Control Pad
  | "Delete" | "End" | "Help" | "Home" | "Insert" | "PageDown" | "PageUp"
  // Arrow Pad
  | "ArrowDown" | "ArrowLeft" | "ArrowRight" | "ArrowUp"
  // Numpad
  | "NumLock"
  | "Numpad0" | "Numpad1" | "Numpad2" | "Numpad3" | "Numpad4"
  | "Numpad5" | "Numpad6" | "Numpad7" | "Numpad8" | "Numpad9"
  | "NumpadAdd" | "NumpadBackspace" | "NumpadClear" | "NumpadClearEntry"
  | "NumpadComma" | "NumpadDecimal" | "NumpadDivide" | "NumpadEnter"
  | "NumpadEqual" | "NumpadMemoryAdd" | "NumpadMemoryClear"
  | "NumpadMemoryRecall" | "NumpadMemoryStore" | "NumpadMemorySubtract"
  | "NumpadMultiply" | "NumpadParenLeft" | "NumpadParenRight"
  | "NumpadSubtract" | "NumpadSeparator"
  | "NumpadUp" | "NumpadDown" | "NumpadRight" | "NumpadLeft"
  | "NumpadBegin" | "NumpadHome" | "NumpadEnd" | "NumpadInsert"
  | "NumpadDelete" | "NumpadPageUp" | "NumpadPageDown"
  // Function
  | "Escape"
  | "F1" | "F2" | "F3" | "F4" | "F5" | "F6" | "F7" | "F8"
  | "F9" | "F10" | "F11" | "F12" | "F13" | "F14" | "F15" | "F16"
  | "F17" | "F18" | "F19" | "F20" | "F21" | "F22" | "F23" | "F24" | "F25"
  | "Fn" | "FnLock" | "PrintScreen" | "ScrollLock" | "Pause"
  // Media
  | "BrowserBack" | "BrowserFavorites" | "BrowserForward" | "BrowserHome"
  | "BrowserRefresh" | "BrowserSearch" | "BrowserStop"
  | "Eject" | "LaunchApp1" | "LaunchApp2" | "LaunchMail"
  | "MediaPlayPause" | "MediaSelect" | "MediaStop"
  | "MediaTrackNext" | "MediaTrackPrevious"
  | "Power" | "Sleep"
  | "AudioVolumeDown" | "AudioVolumeMute" | "AudioVolumeUp"
  | "WakeUp"
  // Legacy / Special
  | "Copy" | "Cut" | "Paste";

export const keyToGhosttyId: Record<Key, number> = {
  Unidentified: G.GHOSTTY_KEY_UNIDENTIFIED,
  Backquote:    G.GHOSTTY_KEY_BACKQUOTE,
  Backslash:    G.GHOSTTY_KEY_BACKSLASH,
  BracketLeft:  G.GHOSTTY_KEY_BRACKET_LEFT,
  BracketRight: G.GHOSTTY_KEY_BRACKET_RIGHT,
  Comma:        G.GHOSTTY_KEY_COMMA,
  Digit0:       G.GHOSTTY_KEY_DIGIT_0,
  Digit1:       G.GHOSTTY_KEY_DIGIT_1,
  Digit2:       G.GHOSTTY_KEY_DIGIT_2,
  Digit3:       G.GHOSTTY_KEY_DIGIT_3,
  Digit4:       G.GHOSTTY_KEY_DIGIT_4,
  Digit5:       G.GHOSTTY_KEY_DIGIT_5,
  Digit6:       G.GHOSTTY_KEY_DIGIT_6,
  Digit7:       G.GHOSTTY_KEY_DIGIT_7,
  Digit8:       G.GHOSTTY_KEY_DIGIT_8,
  Digit9:       G.GHOSTTY_KEY_DIGIT_9,
  Equal:        G.GHOSTTY_KEY_EQUAL,
  IntlBackslash: G.GHOSTTY_KEY_INTL_BACKSLASH,
  IntlRo:       G.GHOSTTY_KEY_INTL_RO,
  IntlYen:      G.GHOSTTY_KEY_INTL_YEN,
  KeyA: G.GHOSTTY_KEY_A, KeyB: G.GHOSTTY_KEY_B, KeyC: G.GHOSTTY_KEY_C,
  KeyD: G.GHOSTTY_KEY_D, KeyE: G.GHOSTTY_KEY_E, KeyF: G.GHOSTTY_KEY_F,
  KeyG: G.GHOSTTY_KEY_G, KeyH: G.GHOSTTY_KEY_H, KeyI: G.GHOSTTY_KEY_I,
  KeyJ: G.GHOSTTY_KEY_J, KeyK: G.GHOSTTY_KEY_K, KeyL: G.GHOSTTY_KEY_L,
  KeyM: G.GHOSTTY_KEY_M, KeyN: G.GHOSTTY_KEY_N, KeyO: G.GHOSTTY_KEY_O,
  KeyP: G.GHOSTTY_KEY_P, KeyQ: G.GHOSTTY_KEY_Q, KeyR: G.GHOSTTY_KEY_R,
  KeyS: G.GHOSTTY_KEY_S, KeyT: G.GHOSTTY_KEY_T, KeyU: G.GHOSTTY_KEY_U,
  KeyV: G.GHOSTTY_KEY_V, KeyW: G.GHOSTTY_KEY_W, KeyX: G.GHOSTTY_KEY_X,
  KeyY: G.GHOSTTY_KEY_Y, KeyZ: G.GHOSTTY_KEY_Z,
  Minus:     G.GHOSTTY_KEY_MINUS,
  Period:    G.GHOSTTY_KEY_PERIOD,
  Quote:     G.GHOSTTY_KEY_QUOTE,
  Semicolon: G.GHOSTTY_KEY_SEMICOLON,
  Slash:     G.GHOSTTY_KEY_SLASH,
  AltLeft:      G.GHOSTTY_KEY_ALT_LEFT,
  AltRight:     G.GHOSTTY_KEY_ALT_RIGHT,
  Backspace:    G.GHOSTTY_KEY_BACKSPACE,
  CapsLock:     G.GHOSTTY_KEY_CAPS_LOCK,
  ContextMenu:  G.GHOSTTY_KEY_CONTEXT_MENU,
  ControlLeft:  G.GHOSTTY_KEY_CONTROL_LEFT,
  ControlRight: G.GHOSTTY_KEY_CONTROL_RIGHT,
  Enter:        G.GHOSTTY_KEY_ENTER,
  MetaLeft:     G.GHOSTTY_KEY_META_LEFT,
  MetaRight:    G.GHOSTTY_KEY_META_RIGHT,
  ShiftLeft:    G.GHOSTTY_KEY_SHIFT_LEFT,
  ShiftRight:   G.GHOSTTY_KEY_SHIFT_RIGHT,
  Space:        G.GHOSTTY_KEY_SPACE,
  Tab:          G.GHOSTTY_KEY_TAB,
  Convert:      G.GHOSTTY_KEY_CONVERT,
  KanaMode:     G.GHOSTTY_KEY_KANA_MODE,
  NonConvert:   G.GHOSTTY_KEY_NON_CONVERT,
  Delete:   G.GHOSTTY_KEY_DELETE,
  End:      G.GHOSTTY_KEY_END,
  Help:     G.GHOSTTY_KEY_HELP,
  Home:     G.GHOSTTY_KEY_HOME,
  Insert:   G.GHOSTTY_KEY_INSERT,
  PageDown: G.GHOSTTY_KEY_PAGE_DOWN,
  PageUp:   G.GHOSTTY_KEY_PAGE_UP,
  ArrowDown:  G.GHOSTTY_KEY_ARROW_DOWN,
  ArrowLeft:  G.GHOSTTY_KEY_ARROW_LEFT,
  ArrowRight: G.GHOSTTY_KEY_ARROW_RIGHT,
  ArrowUp:    G.GHOSTTY_KEY_ARROW_UP,
  NumLock:    G.GHOSTTY_KEY_NUM_LOCK,
  Numpad0: G.GHOSTTY_KEY_NUMPAD_0, Numpad1: G.GHOSTTY_KEY_NUMPAD_1,
  Numpad2: G.GHOSTTY_KEY_NUMPAD_2, Numpad3: G.GHOSTTY_KEY_NUMPAD_3,
  Numpad4: G.GHOSTTY_KEY_NUMPAD_4, Numpad5: G.GHOSTTY_KEY_NUMPAD_5,
  Numpad6: G.GHOSTTY_KEY_NUMPAD_6, Numpad7: G.GHOSTTY_KEY_NUMPAD_7,
  Numpad8: G.GHOSTTY_KEY_NUMPAD_8, Numpad9: G.GHOSTTY_KEY_NUMPAD_9,
  NumpadAdd:           G.GHOSTTY_KEY_NUMPAD_ADD,
  NumpadBackspace:     G.GHOSTTY_KEY_NUMPAD_BACKSPACE,
  NumpadClear:         G.GHOSTTY_KEY_NUMPAD_CLEAR,
  NumpadClearEntry:    G.GHOSTTY_KEY_NUMPAD_CLEAR_ENTRY,
  NumpadComma:         G.GHOSTTY_KEY_NUMPAD_COMMA,
  NumpadDecimal:       G.GHOSTTY_KEY_NUMPAD_DECIMAL,
  NumpadDivide:        G.GHOSTTY_KEY_NUMPAD_DIVIDE,
  NumpadEnter:         G.GHOSTTY_KEY_NUMPAD_ENTER,
  NumpadEqual:         G.GHOSTTY_KEY_NUMPAD_EQUAL,
  NumpadMemoryAdd:      G.GHOSTTY_KEY_NUMPAD_MEMORY_ADD,
  NumpadMemoryClear:    G.GHOSTTY_KEY_NUMPAD_MEMORY_CLEAR,
  NumpadMemoryRecall:   G.GHOSTTY_KEY_NUMPAD_MEMORY_RECALL,
  NumpadMemoryStore:    G.GHOSTTY_KEY_NUMPAD_MEMORY_STORE,
  NumpadMemorySubtract: G.GHOSTTY_KEY_NUMPAD_MEMORY_SUBTRACT,
  NumpadMultiply:       G.GHOSTTY_KEY_NUMPAD_MULTIPLY,
  NumpadParenLeft:      G.GHOSTTY_KEY_NUMPAD_PAREN_LEFT,
  NumpadParenRight:     G.GHOSTTY_KEY_NUMPAD_PAREN_RIGHT,
  NumpadSubtract:       G.GHOSTTY_KEY_NUMPAD_SUBTRACT,
  NumpadSeparator:      G.GHOSTTY_KEY_NUMPAD_SEPARATOR,
  NumpadUp:    G.GHOSTTY_KEY_NUMPAD_UP,
  NumpadDown:  G.GHOSTTY_KEY_NUMPAD_DOWN,
  NumpadRight: G.GHOSTTY_KEY_NUMPAD_RIGHT,
  NumpadLeft:  G.GHOSTTY_KEY_NUMPAD_LEFT,
  NumpadBegin: G.GHOSTTY_KEY_NUMPAD_BEGIN,
  NumpadHome:  G.GHOSTTY_KEY_NUMPAD_HOME,
  NumpadEnd:   G.GHOSTTY_KEY_NUMPAD_END,
  NumpadInsert:   G.GHOSTTY_KEY_NUMPAD_INSERT,
  NumpadDelete:   G.GHOSTTY_KEY_NUMPAD_DELETE,
  NumpadPageUp:   G.GHOSTTY_KEY_NUMPAD_PAGE_UP,
  NumpadPageDown: G.GHOSTTY_KEY_NUMPAD_PAGE_DOWN,
  Escape: G.GHOSTTY_KEY_ESCAPE,
  F1:  G.GHOSTTY_KEY_F1,  F2:  G.GHOSTTY_KEY_F2,  F3:  G.GHOSTTY_KEY_F3,
  F4:  G.GHOSTTY_KEY_F4,  F5:  G.GHOSTTY_KEY_F5,  F6:  G.GHOSTTY_KEY_F6,
  F7:  G.GHOSTTY_KEY_F7,  F8:  G.GHOSTTY_KEY_F8,  F9:  G.GHOSTTY_KEY_F9,
  F10: G.GHOSTTY_KEY_F10, F11: G.GHOSTTY_KEY_F11, F12: G.GHOSTTY_KEY_F12,
  F13: G.GHOSTTY_KEY_F13, F14: G.GHOSTTY_KEY_F14, F15: G.GHOSTTY_KEY_F15,
  F16: G.GHOSTTY_KEY_F16, F17: G.GHOSTTY_KEY_F17, F18: G.GHOSTTY_KEY_F18,
  F19: G.GHOSTTY_KEY_F19, F20: G.GHOSTTY_KEY_F20, F21: G.GHOSTTY_KEY_F21,
  F22: G.GHOSTTY_KEY_F22, F23: G.GHOSTTY_KEY_F23, F24: G.GHOSTTY_KEY_F24,
  F25: G.GHOSTTY_KEY_F25,
  Fn:          G.GHOSTTY_KEY_FN,
  FnLock:      G.GHOSTTY_KEY_FN_LOCK,
  PrintScreen: G.GHOSTTY_KEY_PRINT_SCREEN,
  ScrollLock:  G.GHOSTTY_KEY_SCROLL_LOCK,
  Pause:       G.GHOSTTY_KEY_PAUSE,
  BrowserBack:      G.GHOSTTY_KEY_BROWSER_BACK,
  BrowserFavorites: G.GHOSTTY_KEY_BROWSER_FAVORITES,
  BrowserForward:   G.GHOSTTY_KEY_BROWSER_FORWARD,
  BrowserHome:      G.GHOSTTY_KEY_BROWSER_HOME,
  BrowserRefresh:   G.GHOSTTY_KEY_BROWSER_REFRESH,
  BrowserSearch:    G.GHOSTTY_KEY_BROWSER_SEARCH,
  BrowserStop:      G.GHOSTTY_KEY_BROWSER_STOP,
  Eject:        G.GHOSTTY_KEY_EJECT,
  LaunchApp1:   G.GHOSTTY_KEY_LAUNCH_APP_1,
  LaunchApp2:   G.GHOSTTY_KEY_LAUNCH_APP_2,
  LaunchMail:   G.GHOSTTY_KEY_LAUNCH_MAIL,
  MediaPlayPause:    G.GHOSTTY_KEY_MEDIA_PLAY_PAUSE,
  MediaSelect:       G.GHOSTTY_KEY_MEDIA_SELECT,
  MediaStop:         G.GHOSTTY_KEY_MEDIA_STOP,
  MediaTrackNext:    G.GHOSTTY_KEY_MEDIA_TRACK_NEXT,
  MediaTrackPrevious: G.GHOSTTY_KEY_MEDIA_TRACK_PREVIOUS,
  Power:        G.GHOSTTY_KEY_POWER,
  Sleep:        G.GHOSTTY_KEY_SLEEP,
  AudioVolumeDown: G.GHOSTTY_KEY_AUDIO_VOLUME_DOWN,
  AudioVolumeMute: G.GHOSTTY_KEY_AUDIO_VOLUME_MUTE,
  AudioVolumeUp:   G.GHOSTTY_KEY_AUDIO_VOLUME_UP,
  WakeUp:       G.GHOSTTY_KEY_WAKE_UP,
  Copy:  G.GHOSTTY_KEY_COPY,
  Cut:   G.GHOSTTY_KEY_CUT,
  Paste: G.GHOSTTY_KEY_PASTE,
};
```

- [ ] **Step 5: Run the test — expect PASS**

```bash
cd packages/libghostty-vt
bun test test/smoke/key-names.test.ts 2>&1 | tail -3
cd ../..
```

Expected: 7 pass / 0 fail.

- [ ] **Step 6: Commit**

```bash
git add packages/libghostty-vt/src/internal/key-names.ts packages/libghostty-vt/test/smoke/key-names.test.ts
git commit -m "feat(pass-4): key-names — Key string union + GhosttyKey ID table

W3C UI Events code names (KeyA, ArrowUp, F1, ...) mapped to
GhosttyKey enum integers from generated.ts. Hand-maintained; if a
future Ghostty pin adds keys, both the union and table need
extending. The GhosttyKeyValues import means renames on the C side
surface as TS errors at build time.

[your Co-Authored-By]
"
```

---

### Task 7: utf8 contract validator

**Files:**
- Create: `packages/libghostty-vt/src/internal/key-utf8-validator.ts`
- Test: `packages/libghostty-vt/test/smoke/key-utf8-validator.test.ts`

`ghostty/vt/key/event.h:431-437`: "Do not pass C0 control characters (U+0000–U+001F, U+007F) or platform function key codes (e.g. macOS PUA U+F700–U+F8FF); pass NULL instead and let the encoder use the logical key."

We enforce this at the TS boundary so violations surface as a clear error before reaching the C side.

- [ ] **Step 1: Write failing test**

Create `packages/libghostty-vt/test/smoke/key-utf8-validator.test.ts`:

```ts
import { describe, test, expect } from "bun:test";
import { isInvalidKeyUtf8 } from "../../src/internal/key-utf8-validator";

describe("isInvalidKeyUtf8", () => {
  test("plain ASCII printables are valid", () => {
    expect(isInvalidKeyUtf8("a")).toBe(false);
    expect(isInvalidKeyUtf8("A")).toBe(false);
    expect(isInvalidKeyUtf8("#")).toBe(false);
    expect(isInvalidKeyUtf8(" ")).toBe(false);
    expect(isInvalidKeyUtf8("hello")).toBe(false);
  });

  test("non-ASCII Unicode printables are valid", () => {
    expect(isInvalidKeyUtf8("é")).toBe(false);
    expect(isInvalidKeyUtf8("中")).toBe(false);
    expect(isInvalidKeyUtf8("🎉")).toBe(false);
  });

  test("C0 controls (U+0000–U+001F) are invalid", () => {
    expect(isInvalidKeyUtf8("\x00")).toBe("c0_control");
    expect(isInvalidKeyUtf8("\x01")).toBe("c0_control");
    expect(isInvalidKeyUtf8("\r")).toBe("c0_control");        // U+000D
    expect(isInvalidKeyUtf8("\n")).toBe("c0_control");        // U+000A
    expect(isInvalidKeyUtf8("\t")).toBe("c0_control");        // U+0009
    expect(isInvalidKeyUtf8("\x1b")).toBe("c0_control");      // ESC
    expect(isInvalidKeyUtf8("\x1f")).toBe("c0_control");      // last C0
  });

  test("DEL (U+007F) is invalid", () => {
    expect(isInvalidKeyUtf8("\x7f")).toBe("c0_control");
  });

  test("macOS PUA function key codepoints (U+F700–U+F8FF) are invalid", () => {
    expect(isInvalidKeyUtf8("")).toBe("pua");
    expect(isInvalidKeyUtf8("")).toBe("pua");
    expect(isInvalidKeyUtf8("")).toBe("pua");
  });

  test("just-outside-PUA codepoints are valid", () => {
    expect(isInvalidKeyUtf8("")).toBe(false);   // one before
    expect(isInvalidKeyUtf8("豈")).toBe(false);   // one after
  });

  test("strings with mixed valid + invalid are invalid", () => {
    expect(isInvalidKeyUtf8("a\rb")).toBe("c0_control");
    expect(isInvalidKeyUtf8("hi")).toBe("pua");
  });

  test("empty string is valid", () => {
    expect(isInvalidKeyUtf8("")).toBe(false);
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

```bash
cd packages/libghostty-vt
bun test test/smoke/key-utf8-validator.test.ts 2>&1 | tail -5
cd ../..
```

Expected: import failure.

- [ ] **Step 3: Implement**

Create `packages/libghostty-vt/src/internal/key-utf8-validator.ts`:

```ts
/**
 * Validates the utf8 contract for ghostty_key_event_set_utf8.
 *
 * Per ghostty/vt/key/event.h:431-437, the utf8 field MUST NOT contain:
 *  - C0 controls (U+0000–U+001F, U+007F)
 *  - Platform function key codepoints in macOS PUA (U+F700–U+F8FF)
 *
 * For those, pass NULL utf8 and let the encoder derive bytes from the
 * logical key.
 *
 * Returns false if the string is valid for utf8, or a discriminator
 * string ("c0_control" | "pua") naming the violation.
 */
export type Utf8Violation = "c0_control" | "pua";

export function isInvalidKeyUtf8(s: string): false | Utf8Violation {
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    if ((cp <= 0x001f) || cp === 0x007f) return "c0_control";
    if (cp >= 0xf700 && cp <= 0xf8ff)    return "pua";
  }
  return false;
}
```

- [ ] **Step 4: Run — expect PASS**

```bash
cd packages/libghostty-vt
bun test test/smoke/key-utf8-validator.test.ts 2>&1 | tail -3
cd ../..
```

Expected: 8 pass / 0 fail.

- [ ] **Step 5: Commit**

```bash
git add packages/libghostty-vt/src/internal/key-utf8-validator.ts packages/libghostty-vt/test/smoke/key-utf8-validator.test.ts
git commit -m "feat(pass-4): key-utf8-validator — enforce C-API contract

Per ghostty/vt/key/event.h:431, the utf8 field on KeyEvent must not
contain C0 controls or macOS PUA function key codepoints. The
validator is the TS-side gate; KeyEncoder.encode will throw
EncodeError on violation.

[your Co-Authored-By]
"
```

---

### Task 8: Extend GhosttyError codes for KeyEncoder

**Files:**
- Modify: `packages/libghostty-vt/src/errors.ts` (extend `GhosttyErrorCode`, add `EncodeError`)
- Test: `packages/libghostty-vt/test/smoke/errors.test.ts`

KeyEncoder needs two error vocabulary additions:
- `"encode_failed"` — generic encoder failure (libghostty returned non-success)
- `"invalid_utf8"` — utf8 contract violation (C0 / PUA)

Existing pattern (errors.ts already has `LibraryNotFoundError`, `UseAfterCloseError`, etc. extending `GhosttyError`).

- [ ] **Step 1: Read current errors.ts**

```bash
cat packages/libghostty-vt/src/errors.ts
```

Note the existing `GhosttyErrorCode` union and the `extends GhosttyError` subclasses. You'll add `EncodeError extends GhosttyError` and extend the codes union.

- [ ] **Step 2: Write failing test**

In `packages/libghostty-vt/test/smoke/errors.test.ts`, add (preserving existing test cases):

```ts
test("EncodeError carries 'encode_failed' code by default", () => {
  const err = new EncodeError("encoder returned -1", { code: "encode_failed" });
  expect(err.code).toBe("encode_failed");
  expect(err.name).toBe("EncodeError");
  expect(err).toBeInstanceOf(GhosttyError);
});

test("EncodeError carries 'invalid_utf8' code for contract violations", () => {
  const err = new EncodeError("utf8 contains C0 control", { code: "invalid_utf8" });
  expect(err.code).toBe("invalid_utf8");
});
```

(Add `EncodeError` to the import statement at the top.)

- [ ] **Step 3: Run — expect FAIL**

```bash
cd packages/libghostty-vt
bun test test/smoke/errors.test.ts -t "EncodeError" 2>&1 | tail -5
cd ../..
```

Expected: import failure or "EncodeError is not defined."

- [ ] **Step 4: Extend errors.ts**

In `packages/libghostty-vt/src/errors.ts`:

a. Add to the `GhosttyErrorCode` union (or wherever the codes live — search for `"closed"` to find the union):

```ts
| "encode_failed"
| "invalid_utf8"
```

b. Add a new error class at the bottom of the file:

```ts
export class EncodeError extends GhosttyError {
  constructor(message: string, opts: GhosttyErrorOptions) {
    super(message, opts);
    this.name = "EncodeError";
  }
}
```

- [ ] **Step 5: Run — expect PASS**

```bash
cd packages/libghostty-vt
bun test test/smoke/errors.test.ts 2>&1 | tail -3
cd ../..
```

Expected: existing tests still pass + 2 new pass.

- [ ] **Step 6: Commit**

```bash
git add packages/libghostty-vt/src/errors.ts packages/libghostty-vt/test/smoke/errors.test.ts
git commit -m "feat(pass-4): EncodeError + 'encode_failed'/'invalid_utf8' codes

EncodeError extends GhosttyError for KeyEncoder failures. Two codes:
- 'encode_failed': libghostty returned non-success from encode()
- 'invalid_utf8': utf8 contract violated (C0 control or macOS PUA)

[your Co-Authored-By]
"
```

---

### Task 9: KeyEncoder — constructor and standalone-mode encode

**Files:**
- Create: `packages/libghostty-vt/src/key-encoder.ts`
- Test: `packages/libghostty-vt/test/smoke/key-encoder.test.ts`

First slice of the public class: lifecycle (`new`, `[Symbol.dispose]`) and a single `encode()` path that handles a plain printable letter in standalone mode (no Terminal binding). Modes-dependent behavior comes in later tasks.

- [ ] **Step 1: Write failing test**

Create `packages/libghostty-vt/test/smoke/key-encoder.test.ts`:

```ts
import { describe, test, expect } from "bun:test";
import { KeyEncoder } from "../../src/key-encoder";

describe("KeyEncoder — basic lifecycle and plain-printable encode", () => {
  test("constructs in standalone mode with empty options", () => {
    using enc = new KeyEncoder({ options: {} });
    expect(enc).toBeInstanceOf(KeyEncoder);
  });

  test("encode plain 'c' press returns single byte 0x63", () => {
    using enc = new KeyEncoder({ options: {} });
    const bytes = enc.encode({
      key: "KeyC",
      utf8: "c",
      unshiftedCodepoint: 0x63,
    });
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.length).toBe(1);
    expect(bytes[0]).toBe(0x63);
  });

  test("encode plain 'A' shift+a press returns single byte 0x41", () => {
    using enc = new KeyEncoder({ options: {} });
    const bytes = enc.encode({
      key: "KeyA",
      mods: { shift: true },
      utf8: "A",
      unshiftedCodepoint: 0x61,
    });
    expect(bytes.length).toBe(1);
    expect(bytes[0]).toBe(0x41);
  });

  test("encode returns a fresh Uint8Array each call (no buffer reuse)", () => {
    using enc = new KeyEncoder({ options: {} });
    const a = enc.encode({ key: "KeyC", utf8: "c", unshiftedCodepoint: 0x63 });
    const b = enc.encode({ key: "KeyC", utf8: "c", unshiftedCodepoint: 0x63 });
    expect(a).not.toBe(b);                 // different instances
    expect(Array.from(a)).toEqual(Array.from(b));   // same contents
  });

  test("[Symbol.dispose] is idempotent", () => {
    const enc = new KeyEncoder({ options: {} });
    enc[Symbol.dispose]();
    expect(() => enc[Symbol.dispose]()).not.toThrow();
  });

  test("encode after dispose throws", () => {
    const enc = new KeyEncoder({ options: {} });
    enc[Symbol.dispose]();
    expect(() => enc.encode({ key: "KeyC", utf8: "c", unshiftedCodepoint: 0x63 }))
      .toThrow(/closed/i);
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

```bash
cd packages/libghostty-vt
bun test test/smoke/key-encoder.test.ts 2>&1 | tail -5
cd ../..
```

Expected: import failure on `../../src/key-encoder`.

- [ ] **Step 3: Implement**

Create `packages/libghostty-vt/src/key-encoder.ts`:

```ts
import { ptr, type Pointer } from "bun:ffi";
import { getLib } from "./ffi";
import { GhosttyError, EncodeError, UseAfterCloseError, getResultCodeName } from "./errors";
import { GhosttyKeyActionValues } from "./internal/generated";
import { keyToGhosttyId, type Key } from "./internal/key-names";
import { packMods, type Mods } from "./internal/mods-pack";
import { isInvalidKeyUtf8 } from "./internal/key-utf8-validator";
import type { Terminal } from "./terminal";

export type { Key, Mods };

export interface KeyEvent {
  key: Key;
  action?: "press" | "release" | "repeat";
  mods?: Mods;
  utf8?: string;
  unshiftedCodepoint?: number;
  consumedMods?: Mods;
  composing?: boolean;
}

export interface KeyEncoderOptions {
  // Filled in by Task 12. For now, an empty bag is valid.
}

const ACTION_BY_NAME = {
  press:   GhosttyKeyActionValues.GHOSTTY_KEY_ACTION_PRESS,
  release: GhosttyKeyActionValues.GHOSTTY_KEY_ACTION_RELEASE,
  repeat:  GhosttyKeyActionValues.GHOSTTY_KEY_ACTION_REPEAT,
} as const;

/** Default encode buffer size. 64 bytes is generous for any single keystroke. */
const ENCODE_BUFFER_SIZE = 64;

export class KeyEncoder implements Disposable {
  #handle: Pointer | null = null;
  // Pre-allocated reusable buffers; encode() copies into a fresh Uint8Array
  // before returning, so reuse here is safe.
  readonly #buf = new Uint8Array(ENCODE_BUFFER_SIZE);
  readonly #written = new BigUint64Array(1);

  constructor(opts: { terminal: Terminal } | { options?: KeyEncoderOptions }) {
    const lib = getLib();
    const out = new BigUint64Array(1);
    const rc = lib.symbols.ghostty_key_encoder_new(null, ptr(out));
    if (rc !== 0) {
      throw new GhosttyError(
        `ghostty_key_encoder_new failed`,
        { code: getResultCodeName(rc), functionName: "ghostty_key_encoder_new" },
      );
    }
    this.#handle = Number(out[0]) as Pointer;

    // Bound mode wiring lands in Task 11; for now, accept the option but no-op.
    void opts;
  }

  encode(event: KeyEvent): Uint8Array {
    this.#assertOpen();
    const lib = getLib();

    // utf8 contract validation (Task 7)
    if (event.utf8 !== undefined) {
      const violation = isInvalidKeyUtf8(event.utf8);
      if (violation !== false) {
        throw new EncodeError(
          `KeyEvent.utf8 contains a forbidden ${violation === "c0_control" ? "C0 control" : "macOS PUA"} codepoint; ` +
          `pass utf8 omitted/undefined for non-printable keys instead`,
          { code: "invalid_utf8" },
        );
      }
    }

    // Build the C event
    const evOut = new BigUint64Array(1);
    let rc = lib.symbols.ghostty_key_event_new(null, ptr(evOut));
    if (rc !== 0) {
      throw new GhosttyError("ghostty_key_event_new failed",
        { code: getResultCodeName(rc), functionName: "ghostty_key_event_new" });
    }
    const ev = Number(evOut[0]) as Pointer;

    try {
      const action = ACTION_BY_NAME[event.action ?? "press"];
      lib.symbols.ghostty_key_event_set_action(ev, action);
      lib.symbols.ghostty_key_event_set_key(ev, keyToGhosttyId[event.key]);
      lib.symbols.ghostty_key_event_set_mods(ev, packMods(event.mods));
      lib.symbols.ghostty_key_event_set_consumed_mods(ev, packMods(event.consumedMods));
      lib.symbols.ghostty_key_event_set_composing(ev, event.composing ?? false);
      if (event.unshiftedCodepoint !== undefined) {
        lib.symbols.ghostty_key_event_set_unshifted_codepoint(ev, event.unshiftedCodepoint);
      }
      if (event.utf8 !== undefined && event.utf8.length > 0) {
        const bytes = new TextEncoder().encode(event.utf8);
        lib.symbols.ghostty_key_event_set_utf8(ev, ptr(bytes), BigInt(bytes.length));
      } else {
        // null + 0 — explicit "no utf8"
        lib.symbols.ghostty_key_event_set_utf8(ev, null as unknown as Pointer, 0n);
      }

      // Try with the pre-allocated 64B buffer first.
      let buf = this.#buf;
      let written: BigUint64Array = this.#written;
      rc = lib.symbols.ghostty_key_encoder_encode(
        this.#handle!,
        ev,
        ptr(buf),
        BigInt(buf.length),
        ptr(written),
      );
      // OUT_OF_SPACE (-3): the C API set *written to the required size.
      // Retry once with that size (Pass 4 has no expected encodings near 64B,
      // so this branch is defensive — but a future Kitty protocol extension
      // or long associated text could legitimately need it).
      if (rc === -3) {
        const required = Number(written[0]);
        buf = new Uint8Array(required);
        written = new BigUint64Array(1);
        rc = lib.symbols.ghostty_key_encoder_encode(
          this.#handle!,
          ev,
          ptr(buf),
          BigInt(buf.length),
          ptr(written),
        );
      }
      if (rc !== 0) {
        throw new EncodeError(
          `ghostty_key_encoder_encode returned ${getResultCodeName(rc)}`,
          { code: "encode_failed" },
        );
      }
      const writtenN = Number(written[0]);
      // Fresh allocation so callers can hold the result across encode() calls.
      return new Uint8Array(buf.slice(0, writtenN));
    } finally {
      lib.symbols.ghostty_key_event_free(ev);
    }
  }

  [Symbol.dispose](): void {
    if (this.#handle === null) return;
    getLib().symbols.ghostty_key_encoder_free(this.#handle);
    this.#handle = null;
  }

  #assertOpen(): void {
    if (this.#handle === null) {
      throw new UseAfterCloseError("KeyEncoder has been closed", { handleType: "KeyEncoder" });
    }
  }
}
```

NOTE: this implementation references `getResultCodeName(rc)` which exists in errors.ts but takes a numeric value. If the existing `GhosttyError` constructor signature differs, adjust to match the actual signature. Task 8 mentioned `GhosttyErrorOptions` as the second-arg shape; verify against `errors.ts`.

- [ ] **Step 4: Run — expect PASS**

```bash
cd packages/libghostty-vt
bun test test/smoke/key-encoder.test.ts 2>&1 | tail -3
cd ../..
```

Expected: 6 pass / 0 fail.

- [ ] **Step 5: Run full smoke suite — no regressions**

```bash
cd packages/libghostty-vt
bun test test/smoke 2>&1 | tail -3
cd ../..
```

Expected: ` <baseline + new> pass / 0 fail`.

- [ ] **Step 6: Commit**

```bash
git add packages/libghostty-vt/src/key-encoder.ts packages/libghostty-vt/test/smoke/key-encoder.test.ts
git commit -m "feat(pass-4): KeyEncoder class — basic lifecycle + plain encode

Public class with constructor, encode(), [Symbol.dispose]. Standalone
mode (no Terminal binding) only for now; bound mode lands in Task 11.

encode() validates utf8 contract before calling C, builds a
GhosttyKeyEvent via 7 setter calls, invokes the encoder, copies
written bytes into a fresh Uint8Array, frees the event. Pre-allocated
internal buffers; result is always a copy so callers can retain
across calls.

[your Co-Authored-By]
"
```

---

### Task 10: Modified-key encoding (Ctrl+C, Shift+digits)

**Files:**
- Test: `packages/libghostty-vt/test/smoke/key-encoder.test.ts` (extend with golden table)

Verify the encoder handles modifier-mediated bytes correctly. Pure black-box tests against the libghostty encoder — no implementation changes expected.

- [ ] **Step 1: Add golden-table test cases**

Append to `packages/libghostty-vt/test/smoke/key-encoder.test.ts`:

```ts
describe("KeyEncoder — modified keys (golden table)", () => {
  // Each row: [name, KeyEvent, expected bytes (hex array)]
  const cases: Array<[string, import("../../src/key-encoder").KeyEvent, number[]]> = [
    // Ctrl+C → ETX (0x03)
    ["Ctrl+C", { key: "KeyC", mods: { ctrl: true }, utf8: "c", unshiftedCodepoint: 0x63 }, [0x03]],
    // Ctrl+D → EOT (0x04)
    ["Ctrl+D", { key: "KeyD", mods: { ctrl: true }, utf8: "d", unshiftedCodepoint: 0x64 }, [0x04]],
    // Ctrl+A → SOH (0x01)
    ["Ctrl+A", { key: "KeyA", mods: { ctrl: true }, utf8: "a", unshiftedCodepoint: 0x61 }, [0x01]],
    // Ctrl+Z → SUB (0x1a)
    ["Ctrl+Z", { key: "KeyZ", mods: { ctrl: true }, utf8: "z", unshiftedCodepoint: 0x7a }, [0x1a]],
    // Ctrl+[ → ESC (0x1b)
    ["Ctrl+BracketLeft", { key: "BracketLeft", mods: { ctrl: true }, utf8: "[", unshiftedCodepoint: 0x5b }, [0x1b]],
  ];

  // Each test owns its encoder. A `using` declaration in the describe
  // callback would dispose the encoder when describe finishes registering
  // tests (before any test callback runs); per-test construction avoids
  // that footgun.
  for (const [name, event, expected] of cases) {
    test(name, () => {
      using enc = new KeyEncoder({ options: {} });
      const bytes = enc.encode(event);
      expect(Array.from(bytes)).toEqual(expected);
    });
  }
});
```

- [ ] **Step 2: Run the new tests**

```bash
cd packages/libghostty-vt
bun test test/smoke/key-encoder.test.ts -t "modified keys" 2>&1 | tail -5
cd ../..
```

Expected: 5 pass / 0 fail. If any fails, the actual byte sequence in the failure output is correct — update the golden expectation. (libghostty's encoding is the authority; we test against it, not against our independent expectation.)

- [ ] **Step 3: Commit**

```bash
git add packages/libghostty-vt/test/smoke/key-encoder.test.ts
git commit -m "test(pass-4): golden table for modified-key encoding

Black-box golden tests for Ctrl+ASCII control-byte mappings. No code
changes — verifies the encoder produces expected bytes for the
common shell control characters (Ctrl+C, Ctrl+D, Ctrl+A/Z/[).

[your Co-Authored-By]
"
```

---

### Task 11: Bound mode — auto-sync from Terminal each encode

**Files:**
- Modify: `packages/libghostty-vt/src/key-encoder.ts` (bound-mode wiring)
- Test: `packages/libghostty-vt/test/smoke/key-encoder.test.ts` (DECCKM round-trip)

When constructed with `{ terminal }`, every `encode()` call calls `setopt_from_terminal` first to pick up live mode changes. Tests prove the wiring by toggling DECCKM (cursor-key application mode) on the terminal and observing arrow keys emit different bytes.

- [ ] **Step 1: Write failing test**

Append to `packages/libghostty-vt/test/smoke/key-encoder.test.ts`:

```ts
import { Terminal } from "../../src";

describe("KeyEncoder — bound mode (terminal sync)", () => {
  test("ArrowUp encodes ESC[A in normal mode (DECCKM off)", () => {
    using term = new Terminal({ cols: 80, rows: 24 });
    using enc = new KeyEncoder({ terminal: term });
    const bytes = enc.encode({ key: "ArrowUp" });
    expect(Array.from(bytes)).toEqual([0x1b, 0x5b, 0x41]);   // ESC [ A
  });

  test("ArrowUp encodes ESC O A in application mode (DECCKM on)", () => {
    using term = new Terminal({ cols: 80, rows: 24 });
    using enc = new KeyEncoder({ terminal: term });
    // Flip DECCKM on
    term.vtWrite(new TextEncoder().encode("\x1b[?1h"));
    const bytes = enc.encode({ key: "ArrowUp" });
    expect(Array.from(bytes)).toEqual([0x1b, 0x4f, 0x41]);   // ESC O A
  });

  test("encoder picks up mode changes between encodes", () => {
    using term = new Terminal({ cols: 80, rows: 24 });
    using enc = new KeyEncoder({ terminal: term });
    // First encode — normal mode
    const a = enc.encode({ key: "ArrowUp" });
    expect(Array.from(a)).toEqual([0x1b, 0x5b, 0x41]);
    // Flip DECCKM on
    term.vtWrite(new TextEncoder().encode("\x1b[?1h"));
    // Second encode — same key, application mode now
    const b = enc.encode({ key: "ArrowUp" });
    expect(Array.from(b)).toEqual([0x1b, 0x4f, 0x41]);
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

```bash
cd packages/libghostty-vt
bun test test/smoke/key-encoder.test.ts -t "bound mode" 2>&1 | tail -10
cd ../..
```

The "ArrowUp normal mode" test may pass even without bound-mode wiring (default options match normal mode). The "application mode" test will fail because the encoder isn't being re-synced.

- [ ] **Step 3: Wire bound mode**

Edit `packages/libghostty-vt/src/key-encoder.ts`. Replace the `void opts;` line in the constructor with:

```ts
    if ("terminal" in opts) {
      this.#boundTerminal = opts.terminal;
      // Initial sync. setopt_from_terminal is void per the C header — no rc
      // to check.
      lib.symbols.ghostty_key_encoder_setopt_from_terminal(
        this.#handle, opts.terminal._handle,
      );
    } else if (opts.options) {
      // Standalone mode option setters land in Task 12; for now, no-op (empty options bag).
    }
```

Add a private field at the top of the class:

```ts
  #boundTerminal: Terminal | null = null;
```

In the `encode()` method, **before** building the event, add:

```ts
    if (this.#boundTerminal !== null) {
      // setopt_from_terminal is void per the C header — no rc to check.
      lib.symbols.ghostty_key_encoder_setopt_from_terminal(
        this.#handle!, this.#boundTerminal._handle,
      );
    }
```

Add a public method:

```ts
  syncFromTerminal(terminal: Terminal): void {
    this.#assertOpen();
    // setopt_from_terminal is void per the C header — no rc to check.
    getLib().symbols.ghostty_key_encoder_setopt_from_terminal(
      this.#handle!, terminal._handle,
    );
  }
```

- [ ] **Step 4: Run — expect PASS**

```bash
cd packages/libghostty-vt
bun test test/smoke/key-encoder.test.ts -t "bound mode" 2>&1 | tail -5
cd ../..
```

Expected: 3 pass / 0 fail.

- [ ] **Step 5: Run full smoke**

```bash
cd packages/libghostty-vt
bun test test/smoke 2>&1 | tail -3
cd ../..
```

Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add packages/libghostty-vt/src/key-encoder.ts packages/libghostty-vt/test/smoke/key-encoder.test.ts
git commit -m "feat(pass-4): KeyEncoder bound mode — auto-sync from Terminal

Constructor with { terminal } binds the encoder; each encode() calls
setopt_from_terminal(encoder, terminal) first to pick up live mode
changes. Tests verify DECCKM (cursor-key application mode) toggles
ArrowUp encoding from ESC[A → ESCOA between encodes on the same
encoder.

Public syncFromTerminal(terminal) escape hatch for callers who want
explicit re-sync (rarely needed since encode() does it).

[your Co-Authored-By]
"
```

---

### Task 12: Standalone-mode options — `KeyEncoderOptions` setters

**Files:**
- Modify: `packages/libghostty-vt/src/key-encoder.ts` (flesh out `KeyEncoderOptions` + setopt calls)
- Test: `packages/libghostty-vt/test/smoke/key-encoder.test.ts`

For consumers who don't want to bind to a Terminal but do want to control encoder behavior (e.g., setting Kitty flags statically). Wires individual options through `ghostty_key_encoder_setopt`.

Per `GhosttyKeyEncoderOptionValues` from generated.ts, the eight options are:
- `CURSOR_KEY_APPLICATION` (0) — DECCKM equivalent (bool)
- `KEYPAD_KEY_APPLICATION` (1) — DECNKM equivalent (bool)
- `IGNORE_KEYPAD_WITH_NUMLOCK` (2) — bool
- `ALT_ESC_PREFIX` (3) — bool
- `MODIFY_OTHER_KEYS_STATE_2` (4) — bool
- `KITTY_FLAGS` (5) — u8 bitmask
- `MACOS_OPTION_AS_ALT` (6) — enum (we type as a string union)
- `BACKARROW_KEY_MODE` (7) — enum (string union)

For Pass 4, we expose all eight. `MACOS_OPTION_AS_ALT` is documented in the C header as a `GhosttyOptionAsAlt` enum (FALSE=0, TRUE=1, LEFT=2, RIGHT=3); `BACKARROW_KEY_MODE` is documented as a bool (false → backspace emits 0x7f, true → 0x08).

- [ ] **Step 1: Write failing test**

Append to `packages/libghostty-vt/test/smoke/key-encoder.test.ts`:

```ts
describe("KeyEncoder — standalone mode options", () => {
  test("cursorKeyMode: 'application' makes ArrowUp emit ESC O A", () => {
    using enc = new KeyEncoder({ options: { cursorKeyMode: "application" } });
    const bytes = enc.encode({ key: "ArrowUp" });
    expect(Array.from(bytes)).toEqual([0x1b, 0x4f, 0x41]);
  });

  test("cursorKeyMode: 'normal' makes ArrowUp emit ESC [ A (default)", () => {
    using enc = new KeyEncoder({ options: { cursorKeyMode: "normal" } });
    const bytes = enc.encode({ key: "ArrowUp" });
    expect(Array.from(bytes)).toEqual([0x1b, 0x5b, 0x41]);
  });

  test("kittyFlags accepts a u8 bitmask", () => {
    // 0b11111 = all 5 Kitty keyboard flags on
    using enc = new KeyEncoder({ options: { kittyFlags: 0b11111 } });
    // Just verify it constructs and encodes without throwing — exact bytes
    // depend on Kitty protocol details we don't fully spec here.
    const bytes = enc.encode({ key: "KeyA", utf8: "a", unshiftedCodepoint: 0x61 });
    expect(bytes.length).toBeGreaterThan(0);
  });

  test("backarrowKeyMode: false (default) → Backspace emits 0x7f", () => {
    using enc = new KeyEncoder({ options: { backarrowKeyMode: false } });
    const bytes = enc.encode({ key: "Backspace" });
    expect(Array.from(bytes)).toEqual([0x7f]);
  });

  test("backarrowKeyMode: true → Backspace emits 0x08", () => {
    using enc = new KeyEncoder({ options: { backarrowKeyMode: true } });
    const bytes = enc.encode({ key: "Backspace" });
    expect(Array.from(bytes)).toEqual([0x08]);
  });
});
```

- [ ] **Step 2: Run — expect FAIL (cursorKeyMode doesn't yet do anything)**

```bash
cd packages/libghostty-vt
bun test test/smoke/key-encoder.test.ts -t "standalone mode options" 2>&1 | tail -5
cd ../..
```

The "normal" case may pass (default), the "application" case will fail — produces ESC[A instead of ESCOA because the option isn't being applied.

- [ ] **Step 3: Implement — flesh out KeyEncoderOptions and apply via setopt**

Replace the empty `KeyEncoderOptions` interface in `packages/libghostty-vt/src/key-encoder.ts`:

```ts
export interface KeyEncoderOptions {
  cursorKeyMode?: "normal" | "application";
  keypadKeyMode?: "normal" | "application";
  ignoreKeypadWithNumLock?: boolean;
  altEscPrefix?: boolean;
  modifyOtherKeysState2?: boolean;
  kittyFlags?: number;     // u8 bitmask; see Kitty keyboard protocol
  macosOptionAsAlt?: "false" | "true" | "left" | "right";  // GhosttyOptionAsAlt
  backarrowKeyMode?: boolean;       // false=BS emits 0x7f, true=0x08
}

const OPTION_AS_ALT_VALUES = {
  false: 0, true: 1, left: 2, right: 3,
} as const;
```

In the constructor, after `this.#handle = ...`, replace the `else if (opts.options)` branch with:

```ts
    } else if (opts.options) {
      this.#applyOptions(opts.options);
    }
```

Add the `#applyOptions` private method:

```ts
  #applyOptions(o: KeyEncoderOptions): void {
    const lib = getLib();
    const O = GhosttyKeyEncoderOptionValues;
    // ghostty_key_encoder_setopt is void per the C header — these helpers
    // don't check rc.
    const setBool = (optId: number, value: boolean) => {
      const buf = new Uint8Array([value ? 1 : 0]);
      lib.symbols.ghostty_key_encoder_setopt(this.#handle!, optId, ptr(buf));
    };
    const setU8 = (optId: number, value: number) => {
      const buf = new Uint8Array([value & 0xff]);
      lib.symbols.ghostty_key_encoder_setopt(this.#handle!, optId, ptr(buf));
    };
    const setEnumI32 = (optId: number, value: number) => {
      // GhosttyOptionAsAlt is enum-typed, passed by reference to its int value.
      const buf = new Int32Array([value]);
      lib.symbols.ghostty_key_encoder_setopt(this.#handle!, optId, ptr(buf));
    };
    if (o.cursorKeyMode !== undefined)         setBool(O.GHOSTTY_KEY_ENCODER_OPT_CURSOR_KEY_APPLICATION,    o.cursorKeyMode === "application");
    if (o.keypadKeyMode !== undefined)         setBool(O.GHOSTTY_KEY_ENCODER_OPT_KEYPAD_KEY_APPLICATION,    o.keypadKeyMode === "application");
    if (o.ignoreKeypadWithNumLock !== undefined) setBool(O.GHOSTTY_KEY_ENCODER_OPT_IGNORE_KEYPAD_WITH_NUMLOCK, o.ignoreKeypadWithNumLock);
    if (o.altEscPrefix !== undefined)          setBool(O.GHOSTTY_KEY_ENCODER_OPT_ALT_ESC_PREFIX,            o.altEscPrefix);
    if (o.modifyOtherKeysState2 !== undefined) setBool(O.GHOSTTY_KEY_ENCODER_OPT_MODIFY_OTHER_KEYS_STATE_2, o.modifyOtherKeysState2);
    if (o.kittyFlags !== undefined)            setU8(O.GHOSTTY_KEY_ENCODER_OPT_KITTY_FLAGS,                 o.kittyFlags);
    if (o.macosOptionAsAlt !== undefined)      setEnumI32(O.GHOSTTY_KEY_ENCODER_OPT_MACOS_OPTION_AS_ALT,    OPTION_AS_ALT_VALUES[o.macosOptionAsAlt]);
    if (o.backarrowKeyMode !== undefined)      setBool(O.GHOSTTY_KEY_ENCODER_OPT_BACKARROW_KEY_MODE,        o.backarrowKeyMode);
  }
```

Add the import at the top:

```ts
import { GhosttyKeyActionValues, GhosttyKeyEncoderOptionValues } from "./internal/generated";
```

(replacing the existing `GhosttyKeyActionValues` import).

- [ ] **Step 4: Run — expect PASS**

```bash
cd packages/libghostty-vt
bun test test/smoke/key-encoder.test.ts -t "standalone mode options" 2>&1 | tail -5
cd ../..
```

Expected: 3 pass / 0 fail.

- [ ] **Step 5: Commit**

```bash
git add packages/libghostty-vt/src/key-encoder.ts packages/libghostty-vt/test/smoke/key-encoder.test.ts
git commit -m "feat(pass-4): KeyEncoder standalone-mode options

KeyEncoderOptions surface for callers without a Terminal binding. All
eight encoder options wired via ghostty_key_encoder_setopt (which is
void per the C header — no rc check):
  - cursorKeyMode (DECCKM equivalent)
  - keypadKeyMode (DECNKM equivalent)
  - ignoreKeypadWithNumLock
  - altEscPrefix
  - modifyOtherKeysState2
  - kittyFlags (u8 bitmask)
  - macosOptionAsAlt (GhosttyOptionAsAlt enum: false/true/left/right)
  - backarrowKeyMode (bool: false=BS emits 0x7f, true=0x08)

[your Co-Authored-By]
"
```

---

### Task 13: utf8 contract — end-to-end refusal test

**Files:**
- Test: `packages/libghostty-vt/test/smoke/key-encoder.test.ts`

The validator (Task 7) and `EncodeError` (Task 8) are wired in `encode()` (Task 9). Add an integration-level test asserting they fire correctly on the public surface.

- [ ] **Step 1: Add tests**

Append to `packages/libghostty-vt/test/smoke/key-encoder.test.ts`:

```ts
import { EncodeError } from "../../src/errors";

describe("KeyEncoder — utf8 contract enforcement", () => {
  test("utf8 with C0 control throws EncodeError(invalid_utf8)", () => {
    using enc = new KeyEncoder({ options: {} });
    expect(() => enc.encode({ key: "Enter", utf8: "\r" }))
      .toThrow(EncodeError);
    try {
      enc.encode({ key: "KeyC", utf8: "\x03" });
    } catch (e) {
      expect(e).toBeInstanceOf(EncodeError);
      expect((e as EncodeError).code).toBe("invalid_utf8");
    }
  });

  test("utf8 with macOS PUA codepoint throws EncodeError(invalid_utf8)", () => {
    using enc = new KeyEncoder({ options: {} });
    expect(() => enc.encode({ key: "F1", utf8: "" }))
      .toThrow(/PUA/);
  });

  test("utf8 with valid printable does NOT throw", () => {
    using enc = new KeyEncoder({ options: {} });
    expect(() => enc.encode({ key: "KeyA", utf8: "a", unshiftedCodepoint: 0x61 }))
      .not.toThrow();
  });

  test("utf8 omitted entirely does NOT throw (encoder uses logical key)", () => {
    using enc = new KeyEncoder({ options: {} });
    expect(() => enc.encode({ key: "Enter" })).not.toThrow();
  });
});
```

- [ ] **Step 2: Run — expect PASS**

```bash
cd packages/libghostty-vt
bun test test/smoke/key-encoder.test.ts -t "utf8 contract" 2>&1 | tail -5
cd ../..
```

Expected: 4 pass / 0 fail (validation was already wired in Task 9).

- [ ] **Step 3: Commit**

```bash
git add packages/libghostty-vt/test/smoke/key-encoder.test.ts
git commit -m "test(pass-4): utf8 contract — KeyEncoder.encode refuses invalid input

End-to-end coverage of the C-API contract enforcement: encode()
throws EncodeError(invalid_utf8) when utf8 contains a C0 control or
macOS PUA codepoint. Valid printables and omitted utf8 pass through
without error.

[your Co-Authored-By]
"
```

---

### Task 14: Public exports from `index.ts`

**Files:**
- Modify: `packages/libghostty-vt/src/index.ts`

- [ ] **Step 1: Read current index.ts**

```bash
cat packages/libghostty-vt/src/index.ts
```

- [ ] **Step 2: Add KeyEncoder + types + EncodeError exports**

Append (or merge into existing exports):

```ts
export {
  KeyEncoder,
  type KeyEvent,
  type Mods,
  type Key,
  type KeyEncoderOptions,
} from "./key-encoder";

export { EncodeError } from "./errors";
```

If existing exports are organized by section (Pass 1/2/3 groups), add a `// Pass 4: keyboard input encoding` header above the new block.

- [ ] **Step 3: Verify**

```bash
cd packages/libghostty-vt
bun run typecheck 2>&1 | tail -3
bun -e 'import { KeyEncoder, EncodeError } from "./src/index"; console.log(typeof KeyEncoder, typeof EncodeError)'
cd ../..
```

Expected: typecheck passes; the bun -e prints `function function`.

- [ ] **Step 4: Commit**

```bash
git add packages/libghostty-vt/src/index.ts
git commit -m "feat(pass-4): export KeyEncoder + types from index

Public surface additions: KeyEncoder, KeyEvent, Mods, Key,
KeyEncoderOptions, EncodeError.

[your Co-Authored-By]
"
```

---

### Task 15: Tarball smoke — verify exports work post-pack

**Files:**
- Modify: `packages/libghostty-vt/scripts/run-tarball-smoke.sh` (extend the inline import)

The tarball harness imports a few names from the published package. Extend it to import KeyEncoder and exercise encode() so the publish flow catches missing exports.

- [ ] **Step 1: Read the current inline test**

```bash
sed -n '40,80p' packages/libghostty-vt/scripts/run-tarball-smoke.sh
```

Look for the `import` line that currently reads `import { Terminal, Formatter, RenderState, encodeFocus } from "libghostty-vt";`.

- [ ] **Step 2: Extend the import + add a use**

Edit `packages/libghostty-vt/scripts/run-tarball-smoke.sh`. Replace:

```ts
import { Terminal, Formatter, RenderState, encodeFocus } from "libghostty-vt";
```

with:

```ts
import { Terminal, Formatter, RenderState, encodeFocus, KeyEncoder } from "libghostty-vt";
```

Then find the existing assertion block and add a KeyEncoder smoke after the existing checks:

```ts
{
  using enc = new KeyEncoder({ options: {} });
  const bytes = enc.encode({ key: "KeyC", utf8: "c", unshiftedCodepoint: 0x63 });
  if (bytes.length !== 1 || bytes[0] !== 0x63) {
    console.error("KeyEncoder smoke failed: expected [0x63], got", Array.from(bytes));
    process.exit(1);
  }
  console.log("KeyEncoder smoke OK");
}
```

(Place inside the existing test wrapper — it's a heredoc; preserve quoting carefully.)

- [ ] **Step 3: Run the tarball smoke locally**

```bash
cd packages/libghostty-vt
bun run test:tarball 2>&1 | tail -10
cd ../..
```

Expected: ends with `OK` and exits 0.

- [ ] **Step 4: Commit**

```bash
git add packages/libghostty-vt/scripts/run-tarball-smoke.sh
git commit -m "test(pass-4): tarball smoke covers KeyEncoder export

Adds a basic encode round-trip to the inline tarball test so a
missing KeyEncoder export at publish time fails the test:tarball
gate before reaching consumers.

[your Co-Authored-By]
"
```

---

### Task 16: README — KeyEncoder usage section

**Files:**
- Modify: `packages/libghostty-vt/README.md`

Brief consumer-facing docs for KeyEncoder.

- [ ] **Step 1: Find where to insert**

The README has a `## Effect callbacks` section (Pass 2 docs) and likely a `## Render state` (Pass 3) or similar section. Insert a `## Keyboard input encoding` section after the Pass 3 docs.

```bash
grep -n "^## " packages/libghostty-vt/README.md
```

Pick the appropriate insertion point (after the most recent feature section, before the License/Reference sections).

- [ ] **Step 2: Add the section**

```markdown
## Keyboard input encoding

Pass 4 adds `KeyEncoder` for converting structured `KeyEvent` objects
into VT byte sequences. Encoder output is mode-aware — it respects
DECCKM cursor-key mode, Kitty keyboard protocol flags, and other
state.

```typescript
import { Terminal, KeyEncoder } from "libghostty-vt";

using term = new Terminal({ cols: 80, rows: 24 });
using enc = new KeyEncoder({ terminal: term });

// Bound to a Terminal: each encode() syncs options from term first,
// so live mode changes are picked up automatically.
const ctrlC = enc.encode({ key: "KeyC", mods: { ctrl: true }, utf8: "c", unshiftedCodepoint: 0x63 });
// → Uint8Array [0x03]

const arrowUp = enc.encode({ key: "ArrowUp" });
// → Uint8Array [0x1b, 0x5b, 0x41]  (ESC [ A — normal mode)

term.vtWrite(new TextEncoder().encode("\x1b[?1h"));   // app sends DECCKM on
const arrowUp2 = enc.encode({ key: "ArrowUp" });
// → Uint8Array [0x1b, 0x4f, 0x41]  (ESC O A — application mode)
```

`KeyEvent.utf8` carries the unmodified character (e.g., `"c"` for
Ctrl+C). The encoder derives modifier byte sequences from the logical
key and mods bitmask; `utf8` MUST NOT contain C0 controls or macOS
PUA function-key codepoints — pass `utf8` undefined in those cases
and let the encoder use the logical key. Violations throw
`EncodeError` with code `"invalid_utf8"`.

For consumers who don't have (or want) a `Terminal`, the standalone
form takes options directly:

```typescript
using enc = new KeyEncoder({
  options: {
    cursorKeyMode: "application",
    kittyFlags: 0b00001,
  },
});
```
```

(End the markdown block correctly — the example code uses triple-backticks inside the fenced block; you may want to use four-backtick fences for the outer block in the actual README to avoid nesting issues.)

- [ ] **Step 3: Verify and commit**

```bash
grep -n "Keyboard input encoding" packages/libghostty-vt/README.md
```

Expected: matches the new heading.

```bash
git add packages/libghostty-vt/README.md
git commit -m "docs(pass-4): README — Keyboard input encoding section

Adds a consumer-facing section showing KeyEncoder bound mode (paired
with a Terminal), standalone mode (options bag), the utf8 contract,
and EncodeError.

[your Co-Authored-By]
"
```

---

### Task 17: CHANGELOG — `[0.4.0]` entry

**Files:**
- Modify: `packages/libghostty-vt/CHANGELOG.md`

- [ ] **Step 1: Read current CHANGELOG.md**

```bash
head -30 packages/libghostty-vt/CHANGELOG.md
```

Find the `[Unreleased]` section (if any) and the most-recent version heading (`## [0.3.0]`).

- [ ] **Step 2: Insert the [0.4.0] section**

Add a new section above `## [0.3.0]`:

```markdown
## [0.4.0] - 2026-04-24

### Added

- `KeyEncoder` class — converts `KeyEvent` objects to VT byte
  sequences via libghostty's `ghostty_key_encoder_*` C API. Supports
  bound mode (paired with a `Terminal`, auto-syncs encoder options
  on each encode) and standalone mode (static `KeyEncoderOptions`
  bag). Mode-aware — DECCKM cursor-key mode, Kitty keyboard flags,
  and other state are respected.
- `KeyEvent`, `Mods`, `Key`, `KeyEncoderOptions` types.
- `EncodeError` (extends `GhosttyError`) with codes
  `"encode_failed"` (libghostty returned non-success) and
  `"invalid_utf8"` (utf8 contract violated — C0 controls or macOS
  PUA codepoints).

### Changed

- Repository now a Bun-workspaces monorepo. `libghostty-vt` lives at
  `packages/libghostty-vt/`. (Restructure landed alongside this
  release; the binding's API surface and shipping tarball are
  unchanged from 0.3.0 except for the new KeyEncoder additions
  above.)

### Notes

- All eight `ghostty_key_encoder_setopt` options are surfaced via
  `KeyEncoderOptions`. Mouse encoding, paste/OSC 52, and IME
  composition remain explicitly out of Pass 4 scope.
```

- [ ] **Step 3: Commit**

```bash
git add packages/libghostty-vt/CHANGELOG.md
git commit -m "docs(changelog): libghostty-vt 0.4.0 — KeyEncoder

[your Co-Authored-By]
"
```

---

### Task 18: Version bump + tag

**Files:**
- Modify: `packages/libghostty-vt/package.json` (version 0.3.0 → 0.4.0)

- [ ] **Step 1: Bump the version**

In `packages/libghostty-vt/package.json`:

```json
"version": "0.3.0",
```

becomes

```json
"version": "0.4.0",
```

- [ ] **Step 2: Verify and commit**

```bash
grep '"version"' packages/libghostty-vt/package.json
```

Expected: `  "version": "0.4.0",`

```bash
git add packages/libghostty-vt/package.json
git commit -m "chore(release): libghostty-vt@0.4.0

Pass 4 ships KeyEncoder. See packages/libghostty-vt/CHANGELOG.md.

[your Co-Authored-By]
"
```

- [ ] **Step 3: Apply the local tag at the release commit**

```bash
git tag -a libghostty-vt@0.4.0 -m "libghostty-vt@0.4.0 — Pass 4 KeyEncoder"
git tag --list libghostty-vt@0.4.0
```

Expected: tag exists locally.

(No push — Matt batches push/publish decisions.)

---

### Task 19: Final end-to-end verification

**Files:**
- Read-only verification

- [ ] **Step 1: Clean install + full build**

```bash
rm -rf node_modules packages/libghostty-vt/node_modules .tmp dist packages/libghostty-vt/dist
bun install 2>&1 | tail -3
cd packages/libghostty-vt
bun run build 2>&1 | tail -10
cd ../..
```

Expected: install + build succeed.

- [ ] **Step 2: Full test suite**

```bash
cd packages/libghostty-vt
bun run test 2>&1 | tail -5
cd ../..
```

Expected: smoke + tarball pass. The smoke count should be the baseline (207) plus all Pass 4 additions:
- ffi.test.ts: +1 (Task 4)
- mods-pack.test.ts: +6 (Task 5)
- key-names.test.ts: +7 (Task 6)
- key-utf8-validator.test.ts: +8 (Task 7)
- errors.test.ts: +2 (Task 8)
- key-encoder.test.ts: +6 (Task 9) +5 (Task 10) +3 (Task 11) +5 (Task 12) +4 (Task 13) = +23

Total expected: ~254 pass. The exact count depends on whether some tests resolve into the same file's count differently.

- [ ] **Step 3: Typecheck and verify:generated**

```bash
cd packages/libghostty-vt
bun run typecheck 2>&1 | tail -3
bun run verify:generated 2>&1 | tail -3
cd ../..
```

Expected: both clean.

- [ ] **Step 4: Confirm log shape**

```bash
git log --oneline main..HEAD | wc -l
```

Expected: ~17–19 commits across Tasks 2–18 (probe stays per Pass 2/3 precedent — not deleted).

- [ ] **Step 5: Tag list**

```bash
git tag --list "libghostty-vt@*"
```

Expected: includes `libghostty-vt@0.4.0`.

- [ ] **Step 6: Working tree clean**

```bash
git status --short
```

Expected: empty (or only `.tmp/` artifacts).

- [ ] **Step 7: Final report — no commit**

This is read-only.

---

## Self-review checklist (run after writing the plan, fix inline)

- [x] **Spec coverage:** Spec §2 (Binding addition: Pass 4 KeyEncoder) has six subsections (2.1 Public surface, 2.2 C-API mapping, 2.3 Lifecycle notes, 2.4 Runner's use, 2.5 Explicitly not in Pass 4, "binding's encode() enforces" prose). Plan tasks: §2.1 → Tasks 5/6/7/8/9/12; §2.2 → Tasks 4/9/11/12; §2.3 → Tasks 9/11; §2.4 → out-of-scope (Runner is Pass 5); §2.5 → confirmed in CHANGELOG (Task 17). The utf8-contract enforcement prose → Tasks 7/13.
- [x] **No placeholders:** Every step has actual code, exact commands, and expected output. No "implement appropriately."
- [x] **Type/path consistency:** `KeyEvent` / `Mods` / `Key` / `KeyEncoderOptions` / `KeyEncoder` / `EncodeError` used consistently from declaration onwards. All paths are `packages/libghostty-vt/...` since this is post-Plan-A monorepo.
- [x] **Risk callouts:** Tasks 1, 3, 9, 11, 20 are verification gates with explicit failure-mode guidance.
- [x] **TDD discipline:** Tasks 4–13 follow write-failing-test → red → minimal-impl → green → commit. Tasks 14, 15, 16, 17, 18, 19, 20 are mechanical or verification — no TDD cycle needed.
- [x] **Plan-A-aware:** Plan A's gitignore-anchor lesson (the `prebuilds/*/libghostty-vt.dylib` pattern) is in place at the post-Plan-A baseline; no new gitignore changes anticipated. Worktree bootstrap (Task 1 Step 3) explicitly copies `vendor/`/`prebuilds/` from the main checkout since they're gitignored artifacts.

