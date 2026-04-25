// Pass 2 Task 2 probe — validates bun:ffi JSCallback + ghostty_terminal_set
// compatibility against the pinned libghostty-vt. Run manually:
//
//   bun run scripts/probe-callbacks.ts
//
// Probes (structured tagged output, parseable by the Task 2 Step 2 gate):
//   (a)  JSCallback.ptr passes to ghostty_terminal_set for each of the three
//        Pass 2 options (WRITE_PTY, BELL, TITLE_CHANGED) without error return.
//   (b)  ghostty_terminal_set(handle, OPT, null) detaches each without error.
//   (c)  A minimal vt_write triggers each callback synchronously.
//   (d)  The `terminal` arg passed by libghostty to the callback equals the
//        handle we stored from ghostty_terminal_new — so JS closures can rely
//        on identity, and userdata can stay NULL.
//   (e)  A DA1 (CSI c) query triggers WRITE_PTY with CSI-prefixed reply bytes.
//   (f)  An OSC 0 title change triggers TITLE_CHANGED; a snapshot()-equivalent
//        ghostty_terminal_get(TITLE) from INSIDE the trampoline reveals
//        whether the post-change title is synchronously readable
//        (Open Question #1 resolution). This result directs Task 9's Step 3.
//   (g)  Teardown order (set NULL → jscallback.close → terminal_free) does
//        not crash for any registered subset.
//
// Exits 0 on success. On any failure, prints a tagged error line and exits 1.

import { dlopen, FFIType, JSCallback, ptr, toArrayBuffer, type Pointer } from "bun:ffi";
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
  ghostty_terminal_get: {
    args: [FFIType.ptr, FFIType.i32, FFIType.ptr],
    returns: FFIType.i32,
  },
  ghostty_terminal_vt_write: {
    args: [FFIType.ptr, FFIType.ptr, FFIType.u64],
    returns: FFIType.void,
  },
});

const OPT_WRITE_PTY     = 1;
const OPT_BELL          = 2;
const OPT_TITLE_CHANGED = 5;
const DATA_TITLE        = 12;

function failIf(cond: boolean, tag: string, detail: string): void {
  if (!cond) return;
  console.error(`tag=${tag} FAIL ${detail}`);
  process.exit(1);
}

// Build a 10x3 Terminal options struct (cols=10, rows=3, max_scrollback=100).
const opts = new Uint8Array(16);
new DataView(opts.buffer).setUint16(0, 10, true);
new DataView(opts.buffer).setUint16(2, 3, true);
new DataView(opts.buffer).setBigUint64(8, 100n, true);
const u64s = new BigUint64Array(opts.buffer, 0, 2);
const outSlot = new BigUint64Array(1);

const newResult = lib.symbols.ghostty_terminal_new(null, ptr(outSlot), u64s[0]!, u64s[1]!);
console.log("tag=terminal_new result=", newResult);
failIf(newResult !== 0, "terminal_new", `result=${newResult}`);
const handle = Number(outSlot[0]!) as Pointer;
const handleBig = outSlot[0]!;
console.log("tag=handle ok=", handle !== 0, "value=", handle);

// ---- Register all three callbacks; track observed terminal-handle args ----

let bellCount = 0;
let titleCount = 0;
let writePtyCount = 0;
const observedTerminalArgs: bigint[] = [];
let lastWritePtyBytes: Uint8Array | null = null;
let titleReadDuringCallback: string = "<not-read>";

const bellCb = new JSCallback(
  (term: Pointer | null, _userdata: Pointer | null) => {
    bellCount++;
    if (term !== null) observedTerminalArgs.push(BigInt(term));
  },
  { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.void },
);

const titleCb = new JSCallback(
  (term: Pointer | null, _userdata: Pointer | null) => {
    titleCount++;
    if (term !== null) observedTerminalArgs.push(BigInt(term));
    // Open Question #1 probe: read TITLE from inside the trampoline.
    const slot = new ArrayBuffer(16);
    const r = lib.symbols.ghostty_terminal_get(term, DATA_TITLE, ptr(new Uint8Array(slot)));
    if (r === 0) {
      const view = new DataView(slot);
      const p = Number(view.getBigUint64(0, true));
      const l = Number(view.getBigUint64(8, true));
      if (p !== 0 && l !== 0) {
        const bytes = new Uint8Array(toArrayBuffer(p as unknown as Pointer, 0, l));
        const copy = new Uint8Array(l);
        copy.set(bytes);
        titleReadDuringCallback = new TextDecoder("utf-8").decode(copy);
      } else {
        titleReadDuringCallback = "";
      }
    } else {
      titleReadDuringCallback = `<err=${r}>`;
    }
  },
  { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.void },
);

