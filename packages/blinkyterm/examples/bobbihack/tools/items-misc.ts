// Miscellaneous action tool handlers:
//   zap, drop, throw, apply, kick, pray, force_fight,
//   extended_command, command.
//
// NetHack 3.6 keys (per the bobbihack spec):
//   zap        → 'z<slot>[<dir>]'
//   drop       → 'd<slot>'
//   throw      → 't<slot><dir>'
//   apply      → 'a<slot>'
//   kick       → '\x04' + <dir>      (spec says use \x04 directly)
//   pray       → '#pray\r'
//   force_fight→ 'F<dir>'
//   extended  → '#<name>\r' + optional literal args
//   command    → literal keystrokes ≤ 16 chars (last-resort hatch)

import type { ToolContext } from "../tool-context";
import {
  compassDirectionToKey,
  errJson,
  isValidCompassDirection,
  isValidSlot,
  sendAndFormat,
  type CompassDirection,
} from "./_shared";

export async function handleZap(
  args: { slot: string; direction?: CompassDirection },
  ctx: ToolContext,
): Promise<string> {
  if (!isValidSlot(args.slot)) {
    return errJson(`zap: 'slot' is required and must be a single letter; got ${JSON.stringify(args.slot)}`);
  }
  if (args.direction !== undefined && !isValidCompassDirection(args.direction)) {
    return errJson(`zap: invalid direction ${JSON.stringify(args.direction)}`);
  }
  const dirKey =
    args.direction === undefined
      ? ""
      : compassDirectionToKey(args.direction);
  const keys = `z${args.slot}${dirKey}`;
  const head =
    args.direction === undefined
      ? `zap(slot=${args.slot})`
      : `zap(slot=${args.slot}, direction=${args.direction})`;
  return sendAndFormat(ctx, keys, head);
}

export async function handleDrop(
  args: { slot: string },
  ctx: ToolContext,
): Promise<string> {
  if (!isValidSlot(args.slot)) {
    return errJson(`drop: 'slot' is required and must be a single letter; got ${JSON.stringify(args.slot)}`);
  }
  return sendAndFormat(ctx, `d${args.slot}`, `drop(slot=${args.slot})`);
}

export async function handleThrow(
  args: { slot: string; direction: CompassDirection },
  ctx: ToolContext,
): Promise<string> {
  if (!isValidSlot(args.slot)) {
    return errJson(`throw: 'slot' is required and must be a single letter; got ${JSON.stringify(args.slot)}`);
  }
  if (!isValidCompassDirection(args.direction)) {
    return errJson(`throw: 'direction' is required (compass-only); got ${JSON.stringify(args.direction)}`);
  }
  const keys = `t${args.slot}${compassDirectionToKey(args.direction)}`;
  return sendAndFormat(
    ctx,
    keys,
    `throw(slot=${args.slot}, direction=${args.direction})`,
  );
}

export async function handleApply(
  args: { slot: string },
  ctx: ToolContext,
): Promise<string> {
  if (!isValidSlot(args.slot)) {
    return errJson(`apply: 'slot' is required and must be a single letter; got ${JSON.stringify(args.slot)}`);
  }
  return sendAndFormat(ctx, `a${args.slot}`, `apply(slot=${args.slot})`);
}

export async function handleKick(
  args: { direction: CompassDirection },
  ctx: ToolContext,
): Promise<string> {
  if (!isValidCompassDirection(args.direction)) {
    return errJson(`kick: 'direction' is required (compass-only); got ${JSON.stringify(args.direction)}`);
  }
  // Spec: send literal \x04 followed by the direction key. (NetHack 3.6's
  // real binding for kick is Ctrl-D, which IS \x04 — same byte either way.)
  const keys = `\x04${compassDirectionToKey(args.direction)}`;
  return sendAndFormat(ctx, keys, `kick(direction=${args.direction})`);
}

export async function handlePray(
  _args: object,
  ctx: ToolContext,
): Promise<string> {
  return sendAndFormat(ctx, "#pray\r", "pray()");
}

export async function handleForceFight(
  args: { direction: CompassDirection },
  ctx: ToolContext,
): Promise<string> {
  if (!isValidCompassDirection(args.direction)) {
    return errJson(`force_fight: 'direction' is required (compass-only); got ${JSON.stringify(args.direction)}`);
  }
  const keys = `F${compassDirectionToKey(args.direction)}`;
  return sendAndFormat(
    ctx,
    keys,
    `force_fight(direction=${args.direction})`,
  );
}

// Extended command name validator: alphanumeric + a few common metas
// (NetHack's own set is limited — chat, dip, force, kick, loot, monster,
// name, offer, pray, ride, sit, terrain, turn, untrap, version, wipe...).
// We accept the lowercase letter form to keep the surface tight.
const EXT_NAME_RE = /^[a-z]{1,16}$/;

export async function handleExtendedCommand(
  args: { name: string; args?: string },
  ctx: ToolContext,
): Promise<string> {
  if (typeof args.name !== "string" || !EXT_NAME_RE.test(args.name)) {
    return errJson(`extended_command: 'name' must be 1-16 lowercase letters; got ${JSON.stringify(args.name)}`);
  }
  if (args.args !== undefined && typeof args.args !== "string") {
    return errJson("extended_command: 'args' must be a string when present");
  }
  // Cap extra args so a runaway model can't blast hundreds of bytes.
  const extra = args.args ?? "";
  if (extra.length > 32) {
    return errJson(`extended_command: 'args' length ${extra.length} exceeds max 32`);
  }
  const keys = `#${args.name}\r${extra}`;
  const head =
    extra.length === 0
      ? `extended_command(${args.name})`
      : `extended_command(${args.name}, args=${JSON.stringify(extra)})`;
  return sendAndFormat(ctx, keys, head);
}

// Last-resort raw keystroke escape hatch. Capped at 16 chars to keep
// blast-radius bounded.
const COMMAND_MAX_KEYS = 16;

export async function handleCommand(
  args: { keys: string },
  ctx: ToolContext,
): Promise<string> {
  if (typeof args.keys !== "string") {
    return errJson("command: 'keys' must be a string");
  }
  if (args.keys.length === 0) {
    return errJson("command: 'keys' must be non-empty");
  }
  if (args.keys.length > COMMAND_MAX_KEYS) {
    return errJson(`command: 'keys' length ${args.keys.length} exceeds max ${COMMAND_MAX_KEYS}`);
  }
  return sendAndFormat(ctx, args.keys, `command(${JSON.stringify(args.keys)})`);
}
