import { describe, expect, test } from "bun:test";
import {
  handleWear,
  handlePuton,
  handleTakeoff,
  handleRemove,
  handleWield,
} from "../../examples/bobbihack/tools/items-equip";
import { GameMap } from "../../examples/bobbihack/game-map";
import { TOOL_RESULT_HEADER } from "../../examples/bobbihack/tool-result";
import type { StatusLine } from "../../examples/bobbihack/parsers";
import type { ToolContext } from "../../examples/bobbihack/tool-context";

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

function mockCtx(): { ctx: ToolContext; sentKeys: string[] } {
  const sentKeys: string[] = [];
  const map = new GameMap();
  const ac = new AbortController();
  const ctx: ToolContext = {
    map,
    runState: { gameOver: false, endReason: null },
    signal: ac.signal,
    journalDir: "",
    sendKeysAndWait: async (keys: string) => {
      sentKeys.push(keys);
      const rows = Array.from({ length: 24 }, () => " ".repeat(80));
      return {
        rows,
        glyphClass: rows.map(() => []),
        status: status(),
        message: "",
        frameReason: "cellChange",
        screenAnsi: rows.join("\n"),
      };
    },
  };
  return { ctx, sentKeys };
}

describe("handleWear", () => {
  test("sends 'W<slot>'", async () => {
    const { ctx, sentKeys } = mockCtx();
    const out = await handleWear({ slot: "a" }, ctx);
    expect(sentKeys).toEqual(["Wa"]);
    expect(out).toContain(TOOL_RESULT_HEADER);
    expect(out).toContain("wear(slot=a)");
  });

  test("requires slot", async () => {
    const { ctx, sentKeys } = mockCtx();
    const out = await handleWear({} as { slot: string }, ctx);
    expect(sentKeys).toEqual([]);
    expect(out).toContain("error");
  });
});

describe("handlePuton", () => {
  test("sends 'P<slot>'", async () => {
    const { ctx, sentKeys } = mockCtx();
    const out = await handlePuton({ slot: "g" }, ctx);
    expect(sentKeys).toEqual(["Pg"]);
    expect(out).toContain("puton(slot=g)");
  });

  test("rejects invalid slot", async () => {
    const { ctx, sentKeys } = mockCtx();
    const out = await handlePuton({ slot: "!!" }, ctx);
    expect(sentKeys).toEqual([]);
    expect(out).toContain("error");
  });
});

describe("handleTakeoff", () => {
  test("with slot sends 'T<slot>'", async () => {
    const { ctx, sentKeys } = mockCtx();
    const out = await handleTakeoff({ slot: "b" }, ctx);
    expect(sentKeys).toEqual(["Tb"]);
    expect(out).toContain("takeoff(slot=b)");
  });

  test("without slot sends bare 'T'", async () => {
    const { ctx, sentKeys } = mockCtx();
    const out = await handleTakeoff({}, ctx);
    expect(sentKeys).toEqual(["T"]);
    expect(out).toContain("takeoff()");
  });
});

describe("handleRemove", () => {
  test("with slot sends 'R<slot>'", async () => {
    const { ctx, sentKeys } = mockCtx();
    const out = await handleRemove({ slot: "h" }, ctx);
    expect(sentKeys).toEqual(["Rh"]);
    expect(out).toContain("remove(slot=h)");
  });

  test("without slot sends bare 'R'", async () => {
    const { ctx, sentKeys } = mockCtx();
    await handleRemove({}, ctx);
    expect(sentKeys).toEqual(["R"]);
  });
});

describe("handleWield", () => {
  test("sends 'w<slot>' for letter slot", async () => {
    const { ctx, sentKeys } = mockCtx();
    const out = await handleWield({ slot: "a" }, ctx);
    expect(sentKeys).toEqual(["wa"]);
    expect(out).toContain("wield(slot=a)");
  });

  test("'-' is a valid slot (bare hands)", async () => {
    const { ctx, sentKeys } = mockCtx();
    const out = await handleWield({ slot: "-" }, ctx);
    expect(sentKeys).toEqual(["w-"]);
    expect(out).toContain("wield(slot=-)");
  });

  test("requires slot", async () => {
    const { ctx, sentKeys } = mockCtx();
    const out = await handleWield({} as { slot: string }, ctx);
    expect(sentKeys).toEqual([]);
    expect(out).toContain("error");
  });
});
