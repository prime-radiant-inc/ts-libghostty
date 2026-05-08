import { describe, expect, test } from "bun:test";
import {
  parseStatusLine,
  parseMessageLine,
  classifyGlyph,
  classifyTerrain,
  detectBranch,
  detectRogueLevel,
  detectPolymorph,
} from "../../examples/bobbihack/parsers";
import type { CellStyle } from "libghostty-vt";

function styleWithFg(palette: number): CellStyle {
  return {
    fg: { palette },
    bold: false,
    faint: false,
    italic: false,
    underline: "none",
    overline: false,
    strikethrough: false,
    blink: false,
    inverse: false,
    invisible: false,
  };
}

describe("parseStatusLine", () => {
  test("parses standard NetHack 3.6 two-line status", () => {
    // Row 22: name + title + attrs + alignment + score
    // Row 23: dungeon + gold + HP + Pw + AC + Xp + Turn + hunger + conditions
    const row22 = "Bobbihack the Stripling      St:18 Dx:11 Co:14 In:11 Wi:13 Ch:7  Lawful S:0";
    const row23 = "Dlvl:1 $:0 HP:14(14) Pw:0(0) AC:7 Xp:1/0 T:1";
    const s = parseStatusLine(row22, row23);
    expect(s.name).toBe("Bobbihack");
    expect(s.title).toBe("the Stripling");
    expect(s.attrs.st).toBe("18");
    expect(s.attrs.dx).toBe(11);
    expect(s.attrs.co).toBe(14);
    expect(s.alignment).toBe("Lawful");
    expect(s.dlvl).toBe(1);
    expect(s.gold).toBe(0);
    expect(s.hp).toBe(14);
    expect(s.hpMax).toBe(14);
    expect(s.pw).toBe(0);
    expect(s.pwMax).toBe(0);
    expect(s.ac).toBe(7);
    expect(s.level).toBe(1);
    expect(s.xp).toBe(0);
    expect(s.turn).toBe(1);
    expect(s.hunger).toBe("ok");
    expect(s.conditions).toEqual([]);
  });

  test("parses St:18/01 percentile strength", () => {
    const row22 = "Hero the Newbie              St:18/01 Dx:10 Co:10 In:10 Wi:10 Ch:10 Neutral S:5";
    const row23 = "Dlvl:1 $:0 HP:10(10) Pw:0(0) AC:10 Xp:1/0 T:1";
    const s = parseStatusLine(row22, row23);
    expect(s.attrs.st).toBe("18/01");
    expect(s.alignment).toBe("Neutral");
  });

  test("parses Hungry status", () => {
    const row22 = "Hero the Stripling           St:18 Dx:11 Co:14 In:11 Wi:13 Ch:7  Lawful S:42";
    const row23 = "Dlvl:3 $:25 HP:12(14) Pw:0(0) AC:7 Xp:2/15 T:480 Hungry";
    const s = parseStatusLine(row22, row23);
    expect(s.hunger).toBe("Hungry");
    expect(s.gold).toBe(25);
    expect(s.dlvl).toBe(3);
    expect(s.turn).toBe(480);
    expect(s.conditions).toEqual([]);
  });

  test("parses multiple conditions (Conf + Stun + Blind)", () => {
    const row22 = "Hero the Stripling           St:18 Dx:11 Co:14 In:11 Wi:13 Ch:7  Lawful S:42";
    const row23 = "Dlvl:5 $:50 HP:8(14) Pw:0(0) AC:6 Xp:3/45 T:920 Weak Conf Stun Blind";
    const s = parseStatusLine(row22, row23);
    expect(s.hunger).toBe("Weak");
    expect(s.conditions).toContain("Conf");
    expect(s.conditions).toContain("Stun");
    expect(s.conditions).toContain("Blind");
    expect(s.conditions.length).toBe(3);
  });

  test("handles negative AC", () => {
    const row22 = "Hero the Hero                St:18 Dx:18 Co:18 In:18 Wi:18 Ch:18 Lawful S:1000";
    const row23 = "Dlvl:10 $:500 HP:75(80) Pw:30(30) AC:-5 Xp:12/15000 T:8000";
    const s = parseStatusLine(row22, row23);
    expect(s.ac).toBe(-5);
  });

  test("handles negative HP edge case (player about to die)", () => {
    // NetHack does briefly show HP:-3(14) before the death prompt; parser
    // shouldn't barf on a leading minus.
    const row22 = "Hero the Stripling           St:18 Dx:11 Co:14 In:11 Wi:13 Ch:7  Lawful S:42";
    const row23 = "Dlvl:5 $:50 HP:-3(14) Pw:0(0) AC:6 Xp:3/45 T:920 Weak";
    const s = parseStatusLine(row22, row23);
    expect(s.hp).toBe(-3);
    expect(s.hpMax).toBe(14);
  });

  test("returns sentinel values when status row is unparseable", () => {
    const s = parseStatusLine("garbage", "more garbage");
    // Implementation must return well-formed object with sentinel values
    // rather than throw — caller can detect via hp === -1 sentinel
    expect(s).toBeDefined();
    expect(s.hp).toBe(-1);
  });
});

