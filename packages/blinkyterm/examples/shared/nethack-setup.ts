import { spawnSync } from "node:child_process";
import { readdirSync, unlinkSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Returns true if the `nethack` binary is on `PATH`. Examples skip cleanly
 * when this is false rather than blow up — NetHack is not part of CI.
 */
export function hasNethack(): boolean {
  const result = spawnSync("bash", ["-lc", "command -v nethack"], {
    stdio: "ignore",
  });
  return result.status === 0;
}

/**
 * Files this regex matches are NetHack's per-game lock indicators.
 * Deleting them between SIGTERMed test runs frees NetHack to start a
 * new game (otherwise NetHack rejects new games with "Too many hacks
 * running now.").
 *
 * IMPORTANT: this regex used to be `/lock/i`, which matched `block.N`
 * as a substring. `block.N` is NetHack's per-level data file (where
 * inactive levels page to disk), NOT a lock — deleting it orphans an
 * in-progress game and triggers a "tricked death" on the next level
 * transition. Live run bbh-20260511-202947-7d8afd hit this: the agent
 * descended at turn 190, NetHack tried to read `block.0` for the
 * starting level, got ENOENT ("Probably someone removed it."), and
 * dropped into the end-of-game sequence. Most likely root cause: a
 * concurrent test run called `cleanupNetHackLocks()` and nuked the
 * live game's level data.
 *
 * Allowed patterns:
 *   - `alock.<N>`  active-lock indicator for level N
 *   - `lock.<N>`   legacy lock name
 *   - `xlock`      game-process lock (single file)
 *   - `nhlock.<N>` legacy
 * Disallowed (NOT lock files):
 *   - `block.<N>`  level data
 *   - `logfile`, `paniclog`, `record`, `xlogfile`  game logs
 *   - `save/`      save-game directory
 *   - `perm`       shared permissions
 */
const LOCK_FILE_RE = /^(alock|nhlock|lock)\.\d+$|^xlock$/;

/**
 * Remove stale NetHack lock files left behind by SIGTERMed test runs.
 *
 * Returns the number of files removed. Silent failure if the data dir
 * isn't found — every install puts it somewhere different.
 *
 * **Side effect note:** this clears EVERY lock file in the data dir,
 * not just the ones from `name:agent`. If a game is in progress
 * against the same install, calling this can prevent the game from
 * making forward progress (NetHack will refuse to acquire a new lock
 * for descent). It will NOT corrupt level data (see LOCK_FILE_RE
 * above), but it WILL block a live game from advancing. Tests should
 * call this between runs; production code should not.
 */
export function cleanupNetHackLocks(): number {
  const candidates = [
    "/opt/homebrew/share/nethack",
    "/usr/local/share/nethack",
    "/usr/share/nethack",
    "/opt/homebrew/share/nethackdir",
  ];
  let removed = 0;
  for (const dir of candidates) {
    try {
      statSync(dir);
    } catch {
      continue;
    }
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (!LOCK_FILE_RE.test(name)) continue;
      try {
        unlinkSync(join(dir, name));
        removed += 1;
      } catch {
        // permission denied or already gone — skip
      }
    }
  }
  return removed;
}

/**
 * Exported for unit testing — the regex that decides whether a file
 * in the NetHack data dir is a lock (safe to delete between test
 * runs) or NOT (game state we'd corrupt).
 */
export const _LOCK_FILE_RE_FOR_TEST = LOCK_FILE_RE;

/**
 * Environment variables that bypass NetHack's character-creation prompts so
 * the bot lands in the dungeon immediately instead of stalling on role/race
 * selection. Matches the shape used by `probe-nethack-startup.ts`.
 *
 * Load-bearing flag: `hilite_pet`. With this enabled NetHack renders pet
 * glyphs (kitten, small dog, etc.) with SGR 7 (inverse video), which the
 * bobbihack autopilot interrupt detector reads via `style.inverse` to
 * distinguish pets from hostile monsters. Removing `hilite_pet` silently
 * breaks pet classification — every pet step would trip the
 * `monster_visible` interrupt and abort autopilot loops. See
 * docs/superpowers/specs/2026-05-07-bobbihack-attribute-aware-interrupts-design.md.
 *
 * `!tutorial` skips NetHack 5.0.0's "Do you want a tutorial?" yn prompt
 * that follows the welcome message. Without it the agent burns an LLM
 * turn answering it (and any test harness that only sends space gets
 * stuck on it). The leading `!` is NetHack's negate-boolean syntax.
 *
 * Do NOT add `hilite_peaceful` — NetHack 5.0.0 rejects it as an unknown
 * option and prints a startup error modal that every game would have to
 * dismiss (probe confirmed). Peacefuls are a known limitation; the
 * autopilot will trip `monster_visible` on them as it did before.
 */
export function nethackEnv(): Record<string, string> {
  return {
    NETHACKOPTIONS:
      "name:agent,role:valkyrie,race:human,gender:female,align:lawful," +
      // `time` shows the in-game turn counter (`T:N`) in the status
      // line. NetHack 5.0.0 defaults it off; without it
      // `parseStatusLine` can't find `T:N` and the bobbihack
      // tool_result header always says "Turn: 0", which agents waste
      // turns trying to debug (run bbh-20260508-205038-9e2e2a
      // msg[284]: "the turn count is STILL 0! Is the game somehow
      // paused?").
      "hilite_pet,!tutorial,time",
  };
}
