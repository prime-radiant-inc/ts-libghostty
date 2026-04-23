import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Terminal } from "../../src/terminal";
import { UseAfterCloseError } from "../../src/errors";
import * as ffi from "../../src/ffi";

describe("Terminal lifecycle", () => {
  beforeEach(() => {
    // No need to reset ffi — load is shared across tests in the same process.
  });

  it("constructs with required options", () => {
    using term = new Terminal({ cols: 80, rows: 24 });
    expect(term).toBeDefined();
  });

  it("close() is idempotent", () => {
    const term = new Terminal({ cols: 80, rows: 24 });
    term.close();
    term.close();   // must not throw
  });

  it("Symbol.dispose closes", () => {
    let terminal: Terminal;
    {
      using term = new Terminal({ cols: 80, rows: 24 });
      terminal = term;
    }
    // After the `using` block, the handle is closed. Using it throws.
    expect(() => terminal.vtWrite(new Uint8Array([65]))).toThrow(UseAfterCloseError);
  });

  it("throws UseAfterCloseError on any method after close()", () => {
    const term = new Terminal({ cols: 80, rows: 24 });
    term.close();
    expect(() => term.vtWrite(new Uint8Array([65]))).toThrow(UseAfterCloseError);
    expect(() => term.snapshot()).toThrow(UseAfterCloseError);
    expect(() => term.resize(100, 30)).toThrow(UseAfterCloseError);
    expect(() => term.reset()).toThrow(UseAfterCloseError);
    expect(() => term.mode("bracketed_paste")).toThrow(UseAfterCloseError);
    expect(() => term.setMode("bracketed_paste", true)).toThrow(UseAfterCloseError);
  });

  it("constructor validates cols/rows > 0", () => {
    expect(() => new Terminal({ cols: 0, rows: 24 })).toThrow();
    expect(() => new Terminal({ cols: 80, rows: 0 })).toThrow();
    expect(() => new Terminal({ cols: -1, rows: 24 })).toThrow();
  });
});
