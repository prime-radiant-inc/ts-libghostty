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

describe("Terminal effect callbacks — onTitleChanged", () => {
  const oscTitle = (title: string): Uint8Array => {
    const enc = new TextEncoder();
    const prefix = enc.encode("\x1b]0;");
    const body = enc.encode(title);
    const suffix = new Uint8Array([0x07]);
    const out = new Uint8Array(prefix.length + body.length + suffix.length);
    out.set(prefix, 0);
    out.set(body, prefix.length);
    out.set(suffix, prefix.length + body.length);
    return out;
  };

  it("fires on OSC 0 title change with the new title", () => {
    const titles: string[] = [];
    using term = new Terminal({
      cols: 10, rows: 3,
      onTitleChanged: (t) => { titles.push(t); },
    });
    term.vtWrite(oscTitle("hello"));
    expect(titles).toEqual(["hello"]);
  });

  it("fires on OSC 2 title change", () => {
    const titles: string[] = [];
    using term = new Terminal({
      cols: 10, rows: 3,
      onTitleChanged: (t) => { titles.push(t); },
    });
    const enc = new TextEncoder();
    const prefix = enc.encode("\x1b]2;");
    const body = enc.encode("osc2-title");
    const suffix = new Uint8Array([0x07]);
    const seq = new Uint8Array(prefix.length + body.length + suffix.length);
    seq.set(prefix, 0);
    seq.set(body, prefix.length);
    seq.set(suffix, prefix.length + body.length);
    term.vtWrite(seq);
    expect(titles).toEqual(["osc2-title"]);
  });

  it("fires once per title change in a stream of multiple changes", () => {
    const titles: string[] = [];
    using term = new Terminal({
      cols: 10, rows: 3,
      onTitleChanged: (t) => { titles.push(t); },
    });
    const first = oscTitle("one");
    const second = oscTitle("two");
    const third = oscTitle("three");
    const combined = new Uint8Array(first.length + second.length + third.length);
    combined.set(first, 0);
    combined.set(second, first.length);
    combined.set(third, first.length + second.length);
    term.vtWrite(combined);
    expect(titles).toEqual(["one", "two", "three"]);
  });

  it("handles empty titles (OSC 0 ; BEL)", () => {
    const titles: string[] = [];
    using term = new Terminal({
      cols: 10, rows: 3,
      onTitleChanged: (t) => { titles.push(t); },
    });
    const empty = new Uint8Array([0x1b, 0x5d, 0x30, 0x3b, 0x07]);
    term.vtWrite(empty);
    expect(titles.length === 0 || titles[0] === "").toBe(true);
  });

  it("handles Unicode titles (multi-byte UTF-8)", () => {
    const titles: string[] = [];
    using term = new Terminal({
      cols: 10, rows: 3,
      onTitleChanged: (t) => { titles.push(t); },
    });
    term.vtWrite(oscTitle("тайтл 🦀"));
    expect(titles).toEqual(["тайтл 🦀"]);
  });
});

describe("Terminal effect callbacks — onWritePty", () => {
  it("fires with plausible bytes when DA1 (CSI c) is received", () => {
    const responses: Uint8Array[] = [];
    using term = new Terminal({
      cols: 10, rows: 3,
      onWritePty: (bytes) => { responses.push(bytes); },
    });
    term.vtWrite(new Uint8Array([0x1b, 0x5b, 0x63]));
    expect(responses.length).toBeGreaterThan(0);
    const first = responses[0]!;
    expect(first.length).toBeGreaterThan(0);
    expect(first[0]).toBe(0x1b);
  });

  it("delivers a retainable Uint8Array — bytes survive later vtWrite calls", () => {
    const responses: Uint8Array[] = [];
    using term = new Terminal({
      cols: 10, rows: 3,
      onWritePty: (bytes) => { responses.push(bytes); },
    });
    term.vtWrite(new Uint8Array([0x1b, 0x5b, 0x63]));
    expect(responses.length).toBeGreaterThan(0);
    const retained = responses[0]!;
    const snapshot = Array.from(retained);

    term.vtWrite(new TextEncoder().encode("ABCDEFG"));
    term.vtWrite(new Uint8Array([0x1b, 0x5b, 0x63]));

    expect(Array.from(retained)).toEqual(snapshot);
  });

  it("user mutation of the received Uint8Array does not affect libghostty's next reply", () => {
    const responses: Uint8Array[] = [];
    using term = new Terminal({
      cols: 10, rows: 3,
      onWritePty: (bytes) => { responses.push(bytes); },
    });
    term.vtWrite(new Uint8Array([0x1b, 0x5b, 0x63]));
    expect(responses.length).toBeGreaterThan(0);
    const r1 = responses[0]!;
    const lenBefore = responses.length;
    r1.fill(0xff);

    term.vtWrite(new Uint8Array([0x1b, 0x5b, 0x63]));
    const fresh = responses.slice(lenBefore);
    expect(fresh.length).toBeGreaterThan(0);
    for (const r of fresh) {
      expect(r[0]).toBe(0x1b);
    }
  });

  it("does not fire on plain printable input", () => {
    let count = 0;
    using term = new Terminal({
      cols: 10, rows: 3,
      onWritePty: () => { count++; },
    });
    term.vtWrite(new TextEncoder().encode("hello"));
    expect(count).toBe(0);
  });

  it("fires for DSR cursor-position query (CSI 6 n)", () => {
    const responses: Uint8Array[] = [];
    using term = new Terminal({
      cols: 10, rows: 3,
      onWritePty: (bytes) => { responses.push(bytes); },
    });
    term.vtWrite(new Uint8Array([0x1b, 0x5b, 0x36, 0x6e]));
    expect(responses.length).toBeGreaterThan(0);
    const r = responses[0]!;
    expect(r[0]).toBe(0x1b);
    expect(r[1]).toBe(0x5b);
    expect(r[r.length - 1]).toBe(0x52);
  });
});
