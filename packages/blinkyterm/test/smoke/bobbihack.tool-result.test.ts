import { describe, expect, test } from "bun:test";
import {
  formatToolResult,
  formatGameOverResult,
  TOOL_RESULT_HEADER,
} from "../../examples/bobbihack/tool-result";
import { GameMap } from "../../examples/bobbihack/game-map";
import type { StatusLine } from "../../examples/bobbihack/parsers";

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
    dlvl: 2,
    turn: 142,
    gold: 0,
    hunger: "ok",
    conditions: [],
    ...overrides,
  };
}

const SCREEN_ANSI = "<screen ansi here>";

describe("formatToolResult", () => {
  test("includes the v1 header line as the first line", () => {
    const m = new GameMap();
    // Manually populate visitedFloors via updateFromFrame on a synthetic frame.
    const dummyFrame = Array.from({ length: 24 }, () => " ".repeat(80));
    dummyFrame[5] = "  @  ".padEnd(80, " ");
    m.updateFromFrame(dummyFrame, status({ dlvl: 1, turn: 1 }), "");
    m.updateFromFrame(dummyFrame, status({ dlvl: 2, turn: 50 }), "", {
      tool: "move",
      args: { direction: "down" },
    });
    const out = formatToolResult({
      summary: "move(east): moved to (12,8).",
      screenAnsi: SCREEN_ANSI,
      map: m,
      status: status(),
    });
    const lines = out.split("\n");
    expect(lines[0]).toBe(TOOL_RESULT_HEADER);
    expect(TOOL_RESULT_HEADER).toBe("== bobbihack tool_result v1 ==");
  });

  test("layers in correct order: header, summary, standing, status, blank, screen", () => {
    const m = new GameMap();
    m.updateFromFrame(
      Array.from({ length: 24 }, () => " ".repeat(80)),
      status({ dlvl: 2, turn: 142 }),
      "",
    );
    const out = formatToolResult({
      summary: "move(east): bumped a wall.",
      screenAnsi: SCREEN_ANSI,
      map: m,
      status: status({ dlvl: 2, turn: 142 }),
    });
    const lines = out.split("\n");
    expect(lines[0]).toBe(TOOL_RESULT_HEADER);
    expect(lines[1]).toBe("move(east): bumped a wall.");
    expect(lines[2]).toMatch(/^Floor: D2\. Visited: .*Turn: 142\./);
    expect(lines[3]).toMatch(/^HP 14\/14/);
    expect(lines[4]).toBe("");
    expect(lines.slice(5).join("\n")).toBe(SCREEN_ANSI);
  });

  test("standing-state line lists visited floors", () => {
    const m = new GameMap();
    const dummyFrame = Array.from({ length: 24 }, () => " ".repeat(80));
    dummyFrame[5] = "  @  ".padEnd(80, " ");
    m.updateFromFrame(dummyFrame, status({ dlvl: 1, turn: 1 }), "");
    m.updateFromFrame(dummyFrame, status({ dlvl: 2, turn: 50 }), "", {
      tool: "move",
      args: { direction: "down" },
    });
    const out = formatToolResult({
      summary: "move(east).",
      screenAnsi: SCREEN_ANSI,
      map: m,
      status: status({ dlvl: 2, turn: 50 }),
    });
    expect(out).toContain("Visited: D1, D2");
    expect(out).toContain("Floor: D2");
  });

  test("status block includes hunger and conditions", () => {
    const m = new GameMap();
    const out = formatToolResult({
      summary: "move(east).",
      screenAnsi: SCREEN_ANSI,
      map: m,
      status: status({
        hp: 8,
        hpMax: 14,
        pw: 0,
        pwMax: 5,
        ac: 6,
        hunger: "Hungry",
        conditions: ["Conf", "Stun"],
      }),
    });
    expect(out).toContain("HP 8/14");
    expect(out).toContain("Pw 0/5");
    expect(out).toContain("AC 6");
    expect(out).toContain("Hunger: Hungry");
    expect(out).toContain("Conf");
    expect(out).toContain("Stun");
  });

  test("status block uses '-' when no conditions present", () => {
    const m = new GameMap();
    const out = formatToolResult({
      summary: "move(east).",
      screenAnsi: SCREEN_ANSI,
      map: m,
      status: status(),
    });
    expect(out).toContain("Cond: -");
  });

  test("output ends with the screen ansi unchanged", () => {
    const m = new GameMap();
    const screen = "\x1b[2;3HABCDEFG\x1b[3;3HHIJKLMN";
    const out = formatToolResult({
      summary: "test.",
      screenAnsi: screen,
      map: m,
      status: status(),
    });
    expect(out.endsWith(screen)).toBe(true);
  });
});

describe("formatGameOverResult", () => {
  test("emits GAME OVER format", () => {
    const out = formatGameOverResult({
      reason: "killed by a kobold",
      finalTurn: 273,
      finalHp: -3,
      finalHpMax: 14,
      screenAnsi: SCREEN_ANSI,
    });
    const lines = out.split("\n");
    expect(lines[0]).toBe(TOOL_RESULT_HEADER);
    expect(lines[1]).toContain("GAME OVER: killed by a kobold");
    expect(lines[1]).toContain("Final turn: 273");
    expect(lines[1]).toContain("Final HP: -3/14");
    expect(out.endsWith(SCREEN_ANSI)).toBe(true);
  });
});
