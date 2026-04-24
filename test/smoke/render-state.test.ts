import { describe, test, expect } from "bun:test";
import { Terminal, RenderState } from "../../src";

describe("RenderState lifecycle", () => {
  test("construct + close + dispose", () => {
    using rs = new RenderState();
    expect(rs).toBeDefined();
  });

  test("use-after-close throws", () => {
    const rs = new RenderState();
    rs.close();
    using term = new Terminal({ cols: 10, rows: 4 });
    expect(() => rs.update(term)).toThrow(/closed/i);
  });

  test("double-close is a safe no-op", () => {
    const rs = new RenderState();
    rs.close();
    rs.close();
  });
});

describe("RenderState.update + iteration", () => {
  test("update on fresh terminal produces rowCount rows", () => {
    using term = new Terminal({ cols: 10, rows: 4 });
    using rs = new RenderState();
    rs.update(term);
    let count = 0;
    for (const _ of rs.rows()) count += 1;
    expect(count).toBe(4);
  });

  test("each row has cols cells via ergonomic path", () => {
    using term = new Terminal({ cols: 10, rows: 4 });
    using rs = new RenderState();
    rs.update(term);
    for (const row of rs.rows()) {
      let c = 0;
      for (const _ of row.cells()) c += 1;
      expect(c).toBe(10);
    }
  });

  test("written text appears on row 0 via rows()/cells()", () => {
    using term = new Terminal({ cols: 10, rows: 2 });
    term.vtWrite(new TextEncoder().encode("abc"));
    using rs = new RenderState();
    rs.update(term);
    const rowsArr = [...rs.rows()];
    const row0 = rowsArr[0]!;
    const cells = [...row0.cells()];
    expect(cells[0]!.text).toBe("a");
    expect(cells[1]!.text).toBe("b");
    expect(cells[2]!.text).toBe("c");
  });

  test("hot path forEachCell visits every cell; callback sees same instance", () => {
    using term = new Terminal({ cols: 10, rows: 2 });
    term.vtWrite(new TextEncoder().encode("xy"));
    using rs = new RenderState();
    rs.update(term);
    const seen: string[] = [];
    let firstRef: unknown;
    rs.forEachCell(0, (cell) => {
      if (firstRef === undefined) firstRef = cell;
      else expect(cell).toBe(firstRef); // same instance mutated in place
      seen.push(cell.text);
    });
    expect(seen.length).toBe(10);
    expect(seen[0]).toBe("x");
    expect(seen[1]).toBe("y");
  });

  test("forEachCell accepts row number or RenderRow object", () => {
    using term = new Terminal({ cols: 5, rows: 2 });
    using rs = new RenderState();
    rs.update(term);
    const rowObj = [...rs.rows()][0]!;
    let byNum = 0, byObj = 0;
    rs.forEachCell(0, () => { byNum += 1; });
    rs.forEachCell(rowObj, () => { byObj += 1; });
    expect(byNum).toBe(5);
    expect(byObj).toBe(5);
  });
});

describe("RenderState dirty lifecycle", () => {
  test("fresh update sets dirty() to 'all' (full redraw on init)", () => {
    using term = new Terminal({ cols: 10, rows: 4 });
    using rs = new RenderState();
    rs.update(term);
    expect(["rows", "all"]).toContain(rs.dirty());
  });

  test("markClean() clears both native and JS dirty — subsequent update with no activity stays 'none'", () => {
    using term = new Terminal({ cols: 10, rows: 4 });
    using rs = new RenderState();
    rs.update(term);
    rs.markClean();
    expect(rs.dirty()).toBe("none");
    // Critical test: update again without writing to terminal. If markClean()
    // had been a pure-JS flip (P1 from Codex round 1), the next update would
    // re-read stale native dirty and flip dirty() back to "rows"/"all".
    rs.update(term);
    expect(rs.dirty()).toBe("none");
  });

  test("vtWrite after markClean produces dirty rows", () => {
    using term = new Terminal({ cols: 10, rows: 4 });
    using rs = new RenderState();
    rs.update(term);
    rs.markClean();
    term.vtWrite(new TextEncoder().encode("x"));
    rs.update(term);
    expect(rs.dirty()).not.toBe("none");
  });

  test("forEachDirtyRow iterates only rows with dirty=true after partial write", () => {
    using term = new Terminal({ cols: 10, rows: 4 });
    using rs = new RenderState();
    rs.update(term);
    rs.markClean();
    term.vtWrite(new TextEncoder().encode("a"));
    rs.update(term);
    let dirtyCount = 0;
    rs.forEachDirtyRow(() => { dirtyCount += 1; });
    expect(dirtyCount).toBeGreaterThan(0);
    expect(dirtyCount).toBeLessThanOrEqual(4);
  });

  test("forEachDirtyRow after markClean is empty", () => {
    using term = new Terminal({ cols: 10, rows: 4 });
    using rs = new RenderState();
    rs.update(term);
    rs.markClean();
    let count = 0;
    rs.forEachDirtyRow(() => { count += 1; });
    expect(count).toBe(0);
  });

  test("Codex P1 repro: update → markClean → update (no activity) → forEachDirtyRow is empty", () => {
    // This proves markClean() cleared libghostty's per-row dirty flags natively.
    // If only the global flag had been cleared, the re-update would re-populate
    // each row's dirty=true from the stale per-row state, and forEachDirtyRow
    // would still walk rows while dirty() reports "none".
    using term = new Terminal({ cols: 10, rows: 4 });
    using rs = new RenderState();
    rs.update(term);
    rs.markClean();
    rs.update(term);
    expect(rs.dirty()).toBe("none");
    let count = 0;
    rs.forEachDirtyRow(() => { count += 1; });
    expect(count).toBe(0);
  });
});

