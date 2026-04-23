# ts-libghostty-vt Pass 2 Implementation Plan — Effect Callbacks

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Spec:** `docs/superpowers/specs/2026-04-22-ts-libghostty-design.md` (§4.1 surface, §5.4 internals, §8 testing gates)

**Pass:** 2 of ~5. Pass 1 shipped `Terminal` + `Formatter` + lifecycle + ABI safety as `v0.1.0`. Pass 2 adds the three effect callbacks the spec declares v0: `onWritePty`, `onBell`, `onTitleChanged`. Passes 3–5 add render-state / key-encoder / polish — unchanged from the Pass 1 header.

**Status at start of Pass 2:** all Pass 1 tasks complete; any in-flight fixes from Codex review (e.g. `apcMaxBytes` field removal, range validation, snapshot stub fields) are assumed landed. This plan writes against the post-fix state. If a fix hasn't landed, Task 1 calls it out as a precondition.

---

## Goal

Wire libghostty-vt's three effect callbacks into the `Terminal` class as construction-time options, with full trampoline safety (try/catch-wrap, copy-before-invoke, JSCallback lifetime bound to Terminal, clean teardown). Callbacks are synchronous, invoked inside `vtWrite()`. After Pass 2, a consumer can observe the pty-response bytes, bell events, and title changes emitted by VT sequences — which is the minimum surface any real pty frontend needs.

## What's in scope

The three callbacks from spec §4.1:

```ts
onWritePty?:      (bytes: Uint8Array) => void;   // query responses + DECRQM replies written back to the pty
onBell?:          () => void;                     // BEL (0x07)
onTitleChanged?:  (title: string) => void;        // OSC 0 / OSC 2
```

Plus the FFI plumbing each requires:
- `ghostty_terminal_set` added to the loader's `SYMBOLS` table (already in `declaredHeaderSymbols`).
- `ghostty_terminal_get` added to the loader's `SYMBOLS` table for title read inside the title trampoline (also already declared, not yet loaded).
- `GhosttyTerminalOption` enum values bound in `generated.ts` (already generated; verify the values are reachable — `WRITE_PTY=1`, `BELL=2`, `TITLE_CHANGED=5`).

## What's out of scope

- The other five callback-shaped effects (`ENQUIRY`, `XTVERSION`, `SIZE`, `COLOR_SCHEME`, `DEVICE_ATTRIBUTES`) — all of them are query-response callbacks that must return a `GhosttyString` back into libghostty's allocator, and spec §11 Tranche 2 defers them until the allocator-callback pattern is established. Pass 2 deliberately ships only the fire-and-forget effects.
- `USERDATA` exposure — we pass `NULL` to libghostty and use JS closures for state routing. If a consumer ever wants opaque passthrough, Tranche 1+ can add it.
- Post-construction `setCallback(...)` / unregister APIs. Pass 2 is construction-time only; mutate by reconstructing.
- Changes to `snapshot()` — the existing snapshot path is the canonical "what's the current title" read; the title-changed trampoline reuses its single-key cousin (`ghostty_terminal_get`).

---

## The C-API picture (from `docs/abi/2026-04-22-abi-discovery.md` + `vendor/ghostty/include/ghostty/vt/terminal.h`)

**Registration:** `ghostty_terminal_set(term, GhosttyTerminalOption opt, const void* value) → GhosttyResult`. For callback options, `value` is a **function pointer** (not pointer-to-pointer); `NULL` clears the effect.

**Option identifiers** (header lines 414–475):
- `GHOSTTY_TERMINAL_OPT_WRITE_PTY = 1` → `GhosttyTerminalWritePtyFn`
- `GHOSTTY_TERMINAL_OPT_BELL = 2` → `GhosttyTerminalBellFn`
- `GHOSTTY_TERMINAL_OPT_TITLE_CHANGED = 5` → `GhosttyTerminalTitleChangedFn`

**Callback typedefs** (header lines 262–372):
```c
typedef void (*GhosttyTerminalBellFn)(GhosttyTerminal terminal, void* userdata);
typedef void (*GhosttyTerminalTitleChangedFn)(GhosttyTerminal terminal, void* userdata);
typedef void (*GhosttyTerminalWritePtyFn)(GhosttyTerminal terminal, void* userdata,
                                          const uint8_t* data, size_t len);
```

**Semantics (header lines 42–69):**
- Invoked synchronously during `ghostty_terminal_vt_write()`.
- Callbacks **must not** re-enter `vt_write` on the same terminal (undefined behavior).
- Callbacks "must be very careful to not block for too long or perform expensive operations."
- For `write_pty`: "The data is only valid for the duration of the call; callers must copy it if it needs to persist." → **trampoline copies before invoking user fn.**
- For `title_changed`: "The new title can be queried from the terminal after the callback returns." → **trampoline queries current title via `ghostty_terminal_get(TITLE)` at invocation, copies to JS string, delivers to user.** The ambiguity in "after the callback returns" is probed during Task 4 implementation; fallback is a deferred queue (see Open Questions below).
- `USERDATA` is not used — pass `NULL`. JS closures carry per-Terminal state.

---

## TypeScript-side architecture

### Ergonomics: constructor options

Spec §4.1 already declares the surface. Constructor-time only at v0: consumers pass 0–3 callback functions when creating the `Terminal`. Reasons this is right:

- Matches the FFI reality (registration is a single call after `_new`, no mutation API needed).
- Re-registering after construction is trivially additive if demand surfaces (Tranche 1). Shipping with that open door costs nothing now.
- No `EventEmitter` dependency, no subscribe/unsubscribe accounting, no "who owns the callback" ambiguity: the Terminal owns all of them, and teardown is `close()`.

### Trampoline architecture

