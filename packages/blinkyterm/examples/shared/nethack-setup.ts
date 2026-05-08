import { spawnSync } from "node:child_process";

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
 * Do NOT add `hilite_peaceful` — NetHack 5.0.0 rejects it as an unknown
 * option and prints a startup error modal that every game would have to
 * dismiss (probe confirmed). Peacefuls are a known limitation; the
 * autopilot will trip `monster_visible` on them as it did before.
 */
export function nethackEnv(): Record<string, string> {
  return {
    NETHACKOPTIONS:
      "name:agent,role:valkyrie,race:human,gender:female,align:lawful," +
      "hilite_pet",
  };
}
