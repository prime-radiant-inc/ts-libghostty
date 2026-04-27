// Consumable-item tool handlers: eat, quaff, read.
//
// All three follow the NetHack 3.6 pattern of <command-key>[<slot>]:
//   eat  → 'e'  (slot optional; without one, NetHack prompts)
//   quaff→ 'q'  (slot optional; standing on '{' may trigger fountain prompt)
//   read → 'r'  (slot REQUIRED — there's no menu fallback worth shipping)

import type { ToolContext } from "../tool-context";
import { errJson, isValidSlot, sendAndFormat } from "./_shared";

export async function handleEat(
  args: { slot?: string },
  ctx: ToolContext,
): Promise<string> {
  if (args.slot !== undefined && !isValidSlot(args.slot)) {
    return errJson(`eat: invalid slot ${JSON.stringify(args.slot)}`);
  }
  const keys = args.slot === undefined ? "e" : `e${args.slot}`;
  const head =
    args.slot === undefined ? "eat()" : `eat(slot=${args.slot})`;
  return sendAndFormat(ctx, keys, head);
}

export async function handleQuaff(
  args: { slot?: string },
  ctx: ToolContext,
): Promise<string> {
  if (args.slot !== undefined && !isValidSlot(args.slot)) {
    return errJson(`quaff: invalid slot ${JSON.stringify(args.slot)}`);
  }
  const keys = args.slot === undefined ? "q" : `q${args.slot}`;
  const head =
    args.slot === undefined ? "quaff()" : `quaff(slot=${args.slot})`;
  return sendAndFormat(ctx, keys, head);
}

export async function handleRead(
  args: { slot: string },
  ctx: ToolContext,
): Promise<string> {
  if (!isValidSlot(args.slot)) {
    return errJson(`read: 'slot' is required and must be a single letter; got ${JSON.stringify(args.slot)}`);
  }
  return sendAndFormat(ctx, `r${args.slot}`, `read(slot=${args.slot})`);
}
