import { ptr, type Pointer } from "bun:ffi";
import { getLib } from "./ffi";
import { GhosttyError, EncodeError, UseAfterCloseError, getResultCodeName } from "./errors";
import { GhosttyKeyActionValues, GhosttyKeyEncoderOptionValues } from "./internal/generated";
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
      this.#applyOptions(opts.options);
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

    // Validate key + action BEFORE the FFI call. Without this, a JS caller
    // passing an unknown Key string (e.g. event.key === "Nope") would have
    // keyToGhosttyId[event.key] === undefined; bun:ffi forwards undefined
    // through ghostty_key_event_set_key as an arbitrary integer (typically
    // 0/UNIDENTIFIED) and the encoder silently emits an empty byte stream.
    // Surfacing the typo at the boundary as a typed error is the contract
    // we want for the public API surface.
    const keyId = keyToGhosttyId[event.key];
    if (keyId === undefined) {
      throw new EncodeError(
        `KeyEvent.key is not a known Key: received ${JSON.stringify(event.key)}. ` +
        `Expected a W3C UI Events code string (e.g. "KeyA", "ArrowUp", "F1", "Enter").`,
        { code: "invalid_value" },
      );
    }
    const actionName = event.action ?? "press";
    const actionId = ACTION_BY_NAME[actionName];
    if (actionId === undefined) {
      throw new EncodeError(
        `KeyEvent.action is not valid: received ${JSON.stringify(event.action)}. ` +
        `Expected one of "press", "release", "repeat".`,
        { code: "invalid_value" },
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

    // utf8Bytes is hoisted out of the per-block scope so its underlying
    // memory stays referenced for the lifetime of the C event. The C side
    // (ghostty_key_event_set_utf8) stores a borrowed pointer, not a copy
    // — if we let bytes go out of scope before encode() runs, Bun's GC
    // could collect it and the C event would point at freed memory.
    // The utf8Bytes binding is released when this try-block exits and the
    // event is freed in the finally below.
    let utf8Bytes: Uint8Array | undefined;

    try {
      lib.symbols.ghostty_key_event_set_action(ev, actionId);
      lib.symbols.ghostty_key_event_set_key(ev, keyId);
      lib.symbols.ghostty_key_event_set_mods(ev, packMods(event.mods));
      lib.symbols.ghostty_key_event_set_consumed_mods(ev, packMods(event.consumedMods));
      lib.symbols.ghostty_key_event_set_composing(ev, event.composing ?? false);
      if (event.unshiftedCodepoint !== undefined) {
        lib.symbols.ghostty_key_event_set_unshifted_codepoint(ev, event.unshiftedCodepoint);
      }
      if (event.utf8 !== undefined && event.utf8.length > 0) {
        utf8Bytes = new TextEncoder().encode(event.utf8);
        lib.symbols.ghostty_key_event_set_utf8(ev, ptr(utf8Bytes), BigInt(utf8Bytes.length));
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
      // utf8Bytes can now be dropped — libghostty has no further reference
      // to it after the event is freed. Reassign to undefined to make the
      // intent obvious to readers (and to encourage the JS engine to drop
      // the reference from this stack frame promptly).
      utf8Bytes = undefined;
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
    if (o.cursorKeyMode !== undefined)           setBool(O.GHOSTTY_KEY_ENCODER_OPT_CURSOR_KEY_APPLICATION,    o.cursorKeyMode === "application");
    if (o.keypadKeyMode !== undefined)           setBool(O.GHOSTTY_KEY_ENCODER_OPT_KEYPAD_KEY_APPLICATION,    o.keypadKeyMode === "application");
    if (o.ignoreKeypadWithNumLock !== undefined) setBool(O.GHOSTTY_KEY_ENCODER_OPT_IGNORE_KEYPAD_WITH_NUMLOCK, o.ignoreKeypadWithNumLock);
    if (o.altEscPrefix !== undefined)            setBool(O.GHOSTTY_KEY_ENCODER_OPT_ALT_ESC_PREFIX,            o.altEscPrefix);
    if (o.modifyOtherKeysState2 !== undefined)   setBool(O.GHOSTTY_KEY_ENCODER_OPT_MODIFY_OTHER_KEYS_STATE_2, o.modifyOtherKeysState2);
    if (o.kittyFlags !== undefined)              setU8(O.GHOSTTY_KEY_ENCODER_OPT_KITTY_FLAGS,                 o.kittyFlags);
    if (o.macosOptionAsAlt !== undefined)        setEnumI32(O.GHOSTTY_KEY_ENCODER_OPT_MACOS_OPTION_AS_ALT,    OPTION_AS_ALT_VALUES[o.macosOptionAsAlt]);
    if (o.backarrowKeyMode !== undefined)        setBool(O.GHOSTTY_KEY_ENCODER_OPT_BACKARROW_KEY_MODE,        o.backarrowKeyMode);
  }

  #assertOpen(): void {
    if (this.#handle === null) {
      throw new UseAfterCloseError("KeyEncoder has been closed", { handleType: "KeyEncoder" });
    }
  }
}
