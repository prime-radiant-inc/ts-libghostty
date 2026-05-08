// v2 cell classifier for the bobbihack autopilot.
//
// Produces a `(terrain, foreground)` tuple per FrameSnapshot cell, exposing
// the letter / pet / color information the v1 `classifyGlyph` +
// `glyph-class.ts:classifyCell` pair collapsed away.
//
// This module is the new shape; the v1 modules stay in place during the
// Phase 1 refactor and the cutover happens in Phase 2.
//
// Source of truth for the MonsterClass enumeration: NetHack 5.0
// `include/defsym.h` MONSYM macro (60 entries, IDs 1..60). We split
// `INVISIBLE` (`I`, ID 35) out of the class union — it surfaces as
// `foreground.kind === 'unseen-monster'` instead, since its semantics
// (a placeholder for a creature we cannot classify) are categorically
// different.

import type { CellInfo, CellStyle } from "libghostty-vt";
import type { FrameSnapshot } from "../../src/types";
import { classifyTerrain, type TileKind } from "./parsers";

// 58 monster classes. Mirrors MONSYM minus INVISIBLE — see header comment.
// `ghost` corresponds to the ` ` (space) char, which we do not treat as a
// classifiable cell (most blank cells are unknown terrain). The class name
// stays in the union for completeness; LETTER_TO_CLASS does not produce it.
export type MonsterClass =
  | "ant"
  | "blob"
  | "cockatrice"
  | "dog"
  | "eye"
  | "feline"
  | "gremlin"
  | "humanoid"
  | "imp"
  | "jelly"
  | "kobold"
  | "leprechaun"
  | "mimic"
  | "nymph"
  | "orc"
  | "piercer"
  | "quadruped"
  | "rodent"
  | "spider"
  | "trapper"
  | "unicorn"
  | "vortex"
  | "worm"
  | "xan"
  | "light"
  | "zruty"
  | "angel"
  | "bat"
  | "centaur"
  | "dragon"
  | "elemental"
  | "fungus"
  | "gnome"
  | "giant"
  | "jabberwock"
  | "kop"
  | "lich"
  | "mummy"
  | "naga"
  | "ogre"
  | "pudding"
  | "quantmech"
  | "rustmonst"
  | "snake"
  | "troll"
  | "umber"
  | "vampire"
  | "wraith"
  | "xorn"
  | "yeti"
  | "zombie"
  | "human"
  | "ghost"
  | "golem"
  | "demon"
  | "eel"
  | "lizard"
  | "worm-tail"
  | "mimic-def";

// Mapping from glyph char → MonsterClass. 58 entries:
//   26 lowercase letters (a..z)
//   25 uppercase letters (A..Z minus 'I', which is unseen-monster)
//   7 specials: '@', "'", '&', ';', ':', '~', ']'
//
// Per MONSYM in NetHack-5.0/include/defsym.h. The space-ghost MONSYM(54)
// is intentionally absent from this table — see header comment.
export const LETTER_TO_CLASS: Readonly<Record<string, MonsterClass>> = {
  a: "ant",
  b: "blob",
  c: "cockatrice",
  d: "dog",
  e: "eye",
  f: "feline",
  g: "gremlin",
  h: "humanoid",
  i: "imp",
  j: "jelly",
  k: "kobold",
  l: "leprechaun",
  m: "mimic",
  n: "nymph",
  o: "orc",
  p: "piercer",
  q: "quadruped",
  r: "rodent",
  s: "spider",
  t: "trapper",
  u: "unicorn",
  v: "vortex",
  w: "worm",
  x: "xan",
  y: "light",
  z: "zruty",
  A: "angel",
  B: "bat",
  C: "centaur",
  D: "dragon",
  E: "elemental",
  F: "fungus",
  G: "gnome",
  H: "giant",
  // I = INVISIBLE → handled as foreground.kind === 'unseen-monster'.
  J: "jabberwock",
  K: "kop",
  L: "lich",
  M: "mummy",
  N: "naga",
  O: "ogre",
  P: "pudding",
  Q: "quantmech",
  R: "rustmonst",
  S: "snake",
  T: "troll",
  U: "umber",
  V: "vampire",
  W: "wraith",
  X: "xorn",
  Y: "yeti",
  Z: "zombie",
  "@": "human",
  "'": "golem",
  "&": "demon",
  ";": "eel",
  ":": "lizard",
  "~": "worm-tail",
  "]": "mimic-def",
};