Each user-provided callback is wrapped in a `JSCallback` (Bun's thunk-generator that produces a C-callable function pointer from a JS function). The `JSCallback` is stored as a private field on the Terminal instance. Lifetime is bound to the Terminal; `close()` tears it down.

The JSCallback's JS function is the trampoline. It does four things:

1. **Convert C args to JS values.** For `write_pty`, materialize the borrowed `(data, len)` pointer into a fresh `Uint8Array` by copying (`toArrayBuffer` + `set`). For `title_changed`, call `ghostty_terminal_get(TITLE)` on the captured handle and decode the resulting `GhosttyString` into a JS string. For `bell`, no payload.
2. **Wrap the user call in `try/catch`.** An exception thrown from the user's callback is logged via `console.error` (`"ts-libghostty-vt: <effect> callback threw:", e`) and swallowed. Exceptions cannot cross the C boundary — if one did, Bun's FFI would abort.
3. **Ignore the `terminal` arg** — the closure already holds the TS `Terminal` reference; we don't need to round-trip through the C handle. Ignore `userdata` — we passed NULL.
4. **Return void.** All three callbacks are void-returning; no ABI-level return-marshaling concern.

### Registration order

Inside `Terminal.constructor`, after `ghostty_terminal_new` succeeds and the handle is stored:

```
for each (option, userFn) in opts filtered to provided callbacks:
  create JSCallback wrapping the trampoline
  store on this.#<option>Callback
  ghostty_terminal_set(handle, option_enum_value, jscallback.ptr)  // checkResult on return
```

If `ghostty_terminal_set` returns non-OK for any of them, the constructor throws after calling `ghostty_terminal_free(handle)` and closing any JSCallbacks already created. This is a rare path (indicates an ABI mismatch — the option is valid, the handle is live, and the pointer is well-formed).

### Teardown order

`close()` must detach callbacks before freeing the handle AND before closing the JSCallbacks:

```
1. capture handle locally; null the field (prevents any future TS call from using it)
   — but keep JSCallback pointers alive for step 2

   Actually invert: step 2 needs a live handle. So:

1. snapshot handle into a local
2. for each non-null callback option:
     ghostty_terminal_set(local_handle, option_enum, NULL)   // detach
3. for each non-null callback JSCallback:
     jscallback.close()
4. ghostty_terminal_free(local_handle)
5. null this.#handle and all #*Callback fields
```

Rationale: detaching via `set(NULL)` before `JSCallback.close()` ensures libghostty never looks up a thunk whose backing storage has been freed. Freeing the handle last keeps the whole sequence atomic from the TS side. `close()` remains idempotent: the `if (this.#handle === null) return;` at the top short-circuits double-calls.

### Concurrency and re-entry

The spec (§5.4) and the C header both prohibit re-entry into `vtWrite()` on the same terminal from inside a callback. The binding does not add a runtime guard — the cost of wrapping every `vtWrite` in a reentry flag is paid on every call, and the guard would catch the same misuse the docs forbid. Document the constraint prominently in `TerminalOptions` JSDoc (already spec'd) and in the README. A Tranche 1+ stretch goal could add a dev-mode reentry assertion under an env flag.

Callbacks throwing are handled by the trampoline's `try/catch`. Nothing else in the system needs to care.

---

## Open questions — probed during implementation

Each of these has a default path and a fallback. Task owners should probe, not guess, and update the plan + ABI doc if reality diverges.

1. **Title query timing.** Does `ghostty_terminal_get(TITLE)` inside the `title_changed` trampoline return the new title, or the pre-change one? The header's "can be queried from the terminal after the callback returns" is ambiguous. **Default:** query synchronously inside the trampoline; test that the observed title matches the OSC payload that triggered the callback. **Fallback:** if the title is stale, queue `{event, timestamp}` tuples inside the trampoline and drain them at the end of `vtWrite()` before returning — preserves sync-delivery semantics of §4.1.

2. **`JSCallback.ptr` type compatibility with `const void*`.** Bun's `JSCallback.ptr` is typed as `Pointer | null`. `ghostty_terminal_set`'s `value` arg is declared `FFIType.ptr`. Passing `cb.ptr` directly should work; if not, wrap with `ptr(...)` or fall back to `new BigUint64Array([BigInt(cb.ptr)])`. Task 3's FFI declaration step verifies this path with a live probe before wiring all three callbacks.

3. **Null-default for detach.** `ghostty_terminal_set(handle, opt, NULL)` must accept a null third arg. Bun maps JS `null` to a null pointer for `FFIType.ptr`, but this has bitten us before (Pass 1 Task 11). Verify in Task 3 Step 2 with a quick probe.

4. **`GhosttyTerminal` handle passed to callback vs stored handle.** The C callback receives the handle libghostty registered against. It should equal `this.#handle`. We ignore it (closure carries the TS Terminal) — verify in a smoke test that the C-supplied handle matches, as a diagnostic check. If they diverge for any reason (unlikely — terminal instances are stable), we learn something important.

5. **Can `snapshot()` be called from inside a callback?** Unlikely to be used but worth confirming. The header only prohibits `vt_write` re-entry; read-only ops should be safe. A smoke test that calls `snapshot()` from inside `onBell` confirms this, with the fallback being to document a ban.

---

## File delta from Pass 1

Files touched:

```
src/
  ffi.ts              # add ghostty_terminal_set + ghostty_terminal_get to SYMBOLS
  terminal.ts         # callback fields, trampolines, set/detach wiring in ctor + close
  types.ts            # re-add (correctly) onWritePty/onBell/onTitleChanged to TerminalOptions
  internal/
    callbacks.ts      # NEW — private helpers: makeWritePtyCallback, makeBellCallback,
                      #       makeTitleCallback. One file, three factory fns, each
                      #       returning { jsCallback, optionValue }.
                      #       Keeps terminal.ts from ballooning.

test/smoke/
  callbacks.test.ts   # NEW — one file covering all three effects + error paths

README.md             # add "Effect callbacks" section with minimal example
CLAUDE.md             # add entry for callback-trampoline copy-before-invoke semantics
CONFIRM_WITH_MATT.md  # Pass 2 status block + any surfaced plan/code drift
```

No changes to: `errors.ts` (no new error classes; existing `GhosttyError` covers `_set` failures); `formatter.ts` (orthogonal); `internal/generated.ts` (regenerated but the option enum is already there); `internal/path.ts` / `internal/sized-struct.ts` / `internal/marshal.ts`.

No changes to `scripts/` — we don't regenerate bindings as part of Pass 2; `bun run verify:generated` continues to assert the existing `generated.ts` matches the pin.

---

## Task outline

Twelve tasks, ~1500 lines of snippets below. Smaller than Pass 1's 22 tasks because scope is one subsystem, not a full vertical slice.

| # | Task | Touches |
|---|---|---|
| 1 | Precondition check — Pass-1-fix state | (verification only) |
| 2 | Probe `JSCallback` + `ghostty_terminal_set` compatibility | `scripts/probe-callbacks.ts` (new) |
| 3 | Extend `src/ffi.ts` SYMBOLS | `src/ffi.ts` |
| 4 | Introduce `src/internal/callbacks.ts` | `src/internal/callbacks.ts` (new), `test/smoke/callback-factories.test.ts` (new) |
| 5 | Wire callbacks into `Terminal.constructor` | `src/terminal.ts` |
| 6 | Teardown callbacks in `Terminal.close()` | `src/terminal.ts`, `test/smoke/terminal.test.ts` |
| 7 | Re-add callback fields to `TerminalOptions` | `src/types.ts` |
| 8 | Smoke test — `onBell` | `test/smoke/callbacks.test.ts` (new) |
| 9 | Smoke test — `onTitleChanged` + probe title-timing open question | `test/smoke/callbacks.test.ts` |
| 10 | Smoke test — `onWritePty` | `test/smoke/callbacks.test.ts` |
| 11 | Smoke tests — error paths | `test/smoke/callbacks.test.ts` |
| 12 | Docs — README, CLAUDE.md, CONFIRM_WITH_MATT.md, version bump, tag | `README.md`, `CLAUDE.md`, `CONFIRM_WITH_MATT.md`, `package.json` |

---

---

## Task 1: Precondition check — Pass-1-fix state

**Purpose:** Pass 2 assumes the Codex-surfaced Pass-1 contract bugs (silently-dropped `apcMaxBytes*`, missing range validation, stub `cursor.style` / `mouseTracking`) have landed. This task verifies the working tree's state before touching any code; if the fix branch is still open, this task halts and produces a precise delta for the implementer.

**Files:** none modified. Read-only verification.

- [ ] **Step 1: Confirm baseline.**

```bash
# Clean working tree + main up to date.
git status
# Expected: "nothing to commit, working tree clean" on branch main.

bun run typecheck
# Expected: no errors.

bun test test/smoke
# Expected: all pass. Capture the passing test count for later diff.
```

- [ ] **Step 2: Verify `apcMaxBytes*` fields are gone from `TerminalOptions`.**

```bash
grep -n "apcMaxBytes\|apc_max_bytes" src/types.ts src/terminal.ts
# Expected: no matches in src/types.ts. May match in src/terminal.ts ONLY as a
# comment referencing the field as not-set-here.
```

If this grep finds the fields still declared on `TerminalOptions`, STOP. The Pass-1-fix Bob hasn't landed. File a note in `CONFIRM_WITH_MATT.md` under a new "Pass 2 blocked on Pass-1 fixes" heading and escalate to Matt. Do not proceed to Task 2.

- [ ] **Step 3: Verify range validation on Terminal constructor.**

```bash
# The Codex feedback named four line ranges that needed fail-fast range/integer
# checks: Terminal constructor (cols/rows/maxScrollback/cellPx), resize() args,
# vtWrite (bytes length), snapshot() path. The fix Bob's smoke tests would
# have named these bounds explicitly.
grep -n "u16\|65535\|UINT16_MAX\|out of range\|must fit" src/terminal.ts | head -10
# Expected: hits around constructor + resize() that reference u16 bounds
# explicitly, not just `> 0`.

# Cross-check: the fix Bob should have added regression tests with Codex's
# exact reproductions (cols: 70000, cellPx: -1, maxScrollback: -1).
grep -rn "70000\|cellPx.*-1\|maxScrollback.*-1" test/smoke
# Expected: at least one test per case.
```

If the fix Bob's work didn't land these, STOP as in Step 2.

- [ ] **Step 4: Verify snapshot stub fields — wired or narrowed.**

Inspect `src/types.ts` `TerminalSnapshot`:

```bash
grep -n "cursor\|mouseTracking\|style" src/types.ts
```

Two acceptable outcomes:
1. **Wired (preferred):** `TerminalSnapshot.cursor.style` is a real value read via `get_multi` + style-struct decode, and `mouseTracking` reports the tracking mode set by `DECSET 1000` / `1002` / `1003` / `1006`. Smoke test after `DECSET 1000` should return `mouseTracking: "normal"` or similar, not `"none"`.
2. **Narrowed:** `cursor.style` removed from `TerminalSnapshot` (the interface), and `mouseTracking` either removed or typed as `"unknown" | MouseTracking` with documentation that full decoding lands in Pass 2+. `CONFIRM_WITH_MATT.md` carries an entry under drift.

If neither outcome is visible in the committed code, STOP as above.

- [ ] **Step 5: Record the baseline for Pass 2.**

Write a one-paragraph "Pass 2 start-state" entry to `CONFIRM_WITH_MATT.md` capturing: (a) which fix branch landed and its commit SHA, (b) the test count from Step 1, (c) the `git rev-parse HEAD` Pass 2 starts from. This anchors everything that follows.

**Expected outcome of Task 1:** no code changes, one doc entry, baseline captured. Proceed to Task 2.

---

## Task 2: Probe `JSCallback` + `ghostty_terminal_set` compatibility

**Purpose:** Resolve three open questions (Questions #2–#4 in the plan header) with a short, throwaway probe script, *before* wiring real callbacks into `Terminal`. Eliminates the scenario where all three callbacks have to be unwound because the foundational FFI call doesn't work.

**Files:**
- Create: `scripts/probe-callbacks.ts` (committed; useful diagnostic tool, not thrown away)

- [ ] **Step 1: Write the probe script.**

Contents of `scripts/probe-callbacks.ts`:

```typescript
// Pass 2 Task 2 probe — validates bun:ffi JSCallback + ghostty_terminal_set
// compatibility against the pinned libghostty-vt. Run manually:
//
//   bun run scripts/probe-callbacks.ts
//
// Probes:
//   (a) JSCallback.ptr passes to ghostty_terminal_set for all 3 Pass 2 options
//       without a libghostty error return.
//   (b) ghostty_terminal_set(handle, OPT, null) detaches without error.
//   (c) A minimal vt_write triggers the bell callback synchronously.
//   (d) Callback teardown order (set NULL → jscallback.close → terminal_free)
//       does not crash.
//
// All output goes to stdout as structured tagged lines so a human (or the
// plan's Task 2 Step 2 verification) can audit trivially. Exits 0 on success.

import { dlopen, FFIType, JSCallback, ptr, type Pointer } from "bun:ffi";
import { existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const DYLIB = process.env["GHOSTTY_VT_LIB"] ??
  join(ROOT, "prebuilds/darwin-arm64/libghostty-vt.dylib");
if (!existsSync(DYLIB)) {
  console.error("dylib not found:", DYLIB);
  process.exit(2);
}

const lib = dlopen(DYLIB, {
  ghostty_terminal_new: {
    args: [FFIType.ptr, FFIType.ptr, FFIType.u64, FFIType.u64],
    returns: FFIType.i32,
  },
  ghostty_terminal_free: {
    args: [FFIType.ptr],
    returns: FFIType.void,
  },
  ghostty_terminal_set: {
    args: [FFIType.ptr, FFIType.i32, FFIType.ptr],
    returns: FFIType.i32,
  },
  ghostty_terminal_vt_write: {
    args: [FFIType.ptr, FFIType.ptr, FFIType.u64],
    returns: FFIType.void,
  },
});

// Build a 10x3 Terminal options struct (cols=10, rows=3, max_scrollback=100).
const opts = new Uint8Array(16);
new DataView(opts.buffer).setUint16(0, 10, true); // cols
new DataView(opts.buffer).setUint16(2, 3, true);  // rows
new DataView(opts.buffer).setBigUint64(8, 100n, true); // max_scrollback
const u64s = new BigUint64Array(opts.buffer, 0, 2);
const outSlot = new BigUint64Array(1);

const newResult = lib.symbols.ghostty_terminal_new(null, ptr(outSlot), u64s[0]!, u64s[1]!);
console.log("tag=terminal_new result=", newResult);
if (newResult !== 0) process.exit(1);
const handle = Number(outSlot[0]!) as Pointer;
console.log("tag=handle ok=", handle !== 0);

// ---- (a) Register a bell callback via ghostty_terminal_set -----------------

let bellCount = 0;
const bellCb = new JSCallback(
  (_term: Pointer, _userdata: Pointer) => { bellCount++; },
  { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.void },
);
const OPT_BELL = 2;
const setBellResult = lib.symbols.ghostty_terminal_set(handle, OPT_BELL, bellCb.ptr);
console.log("tag=set_bell result=", setBellResult);
if (setBellResult !== 0) process.exit(1);

// ---- (c) Drive vt_write with a BEL, confirm the callback fires -------------

const bel = new Uint8Array([0x07]);
lib.symbols.ghostty_terminal_vt_write(handle, ptr(bel), 1n);
console.log("tag=bell_count count=", bellCount);
if (bellCount !== 1) process.exit(1);

// ---- (b) Detach with NULL --------------------------------------------------

const detachResult = lib.symbols.ghostty_terminal_set(handle, OPT_BELL, null);
console.log("tag=detach_bell result=", detachResult);
if (detachResult !== 0) process.exit(1);

// Drive another BEL; count should not increment.
lib.symbols.ghostty_terminal_vt_write(handle, ptr(bel), 1n);
console.log("tag=bell_count_after_detach count=", bellCount);
if (bellCount !== 1) process.exit(1);

// ---- (d) Teardown order ----------------------------------------------------

bellCb.close();
console.log("tag=jscallback_close ok=true");
lib.symbols.ghostty_terminal_free(handle);
console.log("tag=terminal_free ok=true");

console.log("tag=probe result=ok");
```

- [ ] **Step 2: Run the probe and capture the output.**

```bash
bun run scripts/probe-callbacks.ts > .tmp/probe-callbacks.out 2>&1 || {
  echo "Probe failed. Output:"
  cat .tmp/probe-callbacks.out
  exit 1
}
cat .tmp/probe-callbacks.out
```

Expected last line: `tag=probe result=ok`. Expected `bell_count=1` after vt_write, `bell_count_after_detach=1` (i.e. no increment after NULL detach).

- [ ] **Step 3: Record findings in the plan and move on.**

Add a short "Task 2 findings" block to `CONFIRM_WITH_MATT.md` under a "Pass 2 notes" heading: which paths worked, which needed adjustment, any surprise. If the probe failed, the implementer MUST stop and diagnose before any production wiring — a failure here invalidates the entire Pass 2 architecture.

**Expected outcome of Task 2:** `scripts/probe-callbacks.ts` committed, `CONFIRM_WITH_MATT.md` updated with one paragraph of findings. Open Questions #2–#4 are answered in the affirmative (the default path works). If not: stop, renegotiate with Matt.

---

## Task 3: Extend `src/ffi.ts` SYMBOLS

**Purpose:** Add `ghostty_terminal_set` and `ghostty_terminal_get` to the dlopen'd symbol manifest. Both are already in `declaredHeaderSymbols` (verified) so `verify:generated` stays green without regeneration. `ghostty_terminal_set` is the main callback-wiring call; `ghostty_terminal_get` is required by the title-read inside the title trampoline.

**Files:**
- Edit: `src/ffi.ts`

- [ ] **Step 1: Add `ghostty_terminal_set` to the `SYMBOLS` object.**

Insert the following entry into `SYMBOLS` in `src/ffi.ts`, immediately after `ghostty_terminal_get_multi`:

```typescript
  // ghostty_terminal_set wires callbacks (WRITE_PTY, BELL, TITLE_CHANGED, ...)
  // and non-callback options (APC bounds, default colors, TITLE/PWD). For
  // callback options the value is a function pointer; for scalar options it's
  // a pointer to the typed scalar slot; passing NULL clears the option.
  // Signature per ABI §4 + terminal.h:960-962.
  ghostty_terminal_set: {
    args: [FFIType.ptr, FFIType.i32, FFIType.ptr],  // (term, opt:c_int, value:void*)
    returns: FFIType.i32,
  },
  // ghostty_terminal_get reads a single terminal data key. For Pass 2 we use
  // it from the title-changed trampoline to read the fresh title. Signature
  // per ABI §4 + terminal.h:1056-1058. For Pass 2's title key (DATA_TITLE=12),
  // the out buffer must be a caller-allocated 16-byte GhosttyString slot.
  ghostty_terminal_get: {
    args: [FFIType.ptr, FFIType.i32, FFIType.ptr],  // (term, data:c_int, out*)
    returns: FFIType.i32,
  },
```

- [ ] **Step 2: Verify typecheck + load + smoke.**

```bash
bun run typecheck
# Expected: clean.

bun test test/smoke
# Expected: all prior tests pass. No new tests in Task 3.

bun run verify:generated
# Expected: green. generated.ts is not touched — both symbols were already
# present in declaredHeaderSymbols.
```

- [ ] **Step 3: Commit.**

Commit message (per repo convention — scope-prefixed, no trailer-heavy boilerplate, but do include a Bobname trailer):

```
feat(ffi): add ghostty_terminal_set + ghostty_terminal_get to SYMBOLS

Pass 2 wiring — effect callbacks register via ghostty_terminal_set; the
title-changed trampoline reads the fresh title via ghostty_terminal_get.
Both symbols were already in declaredHeaderSymbols; this extends the
loader manifest to match.
```

**Expected outcome of Task 3:** `src/ffi.ts` has two new `SYMBOLS` entries, typecheck + smoke + verify:generated all green, one commit.

---

## Task 4: Introduce `src/internal/callbacks.ts`

**Purpose:** Encapsulate the three trampoline factories in one private module so `terminal.ts` doesn't balloon and so trampoline semantics (copy-before-invoke, try/catch-wrap, ignored-userdata) live in one auditable place.

**Files:**
- Create: `src/internal/callbacks.ts`

- [ ] **Step 1: Write the factory module.**

Contents of `src/internal/callbacks.ts`:

```typescript
import { JSCallback, FFIType, toArrayBuffer, type Pointer } from "bun:ffi";
import { GhosttyTerminalOptionValues } from "./generated";

// GhosttyTerminalOption values sourced from generated.ts (authoritative) —
// sidesteps the plan-vs-reality drift risk (ABI §4 lists them but those
// values came from a human reading the header; we want the probed values).
const OPT_WRITE_PTY     = GhosttyTerminalOptionValues["GHOSTTY_TERMINAL_OPT_WRITE_PTY"];
const OPT_BELL          = GhosttyTerminalOptionValues["GHOSTTY_TERMINAL_OPT_BELL"];
const OPT_TITLE_CHANGED = GhosttyTerminalOptionValues["GHOSTTY_TERMINAL_OPT_TITLE_CHANGED"];

export interface TrampolineResult {
  jsCallback: JSCallback;
  optionValue: number;
}

/**
 * Trampoline for GHOSTTY_TERMINAL_OPT_WRITE_PTY.
 *
 * libghostty hands us `(terminal, userdata, data, len)` with `data` borrowed
 * for the duration of the call (header line 355-372). We copy the bytes into
 * a fresh JS-owned Uint8Array before invoking the user callback so the user
 * can safely retain the array.
 *
 * User exceptions are logged via console.error and swallowed; propagating
 * across the C boundary is UB.
 */
export function makeWritePtyCallback(
  userFn: (bytes: Uint8Array) => void,
): TrampolineResult {
  const jsCallback = new JSCallback(
    (_term: Pointer | null, _userdata: Pointer | null, data: Pointer | null, len: bigint | number) => {
      const lenN = typeof len === "bigint" ? Number(len) : len;
      if (data === null || lenN === 0) {
        try { userFn(new Uint8Array(0)); }
        catch (e) { console.error("ts-libghostty-vt: onWritePty callback threw:", e); }
        return;
      }
      // Copy the borrowed buffer immediately. toArrayBuffer aliases the C
      // memory; we .set() it into a fresh JS-owned Uint8Array so the user
      // receives a stable, retainable reference even if the C buffer is
      // reused for the next call.
      const borrowed = new Uint8Array(toArrayBuffer(data, 0, lenN));
      const owned = new Uint8Array(lenN);
      owned.set(borrowed);
      try {
        userFn(owned);
      } catch (e) {
        console.error("ts-libghostty-vt: onWritePty callback threw:", e);
      }
    },
    {
      args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u64],
      returns: FFIType.void,
    },
  );
  return { jsCallback, optionValue: OPT_WRITE_PTY };
}

/**
 * Trampoline for GHOSTTY_TERMINAL_OPT_BELL.
 *
 * No payload. The C callback is `void(*)(terminal, userdata)` — we ignore
 * both because the TS closure holds the Terminal reference and userdata is
 * always NULL (we don't expose per-terminal userdata at v0).
 *
 * User exceptions are logged via console.error and swallowed.
 */
export function makeBellCallback(userFn: () => void): TrampolineResult {
  const jsCallback = new JSCallback(
    (_term: Pointer | null, _userdata: Pointer | null) => {
      try {
        userFn();
      } catch (e) {
        console.error("ts-libghostty-vt: onBell callback threw:", e);
      }
    },
    {
      args: [FFIType.ptr, FFIType.ptr],
      returns: FFIType.void,
    },
  );
  return { jsCallback, optionValue: OPT_BELL };
}

/**
 * Trampoline for GHOSTTY_TERMINAL_OPT_TITLE_CHANGED.
 *
 * The C callback `void(*)(terminal, userdata)` carries no title payload
 * (header line 340-352). The caller is expected to query the current title
 * from the terminal itself. `readTitle` is a zero-arg closure the Terminal
 * provides — it wraps `ghostty_terminal_get(TITLE)` + GhosttyString decode.
 *
 * The header's wording "can be queried from the terminal after the callback
 * returns" is ambiguous; Task 9 smoke-tests the default (query synchronously
 * from inside the trampoline) and falls back to a deferred queue if needed.
 *
 * User exceptions (including from `readTitle`) are logged via console.error
 * and swallowed.
 */
export function makeTitleCallback(
  userFn: (title: string) => void,
  readTitle: () => string,
): TrampolineResult {
  const jsCallback = new JSCallback(
    (_term: Pointer | null, _userdata: Pointer | null) => {
      try {
        const title = readTitle();
        userFn(title);
      } catch (e) {
        console.error("ts-libghostty-vt: onTitleChanged callback threw:", e);
      }
    },
    {
      args: [FFIType.ptr, FFIType.ptr],
      returns: FFIType.void,
    },
  );
  return { jsCallback, optionValue: OPT_TITLE_CHANGED };
}
```

- [ ] **Step 2: Verify the module typechecks in isolation.**

```bash
bun run typecheck
# Expected: clean. `callbacks.ts` compiles without errors despite not being
# imported anywhere yet (tsc still checks it).
```

- [ ] **Step 3: Unit-shape tests (bare JSCallbacks, no Terminal yet).**

Add `test/smoke/callback-factories.test.ts`:

```typescript
// Pass 2 Task 4 — exercises the three trampoline factories in isolation.
// No Terminal, no FFI to libghostty; we just confirm the JSCallbacks can be
// constructed + closed, and that the user-fn throw-swallow path logs and
// does not propagate.

import { describe, expect, it, mock, spyOn } from "bun:test";
import {
  makeBellCallback,
  makeTitleCallback,
  makeWritePtyCallback,
} from "../../src/internal/callbacks";

describe("callback factories", () => {
  it("makeBellCallback produces a callable JSCallback with the BELL option value", () => {
    const fn = mock(() => {});
    const { jsCallback, optionValue } = makeBellCallback(fn);
    try {
      expect(typeof jsCallback.ptr).toBe("number");
      expect(optionValue).toBe(2); // GHOSTTY_TERMINAL_OPT_BELL
    } finally {
      jsCallback.close();
    }
  });

  it("makeWritePtyCallback returns the WRITE_PTY option value", () => {
    const fn = mock((_bytes: Uint8Array) => {});
    const { jsCallback, optionValue } = makeWritePtyCallback(fn);
    try {
      expect(optionValue).toBe(1); // GHOSTTY_TERMINAL_OPT_WRITE_PTY
    } finally {
      jsCallback.close();
    }
  });

  it("makeTitleCallback returns the TITLE_CHANGED option value", () => {
    const fn = mock((_t: string) => {});
    const readTitle = () => "";
    const { jsCallback, optionValue } = makeTitleCallback(fn, readTitle);
    try {
      expect(optionValue).toBe(5); // GHOSTTY_TERMINAL_OPT_TITLE_CHANGED
    } finally {
      jsCallback.close();
    }
  });

  it("bell trampoline swallows user throws and logs via console.error", () => {
    // NB: this test drives the trampoline indirectly by calling the backing
    // JS function — we cannot call it through the C boundary without a live
    // Terminal. We approximate by noting that the JS function closed over by
    // the JSCallback is the trampoline itself; inspecting that is a Bun
    // internal. Instead, the full throw-swallow assertion lives in
    // test/smoke/callbacks.test.ts (Task 11), which drives a real Terminal.
    // This placeholder just asserts the factory doesn't throw at construction
    // time when given a throwing fn.
    const throwing = () => { throw new Error("boom"); };
    const { jsCallback } = makeBellCallback(throwing);
    try {
      expect(jsCallback.ptr).toBeTruthy();
    } finally {
      jsCallback.close();
    }
  });
});
```

- [ ] **Step 4: Run tests and verify.**

```bash
bun test test/smoke/callback-factories.test.ts
# Expected: 4 tests pass.

bun test test/smoke
# Expected: prior tests still pass.
```

**Expected outcome of Task 4:** new file `src/internal/callbacks.ts`, new test file `test/smoke/callback-factories.test.ts`, typecheck + smoke green, no callers of the new module yet.

---

## Task 5: Wire callbacks into `Terminal.constructor`

**Purpose:** Accept the three optional callbacks, build `JSCallback`s via the factories, register them via `ghostty_terminal_set`, store the JSCallbacks as private fields. Handle the mid-registration-failure cleanup path so a partial wiring never leaves dangling thunks.

**Files:**
- Edit: `src/terminal.ts`

- [ ] **Step 1: Add imports and new private fields.**

At the top of `src/terminal.ts`, extend the `bun:ffi` import to include `JSCallback`:

```typescript
import { ptr, toArrayBuffer, type JSCallback, type Pointer } from "bun:ffi";
```

Add callback factory imports below the existing internal imports:

```typescript
import {
  makeBellCallback,
  makeTitleCallback,
  makeWritePtyCallback,
  type TrampolineResult,
} from "./internal/callbacks";
```

Add private fields inside the `Terminal` class, directly after `#cellPx`:

```typescript
  // One JSCallback per enabled effect, created in the constructor and closed
  // in close(). When null, that effect is not registered on the C side.
  #writePtyCb: JSCallback | null = null;
  #bellCb: JSCallback | null = null;
  #titleCb: JSCallback | null = null;
```

- [ ] **Step 2: Add a private `#readTitle()` helper.**

This method reads the current title via `ghostty_terminal_get(TITLE)` and copies the `GhosttyString` into a JS string. Used by the title trampoline. Insert immediately before `#assertOpen()` at the bottom of the class:

```typescript
  /**
   * Read the terminal's current title by calling ghostty_terminal_get(TITLE).
   * The GhosttyString ptr aliases into terminal-owned memory valid only until
   * the next mutating call, so we copy bytes immediately.
   *
   * Returns "" when the terminal has no title set (pointer is null or length
   * is zero) — libghostty does not expose "unset" vs "empty string" distinctly
   * via this accessor. Returns "" on ghostty_terminal_get error to keep the
   * trampoline resilient; full-fidelity error reporting is not useful inside
   * a callback.
   */
  #readTitle(): string {
    if (this.#handle === null) return "";
    const lib = getLib();
    const slot = new ArrayBuffer(16); // GhosttyString: {uint8_t* ptr@0, size_t len@8}
    const result = lib.symbols.ghostty_terminal_get(
      this.#handle,
      GhosttyTerminalDataValues["GHOSTTY_TERMINAL_DATA_TITLE"],
      ptr(new Uint8Array(slot)),
    );
    if (result !== 0) return "";
    const view = new DataView(slot);
    const strPtr = Number(view.getBigUint64(0, true));
    const strLen = Number(view.getBigUint64(8, true));
    if (strPtr === 0 || strLen === 0) return "";
    const borrowed = new Uint8Array(
      toArrayBuffer(strPtr as unknown as Pointer, 0, strLen),
    );
    const copy = new Uint8Array(strLen);
    copy.set(borrowed);
    return new TextDecoder("utf-8").decode(copy);
  }
```

- [ ] **Step 3: Register callbacks in the constructor.**

Inside `Terminal.constructor`, AFTER the `this.#handle = Number(handleBig) as Pointer;` line, append:

```typescript
    // ---- Register effect callbacks ------------------------------------------
    // Each callback factory returns a JSCallback + the option enum value.
    // We register via ghostty_terminal_set; failure here is rare (indicates
    // an ABI mismatch) but we must unwind cleanly: free the handle, close
    // any JSCallbacks already created, then rethrow.
    const registered: TrampolineResult[] = [];
    try {
      if (opts.onWritePty !== undefined) {
        const t = makeWritePtyCallback(opts.onWritePty);
        registered.push(t);
        this.#writePtyCb = t.jsCallback;
        const r = lib.symbols.ghostty_terminal_set(
          this.#handle,
          t.optionValue,
          t.jsCallback.ptr,
        );
        checkResult(r, "ghostty_terminal_set(WRITE_PTY)");
      }
      if (opts.onBell !== undefined) {
        const t = makeBellCallback(opts.onBell);
        registered.push(t);
        this.#bellCb = t.jsCallback;
        const r = lib.symbols.ghostty_terminal_set(
          this.#handle,
          t.optionValue,
          t.jsCallback.ptr,
        );
        checkResult(r, "ghostty_terminal_set(BELL)");
      }
      if (opts.onTitleChanged !== undefined) {
        const userFn = opts.onTitleChanged;
        const readTitle = () => this.#readTitle();
        const t = makeTitleCallback(userFn, readTitle);
        registered.push(t);
        this.#titleCb = t.jsCallback;
        const r = lib.symbols.ghostty_terminal_set(
          this.#handle,
          t.optionValue,
          t.jsCallback.ptr,
        );
        checkResult(r, "ghostty_terminal_set(TITLE_CHANGED)");
      }
    } catch (e) {
      // Unwind: detach any successfully-registered options, close their
      // JSCallbacks, free the terminal, null our fields.
      const h = this.#handle;
      if (h !== null) {
        for (const t of registered) {
          try { lib.symbols.ghostty_terminal_set(h, t.optionValue, null); } catch {}
        }
        for (const t of registered) {
          try { t.jsCallback.close(); } catch {}
        }
        try { lib.symbols.ghostty_terminal_free(h); } catch {}
      }
      this.#writePtyCb = null;
      this.#bellCb = null;
      this.#titleCb = null;
      this.#handle = null;
      throw e;
    }
```

- [ ] **Step 4: Verify no side effects to existing snapshot() / vtWrite() paths.**

```bash
bun run typecheck
# Expected: clean. Note: `JSCallback` is imported as a type for the field
# annotations; `makeBellCallback` etc. are imported as values.

bun test test/smoke
# Expected: all prior tests green. No new tests in Task 5 yet — Task 8-11
# cover callback behavior.
```

- [ ] **Step 5: Commit.**

Commit message:

```
feat(terminal): wire effect callbacks into constructor

Pass 2 Task 5 — register WRITE_PTY / BELL / TITLE_CHANGED via
ghostty_terminal_set when the corresponding opts.onX is provided. Store
JSCallbacks on private fields for teardown. Unwind cleanly on any
mid-registration failure (free handle, close partial callbacks, rethrow).
#readTitle() private helper reads the fresh title via ghostty_terminal_get
and copies the GhosttyString into a JS string for the title trampoline.
```

**Expected outcome of Task 5:** `src/terminal.ts` grows by ~60 lines (imports + fields + `#readTitle()` + registration block). Typecheck + smoke green. Callbacks are actually being registered on the C side — but no smoke test yet exercises them. That's Task 8-11's job.

---

## Task 6: Teardown callbacks in `Terminal.close()`

**Purpose:** On `close()`, detach each registered callback via `ghostty_terminal_set(handle, OPT, null)` before closing the `JSCallback` and before `ghostty_terminal_free`. Preserves the invariant that libghostty never looks up a thunk whose backing JS function has been freed. Keeps `close()` idempotent.

**Files:**
- Edit: `src/terminal.ts`

- [ ] **Step 1: Rewrite `close()` to handle callback teardown.**

Replace the existing `close()` method (currently lines ~163-168 of `src/terminal.ts`):

```typescript
  close(): void {
    if (this.#handle === null) return;
    const lib = getLib();
    const h = this.#handle;

    // Detach callbacks BEFORE closing JSCallbacks and BEFORE terminal_free.
    // Rationale: passing NULL to ghostty_terminal_set clears the effect and
    // ensures libghostty will never invoke a thunk whose JS storage has been
    // freed. terminal_free should also sever callbacks, but we don't want to
    // rely on that assumption — detaching explicitly is belt-and-suspenders.
    //
    // Any single set() returning non-OK is logged but does not stop teardown —
    // we still want to free the handle and close the JSCallbacks.
    if (this.#writePtyCb !== null) {
      const r = lib.symbols.ghostty_terminal_set(
        h,
        GhosttyTerminalOptionValues["GHOSTTY_TERMINAL_OPT_WRITE_PTY"],
        null,
      );
      if (r !== 0) console.error("ts-libghostty-vt: detach WRITE_PTY returned", r);
    }
    if (this.#bellCb !== null) {
      const r = lib.symbols.ghostty_terminal_set(
        h,
        GhosttyTerminalOptionValues["GHOSTTY_TERMINAL_OPT_BELL"],
        null,
      );
      if (r !== 0) console.error("ts-libghostty-vt: detach BELL returned", r);
    }
    if (this.#titleCb !== null) {
      const r = lib.symbols.ghostty_terminal_set(
        h,
        GhosttyTerminalOptionValues["GHOSTTY_TERMINAL_OPT_TITLE_CHANGED"],
        null,
      );
      if (r !== 0) console.error("ts-libghostty-vt: detach TITLE_CHANGED returned", r);
    }

    // Close JSCallbacks now that libghostty no longer holds pointers to them.
    if (this.#writePtyCb !== null) { try { this.#writePtyCb.close(); } catch {} this.#writePtyCb = null; }
    if (this.#bellCb !== null)     { try { this.#bellCb.close();     } catch {} this.#bellCb = null; }
    if (this.#titleCb !== null)    { try { this.#titleCb.close();    } catch {} this.#titleCb = null; }

    lib.symbols.ghostty_terminal_free(h);
    this.#handle = null;
  }
```

- [ ] **Step 2: Add a smoke test for double-close idempotency.**

Append to `test/smoke/terminal.test.ts` (or wherever the Pass 1 double-close test lives — grep to confirm before editing):

```typescript
  it("is idempotent under close() → close() even with callbacks registered", () => {
    let bellCount = 0;
    const term = new Terminal({
      cols: 10, rows: 3,
      onBell: () => { bellCount++; },
    });
    term.close();
    // Second close must be a silent no-op — no throw, no double-free crash.
    expect(() => term.close()).not.toThrow();
    // Behavior after close is already tested elsewhere; here we only care
    // that close() does not bomb a second time.
  });
```

- [ ] **Step 3: Verify.**

```bash
bun run typecheck
# Expected: clean.

bun test test/smoke
# Expected: all green including the new idempotency test.
```

- [ ] **Step 4: Commit.**

```
fix(terminal): callback-aware teardown in close()

Pass 2 Task 6 — close() now detaches each registered callback via
ghostty_terminal_set(NULL) before closing the JSCallback and before
ghostty_terminal_free. close() remains idempotent; double-close with
callbacks registered is verified by a new smoke test.
```

**Expected outcome of Task 6:** `close()` is ~40 lines (up from ~5), one new smoke test, typecheck + smoke green. The full callback lifecycle (register → fire → detach → free) is now wired end-to-end on the binding side; Task 8-11 verify it from the user's perspective.

---

## Task 7: Re-add callback fields to `TerminalOptions`

**Purpose:** Restore the three callback fields on `TerminalOptions` with correct JSDoc stating the constraints (no re-entry into vtWrite, no throwing, values are owned copies). The Pass-1 fix Bob removed `apcMaxBytes*`; this task restores the legitimate callback fields that the spec has always called for.

**Files:**
- Edit: `src/types.ts`

- [ ] **Step 1: Extend `TerminalOptions`.**

Replace the existing `TerminalOptions` definition with:

```typescript
export interface TerminalOptions {
  cols: number;
  rows: number;
  maxScrollback?: number;
  cellPx?: { width: number; height: number };

  /**
   * Invoked when libghostty needs to write data back to the pty in response
   * to a VT query sequence (e.g. DA1, DECRQM, device status report). The
   * `bytes` array is a JS-owned copy of libghostty's borrowed buffer — safe
   * to retain past the callback's return.
   *
   * Constraints:
   * - MUST NOT re-enter `vtWrite()` on this Terminal. libghostty is mid-parse
   *   and re-entry is undefined behavior. Defer work with `queueMicrotask`
   *   or similar if you need to write back to this Terminal in response.
   * - MUST NOT throw. Exceptions are caught at the FFI boundary and logged
   *   via `console.error`; they cannot cross the C frame.
   * - SHOULD NOT block. The callback runs synchronously inside `vtWrite()`
   *   and blocks further input parsing until it returns.
   */
  onWritePty?: (bytes: Uint8Array) => void;

  /**
   * Invoked when libghostty processes a BEL character (0x07).
   *
   * Same constraints as onWritePty (no re-entry, no throw, no blocking).
   */
  onBell?: () => void;

  /**
   * Invoked when libghostty processes an OSC 0 or OSC 2 escape that changes
   * the terminal title. The `title` string is a JS-owned copy — safe to
   * retain past the callback's return.
   *
   * Same constraints as onWritePty (no re-entry, no throw, no blocking).
   */
  onTitleChanged?: (title: string) => void;
}
```

- [ ] **Step 2: Verify `exactOptionalPropertyTypes` compatibility.**

The fields are typed `fn | undefined` (implicit via `?:`). The constructor reads them with `opts.onWritePty !== undefined` guards (Task 5 Step 3), which is compatible with `exactOptionalPropertyTypes`.

```bash
bun run typecheck
# Expected: clean.
```

- [ ] **Step 3: Verify the tarball-smoke test now captures the surface.**

```bash
bash scripts/run-tarball-smoke.sh
# Expected: existing smoke (import + use Terminal/Formatter) still passes.
# We do NOT extend tarball-smoke to exercise callbacks; that belongs in the
# unit smoke tests where we can inspect state. Tarball-smoke is only a
# "does it import" gate.
```

- [ ] **Step 4: Commit.**

```
feat(types): add onWritePty/onBell/onTitleChanged to TerminalOptions

Pass 2 Task 7 — restore the three effect-callback fields declared in
spec §4.1, with JSDoc stating the no-reentry / no-throw / no-blocking
constraints. These are the legitimate counterpart to the apcMaxBytes*
fields the Pass-1 fix Bob removed (which were never wired).
```

**Expected outcome of Task 7:** `src/types.ts` `TerminalOptions` grows by ~30 lines of JSDoc + fields. `bun run typecheck` clean. Tarball-smoke still passes.

---

## Task 8: Smoke test — `onBell`

**Purpose:** End-to-end verification that a BEL (0x07) fed to `vtWrite` invokes the `onBell` callback exactly once, synchronously.

**Files:**
- Create: `test/smoke/callbacks.test.ts`

- [ ] **Step 1: Write the bell test.**

Contents of `test/smoke/callbacks.test.ts` (first cut — Tasks 9, 10, 11 will append more tests to this file):

```typescript
// Pass 2 — end-to-end callback smoke tests. Each test exercises a real
// Terminal against the real libghostty-vt, verifying callback behavior
// matches the spec §4.1 contract.

import { describe, expect, it } from "bun:test";
import { Terminal } from "../../src/terminal";

describe("Terminal effect callbacks — onBell", () => {
  it("fires on BEL (0x07) during vtWrite", () => {
    let count = 0;
    using term = new Terminal({
      cols: 10, rows: 3,
      onBell: () => { count++; },
    });
    term.vtWrite(new Uint8Array([0x07]));
    expect(count).toBe(1);
  });

  it("fires once per BEL character in the stream", () => {
    let count = 0;
    using term = new Terminal({
      cols: 10, rows: 3,
      onBell: () => { count++; },
    });
    // Three BELs + interspersed printable chars — printable chars do not
    // trigger bell.
    term.vtWrite(new Uint8Array([0x07, 0x41, 0x07, 0x42, 0x07]));
    expect(count).toBe(3);
  });

  it("does not fire when onBell is not provided", () => {
    // Construct without onBell; driving a BEL must not crash, even though
    // libghostty has no effect registered. Verifies NULL-default behavior.
    using term = new Terminal({ cols: 10, rows: 3 });
    expect(() => term.vtWrite(new Uint8Array([0x07]))).not.toThrow();
  });

  it("is invoked synchronously — count reflects vtWrite completion", () => {
    let count = 0;
    using term = new Terminal({
      cols: 10, rows: 3,
      onBell: () => { count++; },
    });
    term.vtWrite(new Uint8Array([0x07]));
    // No setImmediate / microtask wait — the spec guarantees sync invocation.
    expect(count).toBe(1);
  });
});
```

- [ ] **Step 2: Run.**

```bash
bun test test/smoke/callbacks.test.ts
# Expected: 4 tests pass.
```

- [ ] **Step 3: Commit.**

```
test(callbacks): smoke tests for onBell

Pass 2 Task 8 — four tests covering BEL triggering, multi-BEL streams,
absent callback tolerance, and synchronous invocation ordering.
```

**Expected outcome of Task 8:** 4 new passing tests in `test/smoke/callbacks.test.ts`. Bell path is verified end-to-end.

---

## Task 9: Smoke test — `onTitleChanged` + probe title-timing open question

**Purpose:** Verify that OSC 0 / OSC 2 title-change sequences invoke the callback with the correct post-change title. Resolves Open Question #1: does `ghostty_terminal_get(TITLE)` inside the trampoline return the new title?

**Files:**
- Edit: `test/smoke/callbacks.test.ts`

- [ ] **Step 1: Append the title tests.**

Append to `test/smoke/callbacks.test.ts`:

```typescript
describe("Terminal effect callbacks — onTitleChanged", () => {
  // Helper: build an OSC 0 title-set escape sequence.
  //   ESC ] 0 ; <title> BEL
  const oscTitle = (title: string): Uint8Array => {
    const enc = new TextEncoder();
    const prefix = enc.encode("\x1b]0;");
    const body = enc.encode(title);
    const suffix = new Uint8Array([0x07]); // BEL terminator
    const out = new Uint8Array(prefix.length + body.length + suffix.length);
    out.set(prefix, 0);
    out.set(body, prefix.length);
    out.set(suffix, prefix.length + body.length);
    return out;
  };

  it("fires on OSC 0 title change with the new title", () => {
    const titles: string[] = [];
    using term = new Terminal({
      cols: 10, rows: 3,
      onTitleChanged: (t) => { titles.push(t); },
    });
    term.vtWrite(oscTitle("hello"));
    // Probes Open Question #1: the trampoline queries title via
    // ghostty_terminal_get(TITLE) inside the callback. If this test fails
    // with an empty string or the pre-change title, fall back to the deferred-
    // queue pattern documented in the plan header (Open Question #1).
    expect(titles).toEqual(["hello"]);
  });

  it("fires on OSC 2 title change", () => {
    const titles: string[] = [];
    using term = new Terminal({
      cols: 10, rows: 3,
      onTitleChanged: (t) => { titles.push(t); },
    });
    const enc = new TextEncoder();
    const prefix = enc.encode("\x1b]2;");
    const body = enc.encode("osc2-title");
    const suffix = new Uint8Array([0x07]);
    const seq = new Uint8Array(prefix.length + body.length + suffix.length);
    seq.set(prefix, 0);
    seq.set(body, prefix.length);
    seq.set(suffix, prefix.length + body.length);
    term.vtWrite(seq);
    expect(titles).toEqual(["osc2-title"]);
  });

  it("fires once per title change in a stream of multiple changes", () => {
    const titles: string[] = [];
    using term = new Terminal({
      cols: 10, rows: 3,
      onTitleChanged: (t) => { titles.push(t); },
    });
    // Three title changes in one vtWrite.
    const first = oscTitle("one");
    const second = oscTitle("two");
    const third = oscTitle("three");
    const combined = new Uint8Array(first.length + second.length + third.length);
    combined.set(first, 0);
    combined.set(second, first.length);
    combined.set(third, first.length + second.length);
    term.vtWrite(combined);
    expect(titles).toEqual(["one", "two", "three"]);
  });

  it("handles empty titles (OSC 0 ; BEL)", () => {
    const titles: string[] = [];
    using term = new Terminal({
      cols: 10, rows: 3,
      onTitleChanged: (t) => { titles.push(t); },
    });
    const empty = new Uint8Array([0x1b, 0x5d, 0x30, 0x3b, 0x07]); // ESC ] 0 ; BEL
    term.vtWrite(empty);
    // Either "" is delivered or no callback fires, depending on whether
    // libghostty considers an empty title as "changed". Accept either — the
    // point of this test is no-crash on pathological input.
    expect(titles.length === 0 || titles[0] === "").toBe(true);
  });

  it("handles Unicode titles (multi-byte UTF-8)", () => {
    const titles: string[] = [];
    using term = new Terminal({
      cols: 10, rows: 3,
      onTitleChanged: (t) => { titles.push(t); },
    });
    term.vtWrite(oscTitle("тайтл 🦀"));
    expect(titles).toEqual(["тайтл 🦀"]);
  });
});
```

- [ ] **Step 2: Run and observe.**

```bash
bun test test/smoke/callbacks.test.ts
# Expected: 4 of 5 new tests pass; the "empty title" test accepts either
# outcome. If "fires on OSC 0 ... with the new title" FAILS — titles array
# is empty, or contains "" instead of "hello" — Open Question #1 requires
# the fallback: queue events inside the trampoline and drain them at the end
# of vtWrite(). See Step 3 below.
```

- [ ] **Step 3: (conditional) If the synchronous title read returns stale, implement the queue fallback.**

Only execute this step if Step 2 fails with a stale title. Skip if tests pass.

Modify `src/internal/callbacks.ts` `makeTitleCallback` to accept an event queue, and modify `src/terminal.ts` to drain the queue at the end of `vtWrite`:

**Sketch only (not a finished snippet — implementer adapts to the observed failure mode):**

```typescript
// callbacks.ts — alternate signature if the default fails:
export function makeTitleCallback(
  userFn: (title: string) => void,
  pushEvent: () => void,   // schedules a deferred read+dispatch
): TrampolineResult { /* ... */ }

// terminal.ts — vtWrite drains after libghostty returns:
vtWrite(bytes: Uint8Array): void {
  // ... existing call ...
  lib.symbols.ghostty_terminal_vt_write(this.#handle, ptr(bytes), BigInt(bytes.length));
  while (this.#titleEventQueue.length > 0) {
    this.#titleEventQueue.shift();
    try { this.#titleUserFn(this.#readTitle()); }
    catch (e) { console.error("ts-libghostty-vt: onTitleChanged callback threw:", e); }
  }
}
```

Document the fallback in `CONFIRM_WITH_MATT.md` under "Pass 2 notes" with the observed behavior. Update the plan header's Open Question #1 to reflect the resolution.

- [ ] **Step 4: Commit.**

```
test(callbacks): smoke tests for onTitleChanged

Pass 2 Task 9 — five tests covering OSC 0, OSC 2, streams of title
changes, empty-title edge case, and Unicode titles. Resolves Open
Question #1: [synchronous query works | queue fallback implemented].
```

**Expected outcome of Task 9:** 5 new tests, all passing (4 assert specific titles; 1 is tolerant of libghostty's empty-title handling). Open Question #1 has a documented answer.

---

## Task 10: Smoke test — `onWritePty`

**Purpose:** End-to-end verification that a VT query sequence (e.g. DA1 — `CSI c`) causes libghostty to invoke `onWritePty` with the response bytes, and that those bytes are owned by the user (mutating them does not affect libghostty's next call).

**Files:**
- Edit: `test/smoke/callbacks.test.ts`

- [ ] **Step 1: Append the write_pty tests.**

Append to `test/smoke/callbacks.test.ts`:

```typescript
describe("Terminal effect callbacks — onWritePty", () => {
  it("fires with plausible bytes when DA1 (CSI c) is received", () => {
    const responses: Uint8Array[] = [];
    using term = new Terminal({
      cols: 10, rows: 3,
      onWritePty: (bytes) => { responses.push(bytes); },
    });
    // DA1 = CSI c = ESC [ c
    term.vtWrite(new Uint8Array([0x1b, 0x5b, 0x63]));
    expect(responses.length).toBeGreaterThan(0);
    // DA1 response starts with CSI: ESC [ (0x1b 0x5b). We don't assert the
    // exact reply bytes (those are upstream-specific) — only that the
    // callback fired with non-empty response bytes that look like a VT reply.
    const first = responses[0]!;
    expect(first.length).toBeGreaterThan(0);
    expect(first[0]).toBe(0x1b); // ESC
  });

  it("delivers a JS-owned Uint8Array — mutation does not affect libghostty", () => {
    const responses: Uint8Array[] = [];
    using term = new Terminal({
      cols: 10, rows: 3,
      onWritePty: (bytes) => { responses.push(bytes); },
    });
    term.vtWrite(new Uint8Array([0x1b, 0x5b, 0x63])); // DA1
    const r = responses[0]!;
    const original = new Uint8Array(r);
    // Mutate the received buffer — must not affect subsequent VT processing.
    r.fill(0xff);
    // Drive another DA1. The next response should look like the first
    // (libghostty's reply text for DA1 is stable), not be corrupted.
    term.vtWrite(new Uint8Array([0x1b, 0x5b, 0x63]));
    expect(responses.length).toBe(2);
    const r2 = responses[1]!;
    expect(r2[0]).toBe(0x1b);
    // The first response's stored copy (before mutation) should still match
    // the second — confirming the trampoline's copy-before-invoke.
    expect(Array.from(r2.slice(0, original.length))).toEqual(
      Array.from(original.slice(0, r2.length)),
    );
  });

  it("does not fire on plain printable input", () => {
    let count = 0;
    using term = new Terminal({
      cols: 10, rows: 3,
      onWritePty: () => { count++; },
    });
    term.vtWrite(new TextEncoder().encode("hello"));
    expect(count).toBe(0);
  });

  it("fires for DSR cursor-position query (CSI 6 n)", () => {
    const responses: Uint8Array[] = [];
    using term = new Terminal({
      cols: 10, rows: 3,
      onWritePty: (bytes) => { responses.push(bytes); },
    });
    // CSI 6 n — request cursor position; libghostty replies CSI row;col R.
    term.vtWrite(new Uint8Array([0x1b, 0x5b, 0x36, 0x6e]));
    expect(responses.length).toBeGreaterThan(0);
    const r = responses[0]!;
    expect(r[0]).toBe(0x1b);
    expect(r[1]).toBe(0x5b); // [
    // Response is CSI <row> ; <col> R, e.g. ESC [ 1 ; 1 R for top-left.
    expect(r[r.length - 1]).toBe(0x52); // 'R'
  });
});
```

- [ ] **Step 2: Run and verify.**

```bash
bun test test/smoke/callbacks.test.ts
# Expected: 4 new tests pass, plus the 9 existing ones. Total 13 passing
# tests in this file.
```

- [ ] **Step 3: Commit.**

```
test(callbacks): smoke tests for onWritePty

Pass 2 Task 10 — four tests covering DA1 response invocation, ownership
(mutating the received Uint8Array does not affect libghostty's next call),
non-triggering printable input, and DSR cursor-position reply.
```

**Expected outcome of Task 10:** 4 new tests, all passing. The copy-before-invoke guarantee from spec §5.4 is verified empirically.

---

## Task 11: Smoke tests — error paths

**Purpose:** Verify that throwing from a user callback is logged and swallowed (does not propagate, does not crash the process), and that calling methods after close() behaves per Pass 1's use-after-close contract.

**Files:**
- Edit: `test/smoke/callbacks.test.ts`

- [ ] **Step 1: Append error-path tests.**

Append to `test/smoke/callbacks.test.ts`:

```typescript
describe("Terminal effect callbacks — error paths", () => {
  it("swallows and logs user-callback throws (onBell)", () => {
    const errors: unknown[] = [];
    const originalErr = console.error;
    console.error = (...args: unknown[]) => { errors.push(args); };
    try {
      using term = new Terminal({
        cols: 10, rows: 3,
        onBell: () => { throw new Error("boom from bell"); },
      });
      // Must not throw despite user-callback throwing.
      expect(() => term.vtWrite(new Uint8Array([0x07]))).not.toThrow();
    } finally {
      console.error = originalErr;
    }
    expect(errors.length).toBe(1);
    const args = errors[0] as unknown[];
    expect(String(args[0])).toContain("onBell");
    expect((args[1] as Error).message).toBe("boom from bell");
  });

  it("swallows and logs user-callback throws (onWritePty)", () => {
    const errors: unknown[] = [];
    const originalErr = console.error;
    console.error = (...args: unknown[]) => { errors.push(args); };
    try {
      using term = new Terminal({
        cols: 10, rows: 3,
        onWritePty: () => { throw new Error("boom from write"); },
      });
      expect(() => term.vtWrite(new Uint8Array([0x1b, 0x5b, 0x63]))).not.toThrow();
    } finally {
      console.error = originalErr;
    }
    expect(errors.length).toBeGreaterThanOrEqual(1);
    const args = errors[0] as unknown[];
    expect(String(args[0])).toContain("onWritePty");
  });

  it("swallows and logs user-callback throws (onTitleChanged)", () => {
    const errors: unknown[] = [];
    const originalErr = console.error;
    console.error = (...args: unknown[]) => { errors.push(args); };
    try {
      using term = new Terminal({
        cols: 10, rows: 3,
        onTitleChanged: () => { throw new Error("boom from title"); },
      });
      const enc = new TextEncoder();
      const seq = new Uint8Array([
        ...enc.encode("\x1b]0;"),
        ...enc.encode("x"),
        0x07,
      ]);
      expect(() => term.vtWrite(seq)).not.toThrow();
    } finally {
      console.error = originalErr;
    }
    expect(errors.length).toBeGreaterThanOrEqual(1);
    const args = errors[0] as unknown[];
    expect(String(args[0])).toContain("onTitleChanged");
  });

  it("subsequent callbacks fire normally after one threw", () => {
    let throwOnce = true;
    let count = 0;
    const originalErr = console.error;
    console.error = () => {}; // silence for this test
    try {
      using term = new Terminal({
        cols: 10, rows: 3,
        onBell: () => {
          count++;
          if (throwOnce) { throwOnce = false; throw new Error("first-throw"); }
        },
      });
      term.vtWrite(new Uint8Array([0x07, 0x07, 0x07]));
      expect(count).toBe(3);
    } finally {
      console.error = originalErr;
    }
  });

  it("use-after-close still throws UseAfterCloseError on callback-bearing Terminal", () => {
    let bellCount = 0;
    const term = new Terminal({
      cols: 10, rows: 3,
      onBell: () => { bellCount++; },
    });
    term.close();
    expect(() => term.vtWrite(new Uint8Array([0x07]))).toThrow(/closed/i);
    expect(bellCount).toBe(0);
  });

  it("vtWrite runs even when no callbacks are registered (after close reattach wouldn't happen)", () => {
    // Regression guard against the scenario where the teardown path left a
    // dangling state flag that would block future Terminals in the same
    // process. Build a fresh one after closing the first.
    {
      using t1 = new Terminal({ cols: 10, rows: 3, onBell: () => {} });
      t1.vtWrite(new Uint8Array([0x07]));
    }
    let count = 0;
    using t2 = new Terminal({ cols: 10, rows: 3, onBell: () => { count++; } });
    t2.vtWrite(new Uint8Array([0x07]));
    expect(count).toBe(1);
  });
});
```

- [ ] **Step 2: Run and verify.**

```bash
bun test test/smoke/callbacks.test.ts
# Expected: 6 new tests pass, plus the prior 13. Total 19 passing tests.
```

- [ ] **Step 3: Commit.**

```
test(callbacks): smoke tests for error paths

Pass 2 Task 11 — six tests covering throw-swallow for all three effects,
throw-then-recover (subsequent callbacks still fire), use-after-close
semantics with callbacks registered, and cross-Terminal isolation.
```

**Expected outcome of Task 11:** 6 new tests, all passing. Full callback behavior contract is verified: fires when expected, swallows throws, tears down cleanly, isolates across instances.

---

## Task 12: Docs — README, CLAUDE.md, CONFIRM_WITH_MATT.md, index.ts

**Purpose:** Ship the user-facing surface and the maintainer notes. Without this task, Pass 2 is invisible from the outside.

**Files:**
- Edit: `README.md`
- Edit: `CLAUDE.md`
- Edit: `CONFIRM_WITH_MATT.md`
- Edit: `src/index.ts` (verify export — `TerminalOptions` should already re-export; we're not adding new top-level names)

- [ ] **Step 1: Add "Effect callbacks" section to `README.md`.**

Insert between the existing "Minimal example" and "Pass 1 surface" sections:

```markdown
## Effect callbacks

Pass 2 adds three synchronous effect callbacks as `Terminal` constructor
options. They are invoked inside `vtWrite()` when libghostty processes the
corresponding VT sequence.

```typescript
import { Terminal } from "ts-libghostty-vt";

using term = new Terminal({
  cols: 80,
  rows: 24,
  onWritePty: (bytes) => { /* query responses to send back to the pty */ },
  onBell: () => { /* BEL (0x07) */ },
  onTitleChanged: (title) => { /* OSC 0 / OSC 2 */ },
});
```

**Constraints** — violating any of these is undefined behavior:

- Callbacks MUST NOT re-enter `vtWrite()` on the same Terminal. libghostty
  is mid-parse; re-entry is undefined. Defer with `queueMicrotask` if you
  need to write back to this Terminal.
- Callbacks MUST NOT throw. Exceptions are caught at the FFI boundary and
  logged via `console.error`; they cannot cross the C frame.
- Callbacks SHOULD NOT block. The call is synchronous inside `vtWrite()`.

**Data ownership** — values handed to your callback are JS-owned copies:

- `onWritePty`: the `bytes` Uint8Array is a fresh copy of libghostty's
  borrowed buffer. Safe to retain.
- `onTitleChanged`: the `title` string is a JS string. Safe to retain.

The other five effect-shaped callbacks exposed by the C API (`ENQUIRY`,
`XTVERSION`, `SIZE`, `COLOR_SCHEME`, `DEVICE_ATTRIBUTES`) are query-response
shapes that return data into libghostty's allocator — deferred until the
allocator-callback pattern is established. See the spec's §11 Tranche 2.
```

Also update the "Pass 1 surface" heading to "API surface (Pass 1 + 2)" and add a bullet under `Terminal`:

```markdown
- `Terminal` — construction, `vtWrite`, `resize`, `reset`, `snapshot`,
  `mode`/`setMode`, lifecycle (`close`, `using`), **effect callbacks
  (`onWritePty`, `onBell`, `onTitleChanged`)**.
```

- [ ] **Step 2: Add a CLAUDE.md gotcha for callback semantics.**

Append to `CLAUDE.md`'s "Load-bearing gotchas" section as item 10:

```markdown
10. **Effect-callback trampolines copy before invoking.** `onWritePty`'s
    `Uint8Array` and `onTitleChanged`'s `title` are JS-owned copies of
    libghostty's borrowed memory — mutating them does not affect
    libghostty. If you change the trampolines in `src/internal/callbacks.ts`,
    preserve the copy-before-invoke; breaking it creates use-after-free bugs
    in consumer code that retains the values.
```

- [ ] **Step 3: Add a Pass 2 shipping block to `CONFIRM_WITH_MATT.md`.**

Insert at the top (after the "Pass 1 is done" block), a new heading:

```markdown
## ✅ Pass 2 is done

Effect callbacks landed — `onWritePty`, `onBell`, `onTitleChanged`. 12 tasks,
~[N] tests, full clean rebuild from bare state verified. `v0.2.0` candidate
tag — NOT pushed until you review.

**End-to-end verified:**
- BEL → `onBell` fires once per character.
- OSC 0 / OSC 2 → `onTitleChanged` fires with the post-change title (Open
  Question #1 resolved: synchronous query works).
- DA1 (CSI c) → `onWritePty` fires with CSI-prefixed reply bytes; the
  received Uint8Array is JS-owned.

**Scope:** three fire-and-forget effects per spec §4.1. Query-response
effects (ENQUIRY, XTVERSION, SIZE, COLOR_SCHEME, DEVICE_ATTRIBUTES) remain
deferred to Tranche 2 (allocator-callback pattern).

### Pass 2 commit timeline

Highlights (full log via `git log v0.1.0..v0.2.0-candidate`):

- (Task 2 commit) — probe JSCallback + ghostty_terminal_set compat
- (Task 3 commit) — extend SYMBOLS with ghostty_terminal_set + _get
- (Task 4 commit) — src/internal/callbacks.ts trampoline factories
- (Task 5 commit) — Terminal.constructor wires callbacks
- (Task 6 commit) — Terminal.close() callback teardown
- (Task 7 commit) — TerminalOptions fields
- (Tasks 8–11 commits) — smoke tests
- (Task 12 commit) — docs

### Before publish — your todo (Pass 2)

1. Push `v0.2.0` tag: `git push origin v0.2.0`. CI runs; verify green.
2. Publish: `bun publish` or `npm publish` from clean tree.
```

- [ ] **Step 4: Verify index.ts exports still match public surface.**

```bash
grep -n "Terminal\|TerminalOptions\|TerminalSnapshot" src/index.ts
# Expected: TerminalOptions is already re-exported (since Pass 1). Adding
# callback fields to the interface does not require any change to index.ts.
```

If `TerminalOptions` is not re-exported, add it:

```typescript
// src/index.ts — near the Terminal / Formatter re-exports:
export type { TerminalOptions, TerminalSnapshot, FormatterOptions, ModeName } from "./types";
```

- [ ] **Step 5: Run the full gate.**

```bash
bun run typecheck
# Expected: clean.

bun test test/smoke
# Expected: all prior + all Pass 2 tests green.

bash scripts/run-tarball-smoke.sh
# Expected: pack + install + import + use — green.

bun run verify:generated
# Expected: green.
```

- [ ] **Step 6: Commit + tag + update `package.json` version.**

```bash
# Bump package version.
# Use bun's package.json manipulation or jq (choose your hazard):
#   jq '.version = "0.2.0"' package.json > .tmp/pj && mv .tmp/pj package.json
# Preserve formatting of the existing file — prefer a focused Edit over a
# full rewrite.
```

Commit:

```
docs: Pass 2 — effect callbacks shipping

Pass 2 Task 12 — README effect-callbacks section, CLAUDE.md gotcha 10
(copy-before-invoke trampolines), CONFIRM_WITH_MATT.md Pass-2-done
block with commit timeline and publish TODO. Version bumped to 0.2.0.
```

Tag:

```bash
git tag -a v0.2.0 -m "ts-libghostty-vt Pass 2 — effect callbacks

onWritePty / onBell / onTitleChanged (spec §4.1).
Query-response effects remain deferred to Tranche 2."
```

Do NOT push the tag — Matt reviews, Matt pushes.

**Expected outcome of Task 12:** README + CLAUDE.md + CONFIRM_WITH_MATT.md updated; `v0.2.0` candidate tag local; full gate green. Pass 2 is shippable pending Matt's push + publish.

---

## Self-review TODOs before the Codex loop

Before sending this plan for external review, the author (current: Murderbot) will:

1. Re-read the spec §5.4 paragraph-for-paragraph against each task's snippet, confirming no claim is made that the spec doesn't authorize.
2. Verify every cited line number in the header and ABI doc still resolves after any Pass-1-fix commits that land before review.
3. Double-check Bun's `JSCallback` docs for any version-specific quirks relative to the pinned `bun >= 1.3.13` (especially: `u64` arg arriving as bigint vs number; `Pointer | null` handling for detach).
4. Walk the teardown sequence on paper with a sample trace (user callback throws during the registration loop → what happens?) and patch the error-path snippets if any leak is found.
5. Audit every `expect(first[0]).toBe(0x1b)` style test for platform/version fragility — libghostty's exact reply bytes for DA1/DSR may shift across pins; the assertions should check structure (CSI prefix + terminator), not full byte sequences.
6. Sanity-check that `ghostty_terminal_set` is called with the correct value kind for callbacks (function pointer directly, not pointer-to-function-pointer). The ABI doc's §4 table shows `size_t*` for APC options and `GhosttyString*` for TITLE/PWD — the pattern for callbacks is **function pointer directly**, and only the probe script in Task 2 currently verifies this. Make sure the Task 5 snippet reads `jsCallback.ptr`, not `ptr(new BigUint64Array([...]))`.

Once Codex review is done and reconciled, this plan gets the same "twice-reviewed" badge Pass 1 earned.
