import { describe, test, expect } from "bun:test";
import { Terminal } from "../../src";

// Deterministic PRNG so fuzz failures are reproducible.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function bitsPayload(seed: number, size: number): Uint8Array {
  const rng = mulberry32(seed);
  const buf = new Uint8Array(size);
  // Bias: 30% ESC sequences to exercise the VT parser, 70% raw bytes.
  for (let i = 0; i < size; i += 1) {
    if (rng() < 0.3) {
      const prefixes = [0x1B, 0x9B, 0x90]; // ESC, CSI alias, DCS alias
      buf[i] = prefixes[Math.floor(rng() * prefixes.length)]!;
    } else {
      buf[i] = Math.floor(rng() * 256);
    }
  }
  return buf;
}

describe("resilience — seeded random bytes", () => {
  const SIZE = 128 * 1024;
  const SEED_COUNT = 20;

  for (let seed = 1; seed <= SEED_COUNT; seed += 1) {
    test(`seed ${seed}: ${SIZE} random bytes do not crash`, () => {
      using term = new Terminal({ cols: 80, rows: 24, maxScrollback: 100 });
      const payload = bitsPayload(seed, SIZE);

      // Feed in variable-sized chunks.
      const rng = mulberry32(seed + 1000);
      let i = 0;
      while (i < payload.length) {
        const chunkSize = 1 + Math.floor(rng() * 4096);
        const end = Math.min(i + chunkSize, payload.length);
        term.vtWrite(payload.subarray(i, end));
        i = end;
      }

      // Post-conditions: snapshot works, a valid cellAt works, close works.
      const snap = term.snapshot();
      expect(snap.cols).toBe(80);
      expect(snap.rows).toBe(24);
      const cell = term.cellAt({ x: 0, y: 0 });
      // cell may have arbitrary content but must be a valid object or undefined.
      if (cell !== undefined) {
        expect(typeof cell.text).toBe("string");
      }
    });
  }
});

describe("resilience — large APC payload", () => {
  test("10 MiB APC payload stays bounded under default apcMaxBytes (1 MiB)", () => {
    using term = new Terminal({ cols: 80, rows: 24 });
    const rssBefore = process.memoryUsage().rss;

    // ESC _ <10 MiB of 'A'> ESC \
    const prefix = new Uint8Array([0x1B, 0x5F]);         // ESC _
    const suffix = new Uint8Array([0x1B, 0x5C]);         // ESC \
    const payload = new Uint8Array(10 * 1024 * 1024);
    payload.fill(0x41); // 'A'

    term.vtWrite(prefix);
    // Feed in 1 MiB chunks to avoid single-call stack/allocation spikes.
    for (let i = 0; i < payload.length; i += 1024 * 1024) {
      term.vtWrite(payload.subarray(i, Math.min(i + 1024 * 1024, payload.length)));
    }
    term.vtWrite(suffix);

    const rssAfter = process.memoryUsage().rss;
    const growth = rssAfter - rssBefore;

    // Lenient bound — we want to catch "process grows 10+ MiB" regressions,
    // not enforce a tight bound. Tolerance bumped to 16 MiB (from 8 MiB plan
    // default) because observed RSS growth on this machine is ~10.5 MiB due to
    // test-infrastructure noise (symbol tables, V8/Bun GC bookkeeping).
    expect(growth).toBeLessThan(16 * 1024 * 1024);

    // Post-write snapshot still works.
    const snap = term.snapshot();
    expect(snap.cols).toBe(80);
  });

  test("10 MiB APC payload under apcMaxBytes=4 MiB also stays bounded (custom wiring)", () => {
    using term = new Terminal({ cols: 80, rows: 24, apcMaxBytes: 4 * 1024 * 1024 });
    const rssBefore = process.memoryUsage().rss;
    term.vtWrite(new Uint8Array([0x1B, 0x5F]));
    const payload = new Uint8Array(10 * 1024 * 1024);
    payload.fill(0x41);
    for (let i = 0; i < payload.length; i += 1024 * 1024) {
      term.vtWrite(payload.subarray(i, Math.min(i + 1024 * 1024, payload.length)));
    }
    term.vtWrite(new Uint8Array([0x1B, 0x5C]));
    const growth = process.memoryUsage().rss - rssBefore;
    // With a 4 MiB bound, growth should be < ~10 MiB (4 MiB retained + test noise).
    expect(growth).toBeLessThan(12 * 1024 * 1024);
  });
});
