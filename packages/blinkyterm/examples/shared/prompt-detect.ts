import type { FrameSnapshot } from "../../src/types";

export type PromptKind = "more" | "yn" | "death" | "none";

/**
 * Heuristic prompt detection for NetHack's modal pop-ups. Hodag's startup
 * probe (Task 4) confirmed `--More--` lands as plain ASCII in the snapshot
 * text — no escape sequences wrapping it — so a substring search suffices.
 *
 * Order matters: death is checked first because the death prompts also
 * contain `--More--` markers and we want the example loop to break instead
 * of trying to dismiss them.
 */
export function detectPrompt(snapshot: FrameSnapshot): PromptKind {
  const text = snapshot.text;
  if (
    text.includes("Do you want your possessions identified?") ||
    text.includes("You die...") ||
    text.includes("Do you want your attributes")
  ) {
    return "death";
  }
  if (text.includes("(y/n)")) return "yn";
  if (text.includes("--More--")) return "more";
  return "none";
}
