import { describe, expect, test } from "bun:test";
import {
  handleMove,
  handleSearch,
  handlePickup,
  directionToKeystroke,
} from "../../examples/bobbihack/tools/move";
import { GameMap } from "../../examples/bobbihack/game-map";
import { TOOL_RESULT_HEADER } from "../../examples/bobbihack/tool-result";
import type { StatusLine } from "../../examples/bobbihack/parsers";
import type { ToolContext } from "../../examples/bobbihack/tool-context";

function status(overrides: Partial<StatusLine> = {}): StatusLine {
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
    ...overrides,
  };
}

interface MockTurn {
  rows?: string[];
  message?: string;
  status?: StatusLine;
  frameReason?: string;
}

function mockCtx(turns: MockTurn[]): { ctx: ToolContext; sentKeys: string[] } {
  const sentKeys: string[] = [];
  const map = new GameMap();
  let turnIdx = 0;
  const ac = new AbortController();

  const ctx: ToolContext = {
    map,
    runState: { gameOver: false, endReason: null },
    signal: ac.signal,
    sendKeysAndWait: async (keys: string) => {
      sentKeys.push(keys);
      const t = turns[turnIdx] ?? {};
      turnIdx += 1;
      const rows = t.rows ?? Array.from({ length: 24 }, () => " ".repeat(80));
      const s = t.status ?? status({ turn: turnIdx });
      const message = t.message ?? "";
      const frameReason = t.frameReason ?? "cellChange";
      const screenAnsi = rows.join("\n");
      // Update map (this mirrors what the real ctx would do).
      map.updateFromFrame(rows, s, message);
      return { rows, status: s, message, frameReason, screenAnsi };
    },
  };
  return { ctx, sentKeys };
}

describe("directionToKeystroke", () => {
  test("eight compass directions map to vi-keys", () => {
    expect(directionToKeystroke("north")).toBe("k");
    expect(directionToKeystroke("south")).toBe("j");
    expect(directionToKeystroke("east")).toBe("l");
    expect(directionToKeystroke("west")).toBe("h");
    expect(directionToKeystroke("northeast")).toBe("u");
    expect(directionToKeystroke("northwest")).toBe("y");
    expect(directionToKeystroke("southeast")).toBe("n");
    expect(directionToKeystroke("southwest")).toBe("b");
  });
  test("up and down map to < and >", () => {
    expect(directionToKeystroke("up")).toBe("<");
    expect(directionToKeystroke("down")).toBe(">");
  });
});

describe("handleMove", () => {
  test("sends a single keystroke for count=1 (default)", async () => {
    const { ctx, sentKeys } = mockCtx([{}]);
    const out = await handleMove({ direction: "east" }, ctx);
    expect(sentKeys).toEqual(["l"]);
    expect(out).toContain(TOOL_RESULT_HEADER);
    expect(out).toContain("move(east");
  });

  test("count prefix sends <count><viKey>", async () => {
    const { ctx, sentKeys } = mockCtx([{}]);
    await handleMove({ direction: "east", count: 5 }, ctx);
    expect(sentKeys).toEqual(["5l"]);
  });

  test("count cap of 50 enforced", async () => {
    const { ctx, sentKeys } = mockCtx([{}]);
    await handleMove({ direction: "east", count: 100 }, ctx);
    expect(sentKeys).toEqual(["50l"]);
  });

  test("returns error tool_result for unknown direction", async () => {
    const { ctx, sentKeys } = mockCtx([{}]);
    const out = await handleMove({ direction: "northnorth" as any }, ctx);
    expect(sentKeys).toEqual([]);
    expect(out).toContain("invalid direction");
  });

  test("up sends '<' (ascend stairs)", async () => {
    const { ctx, sentKeys } = mockCtx([{}]);
    await handleMove({ direction: "up" }, ctx);
    expect(sentKeys).toEqual(["<"]);
  });
});

describe("handleSearch", () => {
  test("sends 's'", async () => {
    const { ctx, sentKeys } = mockCtx([{}]);
    const out = await handleSearch({}, ctx);
    expect(sentKeys).toEqual(["s"]);
    expect(out).toContain("search");
  });
});

describe("handlePickup", () => {
  test("sends ','", async () => {
    const { ctx, sentKeys } = mockCtx([{}]);
    const out = await handlePickup({}, ctx);
    expect(sentKeys).toEqual([","]);
    expect(out).toContain("pickup");
  });
});
