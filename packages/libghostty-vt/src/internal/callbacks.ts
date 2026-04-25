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
      // Wrap the entire non-empty branch, not just the user call. toArrayBuffer,
      // allocation, and set() can all throw (bad len, OOM) — letting any of
      // those escape the JSCallback frame aborts the Bun process.
      try {
        if (data === null || lenN === 0) {
          userFn(new Uint8Array(0));
          return;
        }
        // Copy the borrowed buffer immediately. toArrayBuffer aliases the C
        // memory; we .set() it into a fresh JS-owned Uint8Array so the user
        // receives a stable, retainable reference even if the C buffer is
        // reused for the next call.
        const borrowed = new Uint8Array(toArrayBuffer(data, 0, lenN));
        const owned = new Uint8Array(lenN);
        owned.set(borrowed);
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
 * returns" is ambiguous; Task 2's probe confirmed the synchronous read works.
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