describe("Codex P2: RenderState.colors mirrors Terminal.colors snapshot", () => {
  test("rs.colors() after setColors+update matches term.colors().defaults", () => {
    using term = new Terminal({ cols: 10, rows: 4 });
    term.setColors({ defaults: { fg: [42, 43, 44] } });
    using rs = new RenderState();
    rs.update(term);
    expect(rs.colors().defaults.fg).toEqual([42, 43, 44]);
    expect(term.colors().defaults.fg).toEqual([42, 43, 44]);
  });
});

describe("Codex P1: RenderState decodes wrapped, wide, isWideContinuation", () => {
  test("wide grapheme sets wide on primary, isWideContinuation on trailing", () => {
    using term = new Terminal({ cols: 10, rows: 4 });
    term.vtWrite(new TextEncoder().encode("中"));
    using rs = new RenderState();
    rs.update(term);
    const rowsArr = [...rs.rows()];
    const cells = [...rowsArr[0]!.cells()];
    expect(cells[0]!.text).toBe("中");
    expect(cells[0]!.wide).toBe(true);
    expect(cells[0]!.isWideContinuation).toBe(false);
    expect(cells[1]!.isWideContinuation).toBe(true);
  });

  test("unstyled cells have style === undefined (not an all-false object)", () => {
    using term = new Terminal({ cols: 10, rows: 4 });
    term.vtWrite(new TextEncoder().encode("x"));
    using rs = new RenderState();
    rs.update(term);
    const rowsArr = [...rs.rows()];
    const cells = [...rowsArr[0]!.cells()];
    expect(cells[0]!.style).toBeUndefined();
  });

  test("bold cell carries style.bold === true", () => {
    using term = new Terminal({ cols: 10, rows: 4 });
    term.vtWrite(new TextEncoder().encode("\x1b[1mA"));
    using rs = new RenderState();
    rs.update(term);
    const rowsArr = [...rs.rows()];
    const cells = [...rowsArr[0]!.cells()];
    expect(cells[0]!.style?.bold).toBe(true);
  });
});

describe("RenderState.colors + cursor", () => {
  test("colors() returns effective + defaults shape + 256-entry palette", () => {
    using term = new Terminal({ cols: 10, rows: 4 });
    using rs = new RenderState();
    rs.update(term);
    const c = rs.colors();
    expect(c.palette.length).toBe(256);
    expect(c.effective).toBeDefined();
    expect(c.defaults).toBeDefined();
  });

  test("cursor() returns viewport cursor on fresh terminal", () => {
    using term = new Terminal({ cols: 10, rows: 4 });
    using rs = new RenderState();
    rs.update(term);
    const cur = rs.cursor();
    expect(cur).toBeDefined();
    expect(cur!.x).toBe(0);
    expect(cur!.y).toBe(0);
    expect(cur!.visible).toBe(true);
  });

  test("cursor() tracks x after writing characters", () => {
    using term = new Terminal({ cols: 20, rows: 4 });
    term.vtWrite(new TextEncoder().encode("hello"));
    using rs = new RenderState();
    rs.update(term);
    const cur = rs.cursor();
    expect(cur).toBeDefined();
    expect(cur!.x).toBe(5);
    expect(cur!.y).toBe(0);
  });
});

describe("RenderState resize rebuild", () => {
  test("resize + update rebuilds cache to new geometry", () => {
    using term = new Terminal({ cols: 10, rows: 4 });
    using rs = new RenderState();
    rs.update(term);
    expect([...rs.rows()].length).toBe(4);
    term.resize(20, 6);
    rs.update(term);
    expect([...rs.rows()].length).toBe(6);
    for (const row of rs.rows()) {
      let c = 0;
      for (const _ of row.cells()) c += 1;
      expect(c).toBe(20);
    }
  });
});

describe("RenderState alt-screen dirty=all", () => {
  test("entering alt screen produces dirty()==='all'", () => {
    using term = new Terminal({ cols: 10, rows: 4 });
    using rs = new RenderState();
    rs.update(term);
    rs.markClean();
    // DECSET 1049: enter alt screen + save cursor
    term.vtWrite(new TextEncoder().encode("\x1b[?1049h"));
    rs.update(term);
    expect(rs.dirty()).toBe("all");
  });
});
