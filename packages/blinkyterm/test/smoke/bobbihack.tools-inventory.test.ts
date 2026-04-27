import { describe, expect, test } from "bun:test";
import {
  handleInventory,
  parseInventoryScreen,
} from "../../examples/bobbihack/tools/inventory";
import { GameMap } from "../../examples/bobbihack/game-map";
import type { ToolContext } from "../../examples/bobbihack/tool-context";
import type { StatusLine } from "../../examples/bobbihack/parsers";

function status(): StatusLine {
  return {
    name: "Hero",
    title: "the Stripling",
    attrs: { st: "18", dx: 11, co: 14, in: 11, wi: 13, ch: 7 },
    alignment: "Lawful",
    ac: 7,
    hp: 14,
    hpMax: 14,
    pw: 5,
    pwMax: 5,
    level: 1,
    xp: 0,
    dlvl: 1,
    turn: 1,
    gold: 0,
    hunger: "ok",
    conditions: [],
  };
}

function pad(s: string): string {
  return s.padEnd(80, " ");
}

describe("parseInventoryScreen", () => {
  test("parses simple weapons + armor sections", () => {
    const rows = [
      pad("Weapons"),
      pad("a - a +1 long sword (weapon in hand)"),
      pad("b - 2 daggers"),
      pad("Armor"),
      pad("c - an uncursed +2 small shield (being worn)"),
      pad("(end)"),
    ];
    const r = parseInventoryScreen(rows);
    expect(r.items.length).toBe(3);
    expect(r.items[0]).toEqual({
      slot: "a",
      description: "a +1 long sword (weapon in hand)",
      category: "Weapons",
    });
    expect(r.items[1]).toEqual({
      slot: "b",
      description: "2 daggers",
      category: "Weapons",
    });
    expect(r.items[2]).toEqual({
      slot: "c",
      description: "an uncursed +2 small shield (being worn)",
      category: "Armor",
    });
    expect(r.hasMorePages).toBe(false);
  });

  test("detects (end) marker", () => {
    const rows = [pad("a - apple"), pad("(end)")];
    const r = parseInventoryScreen(rows);
    expect(r.hasMorePages).toBe(false);
  });

  test("detects (N of M) multi-page marker", () => {
    const rows = [pad("a - apple"), pad("(1 of 3)")];
    const r = parseInventoryScreen(rows);
    expect(r.hasMorePages).toBe(true);
  });

  test("ignores blank rows and rows that don't match item shape", () => {
    const rows = [
      pad(""),
      pad("Some random text"),
      pad("a - apple"),
      pad("---separator---"),
      pad(""),
    ];
    const r = parseInventoryScreen(rows);
    expect(r.items.length).toBe(1);
    expect(r.items[0]?.slot).toBe("a");
  });

  test("handles BUC-prefix markers (* for cursed, etc.) gracefully", () => {
    // NetHack doesn't actually prefix item lines with BUC markers in
    // the inventory screen — those are inferred from the description
    // ("a cursed scroll"). The parser just preserves whatever's there.
    const rows = [
      pad("a - a cursed +0 dagger"),
      pad("b - a blessed potion of healing"),
      pad("(end)"),
    ];
    const r = parseInventoryScreen(rows);
    expect(r.items[0]?.description).toContain("cursed");
    expect(r.items[1]?.description).toContain("blessed");
  });

  test("handles empty inventory", () => {
    const rows = [pad("Not carrying anything."), pad("(end)")];
    const r = parseInventoryScreen(rows);
    expect(r.items.length).toBe(0);
  });

  test("parses realistic NetHack 3.6 inventory overlay (right-side overlay on dungeon map)", () => {
    // This is the actual rendering captured from a Valkyrie's starting
    // inventory — the inventory list appears in the right column,
    // overlaying the dungeon map which stays visible on the left.
    const rows = [
      pad("                               Weapons"),
      pad("                               a - a +1 long sword (weapon in hand)"),
      pad("           ------------        b - a +0 dagger (alternate weapon; not wielded)"),
      pad("           |......f...|        Armor"),
      pad("           |.....@....|        c - an uncursed +3 small shield (being worn)"),
      pad("           |.)...$....|        Comestibles"),
      pad("           |..........|        d - an uncursed food ration"),
      pad("           ---+------+-        (end)"),
    ];
    const r = parseInventoryScreen(rows);
    expect(r.items.length).toBe(4);
    expect(r.items[0]).toMatchObject({ slot: "a", category: "Weapons" });
    expect(r.items[0]?.description).toContain("long sword");
    expect(r.items[1]).toMatchObject({ slot: "b", category: "Weapons" });
    expect(r.items[1]?.description).toContain("dagger");
    expect(r.items[2]).toMatchObject({ slot: "c", category: "Armor" });
    expect(r.items[2]?.description).toContain("small shield");
    expect(r.items[3]).toMatchObject({ slot: "d", category: "Comestibles" });
    expect(r.items[3]?.description).toContain("food ration");
    expect(r.hasMorePages).toBe(false);
  });
});

