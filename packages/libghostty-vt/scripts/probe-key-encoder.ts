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
