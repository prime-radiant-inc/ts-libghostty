// Interrupt detection library. The autopilot tools loop until any
// interrupt fires; the conductor reports the primary interrupt and any
// co-occurring interrupts in the tool_result summary.

import type { StatusLine } from "./parsers";
import type { GlyphClass } from "./glyph-class";

export interface InterruptFrame {
  rows: string[];
  // Parallel grid to `rows` classifying letter/`@` glyphs (see
  // ./glyph-class.ts). Optional: callers that don't have it default to
  // an empty grid, which makes `detectHostileAppeared` treat every
  // letter as hostile (the pre-attribute behavior).
  glyphClass?: ReadonlyArray<ReadonlyArray<GlyphClass | undefined>>;
  status: StatusLine;
  message: string;
  frameReason?: string;
}

export interface InterruptContext {
  prev?: InterruptFrame;
  cur: InterruptFrame & { frameReason: string };
  // Map-derived signals.
  enteredTrapTile?: boolean;
  unexpectedLevelChange?: { from: string; to: string };
  abortSignal?: boolean;
}

export type InterruptDetector = (ctx: InterruptContext) => boolean | string;

export interface Interrupt {
  name: string;
  // Lower number = higher priority. Modal/lethal events first.
  priority: number;
  detect: InterruptDetector;
}

// Helpers ------------------------------------------------------------

