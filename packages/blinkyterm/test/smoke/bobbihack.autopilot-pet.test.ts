// End-to-end smoke test for the attribute-aware autopilot interrupt
// fix. Spawns a real NetHack with `hilite_pet` enabled, gets to the
// dungeon, and sends a series of movement keys. The detector
// (`runInterruptChecks`) is run on each consecutive frame pair. The
// pre-fix behavior was that `monster_visible` fired on the very first
// step because the pet moves around (and auto-swaps) with the player.
// The fix is verified by:
//   1. The detector does NOT report `monster_visible` as primary on any
//      pair of frames where the only letter-glyph movement was a pet.
//   2. At least one frame contained a pet glyph (so we're not just
//      lucky — `hilite_pet` is actually working in this binary).
//
// Skipped cleanly when NetHack is not on PATH.
//
// Spec: docs/superpowers/specs/2026-05-07-bobbihack-attribute-aware-interrupts-design.md.

import { describe, expect, test } from "bun:test";
import { Runner } from "../../src/index";
import { hasNethack, nethackEnv } from "../../examples/shared/nethack-setup";
import { GameMap } from "../../examples/bobbihack/game-map";
import { parseStatusLine, parseMessageLine } from "../../examples/bobbihack/parsers";
import { buildGlyphClass, type GlyphClass } from "../../examples/bobbihack/glyph-class";
import {
  runInterruptChecks,
  type InterruptContext,
  type InterruptFrame,
} from "../../examples/bobbihack/interrupts";
import type { Frame } from "../../src/index";

interface CapturedFrame {
  rows: string[];
  glyphClass: ReadonlyArray<ReadonlyArray<GlyphClass | undefined>>;
  status: ReturnType<typeof parseStatusLine>;
  message: string;
  frameReason: string;
  petCount: number;
}

function captureFrame(frame: Frame, map: GameMap): CapturedFrame {
  const rows = frame.snapshot.text.split("\n");
  const message = parseMessageLine(rows[0] ?? "");
  const status = parseStatusLine(
    rows[rows.length - 2] ?? "",
    rows[rows.length - 1] ?? "",
  );
  map.updateFromFrame(rows, status, message);
  const glyphClass = buildGlyphClass(frame.snapshot, rows, map.currentPlayerXY);
  let petCount = 0;
  for (const row of glyphClass) {
    for (const cls of row) if (cls === "pet") petCount++;
  }
  return {
    rows,
    glyphClass,
    status,
    message,
    frameReason: frame.reason,
    petCount,
  };
}

function toInterruptFrame(c: CapturedFrame): InterruptFrame & { frameReason: string } {
  return {
    rows: c.rows,
    glyphClass: c.glyphClass,
    status: c.status,
    message: c.message,
    frameReason: c.frameReason,
  };
}

