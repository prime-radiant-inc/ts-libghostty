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
