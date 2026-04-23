import { describe, expect, it } from "bun:test";
import { Terminal } from "../../src/terminal";
import { Formatter } from "../../src/formatter";
import { UseAfterCloseError } from "../../src/errors";

describe("Formatter lifecycle", () => {
  it("constructs with format: 'plain'", () => {
    using fmt = new Formatter({ format: "plain" });
    expect(fmt).toBeDefined();
  });

  it("constructs with format: 'vt' and 'html'", () => {
    using a = new Formatter({ format: "vt" });
    using b = new Formatter({ format: "html" });
  });

  it("close() is idempotent", () => {
    const f = new Formatter({ format: "plain" });
    f.close();
    f.close();
  });

  it("throws UseAfterCloseError after close", () => {
    using term = new Terminal({ cols: 10, rows: 3 });
    const f = new Formatter({ format: "plain" });
    f.close();
    expect(() => f.format(term)).toThrow(UseAfterCloseError);
    expect(() => f.formatString(term)).toThrow(UseAfterCloseError);
  });
});

describe("Formatter.format / formatString", () => {
  it("formats an empty terminal deterministically (plain trims trailing blanks to empty string)", () => {
    // The plain formatter strips trailing whitespace, so a freshly-constructed
    // empty terminal round-trips to an empty string. This is the observed
    // behavior at the pinned Ghostty commit; ABI §6 describes the output
    // shape. We pin it here so any future output-rule change is caught.
    using term = new Terminal({ cols: 10, rows: 3 });
    using fmt = new Formatter({ format: "plain" });
    const s = fmt.formatString(term);
    expect(typeof s).toBe("string");
    expect(s).toBe("");
  });

  it("formats embedded blanks between printed runs", () => {
    // Writing "a b" keeps the interior blank after trimming trailing blanks.
    using term = new Terminal({ cols: 10, rows: 3 });
    term.vtWrite(new TextEncoder().encode("a b"));
    using fmt = new Formatter({ format: "plain" });
    const s = fmt.formatString(term);
    expect(s).toContain(" ");
    expect(s).toContain("a");
    expect(s).toContain("b");
  });

  it("formats 'hello' after writing bytes", () => {
    using term = new Terminal({ cols: 10, rows: 3 });
    term.vtWrite(new TextEncoder().encode("hello"));
    using fmt = new Formatter({ format: "plain" });
    const s = fmt.formatString(term);
    expect(s).toContain("hello");
  });

  it("format() returns a Uint8Array", () => {
    using term = new Terminal({ cols: 10, rows: 3 });
    term.vtWrite(new TextEncoder().encode("hello"));
    using fmt = new Formatter({ format: "plain" });
    const bytes = fmt.format(term);
    expect(bytes).toBeInstanceOf(Uint8Array);
    const decoded = new TextDecoder().decode(bytes);
    expect(decoded).toContain("hello");
  });
});
