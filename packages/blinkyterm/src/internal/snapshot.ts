import { Formatter, type RenderCell, type RenderState, type Terminal } from "libghostty-vt";
import type { CellInfo, FrameSnapshot } from "../types";

interface BuildFrameSnapshotOptions {
  terminal: Terminal;
  renderState: RenderState;
  bellsSinceLast: number;
  titleChangesSinceLast: readonly string[];
}

interface FrozenCell extends CellInfo {
  readonly x: number;
  readonly y: number;
}

function copyCell(cell: RenderCell, y: number): FrozenCell {
  const out: FrozenCell = Object.freeze({
    x: cell.x,
    y,
    text: cell.text,
    wide: cell.wide,
    isWideContinuation: cell.isWideContinuation,
    ...(cell.style !== undefined ? { style: Object.freeze({ ...cell.style }) } : {}),
    ...(cell.hyperlinkUri !== undefined ? { hyperlinkUri: cell.hyperlinkUri } : {}),
    protected: cell.protected,
  });
  return out;
}

export function buildFrameSnapshot(opts: BuildFrameSnapshotOptions): FrameSnapshot {
  const termSnap = opts.terminal.snapshot();
  const text = new Formatter({ format: "plain" }).formatString(opts.terminal);
  const vt = new Formatter({ format: "vt", style: true, cursor: true }).formatString(opts.terminal);
  const html = new Formatter({ format: "html", style: true, hyperlink: true }).formatString(opts.terminal);
  const rows = new Map<number, FrozenCell[]>();
  for (const row of opts.renderState.rows()) {
    rows.set(row.y, [...row.cells()].map((cell) => copyCell(cell, row.y)));
  }

  const cursor = Object.freeze({
    x: termSnap.cursor.x,
    y: termSnap.cursor.y,
    visible: termSnap.cursor.visible,
  });
  const titleChangesSinceLast = Object.freeze([...opts.titleChangesSinceLast]);

  const snapshot: FrameSnapshot = {
    text,
    title: termSnap.title ?? "",
    cursor,
    bellsSinceLast: opts.bellsSinceLast,
    titleChangesSinceLast,
    toAnsi: () => vt,
    toHtml: () => html,
    toVt: () => vt,
    cellAt(x, y) {
      const cell = rows.get(y)?.find((candidate) => candidate.x === x);
      return cell ?? null;
    },
  };
  return Object.freeze(snapshot);
}
