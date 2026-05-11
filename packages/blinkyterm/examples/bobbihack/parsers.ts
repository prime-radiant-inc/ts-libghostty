// NetHack 3.6 message-line, status-line, and glyph parsers. Pure functions
// with no side effects. The conductor + GameMap consume these.

import type { CellStyle } from "libghostty-vt";

export type TileKind =
  | "floor"
  | "corridor"
  | "wall"
  | "door_closed"
  | "door_open"
  | "door_broken"
  | "stairs_up"
  | "stairs_down"
  | "trapdoor"
  | "altar"
  | "fountain"
  | "sink"
  | "throne"
  | "grave"
  | "tree"
  | "boulder"
  | "trap_known"
  | "ice"
  | "water"
  | "lava"
  | "unknown";

export type Hunger =
  | "Satiated"
  | "ok"
  | "Hungry"
  | "Weak"
  | "Fainting"
  | "Starved";

export type Alignment = "Lawful" | "Neutral" | "Chaotic" | "Unaligned";

export interface StatusLine {
  name: string;
  title: string;
  attrs: { st: string; dx: number; co: number; in: number; wi: number; ch: number };
  alignment: Alignment;
  ac: number;
  hp: number;
  hpMax: number;
  pw: number;
  pwMax: number;
  level: number;
  xp: number;
  dlvl: number;
  turn: number;
  gold: number;
  hunger: Hunger;
  conditions: string[];
}

const KNOWN_HUNGERS: Hunger[] = [
  "Satiated",
  "Hungry",
  "Weak",
  "Fainting",
  "Starved",
];

// NetHack's "condition" tokens that appear after the hunger word on the
// status line. Order isn't guaranteed by the engine; we just enumerate.
const KNOWN_CONDITIONS = new Set([
  "Conf",
  "Stun",
  "Hallu",
  "Blind",
  "Sick",
  "Slime",
  "Strngl",
  "Ill",
  "FoodPois",
  "Lev",
  "Fly",
  "Ride",
  "Held",
  "Grab",
]);

// Sentinel returned when the input is unparseable. Caller detects via
// `s.hp === -1 && s.hpMax === -1`.
const UNPARSEABLE_STATUS: StatusLine = {
  name: "",
  title: "",
  attrs: { st: "", dx: 0, co: 0, in: 0, wi: 0, ch: 0 },
  alignment: "Unaligned",
  ac: 0,
  hp: -1,
  hpMax: -1,
  pw: 0,
  pwMax: 0,
  level: 0,
  xp: 0,
  dlvl: 0,
  turn: 0,
  gold: 0,
  hunger: "ok",
  conditions: [],
};

// Helpers ------------------------------------------------------------

function intMatch(re: RegExp, s: string, fallback: number): number {
  const m = s.match(re);
  if (m === null || m[1] === undefined) return fallback;
  const n = parseInt(m[1], 10);
  return Number.isNaN(n) ? fallback : n;
}

// Parse "HP:14(14)" or "HP:-3(14)" → [hp, hpMax].
function parseHpField(s: string): [number, number] | null {
  const m = s.match(/HP:(-?\d+)\((\d+)\)/);
  if (m === null || m[1] === undefined || m[2] === undefined) return null;
  const hp = parseInt(m[1], 10);
  const max = parseInt(m[2], 10);
  if (Number.isNaN(hp) || Number.isNaN(max)) return null;
  return [hp, max];
}

function parsePwField(s: string): [number, number] {
  const m = s.match(/Pw:(\d+)\((\d+)\)/);
  if (m === null || m[1] === undefined || m[2] === undefined) return [0, 0];
  return [parseInt(m[1], 10), parseInt(m[2], 10)];
}

function parseXpField(s: string): [number, number] {
  const m = s.match(/Xp:(\d+)\/(\d+)/);
  if (m === null || m[1] === undefined || m[2] === undefined) return [0, 0];
  return [parseInt(m[1], 10), parseInt(m[2], 10)];
}

// Public ------------------------------------------------------------

