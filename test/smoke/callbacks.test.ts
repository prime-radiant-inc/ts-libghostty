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
    term.vtWrite(new Uint8Array([0x07, 0x41, 0x07, 0x42, 0x07]));
    expect(count).toBe(3);
  });

  it("does not fire when onBell is not provided", () => {
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
    expect(count).toBe(1);
  });
});