describe("parseMessageLine", () => {
  test("returns the trimmed message text", () => {
    expect(parseMessageLine("It's a wall.")).toBe("It's a wall.");
    expect(parseMessageLine("  Welcome to NetHack!  ")).toBe("Welcome to NetHack!");
  });

  test("strips --More-- markers", () => {
    expect(parseMessageLine("There is a staircase down here.--More--")).toBe(
      "There is a staircase down here.",
    );
  });

  test("returns empty string for empty input", () => {
    expect(parseMessageLine("")).toBe("");
    expect(parseMessageLine("   ")).toBe("");
  });

  test("preserves multi-clause messages (weird-message fixture)", () => {
    // NetHack often shows compound messages on one line.
    const input = "You hit the kobold.  The kobold misses you.  You kill the kobold!--More--";
    expect(parseMessageLine(input)).toBe(
      "You hit the kobold.  The kobold misses you.  You kill the kobold!",
    );
  });
});

describe("classifyGlyph", () => {
  test("classifies floor, corridor, walls", () => {
    expect(classifyGlyph(".")).toBe("floor");
    expect(classifyGlyph("#")).toBe("corridor");
    expect(classifyGlyph("|")).toBe("wall");
    expect(classifyGlyph("-")).toBe("wall");
  });

  test("classifies doors", () => {
    expect(classifyGlyph("+")).toBe("door_closed");
    expect(classifyGlyph("'")).toBe("door_open");
  });

  test("classifies stairs", () => {
    expect(classifyGlyph("<")).toBe("stairs_up");
    expect(classifyGlyph(">")).toBe("stairs_down");
  });

  test("classifies dungeon features", () => {
    expect(classifyGlyph("_")).toBe("altar");
    expect(classifyGlyph("{")).toBe("fountain");
    expect(classifyGlyph("}")).toBe("water");
    expect(classifyGlyph("\\")).toBe("throne");
  });

  test("classifies boulder and traps", () => {
    expect(classifyGlyph("`")).toBe("boulder");
    expect(classifyGlyph("^")).toBe("trap_known");
  });

  test("returns null for transient glyphs (player, monsters, items)", () => {
    expect(classifyGlyph("@")).toBeNull();
    expect(classifyGlyph("d")).toBeNull(); // dog/jackal monster
    expect(classifyGlyph("D")).toBeNull(); // dragon
    expect(classifyGlyph("?")).toBeNull(); // scroll
    expect(classifyGlyph("!")).toBeNull(); // potion
    expect(classifyGlyph("$")).toBeNull(); // gold
    expect(classifyGlyph("%")).toBeNull(); // food
    expect(classifyGlyph("(")).toBeNull(); // weapon
    expect(classifyGlyph("[")).toBeNull(); // armor
    expect(classifyGlyph("=")).toBeNull(); // ring
    expect(classifyGlyph("\"")).toBeNull(); // amulet
  });

  test("returns 'unknown' for empty space", () => {
    expect(classifyGlyph(" ")).toBe("unknown");
  });
});

