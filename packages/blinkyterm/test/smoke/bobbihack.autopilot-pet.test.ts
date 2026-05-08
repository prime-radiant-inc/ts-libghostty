// End-to-end smoke for the attribute-aware monster_visible fix. Spawns
// real NetHack with hilite_pet enabled, dismisses the startup splash,
// then drives `handleAutopilotExplore` for up to 5 steps and asserts
// the autopilot did NOT stop with `monster_visible` despite the pet
// being adjacent and moving every turn. Also asserts the pet was
// actually classified at least once during the run, so the test fails
// loudly if `hilite_pet` ever silently breaks (pet would otherwise
// classify `normal` and the detector would fire on its first move,
// failing the no-monster_visible assertion — but a sanity guard on
// petCount catches the case where the pet wandered off-screen before
// any move was sent).
//
// Set AUTOPILOT_TRACE=1 for per-step timing trace, AUTOPILOT_DUMP=1
// for verbose row-by-row dumps of splash + result. Both are off by
// default to keep CI output tidy.
//
// Spec: docs/superpowers/specs/2026-05-07-bobbihack-attribute-aware-interrupts-design.md.

import { describe, expect, test } from "bun:test";
import { Runner, type Frame } from "../../src/index";
import { hasNethack, nethackEnv } from "../../examples/shared/nethack-setup";
import { GameMap } from "../../examples/bobbihack/game-map";
import { parseStatusLine, parseMessageLine } from "../../examples/bobbihack/parsers";
import { buildGlyphClass } from "../../examples/bobbihack/glyph-class";
import { handleAutopilotExplore } from "../../examples/bobbihack/tools/autopilot";
import type { ToolContext, FrameAwaitResult } from "../../examples/bobbihack/tool-context";

const TRACE = process.env.AUTOPILOT_TRACE === "1";
const DUMP = process.env.AUTOPILOT_DUMP === "1";

function trace(...args: unknown[]): void {
  if (TRACE) console.log("[autopilot-trace]", ...args);
}

function dumpFrame(label: string, rows: string[]): void {
  if (!DUMP) return;
  console.log(`---- ${label} ----`);
  rows.forEach((r, y) => console.log(`${String(y).padStart(2)} |${r}|`));
}

