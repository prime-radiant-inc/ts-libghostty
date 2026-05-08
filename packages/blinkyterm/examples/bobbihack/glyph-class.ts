// Two-class glyph classification for autopilot interrupts.
//
// NetHack 5.0.0 with `hilite_pet` set renders pet glyphs (kitten, dog,
// etc.) with SGR 7 (inverse video). Probe results in
// docs/superpowers/specs/2026-05-07-bobbihack-attribute-aware-interrupts-design.md
// confirm the player's `@` does NOT pick up `inverse`, so `inverse: true`
// on a letter glyph reliably indicates a pet (in this build).
//
// Peacefuls (shopkeepers, priests, the Oracle, watchmen) have no
// distinguishing attribute in NetHack 5.0.0 — `hilite_peaceful` is a
// rejected option. They land in `normal` and trip `monster_visible` like a
// hostile would. This is a known limitation; the union has room to grow a
// `peaceful` arm later if we add a different signal.

import type { CellStyle } from "libghostty-vt";
import type { FrameSnapshot } from "../../src/types";

export type GlyphClass = "pet" | "normal";

/**
 * Classify a single cell. Returns:
 *   - "pet"      — letter or `@` with `style.inverse === true`.
 *   - "normal"   — letter or `@` without `inverse`. Treated as hostile by
 *                  the detector; peacefuls also land here.
 *   - undefined  — text isn't a single tracked glyph (terrain, items,
 *                  cursor, multi-char, empty).
 *
 * Pure function. Does not consult the player position; the caller filters
 * the player's own `@` upstream by comparing (x, y) to
 * `map.currentPlayerXY`. The probe confirmed the player's `@` is never
 * `inverse: true`, so even without that filter the player won't be
 * misclassified as a pet — but the position check is still the correct
 * guard.
 */
export function classifyCell(
  text: string,
  style: CellStyle | undefined,
): GlyphClass | undefined {
  if (text.length !== 1) return undefined;
  const isLetter = /^[a-zA-Z]$/.test(text);
  const isAt = text === "@";
  if (!isLetter && !isAt) return undefined;
  return style?.inverse === true ? "pet" : "normal";
}

/**
 * Build a sparse 2D grid of glyph classifications matching `rows`.
 * `glyphClass[y][x]` is `undefined` for cells we don't track and for the
 * player's own `@` at `playerXY`.
 *
 * The returned arrays are not frozen — callers shouldn't mutate them, but
 * the perf cost of freezing per-cell isn't worth it for a per-frame walk.
 */
export function buildGlyphClass(
  snapshot: FrameSnapshot,
  rows: ReadonlyArray<string>,
  playerXY: { x: number; y: number } | null,
): ReadonlyArray<ReadonlyArray<GlyphClass | undefined>> {
  const grid: (GlyphClass | undefined)[][] = new Array(rows.length);
  for (let y = 0; y < rows.length; y++) {
    const row = rows[y]!;
    const lineLen = row.length;
    const line: (GlyphClass | undefined)[] = new Array(lineLen);
    for (let x = 0; x < lineLen; x++) {
      // Filter the player's own `@` upstream — it's not a monster, so it
      // shouldn't carry a class even if it ever did get inverse rendering.
      if (playerXY !== null && playerXY.x === x && playerXY.y === y) {
        line[x] = undefined;
        continue;
      }
      const ch = row[x] ?? "";
      // Cheap reject: skip non-letter / non-@ before any cellAt() lookup.
      if (ch.length !== 1 || (!/^[a-zA-Z@]$/.test(ch))) {
        line[x] = undefined;
        continue;
      }
      const cell = snapshot.cellAt(x, y);
      line[x] = classifyCell(cell?.text ?? ch, cell?.style);
    }
    grid[y] = line;
  }
  return grid;
}
