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
 */
export function nethackEnv(): Record<string, string> {
  return {
    NETHACKOPTIONS:
      "name:agent,role:valkyrie,race:human,gender:female,align:lawful",
  };
}
