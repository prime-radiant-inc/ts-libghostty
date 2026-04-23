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

describe("Terminal.vtWrite", () => {
  it("accepts a Uint8Array and returns void", () => {
    using term = new Terminal({ cols: 80, rows: 24 });
    // "hello\r\n" — plain ASCII, should not throw
    const bytes = new TextEncoder().encode("hello\r\n");
    expect(term.vtWrite(bytes)).toBeUndefined();
  });

  it("accepts an empty Uint8Array", () => {
    using term = new Terminal({ cols: 80, rows: 24 });
    term.vtWrite(new Uint8Array(0));
  });

  it("accepts a long byte stream (1 MiB)", () => {
    using term = new Terminal({ cols: 80, rows: 24 });
    const big = new Uint8Array(1 << 20);
    big.fill(0x41);  // 'A'
    term.vtWrite(big);
  });

  it("throws UseAfterCloseError if called after close", () => {
    const term = new Terminal({ cols: 80, rows: 24 });
    term.close();
    expect(() => term.vtWrite(new Uint8Array([65]))).toThrow(UseAfterCloseError);
  });
});

describe("Terminal.resize", () => {
  it("accepts new cols/rows and returns void", () => {
    using term = new Terminal({ cols: 80, rows: 24 });
    term.resize(100, 30);
  });

  it("rejects zero or negative dimensions", () => {
    using term = new Terminal({ cols: 80, rows: 24 });
    expect(() => term.resize(0, 30)).toThrow();
    expect(() => term.resize(100, -1)).toThrow();
  });
});

describe("Terminal.reset", () => {
  it("returns void", () => {
    using term = new Terminal({ cols: 80, rows: 24 });
    term.vtWrite(new TextEncoder().encode("hello\r\n"));
    term.reset();
  });
});
