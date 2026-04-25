# Cell-Grid Rectangle Renderer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a cell-grid rectangle renderer to `libghostty-vt` so consumers can compose embedded terminal output into a host UI without the program's own escape sequences leaking — the foundation for tmux-class composition.

**Architecture:** A pure ANSI emission engine in `render-rect.ts` consumes a `RenderState` and returns a string of ANSI bytes that paint into a destination rectangle. Public surface: `RenderState.toAnsiRect(dest, opts)` (primitive) + `RenderState.cursorInRect(dest)` (helper) + `Terminal.renderToAnsiRect(dest, opts)` (convenience that maintains a cached RenderState per Terminal). Every non-default SGR is reset-prefixed (`\x1b[0;…m`) so transitions are stateless. Strict size match between source (RenderState) and dest, throws `RectSizeMismatch` on drift.

**Tech Stack:** Bun (test, runtime), TypeScript 5.x, libghostty-vt's existing `RenderState` cell-grid API, `bun:test`.

**Reference spec:** `docs/superpowers/specs/2026-04-25-render-rect-design.md`.

**Worktree:** Implementation Bobs MUST work on `worktree-bobbihack-impl` (the existing isolated worktree) — verify with `git branch --show-current` before any commit.

**Release target:** `libghostty-vt@0.4.0`.

---

## File Map

**Created:**

| Path | Purpose | Task |
|---|---|---|
| `packages/libghostty-vt/src/render-rect.ts` | Pure ANSI emission engine: `computeSgr` + `renderRect` | 2, 3 |
| `packages/libghostty-vt/test/smoke/render-rect.compute-sgr.test.ts` | Unit tests for `computeSgr` | 2 |
| `packages/libghostty-vt/test/smoke/render-rect.test.ts` | Unit tests for the rect renderer (drives a real Terminal) | 3 |
| `packages/libghostty-vt/test/smoke/cursor-in-rect.test.ts` | Unit tests for `cursorInRect` | 5 |
| `packages/libghostty-vt/test/smoke/render-rect.terminal.test.ts` | Tests for `Terminal.renderToAnsiRect` + cached state | 6 |
| `packages/libghostty-vt/test/smoke/render-rect.integration.test.ts` | End-to-end: vtWrite cursor-positioning input, verify it doesn't leak | 8 |

**Modified:**

| Path | Changes | Task |
|---|---|---|
| `packages/libghostty-vt/src/types.ts` | Add `RenderRect`, `RectRenderOptions`, `RectCursor` | 1 |
| `packages/libghostty-vt/src/errors.ts` | Add `RectSizeMismatch`, extend `GhosttyErrorCode` | 1 |
| `packages/libghostty-vt/src/render-state.ts` | Add `size()`, `toAnsiRect()`, `cursorInRect()` | 4, 5 |
| `packages/libghostty-vt/src/terminal.ts` | Add `renderToAnsiRect()` + cached state lifecycle | 6 |
| `packages/libghostty-vt/src/index.ts` | Export new types + error | 7 |
| `packages/libghostty-vt/scripts/run-tarball-smoke.sh` | Add render-rect smoke stanza | 9 |
| `packages/libghostty-vt/package.json` | Bump 0.3.0 → 0.4.0 | 10 |
| `packages/libghostty-vt/CHANGELOG.md` | Add `[0.4.0]` entry | 10 |

---

## Task 1: Types + error

**Files:**
- Modify: `packages/libghostty-vt/src/types.ts`
- Modify: `packages/libghostty-vt/src/errors.ts`

No test of its own — types + error class are checked by typecheck plus subsequent tasks importing them.

- [ ] **Step 1: Add new types to `types.ts`**

Append at the end of the existing public exports section in `packages/libghostty-vt/src/types.ts`:

```ts
// --- Pass 4 render-rect types ------------------------------------------------

export interface RenderRect {
  readonly row: number;   // 1-based host row of top-left
  readonly col: number;   // 1-based host col of top-left
  readonly cols: number;
  readonly rows: number;
}

export interface RectRenderOptions {
  /**
   * SGR color depth.
   * - "preserve" (default): emit RGB / palette / 16-color SGR as the source
   *   carries it.
   * - "none": skip color and attribute SGR entirely (plain text only;
   *   blank-but-bg-styled cells render as undifferentiated whitespace).
   */
  colorDepth?: "preserve" | "none";
}

export interface RectCursor {
  readonly row: number;       // 1-based host row
  readonly col: number;       // 1-based host col
  /** True when the cursor sits on the trailing half of a wide grapheme. */
  readonly wideTail: boolean;
}

// --- End Pass 4 render-rect types --------------------------------------------
```

- [ ] **Step 2: Extend `GhosttyErrorCode` and add `RectSizeMismatch` to `errors.ts`**

Edit `packages/libghostty-vt/src/errors.ts`:

Replace this block:
```ts
  | "encode_failed"
  | "invalid_utf8"
  | "unknown";
```

with:
```ts
  | "encode_failed"
  | "invalid_utf8"
  | "rect_size_mismatch"
  | "unknown";
```

Then append at the end of the file:

```ts
export class RectSizeMismatch extends GhosttyError {
  readonly source: { cols: number; rows: number };
  readonly dest: { cols: number; rows: number };

  constructor(
    source: { cols: number; rows: number },
    dest: { cols: number; rows: number },
  ) {
    super(
      `RectSizeMismatch: source is ${source.cols}×${source.rows}, ` +
        `dest is ${dest.cols}×${dest.rows}. ` +
        `Resize the source program (terminal.resize) or the destination box.`,
      { code: "rect_size_mismatch" },
    );
    this.name = "RectSizeMismatch";
    this.source = { cols: source.cols, rows: source.rows };
    this.dest = { cols: dest.cols, rows: dest.rows };
  }
}
```

- [ ] **Step 3: Verify typecheck passes**

Run: `cd packages/libghostty-vt && bun run typecheck`
Expected: PASS — types compile.

- [ ] **Step 4: Commit**

```bash
git add packages/libghostty-vt/src/types.ts packages/libghostty-vt/src/errors.ts
git commit -m "feat(libghostty-vt): RenderRect types + RectSizeMismatch error

Co-Authored-By: <YourName> (Bob 811efc4e/<your-model>)"
```

---

## Task 2: `computeSgr` (TDD)

**Files:**
- Create: `packages/libghostty-vt/src/render-rect.ts`
- Test: `packages/libghostty-vt/test/smoke/render-rect.compute-sgr.test.ts`