export function parseStatusLine(row22: string, row23: string): StatusLine {
  // The bottom row (row23) carries the load-bearing fields. If we can't find
  // an HP token, the input isn't NetHack's status; return sentinel.
  const hpPair = parseHpField(row23);
  if (hpPair === null) return { ...UNPARSEABLE_STATUS };
  const [hp, hpMax] = hpPair;
  const [pw, pwMax] = parsePwField(row23);
  const [level, xp] = parseXpField(row23);

  // Top row: name, title, attrs, alignment, score.
  // Strategy: split by 2+ whitespace into tokens; the first token is the
  // name; everything before "St:" is "name + title".
  const stIdx = row22.search(/St:/);
  let name = "";
  let title = "";
  if (stIdx > 0) {
    const left = row22.slice(0, stIdx).trim();
    const parts = left.split(/\s+/);
    name = parts[0] ?? "";
    title = parts.slice(1).join(" ");
  }

  // Attributes — St supports the 18/NN percentile form.
  const stMatch = row22.match(/St:([\d/]+)/);
  const dx = intMatch(/Dx:(\d+)/, row22, 0);
  const co = intMatch(/Co:(\d+)/, row22, 0);
  const inAttr = intMatch(/In:(\d+)/, row22, 0);
  const wi = intMatch(/Wi:(\d+)/, row22, 0);
  const ch = intMatch(/Ch:(\d+)/, row22, 0);

  let alignment: Alignment = "Unaligned";
  if (row22.includes("Lawful")) alignment = "Lawful";
  else if (row22.includes("Neutral")) alignment = "Neutral";
  else if (row22.includes("Chaotic")) alignment = "Chaotic";

  // Bottom row: dungeon, gold, ac, turn, hunger, conditions.
  const dlvl = intMatch(/Dlvl:(\d+)/, row23, 0);
  const gold = intMatch(/\$:(\d+)/, row23, 0);
  // AC can be negative.
  const acMatch = row23.match(/AC:(-?\d+)/);
  const ac = acMatch === null || acMatch[1] === undefined ? 0 : parseInt(acMatch[1], 10);
  const turn = intMatch(/T:(\d+)/, row23, 0);

  // Hunger and conditions: trailing tokens after T:N.
  let hunger: Hunger = "ok";
  const conditions: string[] = [];
  const tIdx = row23.search(/T:\d+/);
  if (tIdx >= 0) {
    const tMatch = row23.slice(tIdx).match(/T:\d+\s*(.*)$/);
    const trailing = tMatch?.[1]?.trim() ?? "";
    if (trailing.length > 0) {
      const tokens = trailing.split(/\s+/);
      for (const tok of tokens) {
        if ((KNOWN_HUNGERS as string[]).includes(tok)) {
          hunger = tok as Hunger;
        } else if (KNOWN_CONDITIONS.has(tok)) {
          conditions.push(tok);
        }
        // Unknown tokens are silently ignored — NetHack adds new ones over
        // versions and we'd rather skip than throw.
      }
    }
  }

  return {
    name,
    title,
    attrs: {
      st: stMatch?.[1] ?? "",
      dx,
      co,
      in: inAttr,
      wi,
      ch,
    },
    alignment,
    ac,
    hp,
    hpMax,
    pw,
    pwMax,
    level,
    xp,
    dlvl,
    turn,
    gold,
    hunger,
    conditions,
  };
}

export function parseMessageLine(raw: string): string {
  // Strip --More-- markers and trim. Multi-clause messages stay intact.
  return raw.replace(/--More--\s*$/u, "").trim();
}

const TERRAIN_GLYPHS: Record<string, TileKind> = {
  ".": "floor",
  "#": "corridor",
  "|": "wall",
  "-": "wall",
  "+": "door_closed",
  // NetHack 5.0 — DO NOT add `'` here. The glyph maps to the GOLEM
  // monster class in 5.0 (MONSYM 55 in `include/defsym.h`), not to
  // an open door. NetHack 5.0 renders open doors as colored `-`/`|`
  // (CLR_BROWN) per the PCHAR table; v2's `cell-classifier.ts`
  // catches `'` as `monster:golem` via `LETTER_TO_CLASS`. Before
  // this fix, `parsers.ts` mapped `'` to `door_open`, causing every
  // golem on screen to be recorded as walkable terrain in
  // `GameMap.floor.tiles` — autopilot would route through them.
  // (The 3.6 → 5.0 renderer change moved `'` from open-door to
  // golem; the binding was written against 3.6 conventions.)
  // Open-door detection from colored `-`/`|` is a v3 follow-up;
  // requires `updateFromFrame` to consume per-cell style.
  "<": "stairs_up",
  ">": "stairs_down",
  _: "altar",
  "{": "fountain",
  "}": "water",
  "\\": "throne",
  "`": "boulder",
  "^": "trap_known",
  " ": "unknown",
};