describe("handleInventory", () => {
  function mockCtx(scriptedFrames: { rows: string[]; message?: string }[]): {
    ctx: ToolContext;
    sentKeys: string[];
  } {
    const sentKeys: string[] = [];
    const map = new GameMap();
    const ac = new AbortController();
    let frameIdx = 0;
    const ctx: ToolContext = {
      map,
      runState: { gameOver: false, endReason: null },
      signal: ac.signal,
      sendKeysAndWait: async (keys: string) => {
        sentKeys.push(keys);
        const frame = scriptedFrames[frameIdx] ?? scriptedFrames[scriptedFrames.length - 1];
        frameIdx += 1;
        const rows =
          frame?.rows ?? Array.from({ length: 24 }, () => " ".repeat(80));
        return {
          rows,
          status: status(),
          message: frame?.message ?? "",
          frameReason: "cellChange",
          screenAnsi: rows.join("\n"),
        };
      },
    };
    return { ctx, sentKeys };
  }

  test("sends 'i' then space to dismiss; returns parsed items", async () => {
    const inventoryRows = [
      pad("Weapons"),
      pad("a - a +1 long sword (weapon in hand)"),
      pad("(end)"),
      ...Array.from({ length: 21 }, () => " ".repeat(80)),
    ];
    const dungeonRows = Array.from({ length: 24 }, () => " ".repeat(80));
    const { ctx, sentKeys } = mockCtx([
      { rows: inventoryRows },
      { rows: dungeonRows },
    ]);
    const out = await handleInventory({}, ctx);
    expect(sentKeys).toEqual(["i", " "]);
    const parsed = JSON.parse(out) as { items: { slot: string }[] };
    expect(parsed.items.length).toBe(1);
    expect(parsed.items[0]?.slot).toBe("a");
  });

  test("on multi-page inventory pages through with space until (end)", async () => {
    const page1 = [
      pad("Weapons"),
      pad("a - a +1 long sword"),
      pad("b - a dagger"),
      pad("(1 of 2)"),
      ...Array.from({ length: 20 }, () => " ".repeat(80)),
    ];
    const page2 = [
      pad("Armor"),
      pad("c - a small shield"),
      pad("(end)"),
      ...Array.from({ length: 21 }, () => " ".repeat(80)),
    ];
    const dungeon = Array.from({ length: 24 }, () => " ".repeat(80));
    const { ctx, sentKeys } = mockCtx([
      { rows: page1 },
      { rows: page2 },
      { rows: dungeon },
    ]);
    const out = await handleInventory({}, ctx);
    // 'i' opens, ' ' advances to page 2, ' ' dismisses (end)
    expect(sentKeys).toEqual(["i", " ", " "]);
    const parsed = JSON.parse(out) as { items: { slot: string }[] };
    expect(parsed.items.map((i) => i.slot)).toEqual(["a", "b", "c"]);
  });
});
