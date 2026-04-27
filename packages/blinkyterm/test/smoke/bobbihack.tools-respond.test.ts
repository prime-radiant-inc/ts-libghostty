import { describe, expect, test } from "bun:test";
import { handleRespondPrompt } from "../../examples/bobbihack/tools/respond-prompt";
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

describe("handleRespondPrompt", () => {
  test("sends a single space to dismiss --More--", async () => {
    const { ctx, sentKeys } = mockCtx();
    const out = await handleRespondPrompt({ keys: " " }, ctx);
    expect(sentKeys).toEqual([" "]);
    expect(out).toContain(TOOL_RESULT_HEADER);
    expect(out).toContain("respond_prompt");
  });

  test("sends 'y' for yes/no prompts", async () => {
    const { ctx, sentKeys } = mockCtx();
    await handleRespondPrompt({ keys: "y" }, ctx);
    expect(sentKeys).toEqual(["y"]);
  });

  test("sends a multi-char sequence (≤8 chars) for chained prompts", async () => {
    const { ctx, sentKeys } = mockCtx();
    await handleRespondPrompt({ keys: " y\r" }, ctx);
    expect(sentKeys).toEqual([" y\r"]);
  });

  test("rejects keys longer than 8 chars", async () => {
    const { ctx, sentKeys } = mockCtx();
    const out = await handleRespondPrompt({ keys: "yyyyyyyyy" }, ctx);
    expect(sentKeys).toEqual([]);
    expect(out).toContain("error");
    expect(out).toContain("8");
  });

  test("rejects empty string", async () => {
    const { ctx, sentKeys } = mockCtx();
    const out = await handleRespondPrompt({ keys: "" }, ctx);
    expect(sentKeys).toEqual([]);
    expect(out).toContain("error");
  });

  test("rejects non-string keys", async () => {
    const { ctx, sentKeys } = mockCtx();
    const out = await handleRespondPrompt({ keys: 123 as unknown as string }, ctx);
    expect(sentKeys).toEqual([]);
    expect(out).toContain("error");
  });
});