describe("bobbihack autopilot end-to-end", () => {
  test.skipIf(!hasNethack())(
    "handleAutopilotExplore runs past pet without aborting",
    async () => {
      const t0 = performance.now();
      trace("spawn nethack");
      const runner = await Runner.spawn(["nethack"], {
        cols: 80,
        rows: 24,
        env: nethackEnv(),
        frame: { minIntervalMs: 100, maxIntervalMs: 5_000, quiesceMs: 100 },
      });
      trace(`spawned in ${(performance.now() - t0).toFixed(0)}ms`);

      try {
        const iter = runner.frames()[Symbol.asyncIterator]();
        const map = new GameMap();

        // ---- splash dismissal ----
        // Three modal types we know about, in observed startup order:
        //   1. role intro --More-- ("It is written in the Book of...")
        //   2. welcome --More-- ("Velkommen agent, welcome to NetHack!")
        //   3. yn prompt "Do you want a tutorial?" — needs `n`, not space
        // After all three, the dungeon is unobstructed. Dismissal:
        //   --More-- → space (any key works but space is canonical)
        //   tutorial yn prompt → n
        //   (end) menu marker → space (closes a paged menu)
        // Use raw rows for prompt detection — parseMessageLine strips
        // --More-- before returning.
        let dungeonReached = false;
        let dungeonFrame: Frame | undefined;
        for (let attempt = 0; attempt < 40; attempt++) {
          const next = await Promise.race([
            iter.next(),
            new Promise<null>((r) => setTimeout(() => r(null), 5_000)),
          ]);
          if (next === null) {
            trace(`splash[${attempt}]: TIMEOUT`);
            break;
          }
          if (next.done || next.value === undefined) break;
          const rows = next.value.snapshot.text.split("\n");
          const rawAll = rows.join("\n");
          const rawMsg = rows[0] ?? "";
          const message = parseMessageLine(rawMsg);
          const stat = parseStatusLine(
            rows[rows.length - 2] ?? "",
            rows[rows.length - 1] ?? "",
          );
          map.updateFromFrame(rows, stat, message);
          const hasMore = /--More--/.test(rawAll);
          const hasReturnPrompt = /Hit return to continue/i.test(rawAll);
          const hasTutorialPrompt = /Do you want a tutorial\?/i.test(rawAll);
          const hasYnPrompt = /\[(yn|ynq|yna)/i.test(rawAll); // generic yn
          const hasEndMarker = /\(end\)/.test(rawAll);
          const hasAt = map.currentPlayerXY !== null;
          const terrainCount = rows.reduce(
            (n, r) => n + (r.match(/[.#]/g)?.length ?? 0),
            0,
          );
          trace(
            `splash[${attempt}] ${(performance.now() - t0).toFixed(0)}ms reason=${next.value.reason}`,
            `hasMore=${hasMore} tutorial=${hasTutorialPrompt} yn=${hasYnPrompt} end=${hasEndMarker} terrain=${terrainCount} hasAt=${hasAt}`,
            `rawMsg=${JSON.stringify(rawMsg.trim().slice(0, 60))}`,
          );
          if (DUMP && attempt < 5) dumpFrame(`splash ${attempt}`, rows);

          // Pick a dismissal key. Order matters: --More-- can co-render
          // with menu paging; resolve --More-- first.
          let key: string | null = null;
          if (hasTutorialPrompt) key = "n";
          else if (hasMore) key = " ";
          else if (hasReturnPrompt) key = "\r";
          else if (hasEndMarker) key = " ";
          else if (hasYnPrompt) key = "n";
          else if (hasAt && terrainCount >= 10) {
            // No prompts visible AND we have a player + visible dungeon.
            dungeonReached = true;
            dungeonFrame = next.value;
            break;
          }

          if (key === null) {
            trace(`splash[${attempt}]: no recognised prompt and no dungeon — bailing`);
            break;
          }
          if (runner.exited) break;
          await runner.sendText(key);
        }
        expect(dungeonReached).toBe(true);
        if (!dungeonReached) return;
        if (DUMP && dungeonFrame !== undefined) {
          dumpFrame("dungeon (entry)", dungeonFrame.snapshot.text.split("\n"));
        }
        trace(`dungeon reached at t=${(performance.now() - t0).toFixed(0)}ms; player @ ${JSON.stringify(map.currentPlayerXY)}`);

        // ---- build real ToolContext ----
        const ac = new AbortController();
        const sendKeysCallTimes: number[] = [];
        let maxPetCount = 0;
        const ctx: ToolContext = {
          map,
          runState: { gameOver: false, endReason: null },
          signal: ac.signal,
          journalDir: "",
          sendKeysAndWait: async (keys: string): Promise<FrameAwaitResult> => {
            const callIdx = sendKeysCallTimes.length;
            const tCall = performance.now();
            sendKeysCallTimes.push(tCall);
            trace(`sendKeysAndWait[${callIdx}] keys=${JSON.stringify(keys)} (t=${(tCall - t0).toFixed(0)}ms)`);
            await runner.sendText(keys);
            const next = await Promise.race([
              iter.next(),
              new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 5_000)),
            ]);
            if (next === "timeout") {
              throw new Error(`frame iterator hung on call ${callIdx} after key ${JSON.stringify(keys)}`);
            }
            if (next.done || next.value === undefined) {
              throw new Error(`iter.done unexpectedly on call ${callIdx}`);
            }
            const frame = next.value;
            trace(`sendKeysAndWait[${callIdx}] frame received reason=${frame.reason}`);
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
              for (const cls of row) if (cls === "pet") petCount += 1;
            }
            if (petCount > maxPetCount) maxPetCount = petCount;
            return {
              rows,
              glyphClass,
              status,
              message,
              frameReason: frame.reason,
              screenAnsi: frame.snapshot.toAnsi(),
            };
          },
        };

        // ---- run the autopilot ----
        trace("invoking handleAutopilotExplore({stepCap: 5})");
        const tAutopilotStart = performance.now();
        const result = await handleAutopilotExplore({ stepCap: 5 }, ctx);
        const tAutopilotEnd = performance.now();
        trace(`autopilot returned in ${(tAutopilotEnd - tAutopilotStart).toFixed(0)}ms`);
        if (DUMP) console.log("---- autopilot result (first 600 chars) ----\n" + result.slice(0, 600));

        // ---- assertions ----
        // The fix is correct iff the autopilot did NOT stop with
        // monster_visible primary because of pet movement. Other stop
        // reasons (modal_prompt from --More--, step_cap, etc.) are fine.
        expect(result).not.toContain("interrupt: monster_visible (");

        // Sanity: at least one sendKeysAndWait happened (no immediate bail).
        expect(sendKeysCallTimes.length).toBeGreaterThanOrEqual(1);

        // Sanity: the pet was on screen and classified as `pet` during at
        // least one autopilot frame. If hilite_pet ever silently stops
        // working, this is the canary — without it the no-monster_visible
        // assertion above could pass vacuously.
        expect(maxPetCount).toBeGreaterThan(0);
      } finally {
        try {
          await runner.terminate({ signal: "SIGTERM", thenAfterMs: 500 });
        } catch {
          // ignore
        }
      }
    },
    60_000,
  );
});
