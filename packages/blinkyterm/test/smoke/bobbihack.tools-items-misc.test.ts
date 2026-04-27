import { describe, expect, test } from "bun:test";
import {
  handleZap,
  handleDrop,
  handleThrow,
  handleApply,
  handleKick,
  handlePray,
  handleForceFight,
  handleExtendedCommand,
  handleCommand,
} from "../../examples/bobbihack/tools/items-misc";
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

describe("handleZap", () => {
  test("with direction sends 'z<slot><dir-key>'", async () => {
    const { ctx, sentKeys } = mockCtx();
    const out = await handleZap({ slot: "f", direction: "east" }, ctx);
    expect(sentKeys).toEqual(["zfl"]);
    expect(out).toContain(TOOL_RESULT_HEADER);
    expect(out).toContain("zap(slot=f, direction=east)");
  });

  test("without direction sends 'z<slot>' (model can follow up)", async () => {
    const { ctx, sentKeys } = mockCtx();
    const out = await handleZap({ slot: "f" }, ctx);
    expect(sentKeys).toEqual(["zf"]);
    expect(out).toContain("zap(slot=f)");
  });

  test("rejects up/down direction", async () => {
    const { ctx, sentKeys } = mockCtx();
    const out = await handleZap(
      { slot: "f", direction: "up" as unknown as "north" },
      ctx,
    );
    expect(sentKeys).toEqual([]);
    expect(out).toContain("error");
  });

  test("requires slot", async () => {
    const { ctx, sentKeys } = mockCtx();
    const out = await handleZap({} as { slot: string }, ctx);
    expect(sentKeys).toEqual([]);
    expect(out).toContain("error");
  });
});

describe("handleDrop", () => {
  test("sends 'd<slot>'", async () => {
    const { ctx, sentKeys } = mockCtx();
    const out = await handleDrop({ slot: "e" }, ctx);
    expect(sentKeys).toEqual(["de"]);
    expect(out).toContain("drop(slot=e)");
  });

  test("requires slot", async () => {
    const { ctx, sentKeys } = mockCtx();
    const out = await handleDrop({} as { slot: string }, ctx);
    expect(sentKeys).toEqual([]);
    expect(out).toContain("error");
  });
});

describe("handleThrow", () => {
  test("sends 't<slot><dir-key>'", async () => {
    const { ctx, sentKeys } = mockCtx();
    const out = await handleThrow({ slot: "g", direction: "northeast" }, ctx);
    expect(sentKeys).toEqual(["tgu"]);
    expect(out).toContain("throw(slot=g, direction=northeast)");
  });

  test("requires direction", async () => {
    const { ctx, sentKeys } = mockCtx();
    const out = await handleThrow(
      { slot: "g" } as { slot: string; direction: "north" },
      ctx,
    );
    expect(sentKeys).toEqual([]);
    expect(out).toContain("error");
  });

  test("requires slot", async () => {
    const { ctx, sentKeys } = mockCtx();
    const out = await handleThrow(
      { direction: "north" } as { slot: string; direction: "north" },
      ctx,
    );
    expect(sentKeys).toEqual([]);
    expect(out).toContain("error");
  });
});

describe("handleApply", () => {
  test("sends 'a<slot>'", async () => {
    const { ctx, sentKeys } = mockCtx();
    const out = await handleApply({ slot: "c" }, ctx);
    expect(sentKeys).toEqual(["ac"]);
    expect(out).toContain("apply(slot=c)");
  });
});

describe("handleKick", () => {
  test("sends '\\x04<dir-key>'", async () => {
    const { ctx, sentKeys } = mockCtx();
    const out = await handleKick({ direction: "south" }, ctx);
    expect(sentKeys).toEqual(["\x04j"]);
    expect(out).toContain("kick(direction=south)");
  });

  test("rejects invalid direction", async () => {
    const { ctx, sentKeys } = mockCtx();
    const out = await handleKick(
      { direction: "down" as unknown as "north" },
      ctx,
    );
    expect(sentKeys).toEqual([]);
    expect(out).toContain("error");
  });
});

describe("handlePray", () => {
  test("sends '#pray\\r'", async () => {
    const { ctx, sentKeys } = mockCtx();
    const out = await handlePray({}, ctx);
    expect(sentKeys).toEqual(["#pray\r"]);
    expect(out).toContain("pray()");
  });
});

describe("handleForceFight", () => {
  test("sends 'F<dir-key>'", async () => {
    const { ctx, sentKeys } = mockCtx();
    const out = await handleForceFight({ direction: "west" }, ctx);
    expect(sentKeys).toEqual(["Fh"]);
    expect(out).toContain("force_fight(direction=west)");
  });

  test("rejects invalid direction", async () => {
    const { ctx, sentKeys } = mockCtx();
    const out = await handleForceFight(
      { direction: "up" as unknown as "north" },
      ctx,
    );
    expect(sentKeys).toEqual([]);
    expect(out).toContain("error");
  });
});

describe("handleExtendedCommand", () => {
  test("sends '#<name>\\r' for name-only invocation", async () => {
    const { ctx, sentKeys } = mockCtx();
    const out = await handleExtendedCommand({ name: "chat" }, ctx);
    expect(sentKeys).toEqual(["#chat\r"]);
    expect(out).toContain("extended_command(chat)");
  });

  test("appends args literally after \\r", async () => {
    const { ctx, sentKeys } = mockCtx();
    await handleExtendedCommand({ name: "name", args: "y\r" }, ctx);
    expect(sentKeys).toEqual(["#name\ry\r"]);
  });

  test("rejects uppercase / mixed-case names", async () => {
    const { ctx, sentKeys } = mockCtx();
    const out = await handleExtendedCommand({ name: "Chat" }, ctx);
    expect(sentKeys).toEqual([]);
    expect(out).toContain("error");
  });

  test("rejects oversized args", async () => {
    const { ctx, sentKeys } = mockCtx();
    const out = await handleExtendedCommand(
      { name: "name", args: "x".repeat(33) },
      ctx,
    );
    expect(sentKeys).toEqual([]);
    expect(out).toContain("error");
  });
});

describe("handleCommand", () => {
  test("sends literal keys", async () => {
    const { ctx, sentKeys } = mockCtx();
    const out = await handleCommand({ keys: "  " }, ctx);
    expect(sentKeys).toEqual(["  "]);
    expect(out).toContain("command(");
  });

  test("rejects empty", async () => {
    const { ctx, sentKeys } = mockCtx();
    const out = await handleCommand({ keys: "" }, ctx);
    expect(sentKeys).toEqual([]);
    expect(out).toContain("error");
  });

  test("rejects keys > 16 chars", async () => {
    const { ctx, sentKeys } = mockCtx();
    const out = await handleCommand({ keys: "x".repeat(17) }, ctx);
    expect(sentKeys).toEqual([]);
    expect(out).toContain("error");
  });

  test("rejects non-string", async () => {
    const { ctx, sentKeys } = mockCtx();
    const out = await handleCommand(
      { keys: 5 as unknown as string },
      ctx,
    );
    expect(sentKeys).toEqual([]);
    expect(out).toContain("error");
  });
});
