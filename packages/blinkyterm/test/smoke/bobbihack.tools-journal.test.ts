// Tests for handleJournalRead and handleJournalWrite — Phase 4.
//
// The journal is six markdown files at <journalDir>/<Section>.md. Reads
// return {section, content}; missing files return content: "". Writes
// must be atomic (temp + rename), validate the section enum, and reject
// content > 64KB. Unknown sections return {error}.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  handleJournalRead,
  handleJournalWrite,
  JOURNAL_SECTIONS,
} from "../../examples/bobbihack/tools/journal";
import { GameMap } from "../../examples/bobbihack/game-map";
import type { ToolContext } from "../../examples/bobbihack/tool-context";

function mockCtx(journalDir: string): ToolContext {
  const ac = new AbortController();
  return {
    map: new GameMap(),
    runState: { gameOver: false, endReason: null },
    signal: ac.signal,
    journalDir,
    sendKeysAndWait: async () => {
      throw new Error("sendKeysAndWait should not be called by journal handlers");
    },
  };
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bbh-journal-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("JOURNAL_SECTIONS", () => {
  test("contains exactly the six fixed sections", () => {
    expect(JOURNAL_SECTIONS).toEqual([
      "Character",
      "Inventory",
      "Knowledge",
      "Dungeon",
      "Goals",
      "Hypotheses",
    ]);
  });
});

describe("handleJournalRead", () => {
  test("returns empty content for a missing file", async () => {
    const ctx = mockCtx(dir);
    const out = await handleJournalRead({ section: "Goals" }, ctx);
    const parsed = JSON.parse(out) as { section: string; content: string };
    expect(parsed).toEqual({ section: "Goals", content: "" });
  });

  test("reads previously-written content", async () => {
    writeFileSync(join(dir, "Character.md"), "I am a Valkyrie.\nLawful, Tyr.");
    const ctx = mockCtx(dir);
    const out = await handleJournalRead({ section: "Character" }, ctx);
    const parsed = JSON.parse(out) as { section: string; content: string };
    expect(parsed.section).toBe("Character");
    expect(parsed.content).toBe("I am a Valkyrie.\nLawful, Tyr.");
  });

  test("rejects unknown section names", async () => {
    const ctx = mockCtx(dir);
    const out = await handleJournalRead({ section: "Notes2" }, ctx);
    const parsed = JSON.parse(out) as { error: string };
    expect(parsed.error).toBeDefined();
    expect(parsed.error).toContain("Notes2");
    // Should list valid sections so the model can recover.
    expect(parsed.error).toContain("Character");
  });

  test("rejects missing section argument", async () => {
    const ctx = mockCtx(dir);
    const out = await handleJournalRead({}, ctx);
    const parsed = JSON.parse(out) as { error: string };
    expect(parsed.error).toBeDefined();
  });

  test("rejects non-string section argument", async () => {
    const ctx = mockCtx(dir);
    const out = await handleJournalRead({ section: 5 }, ctx);
    const parsed = JSON.parse(out) as { error: string };
    expect(parsed.error).toBeDefined();
  });

  test("reads each of the six sections by name", async () => {
    const ctx = mockCtx(dir);
    for (const s of JOURNAL_SECTIONS) {
      writeFileSync(join(dir, `${s}.md`), `content of ${s}`);
      const out = await handleJournalRead({ section: s }, ctx);
      const parsed = JSON.parse(out) as { section: string; content: string };
      expect(parsed.section).toBe(s);
      expect(parsed.content).toBe(`content of ${s}`);
    }
  });
});

describe("handleJournalWrite", () => {
  test("writes content to <section>.md and returns ok", async () => {
    const ctx = mockCtx(dir);
    const out = await handleJournalWrite(
      { section: "Goals", content: "Reach the Mines." },
      ctx,
    );
    const parsed = JSON.parse(out) as { ok: boolean };
    expect(parsed.ok).toBe(true);
    const onDisk = readFileSync(join(dir, "Goals.md"), "utf8");
    expect(onDisk).toBe("Reach the Mines.");
  });

  test("overwrites existing content", async () => {
    writeFileSync(join(dir, "Goals.md"), "old");
    const ctx = mockCtx(dir);
    await handleJournalWrite({ section: "Goals", content: "new" }, ctx);
    expect(readFileSync(join(dir, "Goals.md"), "utf8")).toBe("new");
  });

  test("round-trip: write then read returns same content", async () => {
    const ctx = mockCtx(dir);
    const text = "Knowledge:\n- scroll FOOBIE = identify\n- yellow potion = healing\n";
    await handleJournalWrite({ section: "Knowledge", content: text }, ctx);
    const out = await handleJournalRead({ section: "Knowledge" }, ctx);
    const parsed = JSON.parse(out) as { section: string; content: string };
    expect(parsed.content).toBe(text);
  });

  test("rejects unknown section name", async () => {
    const ctx = mockCtx(dir);
    const out = await handleJournalWrite(
      { section: "Misc", content: "x" },
      ctx,
    );
    const parsed = JSON.parse(out) as { error: string };
    expect(parsed.error).toBeDefined();
    expect(parsed.error).toContain("Misc");
    // No file should have been created.
    expect(readdirSync(dir)).toEqual([]);
  });

  test("rejects content > 64KB", async () => {
    const ctx = mockCtx(dir);
    const big = "x".repeat(64 * 1024 + 1);
    const out = await handleJournalWrite(
      { section: "Goals", content: big },
      ctx,
    );
    const parsed = JSON.parse(out) as { error: string };
    expect(parsed.error).toBeDefined();
    expect(parsed.error).toContain("64");
    expect(readdirSync(dir)).toEqual([]);
  });

  test("accepts content exactly at 64KB", async () => {
    const ctx = mockCtx(dir);
    const justFit = "x".repeat(64 * 1024);
    const out = await handleJournalWrite(
      { section: "Goals", content: justFit },
      ctx,
    );
    const parsed = JSON.parse(out) as { ok: boolean };
    expect(parsed.ok).toBe(true);
    expect(readFileSync(join(dir, "Goals.md"), "utf8").length).toBe(64 * 1024);
  });

  test("rejects non-string content", async () => {
    const ctx = mockCtx(dir);
    const out = await handleJournalWrite(
      { section: "Goals", content: 42 },
      ctx,
    );
    const parsed = JSON.parse(out) as { error: string };
    expect(parsed.error).toBeDefined();
  });

  test("rejects missing section", async () => {
    const ctx = mockCtx(dir);
    const out = await handleJournalWrite({ content: "hi" }, ctx);
    const parsed = JSON.parse(out) as { error: string };
    expect(parsed.error).toBeDefined();
  });

  test("creates the journal directory if it doesn't exist yet", async () => {
    const nested = join(dir, "fresh-run", "journal");
    const ctx = mockCtx(nested);
    const out = await handleJournalWrite(
      { section: "Character", content: "fresh start" },
      ctx,
    );
    const parsed = JSON.parse(out) as { ok: boolean };
    expect(parsed.ok).toBe(true);
    expect(readFileSync(join(nested, "Character.md"), "utf8")).toBe("fresh start");
  });

  test("write is atomic — no partial temp file remains on success", async () => {
    const ctx = mockCtx(dir);
    await handleJournalWrite(
      { section: "Dungeon", content: "D1: stairs down at (12,7)" },
      ctx,
    );
    // Only the final file should remain — no .tmp leftovers.
    const files = readdirSync(dir);
    expect(files).toEqual(["Dungeon.md"]);
  });

  test("accepts empty content (clearing a section)", async () => {
    const ctx = mockCtx(dir);
    writeFileSync(join(dir, "Hypotheses.md"), "old guesses");
    const out = await handleJournalWrite(
      { section: "Hypotheses", content: "" },
      ctx,
    );
    const parsed = JSON.parse(out) as { ok: boolean };
    expect(parsed.ok).toBe(true);
    expect(readFileSync(join(dir, "Hypotheses.md"), "utf8")).toBe("");
  });
});