describe("classifyTerrain (color-aware)", () => {
  test("default '}' is water (no style)", () => {
    expect(classifyTerrain("}", undefined)).toBe("water");
  });

  test("'}' with red fg is lava", () => {
    expect(classifyTerrain("}", styleWithFg(1))).toBe("lava");
  });

  test("'}' with blue fg is water", () => {
    expect(classifyTerrain("}", styleWithFg(4))).toBe("water");
  });

  test("'}' with bright-blue fg is water", () => {
    expect(classifyTerrain("}", styleWithFg(12))).toBe("water");
  });

  test("default '#' is corridor (no style)", () => {
    expect(classifyTerrain("#", undefined)).toBe("corridor");
  });

  test("'#' with green fg is tree", () => {
    expect(classifyTerrain("#", styleWithFg(2))).toBe("tree");
  });

  test("'#' with cyan fg is iron-bars (folded into wall)", () => {
    expect(classifyTerrain("#", styleWithFg(6))).toBe("wall");
    expect(classifyTerrain("#", styleWithFg(14))).toBe("wall");
  });

  test("default '_' is altar", () => {
    expect(classifyTerrain("_", undefined)).toBe("altar");
  });

  test("non-overloaded terrain glyphs match classifyGlyph", () => {
    expect(classifyTerrain(".", undefined)).toBe("floor");
    expect(classifyTerrain("|", undefined)).toBe("wall");
    expect(classifyTerrain("+", undefined)).toBe("door_closed");
    expect(classifyTerrain("<", undefined)).toBe("stairs_up");
    expect(classifyTerrain("^", undefined)).toBe("trap_known");
  });

  test("transient glyphs return null (terrain layer absent)", () => {
    expect(classifyTerrain("d", undefined)).toBeNull();
    expect(classifyTerrain("@", undefined)).toBeNull();
    expect(classifyTerrain("?", undefined)).toBeNull();
  });
});

describe("detectBranch", () => {
  test("detects Mines entry", () => {
    expect(detectBranch("You enter the Gnomish Mines.")).toBe("Mines");
  });

  test("detects Sokoban entry", () => {
    expect(detectBranch("Welcome to Sokoban!")).toBe("Sokoban");
  });

  test("detects Quest portal", () => {
    expect(detectBranch("You feel a strange mental acuity.")).toBe("Quest");
  });

  test("detects Town arrival", () => {
    expect(detectBranch("You arrive in a town.")).toBe("Mines:Town");
  });

  test("returns null for non-branch messages", () => {
    expect(detectBranch("It's a wall.")).toBeNull();
    expect(detectBranch("You hit the kobold.")).toBeNull();
    expect(detectBranch("")).toBeNull();
  });
});

describe("detectRogueLevel", () => {
  test("matches the rogue-level entry message", () => {
    expect(
      detectRogueLevel("You enter what seems to be an older, more primitive world."),
    ).toBe(true);
  });

  test("does not match other messages", () => {
    expect(detectRogueLevel("You enter the Gnomish Mines.")).toBe(false);
    expect(detectRogueLevel("")).toBe(false);
  });
});

describe("detectPolymorph", () => {
  test("matches polymorph messages", () => {
    expect(detectPolymorph("You suddenly turn into a xorn!")).toBe(true);
    expect(detectPolymorph("You suddenly turn into a giant!")).toBe(true);
  });

  test("does not match non-polymorph messages", () => {
    expect(detectPolymorph("You feel different.")).toBe(false);
    expect(detectPolymorph("It's a wall.")).toBe(false);
    expect(detectPolymorph("")).toBe(false);
  });
});
