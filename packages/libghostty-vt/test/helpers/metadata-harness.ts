import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Terminal } from "../../src/terminal";
import { RenderState } from "../../src/render-state";
import type { RGB, CellStyle } from "../../src/types";

export interface MetadataSnapshot {
  geometry: { cols: number; rows: number };
  terminal: {
    cursor: { x: number; y: number; visible: boolean };
    viewportCursor?: { x: number; y: number; visible: boolean; wideTail: boolean };
    activeScreen: "primary" | "alternate";
    title?: string;
    pwd?: string;
    scrollbackRows: number;
  };
  colors: {
    effective: { fg?: RGB; bg?: RGB; cursor?: RGB };
    defaults: { fg?: RGB; bg?: RGB; cursor?: RGB };
    palette: readonly RGB[];
  };
  rows: Array<{
    y: number;
    wrapped: boolean;
    cells: Array<{
      x: number;
      text: string;
      wide?: true;
      isWideContinuation?: true;
      style?: CellStyle;
      hyperlinkUri?: string;
      protected?: true;
    }>;
  }>;
}

export interface MetadataFixtureResult {
  name: string;
  pass: boolean;
  diff?: string;
}

export async function runMetadataFixture(
  fixturesDir: string,
  name: string,
  geometry: { cols: number; rows: number },
  opts: { update: boolean } = { update: false },
): Promise<MetadataFixtureResult> {
  const binPath = join(fixturesDir, `${name}.bin`);
  const jsonPath = join(fixturesDir, `${name}.expected.json`);

  const bin = new Uint8Array(await readFile(binPath));
  using term = new Terminal({ cols: geometry.cols, rows: geometry.rows });
  term.vtWrite(bin);
  using rs = new RenderState();
  rs.update(term);

  const actual = snapshotToJson(term, rs, geometry);
  const actualStr = JSON.stringify(actual, null, 2);

  if (opts.update) {
    await writeFile(jsonPath, actualStr + "\n", "utf8");
    return { name, pass: true };
  }

  const expectedStr = await readFile(jsonPath, "utf8").catch(() => "");
  if (actualStr.trim() === expectedStr.trim()) {
    return { name, pass: true };
  }
  return {
    name,
    pass: false,
    diff: structuredDiff(expectedStr, actualStr),
  };
}

export function snapshotToJson(
  term: Terminal,
  rs: RenderState,
  geometry: { cols: number; rows: number },
): MetadataSnapshot {
  const snap = term.snapshot();
  const colors = term.colors();
  const viewportCursor = rs.cursor();

  const rows: MetadataSnapshot["rows"] = [];
  for (const row of rs.rows()) {
    const cells: MetadataSnapshot["rows"][number]["cells"] = [];
    for (const cell of row.cells()) {
      const entry: MetadataSnapshot["rows"][number]["cells"][number] = {
        x: cell.x,
        text: cell.text,
      };
      if (cell.wide) entry.wide = true;
      if (cell.isWideContinuation) entry.isWideContinuation = true;
      if (cell.style) entry.style = cell.style;
      if (cell.hyperlinkUri) entry.hyperlinkUri = cell.hyperlinkUri;
      if (cell.protected) entry.protected = true;
      cells.push(entry);
    }
    rows.push({ y: row.y, wrapped: row.wrapped, cells });
  }

  const terminal: MetadataSnapshot["terminal"] = {
    cursor: { x: snap.cursor.x, y: snap.cursor.y, visible: snap.cursor.visible },
    activeScreen: snap.activeScreen,
    scrollbackRows: snap.scrollbackRows,
  };
  if (viewportCursor) {
    terminal.viewportCursor = {
      x: viewportCursor.x,
      y: viewportCursor.y,
      visible: viewportCursor.visible,
      wideTail: viewportCursor.wideTail,
    };
  }
  if (snap.title !== undefined) terminal.title = snap.title;
  if (snap.pwd !== undefined) terminal.pwd = snap.pwd;

  const effective: MetadataSnapshot["colors"]["effective"] = {};
  if (colors.effective.fg !== undefined) effective.fg = colors.effective.fg;
  if (colors.effective.bg !== undefined) effective.bg = colors.effective.bg;
  if (colors.effective.cursor !== undefined) effective.cursor = colors.effective.cursor;

  const defaults: MetadataSnapshot["colors"]["defaults"] = {};
  if (colors.defaults.fg !== undefined) defaults.fg = colors.defaults.fg;
  if (colors.defaults.bg !== undefined) defaults.bg = colors.defaults.bg;
  if (colors.defaults.cursor !== undefined) defaults.cursor = colors.defaults.cursor;

  return {
    geometry,
    terminal,
    colors: {
      effective,
      defaults,
      palette: colors.palette, // preserve index order; no sort
    },
    rows,
  };
}

/**
 * Produce a readable diff when fixture JSON doesn't match. Avoids a raw
 * JSON string diff (unreadable on 24×80 grids). Reports at row + cell
 * granularity.
 */
function structuredDiff(expectedStr: string, actualStr: string): string {
  if (!expectedStr) return "expected fixture is empty or missing; regenerate with UPDATE_FIXTURES=1";
  let expected: MetadataSnapshot;
  let actual: MetadataSnapshot;
  try {
    expected = JSON.parse(expectedStr);
    actual = JSON.parse(actualStr);
  } catch {
    return "expected file is not valid JSON; cannot structured-diff";
  }

  const diffs: string[] = [];
  if (expected.geometry.cols !== actual.geometry.cols) {
    diffs.push(`geometry.cols: expected ${expected.geometry.cols}, got ${actual.geometry.cols}`);
  }
  if (expected.geometry.rows !== actual.geometry.rows) {
    diffs.push(`geometry.rows: expected ${expected.geometry.rows}, got ${actual.geometry.rows}`);
  }
  if (JSON.stringify(expected.terminal) !== JSON.stringify(actual.terminal)) {
    diffs.push(`terminal: expected ${JSON.stringify(expected.terminal)}, got ${JSON.stringify(actual.terminal)}`);
  }

  const rowCount = Math.max(expected.rows.length, actual.rows.length);
  for (let y = 0; y < rowCount; y += 1) {
    const er = expected.rows[y];
    const ar = actual.rows[y];
    if (!er || !ar) {
      diffs.push(`row ${y}: ${er ? "missing in actual" : "extra in actual"}`);
      continue;
    }
    if (JSON.stringify(er.cells) !== JSON.stringify(ar.cells)) {
      // Per-cell comparison to narrow the diff.
      const cellCount = Math.max(er.cells.length, ar.cells.length);
      for (let x = 0; x < cellCount; x += 1) {
        const ec = er.cells[x];
        const ac = ar.cells[x];
        if (JSON.stringify(ec) !== JSON.stringify(ac)) {
          diffs.push(`row ${y} col ${x}: expected ${JSON.stringify(ec)}, got ${JSON.stringify(ac)}`);
        }
      }
    }
  }

  return diffs.slice(0, 40).join("\n") + (diffs.length > 40 ? `\n... (${diffs.length - 40} more)` : "");
}