// Single-character transient glyphs (player, monsters, items). NetHack uses
// letters exclusively for monsters and punctuation for items in the default
// charset.
const TRANSIENT_RE = /^[@a-zA-Z?!()=*$%/"\[\])~]$/u;

/**
 * @deprecated Use `classifyTerrain(char, style)` for color-aware terrain
 * classification. `classifyGlyph` is kept as a thin wrapper for backward
 * compatibility during the v2 migration; it delegates to
 * `classifyTerrain(char, undefined)` and therefore can't disambiguate
 * lava-vs-water, tree-vs-corridor-vs-iron-bars.
 */
export function classifyGlyph(char: string): TileKind | null {
  return classifyTerrain(char, undefined);
}

// CLR_* values from NetHack 5.0/include/color.h, mapped to the basic
// 16-color palette indices used by libghostty-vt.
const CLR_RED = 1;
const CLR_GREEN = 2;
const CLR_BLUE = 4;
const CLR_CYAN = 6;
const CLR_BRIGHT_BLUE = 12;

function fgPaletteIndex(style: CellStyle | undefined): number | null {
  if (style === undefined) return null;
  const fg = style.fg;
  if (fg === undefined) return null;
  if (Array.isArray(fg)) return null;
  if (typeof fg === "object" && "palette" in fg) {
    const idx = fg.palette;
    if (typeof idx === "number") return idx;
  }
  return null;
}

/**
 * Color-aware terrain classifier. Disambiguates the overloaded glyphs
 * NetHack uses for distinct terrains:
 *
 *   `}` red → lava, blue/bright_blue → water (default water).
 *   `#` green → tree, cyan/bright_cyan → iron_bars (default corridor).
 *
 * For the `_` altar / iron-chain ambiguity, defaults to altar — iron
 * chains are rare and the v2 spec accepts the misclassification (see
 * spec §"Layer 1").
 *
 * Pass `undefined` for `style` to fall back to the default of each
 * overloaded glyph (matches v1 `classifyGlyph` behavior).
 */
export function classifyTerrain(
  char: string,
  style: CellStyle | undefined,
): TileKind | null {
  if (char.length !== 1) return null;

  if (char === "}") {
    const fg = fgPaletteIndex(style);
    if (fg === CLR_RED) return "lava";
    return "water";
  }

  if (char === "#") {
    const fg = fgPaletteIndex(style);
    if (fg === CLR_GREEN) return "tree";
    // CLR_CYAN (6) and bright cyan (14) both indicate iron bars; HI_METAL
    // resolves to bright cyan in the default palette per
    // NetHack-5.0/include/color.h.
    if (fg === CLR_CYAN || fg === 14) {
      // Iron bars block movement; we fold them into "wall" since v2 has
      // no dedicated iron_bars TileKind. Conservative — the planner
      // already refuses to walk walls.
      return "wall";
    }
    return "corridor";
  }

  if (TERRAIN_GLYPHS[char] !== undefined) return TERRAIN_GLYPHS[char];
  if (TRANSIENT_RE.test(char)) return null;
  return null;
}

// Suppress unused-warning lints for `CLR_BLUE` and `CLR_BRIGHT_BLUE`.
// The named constants document the palette positions even though we
// only test for the `red`/`green`/`cyan` variants explicitly.
void CLR_BLUE;
void CLR_BRIGHT_BLUE;

// Branch detection from message-line text. Returns the branch label (or
// branch-with-sublabel for special floors) or null.
const BRANCH_PATTERNS: { pattern: RegExp; label: string }[] = [
  { pattern: /You enter the Gnomish Mines\./i, label: "Mines" },
  { pattern: /Welcome to Sokoban!?/i, label: "Sokoban" },
  { pattern: /You feel a strange mental acuity\./i, label: "Quest" },
  { pattern: /You arrive in a town\./i, label: "Mines:Town" },
  { pattern: /You enter what seems to be the central temple\./i, label: "Mines:Town" },
  { pattern: /You arrive in a vast, open room\./i, label: "Bigroom" },
  { pattern: /You enter the Oracle's lair\./i, label: "Oracle" },
];

export function detectBranch(messageLine: string): string | null {
  for (const { pattern, label } of BRANCH_PATTERNS) {
    if (pattern.test(messageLine)) return label;
  }
  return null;
}

export function detectRogueLevel(messageLine: string): boolean {
  return /You enter what seems to be an older, more primitive world\./i.test(
    messageLine,
  );
}

export function detectPolymorph(messageLine: string): boolean {
  return /You suddenly turn into /i.test(messageLine);
}
