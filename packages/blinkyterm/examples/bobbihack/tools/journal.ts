// journal_read / journal_write — Phase 4.
//
// Six markdown files at ctx.journalDir, one per fixed section:
//   Character.md, Inventory.md, Knowledge.md, Dungeon.md, Goals.md, Hypotheses.md
//
// journal_read({section}) returns {section, content} (content="" if the
// file doesn't exist yet). Unknown sections return {error}.
//
// journal_write({section, content}) replaces the named file atomically
// (write to <Section>.md.tmp.<pid>.<rand>, then rename). Unknown sections
// or content > 64 KB return {error}; no file is created on rejection.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { ToolContext } from "../tool-context";

export const JOURNAL_SECTIONS = [
  "Character",
  "Inventory",
  "Knowledge",
  "Dungeon",
  "Goals",
  "Hypotheses",
] as const;

export type JournalSection = (typeof JOURNAL_SECTIONS)[number];

const SECTION_SET: ReadonlySet<string> = new Set(JOURNAL_SECTIONS);

const MAX_CONTENT_BYTES = 64 * 1024;

function isJournalSection(s: unknown): s is JournalSection {
  return typeof s === "string" && SECTION_SET.has(s);
}

function unknownSectionError(s: unknown): string {
  return JSON.stringify({
    error: `unknown section ${JSON.stringify(s)}. Valid: ${JOURNAL_SECTIONS.join(", ")}`,
  });
}

function sectionPath(journalDir: string, section: JournalSection): string {
  return join(journalDir, `${section}.md`);
}

export async function handleJournalRead(
  args: unknown,
  ctx: ToolContext,
): Promise<string> {
  const a = (args ?? {}) as { section?: unknown };
  if (!isJournalSection(a.section)) {
    return unknownSectionError(a.section);
  }
  const path = sectionPath(ctx.journalDir, a.section);
  if (!existsSync(path)) {
    return JSON.stringify({ section: a.section, content: "" });
  }
  const content = readFileSync(path, "utf8");
  return JSON.stringify({ section: a.section, content });
}

export async function handleJournalWrite(
  args: unknown,
  ctx: ToolContext,
): Promise<string> {
  const a = (args ?? {}) as { section?: unknown; content?: unknown };
  if (!isJournalSection(a.section)) {
    return unknownSectionError(a.section);
  }
  if (typeof a.content !== "string") {
    return JSON.stringify({
      error: "content must be a string",
    });
  }
  // Size check uses byte length, not code-unit length, since the spec
  // says "≤64KB" of content.
  const byteLen = Buffer.byteLength(a.content, "utf8");
  if (byteLen > MAX_CONTENT_BYTES) {
    return JSON.stringify({
      error: `section content exceeds 64KB (${byteLen} bytes; limit ${MAX_CONTENT_BYTES})`,
    });
  }

  // Make sure the journal directory exists. The runtime path normally
  // creates it during run-lock acquisition (paths.ts), but tests use
  // ad-hoc temp dirs and a fresh nested directory should still work.
  mkdirSync(ctx.journalDir, { recursive: true });

  // Atomic write: temp file in the same dir, then rename. Same-directory
  // rename is guaranteed atomic on POSIX filesystems.
  const finalPath = sectionPath(ctx.journalDir, a.section);
  const tmpPath = `${finalPath}.tmp.${process.pid}.${randomBytes(4).toString("hex")}`;
  try {
    writeFileSync(tmpPath, a.content, "utf8");
    renameSync(tmpPath, finalPath);
  } catch (err) {
    // Best-effort cleanup of the temp file on failure.
    try {
      unlinkSync(tmpPath);
    } catch {
      /* ignore */
    }
    return JSON.stringify({
      error: `journal_write failed: ${(err as Error).message}`,
    });
  }
  return JSON.stringify({ ok: true });
}