// Foreground describes any transient overlaying the terrain.
export type Foreground =
  | { kind: "player" }
  | {
      kind: "monster";
      letter: string;
      class: MonsterClass;
      color: number;
      pet: boolean;
      bold: boolean;
    }
  | { kind: "item"; letter: string; color: number }
  | { kind: "unseen-monster" }
  | { kind: "warning"; tier: 1 | 2 | 3 | 4 | 5 };

// Per-cell classification tuple. `terrain` is the persistent layer (floor,
// wall, door, …); `foreground` is the per-frame transient layer
// (monster, item, marker). Both can be null: an empty/unclassified cell
// outside the map has `terrain: null, foreground: null`.
export interface ClassifiedCell {
  terrain: TileKind | null;
  foreground: Foreground | null;
}

// SGR foreground color → CLR_* (0..15) per NetHack 5.0/include/color.h.
//
// libghostty-vt's `CellStyle.fg` is either an `RGB` triplet
// (`readonly [r, g, b]`) or a `PaletteIndex` (`{ palette: number }`).
// NetHack's terminal renderer uses the basic 16-color palette (0..15).
// Indices 0..7 are the standard colors, 8..15 the bright variants. We
// pass-through if the palette index is in range; otherwise we return -1
// to indicate "unknown / not in the basic palette". RGB inputs likewise
// return -1 because we don't reverse-map RGB to palette here.
export function colorFromStyle(style: CellStyle | undefined): number {
  if (style === undefined) return -1;
  const fg = style.fg;
  if (fg === undefined) return -1;
  // PaletteIndex is `{ palette: number }`. RGB is `readonly [r, g, b]`.
  if (Array.isArray(fg)) return -1;
  if (typeof fg === "object" && "palette" in fg) {
    const idx = fg.palette;
    if (typeof idx === "number" && idx >= 0 && idx <= 15) return idx;
    return -1;
  }
  return -1;
}

