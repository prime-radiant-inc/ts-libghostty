import { expect, test } from "bun:test";
import { eventFromUsLayout } from "../../src/internal/us-layout";

test("letters map to utf8 and unshifted codepoint", () => {
  expect(eventFromUsLayout("KeyA")).toEqual({
    key: "KeyA",
    utf8: "a",
    unshiftedCodepoint: 0x61,
  });
  expect(eventFromUsLayout("KeyA", { shift: true })).toEqual({
    key: "KeyA",
    mods: { shift: true },
    utf8: "A",
    unshiftedCodepoint: 0x61,
  });
});

test("non-printable keys omit utf8", () => {
  expect(eventFromUsLayout("ArrowUp")).toEqual({ key: "ArrowUp" });
});
