import { describe, expect, test } from "bun:test";
import {
  handleEat,
  handleQuaff,
  handleRead,
} from "../../examples/bobbihack/tools/items-consume";
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
        status: status(),
        message: "",
        frameReason: "cellChange",
        screenAnsi: rows.join("\n"),
      };
    },
  };
  return { ctx, sentKeys };
}

describe("handleEat", () => {
  test("with slot sends 'e<slot>'", async () => {
    const { ctx, sentKeys } = mockCtx();
    const out = await handleEat({ slot: "d" }, ctx);
    expect(sentKeys).toEqual(["ed"]);
    expect(out).toContain(TOOL_RESULT_HEADER);
    expect(out).toContain("eat(slot=d)");
  });

  test("without slot sends bare 'e' (yields for prompt)", async () => {
    const { ctx, sentKeys } = mockCtx();
    const out = await handleEat({}, ctx);
    expect(sentKeys).toEqual(["e"]);
    expect(out).toContain("eat()");
  });

  test("rejects invalid slot", async () => {
    const { ctx, sentKeys } = mockCtx();
    const out = await handleEat({ slot: "ab" }, ctx);
    expect(sentKeys).toEqual([]);
    expect(out).toContain("error");
    expect(out).toContain("eat");
  });
});

describe("handleQuaff", () => {
  test("with slot sends 'q<slot>'", async () => {
    const { ctx, sentKeys } = mockCtx();
    const out = await handleQuaff({ slot: "f" }, ctx);
    expect(sentKeys).toEqual(["qf"]);
    expect(out).toContain("quaff(slot=f)");
  });

  test("without slot sends bare 'q'", async () => {
    const { ctx, sentKeys } = mockCtx();
    const out = await handleQuaff({}, ctx);
    expect(sentKeys).toEqual(["q"]);
    expect(out).toContain("quaff()");
  });

  test("rejects digits as slot", async () => {
    const { ctx, sentKeys } = mockCtx();
    const out = await handleQuaff({ slot: "1" }, ctx);
    expect(sentKeys).toEqual([]);
    expect(out).toContain("error");
  });
});

describe("handleRead", () => {
  test("sends 'r<slot>'", async () => {
    const { ctx, sentKeys } = mockCtx();
    const out = await handleRead({ slot: "c" }, ctx);
    expect(sentKeys).toEqual(["rc"]);
    expect(out).toContain("read(slot=c)");
  });

  test("requires slot", async () => {
    const { ctx, sentKeys } = mockCtx();
    const out = await handleRead({} as { slot: string }, ctx);
    expect(sentKeys).toEqual([]);
    expect(out).toContain("error");
  });

  test("rejects non-string slot", async () => {
    const { ctx, sentKeys } = mockCtx();
    const out = await handleRead({ slot: 7 as unknown as string }, ctx);
    expect(sentKeys).toEqual([]);
    expect(out).toContain("error");
  });

  test("accepts uppercase slot", async () => {
    const { ctx, sentKeys } = mockCtx();
    await handleRead({ slot: "Z" }, ctx);
    expect(sentKeys).toEqual(["rZ"]);
  });
});
