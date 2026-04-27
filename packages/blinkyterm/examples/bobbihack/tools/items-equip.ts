// Equipment tool handlers: wear, puton, takeoff, remove, wield.
//
// NetHack 3.6 keys:
//   wear    → 'W'  (armor; slot required)
//   puton   → 'P'  (rings/amulets/blindfolds; slot required)
//   takeoff → 'T'  (armor; slot optional — NetHack auto-picks if you have one piece)
//   remove  → 'R'  (accessories; slot optional — same reason)
//   wield   → 'w'  (weapon; slot required; '-' means bare hands)

import type { ToolContext } from "../tool-context";
import { errJson, isValidSlot, sendAndFormat } from "./_shared";

export async function handleWear(
  args: { slot: string },
  ctx: ToolContext,
): Promise<string> {
  if (!isValidSlot(args.slot)) {
    return errJson(`wear: 'slot' is required and must be a single letter; got ${JSON.stringify(args.slot)}`);
  }
  return sendAndFormat(ctx, `W${args.slot}`, `wear(slot=${args.slot})`);
}

export async function handlePuton(
  args: { slot: string },
  ctx: ToolContext,
): Promise<string> {
  if (!isValidSlot(args.slot)) {
    return errJson(`puton: 'slot' is required and must be a single letter; got ${JSON.stringify(args.slot)}`);
  }
  return sendAndFormat(ctx, `P${args.slot}`, `puton(slot=${args.slot})`);
}

export async function handleTakeoff(
  args: { slot?: string },
  ctx: ToolContext,
): Promise<string> {
  if (args.slot !== undefined && !isValidSlot(args.slot)) {
    return errJson(`takeoff: invalid slot ${JSON.stringify(args.slot)}`);
  }
  const keys = args.slot === undefined ? "T" : `T${args.slot}`;
  const head =
    args.slot === undefined ? "takeoff()" : `takeoff(slot=${args.slot})`;
  return sendAndFormat(ctx, keys, head);
}

export async function handleRemove(
  args: { slot?: string },
  ctx: ToolContext,
): Promise<string> {
  if (args.slot !== undefined && !isValidSlot(args.slot)) {
    return errJson(`remove: invalid slot ${JSON.stringify(args.slot)}`);
  }
  const keys = args.slot === undefined ? "R" : `R${args.slot}`;
  const head =
    args.slot === undefined ? "remove()" : `remove(slot=${args.slot})`;
  return sendAndFormat(ctx, keys, head);
}

export async function handleWield(
  args: { slot: string },
  ctx: ToolContext,
): Promise<string> {
  // '-' is a legitimate slot here (means: wield bare hands). isValidSlot
  // accepts it.
  if (!isValidSlot(args.slot)) {
    return errJson(`wield: 'slot' is required and must be a single letter (or '-' for bare hands); got ${JSON.stringify(args.slot)}`);
  }
  return sendAndFormat(ctx, `w${args.slot}`, `wield(slot=${args.slot})`);
}