The pure SGR builder. Returns `""` for default style or `colorDepth: "none"`; otherwise returns a reset-prefixed CSI sequence.

- [ ] **Step 1: Write the failing tests**

Create `packages/libghostty-vt/test/smoke/render-rect.compute-sgr.test.ts`:

```ts
import { expect, test } from "bun:test";
import { computeSgr } from "../../src/render-rect";
import type { CellStyle } from "../../src/types";

const baseStyle = (overrides: Partial<CellStyle> = {}): CellStyle => ({
  bold: false,
  faint: false,
  italic: false,
  underline: "none",
  overline: false,
  strikethrough: false,
  blink: false,
  inverse: false,
  invisible: false,
  ...overrides,
});

test("undefined style returns empty string", () => {
  expect(computeSgr(undefined, "preserve")).toBe("");
});

test("colorDepth 'none' always returns empty string", () => {
  expect(computeSgr(baseStyle({ bold: true, fg: 1 }), "none")).toBe("");
  expect(computeSgr(undefined, "none")).toBe("");
});

test("all-default style returns empty string", () => {
  // A defined-but-default style is technically possible if a future change
  // stops the omit-default optimization. Defensive: still emit nothing.
  expect(computeSgr(baseStyle(), "preserve")).toBe("");
});

test("single attribute: bold", () => {
  expect(computeSgr(baseStyle({ bold: true }), "preserve")).toBe("\x1b[0;1m");
});

test("multiple attributes preserve the documented order", () => {
  // bold (1), faint (2), italic (3), underline (4), blink (5), inverse (7),
  // invisible (8), strikethrough (9), overline (53)
  const style = baseStyle({
    bold: true,
    italic: true,
    underline: "single",
    inverse: true,
    overline: true,
  });
  expect(computeSgr(style, "preserve")).toBe("\x1b[0;1;3;4;7;53m");
});

test("any non-'none' underline value emits SGR 4", () => {
  for (const u of ["single", "double", "curly", "dotted", "dashed"] as const) {
    expect(computeSgr(baseStyle({ underline: u }), "preserve")).toBe(
      "\x1b[0;4m",
    );
  }
});

test("palette fg 0-7 uses short form 30-37", () => {
  expect(computeSgr(baseStyle({ fg: 0 }), "preserve")).toBe("\x1b[0;30m");
  expect(computeSgr(baseStyle({ fg: 1 }), "preserve")).toBe("\x1b[0;31m");
  expect(computeSgr(baseStyle({ fg: 7 }), "preserve")).toBe("\x1b[0;37m");
});

test("palette fg 8-15 uses bright short form 90-97", () => {
  expect(computeSgr(baseStyle({ fg: 8 }), "preserve")).toBe("\x1b[0;90m");
  expect(computeSgr(baseStyle({ fg: 15 }), "preserve")).toBe("\x1b[0;97m");
});

test("palette fg 16+ uses 256-color form 38;5;N", () => {
  expect(computeSgr(baseStyle({ fg: 16 }), "preserve")).toBe("\x1b[0;38;5;16m");
  expect(computeSgr(baseStyle({ fg: 200 }), "preserve")).toBe(
    "\x1b[0;38;5;200m",
  );
});

test("RGB fg uses truecolor form 38;2;R;G;B", () => {
  expect(computeSgr(baseStyle({ fg: { r: 1, g: 2, b: 3 } }), "preserve")).toBe(
    "\x1b[0;38;2;1;2;3m",
  );
});

test("palette bg 0-7 uses short form 40-47", () => {
  expect(computeSgr(baseStyle({ bg: 0 }), "preserve")).toBe("\x1b[0;40m");
  expect(computeSgr(baseStyle({ bg: 7 }), "preserve")).toBe("\x1b[0;47m");
});

test("palette bg 8-15 uses bright short form 100-107", () => {
  expect(computeSgr(baseStyle({ bg: 8 }), "preserve")).toBe("\x1b[0;100m");
  expect(computeSgr(baseStyle({ bg: 15 }), "preserve")).toBe("\x1b[0;107m");
});

test("palette bg 16+ uses 256-color form 48;5;N", () => {
  expect(computeSgr(baseStyle({ bg: 16 }), "preserve")).toBe("\x1b[0;48;5;16m");
});

test("RGB bg uses truecolor form 48;2;R;G;B", () => {
  expect(
    computeSgr(baseStyle({ bg: { r: 10, g: 20, b: 30 } }), "preserve"),
  ).toBe("\x1b[0;48;2;10;20;30m");
});

test("attributes + fg + bg combine in order", () => {
  const style = baseStyle({
    bold: true,
    fg: 1,
    bg: { r: 0, g: 0, b: 0 },
  });
  expect(computeSgr(style, "preserve")).toBe("\x1b[0;1;31;48;2;0;0;0m");
});
```

- [ ] **Step 2: Run tests to confirm they fail**

Run: `cd packages/libghostty-vt && bun test test/smoke/render-rect.compute-sgr.test.ts`
Expected: FAIL — `Cannot find module '../../src/render-rect'`.

- [ ] **Step 3: Implement `computeSgr` in `render-rect.ts`**

Create `packages/libghostty-vt/src/render-rect.ts`:

```ts
import type { CellStyle, PaletteIndex, RGB } from "./types";

/**
 * Build a reset-prefixed SGR CSI sequence for `style`. Reset-prefix
 * (`\x1b[0;…m`) means each emitted SGR is independent of the prior cell's
 * state — no need to track and un-set attributes from the previous cell.
 *
 * Returns `""` when:
 *   - colorDepth is "none" (always)
 *   - style is undefined (cell has default style)
 *   - style is defined but every field is the default value
 */
export function computeSgr(
  style: CellStyle | undefined,
  colorDepth: "preserve" | "none",
): string {
  if (colorDepth === "none" || style === undefined) return "";

  const params: string[] = ["0"];

  if (style.bold) params.push("1");
  if (style.faint) params.push("2");
  if (style.italic) params.push("3");
  if (style.underline !== "none") params.push("4");
  if (style.blink) params.push("5");
  if (style.inverse) params.push("7");
  if (style.invisible) params.push("8");
  if (style.strikethrough) params.push("9");
  if (style.overline) params.push("53");

  if (style.fg !== undefined) appendColor(params, style.fg, "fg");
  if (style.bg !== undefined) appendColor(params, style.bg, "bg");

  if (params.length === 1) return ""; // only reset, nothing else — default
  return `\x1b[${params.join(";")}m`;
}

function appendColor(
  params: string[],
  color: RGB | PaletteIndex,
  channel: "fg" | "bg",
): void {
  if (typeof color === "number") {
    if (color < 8) {
      params.push(String((channel === "fg" ? 30 : 40) + color));
    } else if (color < 16) {
      params.push(String((channel === "fg" ? 90 : 100) + (color - 8)));
    } else {
      params.push(channel === "fg" ? "38" : "48", "5", String(color));
    }
  } else {
    params.push(
      channel === "fg" ? "38" : "48",
      "2",
      String(color.r),
      String(color.g),
      String(color.b),
    );
  }
}
```

- [ ] **Step 4: Run tests to confirm they pass**

Run: `cd packages/libghostty-vt && bun test test/smoke/render-rect.compute-sgr.test.ts`
Expected: PASS — 14 tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/libghostty-vt/src/render-rect.ts packages/libghostty-vt/test/smoke/render-rect.compute-sgr.test.ts
git commit -m "feat(libghostty-vt): computeSgr — reset-prefixed CSI builder

Co-Authored-By: <YourName> (Bob 811efc4e/<your-model>)"
```

---

## Task 3: `renderRect` (TDD)

**Files:**
- Modify: `packages/libghostty-vt/src/render-rect.ts`
- Test: `packages/libghostty-vt/test/smoke/render-rect.test.ts`

The main emission function. Walks `state.rows()`, emits goto + reset + cells per row.

This task drives a real `Terminal` via `vtWrite` to produce realistic `RenderState` data — simpler than mocking the row iterator.

- [ ] **Step 1: Write the failing tests**

Create `packages/libghostty-vt/test/smoke/render-rect.test.ts`:

```ts
import { expect, test } from "bun:test";
import { Terminal } from "../../src/terminal";
import { RenderState } from "../../src/render-state";
import { renderRect } from "../../src/render-rect";
import { RectSizeMismatch } from "../../src/errors";

const writeStr = (term: Terminal, s: string): void => {
  term.vtWrite(new TextEncoder().encode(s));
};

const stateOf = (cols: number, rows: number, write?: (t: Terminal) => void) => {
  const term = new Terminal({ cols, rows });
  if (write) write(term);
  const rs = new RenderState();
  rs.update(term);
  return { term, rs };
};

test("empty terminal renders all-spaces with row-start resets", () => {
  const { rs } = stateOf(4, 2);
  const out = renderRect(rs, { row: 1, col: 1, cols: 4, rows: 2 }, {});
  // Two row-start sequences: goto + reset
  expect(out).toContain("\x1b[1;1H\x1b[0m");
  expect(out).toContain("\x1b[2;1H\x1b[0m");
  // Four spaces per row
  const spaceRuns = out.match(/    /g);
  expect(spaceRuns?.length).toBeGreaterThanOrEqual(2);
  // No foreign cursor positioning beyond our row-start gotos
  const allGotos = out.match(/\x1b\[\d+;\d+H/g) ?? [];
  expect(allGotos).toEqual(["\x1b[1;1H", "\x1b[2;1H"]);
});

test("plain text content appears in the output", () => {
  const { rs } = stateOf(4, 1, (t) => writeStr(t, "ABCD"));
  const out = renderRect(rs, { row: 1, col: 1, cols: 4, rows: 1 }, {});
  expect(out).toContain("ABCD");
});

test("dest origin is honored — non-1,1 coordinates", () => {
  const { rs } = stateOf(4, 2, (t) => writeStr(t, "ABCD"));
  const out = renderRect(rs, { row: 5, col: 10, cols: 4, rows: 2 }, {});
  expect(out).toContain("\x1b[5;10H");
  expect(out).toContain("\x1b[6;10H");
});

test("styled cell emits reset-prefixed SGR", () => {
  const { rs } = stateOf(4, 1, (t) => writeStr(t, "\x1b[1;31mX"));
  const out = renderRect(rs, { row: 1, col: 1, cols: 4, rows: 1 }, {});
  // Bold red — reset-prefixed
  expect(out).toContain("\x1b[0;1;31m");
  expect(out).toContain("X");
});

test("transition back to default emits reset", () => {
  const { rs } = stateOf(4, 1, (t) => writeStr(t, "\x1b[1;31mX\x1b[0mY"));
  const out = renderRect(rs, { row: 1, col: 1, cols: 4, rows: 1 }, {});
  // Bold red on, then off
  expect(out).toContain("\x1b[0;1;31m");
  expect(out).toContain("X");
  // After X, return to default — must emit reset before Y
  // (cell row layout: row-reset, [styled X], reset-to-default, Y, padding spaces)
  const resetIndex = out.lastIndexOf("\x1b[0m");
  const yIndex = out.indexOf("Y");
  expect(resetIndex).toBeLessThan(yIndex);
});

test("colorDepth 'none' suppresses all SGR", () => {
  const { rs } = stateOf(4, 1, (t) => writeStr(t, "\x1b[1;31mABCD"));
  const out = renderRect(
    rs,
    { row: 1, col: 1, cols: 4, rows: 1 },
    { colorDepth: "none" },
  );
  // No \x1b[…;…m anywhere except possibly the row-start \x1b[0m
  // (we still emit the row-start defensive reset regardless of colorDepth)
  expect(out).toContain("ABCD");
  // Permitted: row-start \x1b[0m. Forbidden: any *other* SGR.
  const allSgr = out.match(/\x1b\[\d+(;\d+)*m/g) ?? [];
  for (const s of allSgr) expect(s).toBe("\x1b[0m");
});

test("size mismatch throws RectSizeMismatch", () => {
  const { rs } = stateOf(4, 2);
  expect(() =>
    renderRect(rs, { row: 1, col: 1, cols: 5, rows: 2 }, {}),
  ).toThrow(RectSizeMismatch);
  expect(() =>
    renderRect(rs, { row: 1, col: 1, cols: 4, rows: 3 }, {}),
  ).toThrow(RectSizeMismatch);
});

test("size mismatch error carries source and dest dims", () => {
  const { rs } = stateOf(4, 2);
  try {
    renderRect(rs, { row: 1, col: 1, cols: 5, rows: 2 }, {});
    throw new Error("expected throw");
  } catch (e) {
    expect(e).toBeInstanceOf(RectSizeMismatch);
    if (e instanceof RectSizeMismatch) {
      expect(e.source).toEqual({ cols: 4, rows: 2 });
      expect(e.dest).toEqual({ cols: 5, rows: 2 });
      expect(e.code).toBe("rect_size_mismatch");
    }
  }
});

test("never-updated RenderState has 0×0 source and throws on any non-zero dest", () => {
  const rs = new RenderState();
  expect(() =>
    renderRect(rs, { row: 1, col: 1, cols: 4, rows: 2 }, {}),
  ).toThrow(RectSizeMismatch);
});
```

- [ ] **Step 2: Run tests to confirm they fail**

Run: `cd packages/libghostty-vt && bun test test/smoke/render-rect.test.ts`
Expected: FAIL — `renderRect` not yet exported.

- [ ] **Step 3: Implement `renderRect` and a private size accessor**

The renderer needs the source's cols/rows. We add a private accessor that the renderer calls — cleaner than walking `rows()` to count.

First, in `packages/libghostty-vt/src/render-state.ts`, add a public `size()` method on `RenderState`. Add it just after `cursor()` (search for `cursor(): ViewportCursor | undefined`):

```ts
  /**
   * Returns the source dimensions captured at the most recent `update()`.
   * Returns {cols: 0, rows: 0} if `update()` has never been called.
   */
  size(): { cols: number; rows: number } {
    this.#assertOpen();
    return { cols: this.#cols, rows: this.#rowCount };
  }
```

Now extend `packages/libghostty-vt/src/render-rect.ts`. Append:

```ts
import { RectSizeMismatch } from "./errors";
import type { RenderState } from "./render-state";
import type { RectRenderOptions, RenderRect } from "./types";

const ESC = "\x1b[";
const RESET = `${ESC}0m`;
const goto = (row: number, col: number) => `${ESC}${row};${col}H`;

/**
 * Walk the cell grid in `state` and emit ANSI bytes that paint the source
 * into the destination rectangle. Pure: no FFI calls; reads only the
 * cached cell data from the most recent `state.update()`.
 *
 * Per row: emit `goto(dest.row+y, dest.col)`, a defensive `\x1b[0m`, then
 * walk the row's cells. SGR is emitted only on transition (within-row
 * diff). Empty cells emit a single space. Wide-char continuation cells
 * are skipped (the terminal advances the cursor by 2 cells when the
 * primary cell's wide glyph renders).
 *
 * Throws `RectSizeMismatch` when `dest` dims don't equal the source's
 * cols × rows (which is 0 × 0 if `state` was never `update()`'d).
 */
export function renderRect(
  state: RenderState,
  dest: RenderRect,
  opts: RectRenderOptions,
): string {
  const size = state.size();
  if (dest.cols !== size.cols || dest.rows !== size.rows) {
    throw new RectSizeMismatch(size, dest);
  }

  const colorDepth = opts.colorDepth ?? "preserve";
  const parts: string[] = [];

  let y = 0;
  for (const row of state.rows()) {
    parts.push(goto(dest.row + y, dest.col));
    parts.push(RESET);
    let lastSgr = "";
    for (const cell of row.cells()) {
      if (cell.isWideContinuation) continue;
      const sgr = computeSgr(cell.style, colorDepth);
      if (sgr !== lastSgr) {
        parts.push(sgr || RESET);
        lastSgr = sgr;
      }
      parts.push(cell.text === "" ? " " : cell.text);
    }
    y++;
  }

  return parts.join("");
}
```

- [ ] **Step 4: Run tests to confirm they pass**

Run: `cd packages/libghostty-vt && bun test test/smoke/render-rect.test.ts test/smoke/render-rect.compute-sgr.test.ts`
Expected: PASS — all tests pass (14 from compute-sgr + 9 from render-rect).

- [ ] **Step 5: Commit**

```bash
git add packages/libghostty-vt/src/render-rect.ts packages/libghostty-vt/src/render-state.ts packages/libghostty-vt/test/smoke/render-rect.test.ts
git commit -m "feat(libghostty-vt): renderRect emission + RenderState.size()

Co-Authored-By: <YourName> (Bob 811efc4e/<your-model>)"
```

---

## Task 4: `RenderState.toAnsiRect`

**Files:**
- Modify: `packages/libghostty-vt/src/render-state.ts`

This is a thin wrapper. The heavy lifting is in `renderRect`. No new tests of its own — Task 3's tests already exercise the same path through `renderRect(rs, …)` and Task 6 verifies the convenience method's parity.

- [ ] **Step 1: Add the method to `RenderState`**

In `packages/libghostty-vt/src/render-state.ts`, add the following method just after the `size()` method (which Task 3 added):

```ts
  /**
   * Render the cached cell grid as ANSI bytes that paint into `dest`.
   * Pure transformation; no FFI calls, no `update()`. Caller controls
   * when `update()` runs.
   *
   * Throws `RectSizeMismatch` if `dest` dimensions don't equal this
   * render state's source cols × rows. Throws `UseAfterCloseError`
   * if this RenderState has been closed.
   *
   * See `Terminal.renderToAnsiRect` for a convenience that manages a
   * cached RenderState per Terminal.
   */
  toAnsiRect(dest: RenderRect, opts?: RectRenderOptions): string {
    this.#assertOpen();
    return renderRect(this, dest, opts ?? {});
  }
```

Then add the imports at the top of `render-state.ts` (alongside the other type imports):

```ts
import { renderRect } from "./render-rect";
import type { RectRenderOptions, RenderRect } from "./types";
```

(If imports already include `RenderRow, RenderCell` from `./types`, just add `RectRenderOptions, RenderRect` to that line.)

- [ ] **Step 2: Verify typecheck and the existing tests still pass**

Run: `cd packages/libghostty-vt && bun run typecheck && bun test test/smoke/render-rect.test.ts`
Expected: typecheck PASS; render-rect tests still PASS.

- [ ] **Step 3: Add a quick sanity test that the method works through the wrapper**

Append to `packages/libghostty-vt/test/smoke/render-rect.test.ts`:

```ts
test("RenderState.toAnsiRect produces same output as renderRect helper", () => {
  const { rs } = stateOf(4, 1, (t) => writeStr(t, "\x1b[1;31mABCD"));
  const direct = renderRect(rs, { row: 1, col: 1, cols: 4, rows: 1 }, {});
  const viaMethod = rs.toAnsiRect({ row: 1, col: 1, cols: 4, rows: 1 });
  expect(viaMethod).toBe(direct);
});

test("RenderState.toAnsiRect throws UseAfterCloseError after close", () => {
  const rs = new RenderState();
  rs.close();
  expect(() =>
    rs.toAnsiRect({ row: 1, col: 1, cols: 4, rows: 2 }),
  ).toThrow(/has been closed/);
});
```

Run: `cd packages/libghostty-vt && bun test test/smoke/render-rect.test.ts`
Expected: PASS — 11 tests pass.

- [ ] **Step 4: Commit**

```bash
git add packages/libghostty-vt/src/render-state.ts packages/libghostty-vt/test/smoke/render-rect.test.ts
git commit -m "feat(libghostty-vt): RenderState.toAnsiRect

Co-Authored-By: <YourName> (Bob 811efc4e/<your-model>)"
```

---

## Task 5: `RenderState.cursorInRect`

**Files:**
- Modify: `packages/libghostty-vt/src/render-state.ts`
- Test: `packages/libghostty-vt/test/smoke/cursor-in-rect.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `packages/libghostty-vt/test/smoke/cursor-in-rect.test.ts`:

```ts
import { expect, test } from "bun:test";
import { Terminal } from "../../src/terminal";
import { RenderState } from "../../src/render-state";
import { RectSizeMismatch } from "../../src/errors";

const writeStr = (term: Terminal, s: string): void => {
  term.vtWrite(new TextEncoder().encode(s));
};

test("never-updated RenderState returns null", () => {
  const rs = new RenderState();
  // 0×0 source; passing a 0×0 dest succeeds and returns null since cursor is unset
  expect(rs.cursorInRect({ row: 1, col: 1, cols: 0, rows: 0 })).toBeNull();
});

test("cursor at (0,0) of source maps to dest origin", () => {
  const term = new Terminal({ cols: 4, rows: 2 });
  // Terminal's initial cursor is at (0,0); we don't write anything so it stays.
  const rs = new RenderState();
  rs.update(term);

  const c = rs.cursorInRect({ row: 1, col: 1, cols: 4, rows: 2 });
  expect(c).not.toBeNull();
  expect(c?.row).toBe(1);
  expect(c?.col).toBe(1);
  expect(c?.wideTail).toBe(false);
});

test("cursor at (0,0) maps to non-1,1 dest origin", () => {
  const term = new Terminal({ cols: 4, rows: 2 });
  const rs = new RenderState();
  rs.update(term);

  const c = rs.cursorInRect({ row: 5, col: 10, cols: 4, rows: 2 });
  expect(c?.row).toBe(5);
  expect(c?.col).toBe(10);
});

test("cursor advances after writes", () => {
  const term = new Terminal({ cols: 4, rows: 2 });
  writeStr(term, "AB");
  const rs = new RenderState();
  rs.update(term);

  const c = rs.cursorInRect({ row: 1, col: 1, cols: 4, rows: 2 });
  expect(c).not.toBeNull();
  expect(c?.col).toBe(3); // dest.col(1) + cursor.x(2) = 3
  expect(c?.row).toBe(1); // dest.row(1) + cursor.y(0) = 1
});

test("size mismatch throws RectSizeMismatch", () => {
  const term = new Terminal({ cols: 4, rows: 2 });
  const rs = new RenderState();
  rs.update(term);
  expect(() =>
    rs.cursorInRect({ row: 1, col: 1, cols: 5, rows: 2 }),
  ).toThrow(RectSizeMismatch);
});

test("UseAfterCloseError after close", () => {
  const rs = new RenderState();
  rs.close();
  expect(() =>
    rs.cursorInRect({ row: 1, col: 1, cols: 0, rows: 0 }),
  ).toThrow(/has been closed/);
});
```

- [ ] **Step 2: Run tests to confirm they fail**

Run: `cd packages/libghostty-vt && bun test test/smoke/cursor-in-rect.test.ts`
Expected: FAIL — `cursorInRect` not yet defined.

- [ ] **Step 3: Implement `cursorInRect` on `RenderState`**

Add to `packages/libghostty-vt/src/render-state.ts`, just after `toAnsiRect`:

```ts
  /**
   * Translate the viewport cursor into 1-based host coordinates relative
   * to `dest`. Returns `null` when the viewport cursor is unset (the
   * source program has hidden the cursor or it's offscreen) or when
   * `update()` has never been called.
   *
   * Enforces the same strict size match as `toAnsiRect` — passing a
   * mismatched dest throws `RectSizeMismatch`.
   */
  cursorInRect(dest: RenderRect): RectCursor | null {
    this.#assertOpen();
    if (
      dest.cols !== this.#cols ||
      dest.rows !== this.#rowCount
    ) {
      throw new RectSizeMismatch(
        { cols: this.#cols, rows: this.#rowCount },
        { cols: dest.cols, rows: dest.rows },
      );
    }
    const cur = this.#viewportCursor;
    if (cur === undefined) return null;
    return {
      row: dest.row + cur.y,
      col: dest.col + cur.x,
      wideTail: cur.wideTail,
    };
  }
```

Add `RectCursor` and `RectSizeMismatch` to the imports at the top:

```ts
import { GhosttyError, RectSizeMismatch, UseAfterCloseError, getResultCodeName } from "./errors";
// ...
import type {
  // existing types...
  RectCursor,
  RectRenderOptions,
  RenderRect,
} from "./types";
```

- [ ] **Step 4: Run tests to confirm they pass**

Run: `cd packages/libghostty-vt && bun test test/smoke/cursor-in-rect.test.ts`
Expected: PASS — 6 tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/libghostty-vt/src/render-state.ts packages/libghostty-vt/test/smoke/cursor-in-rect.test.ts
git commit -m "feat(libghostty-vt): RenderState.cursorInRect

Co-Authored-By: <YourName> (Bob 811efc4e/<your-model>)"
```

---

## Task 6: `Terminal.renderToAnsiRect` with cached state

**Files:**
- Modify: `packages/libghostty-vt/src/terminal.ts`
- Test: `packages/libghostty-vt/test/smoke/render-rect.terminal.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `packages/libghostty-vt/test/smoke/render-rect.terminal.test.ts`:

```ts
import { expect, test } from "bun:test";
import { Terminal } from "../../src/terminal";
import { RenderState } from "../../src/render-state";

const writeStr = (term: Terminal, s: string): void => {
  term.vtWrite(new TextEncoder().encode(s));
};

test("Terminal.renderToAnsiRect returns same content as a manual RenderState", () => {
  const term = new Terminal({ cols: 4, rows: 2 });
  writeStr(term, "ABCD");

  const manual = new RenderState();
  manual.update(term);
  const expected = manual.toAnsiRect({ row: 1, col: 1, cols: 4, rows: 2 });

  const actual = term.renderToAnsiRect({ row: 1, col: 1, cols: 4, rows: 2 });
  expect(actual).toBe(expected);
});

test("Terminal.renderToAnsiRect picks up writes between calls", () => {
  const term = new Terminal({ cols: 4, rows: 2 });
  writeStr(term, "AB");
  const first = term.renderToAnsiRect({ row: 1, col: 1, cols: 4, rows: 2 });
  expect(first).toContain("AB");

  writeStr(term, "CD");
  const second = term.renderToAnsiRect({ row: 1, col: 1, cols: 4, rows: 2 });
  expect(second).toContain("ABCD");
});

test("Terminal.renderToAnsiRect picks up resize", () => {
  const term = new Terminal({ cols: 4, rows: 2 });
  writeStr(term, "ABCD");
  // First call at 4×2 succeeds
  expect(() =>
    term.renderToAnsiRect({ row: 1, col: 1, cols: 4, rows: 2 }),
  ).not.toThrow();

  term.resize(8, 2);
  // After resize, dest must match new size
  expect(() =>
    term.renderToAnsiRect({ row: 1, col: 1, cols: 4, rows: 2 }),
  ).toThrow(/RectSizeMismatch/);
  expect(() =>
    term.renderToAnsiRect({ row: 1, col: 1, cols: 8, rows: 2 }),
  ).not.toThrow();
});

test("Terminal.close disposes cached RenderState", () => {
  const term = new Terminal({ cols: 4, rows: 2 });
  // Trigger cache allocation
  term.renderToAnsiRect({ row: 1, col: 1, cols: 4, rows: 2 });
  // Close the terminal
  term.close();
  // Subsequent calls throw
  expect(() =>
    term.renderToAnsiRect({ row: 1, col: 1, cols: 4, rows: 2 }),
  ).toThrow(/closed/);
});

test("Terminal.renderToAnsiRect throws UseAfterCloseError after close", () => {
  const term = new Terminal({ cols: 4, rows: 2 });
  term.close();
  expect(() =>
    term.renderToAnsiRect({ row: 1, col: 1, cols: 4, rows: 2 }),
  ).toThrow(/closed/);
});
```

- [ ] **Step 2: Run tests to confirm they fail**

Run: `cd packages/libghostty-vt && bun test test/smoke/render-rect.terminal.test.ts`
Expected: FAIL — `renderToAnsiRect` not defined on Terminal.

- [ ] **Step 3: Add the method + cache lifecycle to Terminal**

Edit `packages/libghostty-vt/src/terminal.ts`:

(a) Add `RenderState` import at the top:

```ts
import { RenderState } from "./render-state";
import type { RectRenderOptions, RenderRect } from "./types";
```

(b) Add the cached field declaration in the Terminal class body (near other private `#` fields):

```ts
  #cachedRenderState: RenderState | null = null;
```

(c) Add the method. Place it next to the existing `snapshot()` / `cellAt()` / similar render-adjacent methods:

```ts
  /**
   * Render this Terminal's current state as ANSI bytes that paint into
   * `dest`. Convenience over `RenderState.toAnsiRect`: maintains a
   * cached `RenderState` per Terminal and `update()`s it on every call,
   * so the rendered content always reflects the Terminal's current
   * state (including after resize / vtWrite).
   *
   * Throws `RectSizeMismatch` if `dest.cols`/`dest.rows` don't equal
   * `this.snapshot().cols`/`rows`. Throws `UseAfterCloseError` if the
   * Terminal has been closed.
   *
   * For consumers that want to manage the RenderState explicitly
   * (e.g. for diff rendering later), use
   * `new RenderState(); state.update(term); state.toAnsiRect(...)`.
   */
  renderToAnsiRect(dest: RenderRect, opts?: RectRenderOptions): string {
    this.#assertOpen();
    if (this.#cachedRenderState === null) {
      this.#cachedRenderState = new RenderState();
    }
    this.#cachedRenderState.update(this);
    return this.#cachedRenderState.toAnsiRect(dest, opts);
  }
```

(d) Modify `close()` to dispose the cached RenderState. Find the existing `close()` method (search for `close(): void`) and add the disposal at the very top of the method body, before any other teardown:

```ts
  close(): void {
    this.#assertNotInCallback("close");
    if (this.#closed) return;
    // Dispose the cached RenderState (Pass 4) before the Terminal handle
    // is freed so libghostty's render-state handle is released first.
    if (this.#cachedRenderState !== null) {
      try { this.#cachedRenderState.close(); } catch {}
      this.#cachedRenderState = null;
    }
    // ... existing teardown remains below ...
```

The exact position depends on the existing code; key invariant: **cached RenderState close MUST happen before the Terminal handle close** (since libghostty render-state handles are owned/derived from the Terminal).

- [ ] **Step 4: Run tests to confirm they pass**

Run: `cd packages/libghostty-vt && bun test test/smoke/render-rect.terminal.test.ts`
Expected: PASS — 5 tests pass.

- [ ] **Step 5: Run all render-rect tests**

Run: `cd packages/libghostty-vt && bun test test/smoke/render-rect.compute-sgr.test.ts test/smoke/render-rect.test.ts test/smoke/cursor-in-rect.test.ts test/smoke/render-rect.terminal.test.ts`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/libghostty-vt/src/terminal.ts packages/libghostty-vt/test/smoke/render-rect.terminal.test.ts
git commit -m "feat(libghostty-vt): Terminal.renderToAnsiRect with cached state

Co-Authored-By: <YourName> (Bob 811efc4e/<your-model>)"
```

---

## Task 7: Public exports

**Files:**
- Modify: `packages/libghostty-vt/src/index.ts`

- [ ] **Step 1: Update exports**

Edit `packages/libghostty-vt/src/index.ts`:

(a) Find the existing type re-exports block (the one that lists `RGB, PaletteIndex, …`). Add the three new types:

```ts
export type {
  RGB,
  PaletteIndex,
  CursorStyle,
  MouseTracking,
  ModeName,
  TerminalColors,
  TerminalOptions,
  TerminalSnapshot,
  FormatterOptions,
  UnderlineStyle,
  CellStyle,
  CellInfo,
  CellAtPoint,
  ViewportCursor,
  RenderRow,
  RenderCell,
  RenderRect,
  RectRenderOptions,
  RectCursor,
} from "./types";
```

(b) Find the existing error exports and add `RectSizeMismatch`:

```ts
export {
  GhosttyError,
  LibraryNotFoundError,
  UnsupportedPlatformError,
  LibraryCompatibilityError,
  UseAfterCloseError,
  RectSizeMismatch,
} from "./errors";
```

- [ ] **Step 2: Verify typecheck and full test suite still pass**

Run: `cd packages/libghostty-vt && bun run typecheck && bun test test/smoke`
Expected: typecheck PASS; all libghostty-vt smoke tests pass.

- [ ] **Step 3: Add an exports sanity test**

Append to `packages/libghostty-vt/test/smoke/render-rect.terminal.test.ts`:

```ts
test("public exports include the new render-rect surface", async () => {
  const mod = await import("../../src/index");
  expect(typeof mod.RectSizeMismatch).toBe("function");
  // Type-only exports don't appear at runtime; this test guards the
  // value-shaped exports only. Types are checked at compile time.
});
```

Run: `cd packages/libghostty-vt && bun test test/smoke/render-rect.terminal.test.ts`
Expected: PASS — 6 tests pass.

- [ ] **Step 4: Commit**

```bash
git add packages/libghostty-vt/src/index.ts packages/libghostty-vt/test/smoke/render-rect.terminal.test.ts
git commit -m "feat(libghostty-vt): export render-rect public surface

Co-Authored-By: <YourName> (Bob 811efc4e/<your-model>)"
```

---

## Task 8: Integration test — verify program escapes don't leak

**Files:**
- Create: `packages/libghostty-vt/test/smoke/render-rect.integration.test.ts`

This is the ground-truth test for the design's whole reason for existing.

- [ ] **Step 1: Write the integration test**

Create `packages/libghostty-vt/test/smoke/render-rect.integration.test.ts`:

```ts
import { expect, test } from "bun:test";
import { Terminal } from "../../src/terminal";
import { RenderState } from "../../src/render-state";

const writeStr = (term: Terminal, s: string): void => {
  term.vtWrite(new TextEncoder().encode(s));
};

/**
 * The motivating bug for this feature: a TUI program (e.g. NetHack)
 * writes a cursor-positioning escape after its render. If the consumer
 * splices the formatter's output into its own stream, that escape jumps
 * the host cursor and clobbers content elsewhere.
 *
 * `Terminal.renderToAnsiRect` walks the parsed cell grid and emits its
 * own cursor positioning. The program's own escapes get consumed by
 * libghostty's parser when they arrive via `vtWrite`; they MUST NOT
 * appear in the rect render's output.
 */
test("program cursor-positioning escapes do not leak into rect output", () => {
  const term = new Terminal({ cols: 8, rows: 4 });
  // Write some text, then a cursor-position escape (\x1b[3;5H = row 3 col 5)
  writeStr(term, "ABCD\r\n");
  writeStr(term, "EFGH\x1b[3;5H");

  const out = term.renderToAnsiRect({ row: 1, col: 1, cols: 8, rows: 4 }, {});
  // The program's positioning sequence MUST NOT appear in the output.
  expect(out).not.toContain("\x1b[3;5H");
  // Only our own row-start gotos are allowed (row 1-4, col 1).
  const allGotos = out.match(/\x1b\[\d+;\d+H/g) ?? [];
  for (const g of allGotos) {
    expect(g).toMatch(/^\x1b\[[1-4];1H$/);
  }
});

test("erase-in-line escapes do not leak", () => {
  const term = new Terminal({ cols: 4, rows: 1 });
  // Write text + erase-line. Whatever the visible result, the \x1b[K MUST NOT
  // appear in our rect output.
  writeStr(term, "AB\x1b[K");
  const out = term.renderToAnsiRect({ row: 1, col: 1, cols: 4, rows: 1 }, {});
  expect(out).not.toContain("\x1b[K");
});

test("alt-screen toggle escapes do not leak", () => {
  const term = new Terminal({ cols: 4, rows: 1 });
  // The DEC private modes for alt-screen (1049, 47) MUST NOT appear in output.
  writeStr(term, "\x1b[?1049hABCD");
  const out = term.renderToAnsiRect({ row: 1, col: 1, cols: 4, rows: 1 }, {});
  expect(out).not.toContain("\x1b[?1049h");
  expect(out).not.toContain("\x1b[?1049l");
});

test("OSC title sequences do not leak", () => {
  const term = new Terminal({ cols: 4, rows: 1 });
  writeStr(term, "\x1b]0;hello\x07ABCD");
  const out = term.renderToAnsiRect({ row: 1, col: 1, cols: 4, rows: 1 }, {});
  expect(out).not.toContain("\x1b]");
  expect(out).not.toContain("\x07");
});

test("convenience method matches manual RenderState path byte-for-byte", () => {
  const term = new Terminal({ cols: 8, rows: 2 });
  writeStr(term, "\x1b[1;31mAB\x1b[0mCD\r\nE\x1b[44m F\x1b[0m");

  const convenience = term.renderToAnsiRect(
    { row: 5, col: 10, cols: 8, rows: 2 },
    {},
  );

  const rs = new RenderState();
  rs.update(term);
  const manual = rs.toAnsiRect({ row: 5, col: 10, cols: 8, rows: 2 });

  expect(convenience).toBe(manual);
});
```

- [ ] **Step 2: Run the integration tests**

Run: `cd packages/libghostty-vt && bun test test/smoke/render-rect.integration.test.ts`
Expected: PASS — 5 tests pass.

If any test fails because libghostty-vt represents an escape sequence
differently than expected (e.g. the OSC test fails because libghostty's
toAnsi emits its own OSC for some reason), report findings before
patching — the goal is to verify nothing leaks, not to mask leakage.

- [ ] **Step 3: Run the full smoke suite to make sure nothing regressed**

Run: `cd packages/libghostty-vt && bun test test/smoke`
Expected: all PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/libghostty-vt/test/smoke/render-rect.integration.test.ts
git commit -m "test(libghostty-vt): integration — program escapes don't leak through rect render

Co-Authored-By: <YourName> (Bob 811efc4e/<your-model>)"
```

---

## Task 9: Tarball smoke extension

**Files:**
- Modify: `packages/libghostty-vt/scripts/run-tarball-smoke.sh`

The tarball smoke test packs the binding, installs it into a throwaway directory, and runs a tiny script that imports + uses it. We extend the throwaway script to call the new methods so a regression in the export list will fail this gate.

- [ ] **Step 1: Read the current tarball smoke script**

Run: `cat packages/libghostty-vt/scripts/run-tarball-smoke.sh`

Identify the section that builds the throwaway script (typically a heredoc that writes a `.ts` file inside a temp dir). Extend that script.

- [ ] **Step 2: Add a render-rect stanza to the throwaway script**

Inside the heredoc that constructs the temporary smoke script, locate where it imports from `libghostty-vt` and runs basic operations. After the existing operations, add:

```ts
// Pass 4 / 0.4.0 surface: render-rect
import { Terminal, RenderState, RectSizeMismatch } from "libghostty-vt";

const t = new Terminal({ cols: 4, rows: 2 });
t.vtWrite(new TextEncoder().encode("AB"));

// Convenience method
const out = t.renderToAnsiRect({ row: 1, col: 1, cols: 4, rows: 2 });
if (!out.includes("AB")) throw new Error("renderToAnsiRect missing content");

// Primitive path
const rs = new RenderState();
rs.update(t);
const primitive = rs.toAnsiRect({ row: 1, col: 1, cols: 4, rows: 2 });
if (out !== primitive) {
  throw new Error("convenience and primitive paths diverged");
}

// Cursor helper
const c = rs.cursorInRect({ row: 1, col: 1, cols: 4, rows: 2 });
if (c === null) throw new Error("cursorInRect returned null unexpectedly");

// Error path
let threw = false;
try { rs.toAnsiRect({ row: 1, col: 1, cols: 5, rows: 2 }); }
catch (e) { if (e instanceof RectSizeMismatch) threw = true; }
if (!threw) throw new Error("RectSizeMismatch not thrown on size mismatch");

t.close();
console.log("render-rect smoke passed");
```

The exact line where to insert this depends on the existing script structure. Place it before the script's success print (or merge with whatever final-OK message exists). If the smoke script is structured as multiple smaller files / commands rather than one heredoc, follow the existing pattern.

- [ ] **Step 3: Run the tarball smoke**

Run: `bash packages/libghostty-vt/scripts/run-tarball-smoke.sh`
Expected: PASS — script prints "render-rect smoke passed" alongside any pre-existing success message; exit 0.

This step is slow (packs + installs into a temp project). If it takes >120s, that's normal.

- [ ] **Step 4: Commit**

```bash
git add packages/libghostty-vt/scripts/run-tarball-smoke.sh
git commit -m "test(libghostty-vt): tarball smoke covers render-rect surface

Co-Authored-By: <YourName> (Bob 811efc4e/<your-model>)"
```

---

## Task 10: Version + CHANGELOG

**Files:**
- Modify: `packages/libghostty-vt/package.json`
- Modify: `packages/libghostty-vt/CHANGELOG.md`

- [ ] **Step 1: Bump version**

Edit `packages/libghostty-vt/package.json`:

```diff
-  "version": "0.3.0",
+  "version": "0.4.0",
```

- [ ] **Step 2: Add CHANGELOG entry**

Read `packages/libghostty-vt/CHANGELOG.md` first to confirm the format. Add a new entry under the "[0.3.0]" entry (newest first, per Keep a Changelog format):

```markdown
## [0.4.0] — 2026-04-25

### Added

- `RenderState.toAnsiRect(dest, opts)` — render the cached cell grid as
  ANSI bytes that paint into a destination rectangle. Pure transformation;
  consumer controls when `update()` runs.
- `RenderState.cursorInRect(dest)` — translate the viewport cursor into
  1-based host coordinates, returning `null` when the cursor is unset.
- `RenderState.size()` — read the source dimensions from the most recent
  `update()`.
- `Terminal.renderToAnsiRect(dest, opts)` — convenience that maintains a
  cached `RenderState` per Terminal and `update()`s it on every call.
- `RectSizeMismatch` error — thrown when destination dimensions don't
  equal source dimensions.
- New types: `RenderRect`, `RectRenderOptions`, `RectCursor`.

### Changed

- `Terminal.close()` now disposes the cached `RenderState` (if any) before
  freeing the Terminal handle.
```

(Date is the date of the release; if the implementer is landing this on
a different day, update accordingly.)

- [ ] **Step 3: Run all tests + typecheck one more time**

Run: `cd packages/libghostty-vt && bun run typecheck && bun test test/smoke`
Expected: typecheck PASS; all libghostty-vt smoke tests pass.

- [ ] **Step 4: Commit**

```bash
git add packages/libghostty-vt/package.json packages/libghostty-vt/CHANGELOG.md
git commit -m "chore(libghostty-vt): release v0.4.0 — render-rect

Co-Authored-By: <YourName> (Bob 811efc4e/<your-model>)"
```

---

## Task 11: Final verification

- [ ] **Step 1: Full typecheck across the workspace**

Run from the worktree root:
```bash
cd packages/libghostty-vt && bun run typecheck && cd ../blinkyterm && bun run typecheck
```
Expected: PASS for both packages.

- [ ] **Step 2: Full smoke suite for libghostty-vt**

Run: `cd packages/libghostty-vt && bun test test/smoke`
Expected: all PASS — both pre-existing tests and the new `render-rect.*.test.ts` files.

- [ ] **Step 3: ABI trip-wire**

Run: `cd packages/libghostty-vt && bun run verify:generated`
Expected: PASS — render-rect doesn't change FFI bindings.

- [ ] **Step 4: Tarball smoke**

Run: `bash packages/libghostty-vt/scripts/run-tarball-smoke.sh`
Expected: PASS — includes the new render-rect stanza.

- [ ] **Step 5: Confirm clean state**

Run from worktree root: `git status --short && git log --oneline main..HEAD`

Expected:
- `git status` shows clean (or only the pre-existing `.tmp/` build
  artifact under `packages/libghostty-vt/.tmp/`).
- `git log` shows the Pass 4 commits in order:
  ```
  chore(libghostty-vt): release v0.4.0 — render-rect
  test(libghostty-vt): tarball smoke covers render-rect surface
  test(libghostty-vt): integration — program escapes don't leak through rect render
  feat(libghostty-vt): export render-rect public surface
  feat(libghostty-vt): Terminal.renderToAnsiRect with cached state
  feat(libghostty-vt): RenderState.cursorInRect
  feat(libghostty-vt): RenderState.toAnsiRect
  feat(libghostty-vt): renderRect emission + RenderState.size()
  feat(libghostty-vt): computeSgr — reset-prefixed CSI builder
  feat(libghostty-vt): RenderRect types + RectSizeMismatch error
  ```

If any of those is missing or out of order, fix before tagging.

The `libghostty-vt@0.4.0` git tag is a human gate — left for the user to
apply when they're ready to merge and publish, since tagging triggers
release tooling.
