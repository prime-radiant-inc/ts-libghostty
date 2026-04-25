import type { Key, KeyEvent, Mods } from "libghostty-vt";

const shiftedDigits: Record<string, string> = {
  Digit1: "!",
  Digit2: "@",
  Digit3: "#",
  Digit4: "$",
  Digit5: "%",
  Digit6: "^",
  Digit7: "&",
  Digit8: "*",
  Digit9: "(",
  Digit0: ")",
};

const punctuation: Record<string, [normal: string, shifted: string]> = {
  Minus: ["-", "_"],
  Equal: ["=", "+"],
  BracketLeft: ["[", "{"],
  BracketRight: ["]", "}"],
  Backslash: ["\\", "|"],
  Semicolon: [";", ":"],
  Quote: ["'", "\""],
  Backquote: ["`", "~"],
  Comma: [",", "<"],
  Period: [".", ">"],
  Slash: ["/", "?"],
};

export function eventFromUsLayout(key: Key, mods?: Mods): KeyEvent {
  const shift = mods?.shift === true;
  const base: KeyEvent = { key, ...(mods !== undefined ? { mods } : {}) };
  if (/^Key[A-Z]$/.test(key)) {
    const lower = key.slice(3).toLowerCase();
    return {
      ...base,
      utf8: shift ? lower.toUpperCase() : lower,
      unshiftedCodepoint: lower.codePointAt(0)!,
    };
  }
  if (/^Digit[0-9]$/.test(key)) {
    const digit = key.slice(5);
    return {
      ...base,
      utf8: shift ? shiftedDigits[key]! : digit,
      unshiftedCodepoint: digit.codePointAt(0)!,
    };
  }
  if (key === "Space") {
    return { ...base, utf8: " ", unshiftedCodepoint: 0x20 };
  }
  const punct = punctuation[key];
  if (punct !== undefined) {
    return {
      ...base,
      utf8: shift ? punct[1] : punct[0],
      unshiftedCodepoint: punct[0].codePointAt(0)!,
    };
  }
  return base;
}
