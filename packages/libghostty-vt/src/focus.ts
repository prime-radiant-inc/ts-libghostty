import { ptr } from "bun:ffi";
import { getLib } from "./ffi";
import { GhosttyError, getResultCodeName } from "./errors";

/**
 * Encode a terminal focus in/out event into the bytes an application
 * sends to a terminal. Standalone — no Terminal instance required.
 *
 * Returns a fresh Uint8Array each call; safe to retain.
 */
export function encodeFocus(direction: "in" | "out"): Uint8Array {
  let event: 0 | 1;
  if (direction === "in") event = 0;
  else if (direction === "out") event = 1;
  else {
    throw new GhosttyError(
      `encodeFocus: invalid direction — expected "in" | "out"; received ${JSON.stringify(direction)}`,
      { code: "invalid_value", functionName: "encodeFocus" },
    );
  }

  const lib = getLib();

  // Probe required length: buf=NULL, buf_len=0, out_written=&required.
  const requiredBuf = new BigUint64Array(1);
  const rcProbe = lib.symbols.ghostty_focus_encode(event, null, 0n, ptr(requiredBuf));
  // ghostty_focus_encode returns OUT_OF_SPACE (or equivalent) when buf is too
  // small. Either OK or OUT_OF_SPACE is acceptable — the required length is
  // written either way.
  const probeName = getResultCodeName(rcProbe as number);
  if (rcProbe !== 0 && probeName !== "out_of_space") {
    throw new GhosttyError(
      `ghostty_focus_encode (probe) returned "${probeName}"`,
      { code: probeName as GhosttyError["code"], functionName: "ghostty_focus_encode (probe)" },
    );
  }
  const required = Number(requiredBuf[0]);
  if (required === 0) {
    throw new GhosttyError(
      "ghostty_focus_encode: probe returned zero required length",
      { code: "invalid_value", functionName: "ghostty_focus_encode" },
    );
  }

  const buf = new Uint8Array(required);
  const writtenBuf = new BigUint64Array(1);
  const rc = lib.symbols.ghostty_focus_encode(
    event,
    ptr(buf),
    BigInt(buf.byteLength),
    ptr(writtenBuf),
  );
  if (rc !== 0) {
    const name = getResultCodeName(rc as number);
    throw new GhosttyError(
      `ghostty_focus_encode returned "${name}"`,
      { code: name as GhosttyError["code"], functionName: "ghostty_focus_encode" },
    );
  }
  const written = Number(writtenBuf[0]);
  // Return a fresh copy so callers can retain independently.
  return buf.slice(0, written);
}
