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
  #boundTerminal: Terminal | null = null;
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

    if (this.#boundTerminal !== null) {
      // setopt_from_terminal is void per the C header — no rc to check.
      lib.symbols.ghostty_key_encoder_setopt_from_terminal(
        this.#handle!, this.#boundTerminal._handle,
      );
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
      // Retry once with that size.
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

  syncFromTerminal(terminal: Terminal): void {
    this.#assertOpen();
    // setopt_from_terminal is void per the C header — no rc to check.
    getLib().symbols.ghostty_key_encoder_setopt_from_terminal(
      this.#handle!, terminal._handle,
    );
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