// Item glyphs per the NetHack default charset. Excludes letters and the
// monster-special chars claimed by `LETTER_TO_CLASS`. The `[` armor glyph
// is here; `]` is mimic-def in `LETTER_TO_CLASS` and takes precedence.
const ITEM_GLYPH_RE = /^[?!()=*$%/"\[]$/u;

// Single-cell classifier. Computes terrain (consulting color for the
// `}` water-vs-lava and `#` corridor-vs-tree disambiguation) and then
// the foreground (player/monster/item/unseen-monster/warning).
//
// `position` and `playerXY` are consulted only to flag the player's `@`
// as `kind: 'player'`. Without them, a `@` is classified as a `human`
// monster (which is the correct semantics for any *other* `@` on screen,
// e.g. an elf or a shopkeeper).
//
// Order of precedence:
//   1. Terrain glyphs (`.`, `|`, etc.) → terrain set, foreground null.
//   2. The player's `@` at `playerXY` → foreground 'player'.
//   3. The 'I' marker → foreground 'unseen-monster'.
//   4. Digits 1..5 → foreground 'warning'.
//   5. LETTER_TO_CLASS lookup → foreground 'monster'.
//   6. Item glyph regex → foreground 'item'.
//   7. Otherwise foreground null.
export function classifyCell(
  text: string,
  style: CellStyle | undefined,
  position?: { x: number; y: number },
  playerXY?: { x: number; y: number } | null,
): ClassifiedCell {
  if (text.length !== 1) {
    return { terrain: null, foreground: null };
  }

  const terrain = classifyTerrain(text, style);

  // Player's own `@` short-circuits to the player foreground regardless
  // of what LETTER_TO_CLASS would say.
  if (
    text === "@" &&
    playerXY !== null &&
    playerXY !== undefined &&
    position !== undefined &&
    position.x === playerXY.x &&
    position.y === playerXY.y
  ) {
    return { terrain, foreground: { kind: "player" } };
  }

  // Unseen-monster marker (NetHack 5.0 MONSYM 35: INVISIBLE).
  if (text === "I") {
    return { terrain, foreground: { kind: "unseen-monster" } };
  }

  // Warning digits 1..5. The Warning extrinsic surfaces a 1-char digit
  // on a map cell; the digit's tier corresponds to the danger of the
  // detected creature.
  if (text >= "1" && text <= "5") {
    const tier = (text.charCodeAt(0) - "0".charCodeAt(0)) as 1 | 2 | 3 | 4 | 5;
    return { terrain, foreground: { kind: "warning", tier } };
  }

  // Monster-class lookup (covers @, &, ', ;, :, ~, ] specials).
  const klass = LETTER_TO_CLASS[text];
  if (klass !== undefined) {
    return {
      terrain,
      foreground: {
        kind: "monster",
        letter: text,
        class: klass,
        color: colorFromStyle(style),
        pet: style?.inverse === true,
        bold: style?.bold === true,
      },
    };
  }

  // Item glyphs.
  if (ITEM_GLYPH_RE.test(text)) {
    return {
      terrain,
      foreground: {
        kind: "item",
        letter: text,
        color: colorFromStyle(style),
      },
    };
  }

  // Plain terrain or unrecognized cell — no foreground.
  return { terrain, foreground: null };
}

// Map-row guard. NetHack uses row 0 for the message line and the bottom
// two rows for status. Map cells live on rows 1..rows.length-3 inclusive.
// Mirrors `interrupts.ts:isMapRow` semantics; duplicated here so the
// classifier doesn't depend on the interrupts module.
function isMapRow(y: number, totalRows: number): boolean {
  return y >= 1 && y <= totalRows - 3;
}

// Build a 2D grid of `ClassifiedCell` matching the rows array.
//
// Rows outside the map region (row 0 message line, last two status rows)
// are filled with the empty `{ terrain: null, foreground: null }`
// placeholder so callers can index without bounds checks.
//
// The player's `@` at `playerXY` is classified as `kind: 'player'`
// instead of a human monster.
//
// Pure function. The returned arrays are not frozen — same convention as
// `glyph-class.ts:buildGlyphClass`. Per-cell freeze cost isn't worth it
// for a per-frame walk.
export function buildClassifiedGrid(
  snapshot: FrameSnapshot,
  rows: ReadonlyArray<string>,
  playerXY: { x: number; y: number } | null,
): ReadonlyArray<ReadonlyArray<ClassifiedCell>> {
  const empty: ClassifiedCell = { terrain: null, foreground: null };
  const grid: ClassifiedCell[][] = new Array(rows.length);
  for (let y = 0; y < rows.length; y++) {
    const row = rows[y]!;
    const lineLen = row.length;
    const line: ClassifiedCell[] = new Array(lineLen);
    if (!isMapRow(y, rows.length)) {
      for (let x = 0; x < lineLen; x++) line[x] = empty;
      grid[y] = line;
      continue;
    }
    for (let x = 0; x < lineLen; x++) {
      const ch = row[x] ?? "";
      if (ch.length !== 1) {
        line[x] = empty;
        continue;
      }
      // Read the cell from the snapshot for the actual style. Falls
      // back to the row character if cellAt misses or throws (a stub
      // snapshot may not implement cellAt).
      let cell: CellInfo | null = null;
      try {
        cell = snapshot.cellAt(x, y);
      } catch {
        cell = null;
      }
      const text = cell?.text ?? ch;
      line[x] = classifyCell(text, cell?.style, { x, y }, playerXY);
    }
    grid[y] = line;
  }
  return grid;
}
