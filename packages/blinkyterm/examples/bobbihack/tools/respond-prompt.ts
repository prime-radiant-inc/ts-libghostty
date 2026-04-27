// respond_prompt — answer a NetHack modal prompt by sending a literal
// short keystroke sequence to the pty.

import type { ToolContext } from "../tool-context";
import { formatToolResult } from "../tool-result";

const MAX_KEYS = 8;

export async function handleRespondPrompt(
  args: { keys: string },
  ctx: ToolContext,
): Promise<string> {
  if (typeof args.keys !== "string") {
    return JSON.stringify({ error: "respond_prompt: 'keys' must be a string" });
  }
  if (args.keys.length === 0) {
    return JSON.stringify({ error: "respond_prompt: 'keys' must be non-empty" });
  }
  if (args.keys.length > MAX_KEYS) {
    return JSON.stringify({
      error: `respond_prompt: 'keys' length ${args.keys.length} exceeds max ${MAX_KEYS}`,
    });
  }
  const result = await ctx.sendKeysAndWait(args.keys);
  const summary = `respond_prompt(${JSON.stringify(args.keys)})${
    result.message ? `: ${result.message}` : ""
  }`;
  return formatToolResult({
    summary,
    screenAnsi: result.screenAnsi,
    map: ctx.map,
    status: result.status,
  });
}