describe("bobbihack autopilot does not abort on pet movement", () => {
  test.skipIf(!hasNethack())(
    "monster_visible does not fire when the only glyph movement is the pet",
    async () => {
      const runner = await Runner.spawn(["nethack"], {
        cols: 80,
        rows: 24,
        env: nethackEnv(),
        frame: { minIntervalMs: 100, maxIntervalMs: 5_000, quiesceMs: 100 },
      });

      try {
        const iter = runner.frames()[Symbol.asyncIterator]();
        const map = new GameMap();

        // Drive past intro splash. NetHack prints a multi-screen
        // intro followed by --More-- prompts before the dungeon view
        // is finally drawn. We send \r/space until we get a frame where
        // (a) an actual `@` glyph exists on screen, and (b) the message
        // line is not a --More-- prompt. The status line is already
        // populated in early frames (it shows Dlvl:1 even on the
        // splash) so dlvl alone is not a reliable signal.
        let dungeon: CapturedFrame | null = null;
        for (let attempt = 0; attempt < 12; attempt++) {
          const next = await Promise.race([
            iter.next(),
            new Promise<null>((r) => setTimeout(() => r(null), 5_000)),
          ]);
          if (next === null) break;
          if (next.done || next.value === undefined) break;
          const cap = captureFrame(next.value, map);
          const hasAtGlyph = cap.rows.some((r) => r.includes("@"));
          const isMore = cap.message.includes("--More--");
          if (hasAtGlyph && !isMore && map.currentPlayerXY !== null) {
            dungeon = cap;
            break;
          }
          if (runner.exited) break;
          // Use space to dismiss --More-- (NetHack accepts \r or space).
          await runner.sendText(" ");
        }
        expect(dungeon).not.toBeNull();
        if (dungeon === null) return;

        // Sanity: the valkyrie starts adjacent to a pet (kitten or small
        // dog). With hilite_pet on, that pet must classify as `pet`. If
        // it doesn't, hilite_pet has silently broken in this build and
        // the rest of the test isn't meaningful.
        expect(dungeon.petCount).toBeGreaterThan(0);

        // Send a few movement keys and run the interrupt detector on
        // each consecutive (prev, cur) pair. Walking around in the
        // starting room produces frames where the pet has moved (pets
        // move every player turn). With the bug, monster_visible would
        // fire on the first such pair. With the fix, it must not fire
        // unless an actual hostile glyph appears.
        const captured: CapturedFrame[] = [dungeon];
        const moves = ["l", "h", "j", "k", "l", "h", "j", "k"];
        for (const key of moves) {
          if (runner.exited) break;
          await runner.sendText(key);
          const next = await Promise.race([
            iter.next(),
            new Promise<null>((r) => setTimeout(() => r(null), 5_000)),
          ]);
          if (next === null) break;
          if (next.done || next.value === undefined) break;
          const cap = captureFrame(next.value, map);
          captured.push(cap);
          if (cap.message.includes("--More--")) {
            // Dismiss any popup so we keep moving.
            await runner.sendText(" ");
            const dismiss = await Promise.race([
              iter.next(),
              new Promise<null>((r) => setTimeout(() => r(null), 2_000)),
            ]);
            if (dismiss !== null && !dismiss.done && dismiss.value !== undefined) {
              captured.push(captureFrame(dismiss.value, map));
            }
          }
        }

        // We need at least one (prev, cur) pair to make the detector
        // assertion meaningful.
        expect(captured.length).toBeGreaterThanOrEqual(2);

        // Run the detector on every consecutive pair and collect any
        // monster_visible hits. The fix is correct iff the detector
        // never fires on pure-pet movement. If it does fire we accept
        // it ONLY if the detail name corresponds to a glyph the
        // captured frame classified as `normal` (i.e. an actual hostile
        // appeared mid-test, which is a real-world flake we tolerate).
        let petSeenAcrossRun = dungeon.petCount > 0;
        const spuriousFires: string[] = [];
        for (let i = 1; i < captured.length; i++) {
          const prev = captured[i - 1]!;
          const cur = captured[i]!;
          if (cur.petCount > 0) petSeenAcrossRun = true;
          const ictx: InterruptContext = {
            prev: toInterruptFrame(prev),
            cur: toInterruptFrame(cur),
          };
          const result = runInterruptChecks(ictx);
          if (result.primary?.name === "monster_visible") {
            // Tolerate hostiles that legitimately wandered into view.
            // Parse "<ch> at (x,y)" to find the cell and confirm it was
            // classified normal (not pet).
            const detail = result.primary.detail ?? "";
            const m = detail.match(/^(\S) at \((\d+),(\d+)\)$/);
            if (m !== null) {
              const x = Number(m[2]);
              const y = Number(m[3]);
              const cls = cur.glyphClass[y]?.[x];
              if (cls === "pet") {
                // This is the bug we're fixing — record it as a real
                // failure.
                spuriousFires.push(`pair ${i - 1}->${i}: ${detail} (classified pet)`);
              }
              // If cls === "normal" or undefined, treat as a real
              // hostile encounter and stop scanning further pairs;
              // we've already verified no spurious pet-fire occurred.
              break;
            }
          }
        }

        expect(spuriousFires).toEqual([]);
        expect(petSeenAcrossRun).toBe(true);
      } finally {
        try {
          await runner.terminate({ signal: "SIGTERM", thenAfterMs: 500 });
        } catch {
          // ignore
        }
      }
    },
    45_000,
  );
});