const writePtyCb = new JSCallback(
  (term: Pointer | null, _userdata: Pointer | null, data: Pointer | null, len: bigint | number) => {
    writePtyCount++;
    if (term !== null) observedTerminalArgs.push(BigInt(term));
    const lenN = typeof len === "bigint" ? Number(len) : len;
    if (data !== null && lenN > 0) {
      const borrowed = new Uint8Array(toArrayBuffer(data, 0, lenN));
      const owned = new Uint8Array(lenN);
      owned.set(borrowed);
      lastWritePtyBytes = owned;
    }
  },
  { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u64], returns: FFIType.void },
);

const setBell = lib.symbols.ghostty_terminal_set(handle, OPT_BELL, bellCb.ptr);
console.log("tag=set_bell result=", setBell);
failIf(setBell !== 0, "set_bell", `result=${setBell}`);

const setTitle = lib.symbols.ghostty_terminal_set(handle, OPT_TITLE_CHANGED, titleCb.ptr);
console.log("tag=set_title result=", setTitle);
failIf(setTitle !== 0, "set_title", `result=${setTitle}`);

const setWritePty = lib.symbols.ghostty_terminal_set(handle, OPT_WRITE_PTY, writePtyCb.ptr);
console.log("tag=set_write_pty result=", setWritePty);
failIf(setWritePty !== 0, "set_write_pty", `result=${setWritePty}`);

// ---- (c) BEL triggers bell synchronously ---------------------------------

lib.symbols.ghostty_terminal_vt_write(handle, ptr(new Uint8Array([0x07])), 1n);
console.log("tag=bell_fire count=", bellCount);
failIf(bellCount !== 1, "bell_fire", `expected 1, got ${bellCount}`);

// ---- (e) DA1 triggers write_pty with CSI-prefixed reply ------------------

lib.symbols.ghostty_terminal_vt_write(handle, ptr(new Uint8Array([0x1b, 0x5b, 0x63])), 3n);
console.log("tag=write_pty_fire count=", writePtyCount);
failIf(writePtyCount < 1, "write_pty_fire", `expected ≥1, got ${writePtyCount}`);
failIf(lastWritePtyBytes === null, "write_pty_bytes", "null bytes");
failIf(lastWritePtyBytes !== null && lastWritePtyBytes[0] !== 0x1b, "write_pty_bytes",
       `expected 0x1b prefix, got ${lastWritePtyBytes?.[0]}`);

// ---- (f) OSC 0 title change triggers title_changed + Open Question #1 ---

const enc = new TextEncoder();
const titleSeq = new Uint8Array([
  ...enc.encode("\x1b]0;probe-title"),
  0x07,
]);
lib.symbols.ghostty_terminal_vt_write(handle, ptr(titleSeq), BigInt(titleSeq.length));
console.log("tag=title_fire count=", titleCount);
failIf(titleCount < 1, "title_fire", `expected ≥1, got ${titleCount}`);
console.log("tag=title_read_during_callback value=", JSON.stringify(titleReadDuringCallback));
// This is the key Open Question #1 result. "probe-title" = default path
// works (Task 9 Step 3 is a no-op). "" or "<not-read>" or an older value =
// the default is broken; Task 9 Step 3 instructs HALT AND ESCALATE.

// ---- (d) terminal arg identity ------------------------------------------

const allMatch = observedTerminalArgs.every((t) => t === handleBig);
console.log("tag=terminal_arg_identity all_match=", allMatch, "observed=", observedTerminalArgs.length);
failIf(!allMatch, "terminal_arg_identity",
       `expected all args=${handleBig}, got ${observedTerminalArgs.map(String).join(",")}`);

// ---- (b) Detach all three with NULL -------------------------------------

const detachBell = lib.symbols.ghostty_terminal_set(handle, OPT_BELL, null);
console.log("tag=detach_bell result=", detachBell);
failIf(detachBell !== 0, "detach_bell", `result=${detachBell}`);

const detachTitle = lib.symbols.ghostty_terminal_set(handle, OPT_TITLE_CHANGED, null);
console.log("tag=detach_title result=", detachTitle);
failIf(detachTitle !== 0, "detach_title", `result=${detachTitle}`);

const detachWritePty = lib.symbols.ghostty_terminal_set(handle, OPT_WRITE_PTY, null);
console.log("tag=detach_write_pty result=", detachWritePty);
failIf(detachWritePty !== 0, "detach_write_pty", `result=${detachWritePty}`);

// Post-detach: another BEL must not increment the bell count.
lib.symbols.ghostty_terminal_vt_write(handle, ptr(new Uint8Array([0x07])), 1n);
console.log("tag=bell_after_detach count=", bellCount);
failIf(bellCount !== 1, "bell_after_detach", `expected 1, got ${bellCount}`);

// ---- (g) Teardown ------------------------------------------------------

bellCb.close();
titleCb.close();
writePtyCb.close();
console.log("tag=jscallbacks_close ok=true");
lib.symbols.ghostty_terminal_free(handle);
console.log("tag=terminal_free ok=true");

console.log("tag=probe result=ok");