const MODAL_PATTERNS = [
  /--More--/,
  /\[yn[a-z]*\]/i,                    // [yn], [ynq], [ynaq]
  /\[a-z[A-Z]*\b/i,                   // letter-selection menus  e.g. "[a-z A-Z]"
  /In what direction\?/i,
  /What do you want to (eat|drink|read|wear|put on|take off|remove|wield|drop|throw|apply|zap)\?/i,
  /Pick (up|an? item)/i,
];

// On the standard NetHack 80x24 layout: row 0 is the message line, the
// last two rows are the status lines. Map cells live on rows 1 ..
// rows.length-3 inclusive. Detectors that scan for monster/item glyphs
// MUST restrict to map rows or they'll false-fire on every game message
// — e.g. "You see..." starts row 0 with `Y`, which the pre-restriction
// detector flagged as `monster_visible (Y at (0,0))` and aborted
// autopilot loops mid-walk.
function isMapRow(y: number, totalRows: number): boolean {
  return y >= 1 && y <= totalRows - 3;
}

// Attribute-aware monster detector. Pets (rendered with `inverse: true` in
// NetHack 5.0.0 with `hilite_pet` set) are classified as `pet` upstream
// and skipped here so autopilot doesn't abort on every pet step. Every
// other tracked glyph (`normal`) is treated as hostile, including
// peacefuls — NetHack 5.0.0 doesn't expose a hilite for them, so they're
// indistinguishable from hostiles in this revision (known limitation,
// see the design doc's "Risks and fallbacks" #3).
//
// The interrupt is still named `monster_visible` for log/test schema
// stability; the meaning has tightened from "any letter glyph appeared"
// to "a hostile-or-unclassifiable letter glyph appeared."
function detectHostileAppeared(
  prev: InterruptFrame | undefined,
  cur: InterruptFrame,
): string | false {
  if (prev === undefined) return false;
  const curClassGrid = cur.glyphClass ?? [];
  for (let y = 0; y < cur.rows.length; y++) {
    if (!isMapRow(y, cur.rows.length)) continue;
    const curRow = cur.rows[y]!;
    const prevRow = prev.rows[y] ?? "";
    const curClassRow = curClassGrid[y] ?? [];
    for (let x = 0; x < curRow.length; x++) {
      const ch = curRow[x]!;
      // Only letters (other than @) trigger this interrupt — same shape
      // as the original detector. The class lookup determines hostility.
      if (!/^[a-zA-Z]$/.test(ch) || ch === "@") continue;
      const klass = curClassRow[x];
      if (klass === "pet") continue;
      // klass === "normal" (or undefined when the caller didn't supply a
      // grid — fall through to the pre-attribute "treat as hostile"
      // behavior, which is the safe default).
      if (prevRow[x] !== ch) {
        return `${ch} at (${x},${y})`;
      }
    }
  }
  return false;
}

function detectNewItem(
  prevRows: string[] | undefined,
  curRows: string[],
): string | false {
  if (prevRows === undefined) return false;
  const itemRe = /^[?!()=*$%/"\[\]]$/;
  for (let y = 0; y < curRows.length; y++) {
    if (!isMapRow(y, curRows.length)) continue;
    const cur = curRows[y]!;
    const prev = prevRows[y] ?? "";
    for (let x = 0; x < cur.length; x++) {
      const ch = cur[x]!;
      if (itemRe.test(ch) && prev[x] !== ch) {
        return `${ch} at (${x},${y})`;
      }
    }
  }
  return false;
}

function detectEngulfed(curRows: string[]): boolean {
  // NetHack renders engulfers with a unique 3x3 box of slashes and
  // dashes around the swallowed player:
  //
  //     /-\
  //     |@|
  //     \-/
  //
  // The diagnostic glyphs are the slashes — '/' and '\\' do not
  // appear in plain dungeon wall rendering, so requiring them in
  // all four corners cleanly rejects regular `--/||` walls (which
  // an earlier looser heuristic was matching, false-firing on any
  // @ adjacent to a top/bottom wall — confirmed in production
  // run logs from 2026-05-08).
  for (let y = 1; y < curRows.length - 1; y++) {
    const cur = curRows[y]!;
    const idx = cur.indexOf("@");
    if (idx <= 0 || idx >= cur.length - 1) continue;
    const above = curRows[y - 1]!;
    const below = curRows[y + 1]!;
    if (
      above[idx - 1] === "/" &&
      above[idx] === "-" &&
      above[idx + 1] === "\\" &&
      cur[idx - 1] === "|" &&
      cur[idx + 1] === "|" &&
      below[idx - 1] === "\\" &&
      below[idx] === "-" &&
      below[idx + 1] === "/"
    ) {
      return true;
    }
  }
  return false;
}

// Definitions -------------------------------------------------------

export const INTERRUPTS: Interrupt[] = [
  // 0-99: critical / game-ending
  {
    name: "you_die",
    priority: 0,
    detect: (c) =>
      /^You die/i.test(c.cur.message) ||
      /Do you want your possessions identified/i.test(c.cur.message),
  },
  {
    name: "you_ascend",
    priority: 1,
    detect: (c) =>
      /You offer.*Amulet of Yendor/i.test(c.cur.message) ||
      /Congratulations, you have ascended/i.test(c.cur.message),
  },

  // 100-199: modal / blocking input
  {
    name: "modal_prompt",
    priority: 100,
    detect: (c) => {
      for (const re of MODAL_PATTERNS) {
        if (re.test(c.cur.message)) return true;
      }
      return false;
    },
  },

  // 200-299: combat / immediate danger
  {
    name: "engulfed",
    priority: 200,
    detect: (c) => detectEngulfed(c.cur.rows),
  },
  {
    name: "low_hp",
    priority: 210,
    detect: (c) => {
      const { hp, hpMax } = c.cur.status;
      if (hpMax <= 0) return false;
      return hp < Math.max(1, hpMax / 3) ? `${hp}/${hpMax}` : false;
    },
  },
  {
    name: "hp_drop",
    priority: 220,
    detect: (c) => {
      if (c.prev === undefined) return false;
      if (c.cur.status.hp < c.prev.status.hp) {
        return `${c.prev.status.hp} → ${c.cur.status.hp}`;
      }
      return false;
    },
  },
  {
    name: "pet_attacking_you",
    priority: 230,
    detect: (c) =>
      /Your .* (bites|attacks|hits) you/i.test(c.cur.message) ||
      /Your .* misses you/i.test(c.cur.message),
  },
  {
    // Fires when a hostile-or-unclassifiable letter glyph appears in the
    // current frame at a position it didn't occupy in the previous
    // frame. Pets (classified upstream via `style.inverse === true`) are
    // skipped. Peacefuls are not distinguishable in NetHack 5.0.0 and
    // also trip this interrupt — known limitation.
    name: "monster_visible",
    priority: 240,
    detect: (c) => detectHostileAppeared(c.prev, c.cur),
  },

  // 300-399: status effect onsets
  {
    name: "paralyzed",
    priority: 300,
    detect: (c) => /You can't move yourself!/i.test(c.cur.message),
  },
  {
    name: "polymorphed",
    priority: 310,
    detect: (c) => /You suddenly turn into /i.test(c.cur.message),
  },
  {
    name: "stunned",
    priority: 320,
    detect: (c) =>
      /You stagger/i.test(c.cur.message) ||
      (!c.prev?.status.conditions.includes("Stun") &&
        c.cur.status.conditions.includes("Stun")),
  },
  {
    name: "confused",
    priority: 321,
    detect: (c) =>
      !c.prev?.status.conditions.includes("Conf") &&
      c.cur.status.conditions.includes("Conf"),
  },
  {
    name: "hallucinating",
    priority: 322,
    detect: (c) =>
      !c.prev?.status.conditions.includes("Hallu") &&
      c.cur.status.conditions.includes("Hallu"),
  },
  {
    name: "blind",
    priority: 323,
    detect: (c) =>
      !c.prev?.status.conditions.includes("Blind") &&
      c.cur.status.conditions.includes("Blind"),
  },
  {
    name: "weapon_cursed_welded",
    priority: 330,
    detect: (c) => /welds itself to your hand!/i.test(c.cur.message),
  },
  {
    name: "armor_cursed_stuck",
    priority: 331,
    detect: (c) => /You can't .* (you are wearing|seems to be stuck)/i.test(c.cur.message),
  },
  {
    name: "hunger_transition",
    priority: 340,
    detect: (c) => {
      if (c.prev === undefined) return false;
      if (c.prev.status.hunger !== c.cur.status.hunger) {
        return `${c.prev.status.hunger} → ${c.cur.status.hunger}`;
      }
      return false;
    },
  },
  {
    name: "xp_levelup",
    priority: 350,
    detect: (c) => {
      const m = c.cur.message.match(/Welcome to experience level (\d+)/i);
      return m ? `level ${m[1]}` : false;
    },
  },

  // 400-499: game state changes
  {
    name: "level_changed_unexpectedly",
    priority: 400,
    detect: (c) =>
      c.unexpectedLevelChange !== undefined
        ? `${c.unexpectedLevelChange.from} → ${c.unexpectedLevelChange.to}`
        : false,
  },
  {
    name: "entered_trap_tile",
    priority: 410,
    detect: (c) => c.enteredTrapTile === true,
  },
  {
    name: "new_item_visible",
    priority: 420,
    detect: (c) => detectNewItem(c.prev?.rows, c.cur.rows),
  },
  {
    name: "bell",
    priority: 430,
    detect: (c) => c.cur.frameReason === "bell",
  },
];

// Public API --------------------------------------------------------

export interface InterruptHit {
  name: string;
  detail: string | undefined;
}

export interface InterruptResult {
  primary: InterruptHit | null;
  also: InterruptHit[];
}

export function runInterruptChecks(c: InterruptContext): InterruptResult {
  const hits: { interrupt: Interrupt; detail: string | undefined }[] = [];
  for (const i of INTERRUPTS) {
    const r = i.detect(c);
    if (r === false) continue;
    const detail = typeof r === "string" ? r : undefined;
    hits.push({ interrupt: i, detail });
  }
  if (hits.length === 0) return { primary: null, also: [] };
  hits.sort((a, b) => a.interrupt.priority - b.interrupt.priority);
  return {
    primary: { name: hits[0]!.interrupt.name, detail: hits[0]!.detail },
    also: hits.slice(1).map((h) => ({ name: h.interrupt.name, detail: h.detail })),
  };
}
