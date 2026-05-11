// Predict-and-avoid: ahead-of-step check for tile-induced modal prompts.
//
// The v2 autopilot's per-step loop calls `willStepFireModal` BEFORE
// sending a movement key. Given the classified target cell and the
// hardcoded paranoid-confirmation defaults, the function returns
// either:
//
//   - `null` — no predicted modal; the AP sends the bare direction key.
//   - a `ModalPrediction` whose `resolveWith` tells the AP how to
//     proceed:
//       'm-prefix' — send `m` + direction (suppresses pickup, and per
//                    NetHack 5.0 the m-prefix also suppresses certain
//                    paranoid:* prompts).
//       'step'     — send the bare direction; the engine silently
//                    handles the case (e.g. pet displacement).
//       'refuse'   — do NOT step; mark the tile as blocked, replan.
//
// The v1 AP halted on these prompts AFTER stepping into them. v2 moves
// the decision upstream so predictable modals never reach the LLM.
//
// See spec
// `docs/superpowers/specs/2026-05-09-nethack-aware-autopilot.md`,
// §"Layer 3: predict-and-avoid for tile-induced modals".

import type { ClassifiedCell } from "./cell-classifier";

// Hardcoded paranoid-confirmation defaults shipped by bobbihack via
// `nethack-setup.ts`. NetHack 5.0 ships paranoid:trap and paranoid:swim
// on by default; paranoid:attack is off. v2 keeps these as the only
// inputs to `willStepFireModal`; a future extension could parse a
// user-supplied .nethackrc.
export interface ParanoidConfig {
  paranoidTrap: boolean;
  paranoidSwim: boolean;
  paranoidAttack: boolean;
}

export const DEFAULT_PARANOID_CONFIG: ParanoidConfig = {
  paranoidTrap: true,
  paranoidSwim: true,
  paranoidAttack: false,
};

// Predicted modal classes. Names match the engine prompts loosely;
// they're for tracing/debugging — only `resolveWith` drives behavior.
export type ModalKind =
  | "paranoid-trap"
  | "paranoid-swim"
  | "pet-displace"
  // Diagonal step INTO a pet tile. NetHack 5.0 refuses pet
  // displacement in directions the pet itself can't move into (e.g.
  // through a wall-corner squeeze); the engine emits "You stop.
  // Your <pet> is in the way!" and the step is consumed without
  // movement. Cardinal swaps work; only diagonal needs predict-
  // refuse. Live-confirmed in run bbh-20260509-025250-b0fc34.
  | "pet-displace-blocked"
  | "attack-or-peaceful"
  | "pickup-prompt"
  // Closed door while player has Conf or Stun. NetHack disables
  // door autoopen under these statuses, so the bump just bumps and
  // the door stays shut. Refuse before stepping.
  | "autoopen-disabled";

export type ResolveWith = "m-prefix" | "step" | "refuse";

export interface ModalPrediction {
  kind: ModalKind;
  resolveWith: ResolveWith;
}

// Optional per-call context for predicate checks that depend on more
// than the destination cell itself.
export interface PredictContext {
  /**
   * Step direction (target tile minus player tile). Used to detect
   * diagonal-pet-swap, which NetHack refuses with a non-modal "is in
   * the way" message — invisible to the modal-prompt interrupt but
   * still a no-movement step.
   */
  delta?: { dx: number; dy: number };
  /**
   * Player's current status conditions (`Conf`, `Stun`, `Hallu`,
   * etc.) extracted from the StatusLine. Used to detect autoopen-
   * disabled and similar status-conditioned tile rules. Empty / not-
   * provided falls back to v1 behavior (no status-conditioned
   * predictions).
   */
  conditions?: readonly string[];
}

// Predict whether stepping ONTO `cell` will fire a tile-induced modal.
//
// The function is pure. Order of checks mirrors the spec's Layer-3
// listing. When two predicates would match (e.g. a hostile monster
// standing on a known trap), the FIRST match wins — the destination's
// foreground takes precedence over its terrain because the foreground
// is what the engine will react to first (the attack-or-peaceful prompt
// fires before the trap-step prompt).
//
// `cell` is the destination — the cell the player is about to step
// INTO. Adjacent-tile danger (e.g. a danger-class monster next to the
// path) is the planner's concern, not this predictor's.
export function willStepFireModal(
  cell: ClassifiedCell | null | undefined,
  options: ParanoidConfig = DEFAULT_PARANOID_CONFIG,
  context: PredictContext = {},
): ModalPrediction | null {
  if (cell === null || cell === undefined) return null;
  const fg = cell.foreground;

  // Foreground checks first — the engine reacts to whatever's standing
  // on the cell before it cares about the terrain underneath.
  if (fg !== null) {
    if (fg.kind === "monster" && fg.pet) {
      // Pet displacement: cardinal swaps are silent and safe; diagonal
      // swaps can fail with "Your <pet> is in the way!" when the
      // engine refuses to displace through a corner the pet itself
      // can't traverse. We can't tell from the destination cell alone
      // whether the diagonal will succeed, so the conservative move is
      // to refuse diagonal-pet-swap entirely and rely on the planner
      // to detour (the long way around a pet is one extra step).
      const delta = context.delta;
      const isDiag =
        delta !== undefined && delta.dx !== 0 && delta.dy !== 0;
      if (isDiag) {
        return { kind: "pet-displace-blocked", resolveWith: "refuse" };
      }
      return { kind: "pet-displace", resolveWith: "step" };
    }
    if (fg.kind === "monster" && !fg.pet) {
      // Hostile or peaceful (we can't tell apart in NetHack 5.0 without
      // hilite_peaceful). Conservative: refuse. The bump-attack
      // contract makes this safety-critical — a `y` answer to a
      // "Really attack?" peaceful prompt is destructive.
      return { kind: "attack-or-peaceful", resolveWith: "refuse" };
    }
    if (fg.kind === "unseen-monster") {
      // The `I` marker — we know SOMETHING is there but not what.
      // Refuse on the same conservative grounds as a non-pet monster.
      return { kind: "attack-or-peaceful", resolveWith: "refuse" };
    }
    if (fg.kind === "warning") {
      // Warning digits represent detected creatures we can't see. The
      // tier matters for the interrupt detector; for stepping-on
      // purposes, any warning is a refusal.
      return { kind: "attack-or-peaceful", resolveWith: "refuse" };
    }
    if (fg.kind === "item") {
      // The pickup prompt fires when stepping onto an item pile (with
      // the autopickup default off; bobbihack runs without autopickup).
      // The m-prefix bypass moves WITHOUT picking up — exactly what we
      // want for traversal.
      return { kind: "pickup-prompt", resolveWith: "m-prefix" };
    }
    // 'player' foreground: the destination IS the player. Should never
    // be a pathfind step target; defensive null return.
    if (fg.kind === "player") return null;
  }

  // Terrain-only checks. Known trap and water/lava both fire paranoid:*
  // prompts when paranoid:trap / paranoid:swim are on. Both prompts halt
  // the AP under v1; v2 refuses to step instead.
  //
  // Note: water/lava are also `walkable: 'no'` per game-map's
  // NON_WALKABLE_KINDS, so the pathfinder already excludes them. This
  // arm is defense-in-depth in case a future change makes water
  // walkable (e.g. levitation).
  if (cell.terrain === "trap_known" && options.paranoidTrap) {
    return { kind: "paranoid-trap", resolveWith: "refuse" };
  }
  if (
    (cell.terrain === "water" || cell.terrain === "lava") &&
    options.paranoidSwim
  ) {
    return { kind: "paranoid-swim", resolveWith: "refuse" };
  }

  // Closed door + Conf/Stun: NetHack disables autoopen under these
  // statuses, so a step into a `+` consumes a turn without opening
  // anything. Without this predicate, AP bumps the door until the
  // status wears off — wasted real turns and a confused-looking
  // trace. (In practice today the `confused` interrupt halts AP on
  // the first frame Conf appears, so this predicate is defense-in-
  // depth: if Conf was already set when AP was invoked and somehow
  // didn't trigger the interrupt, predict-and-avoid still catches
  // the bump.)
  if (cell.terrain === "door_closed") {
    const conds = context.conditions ?? [];
    if (conds.includes("Conf") || conds.includes("Stun")) {
      return { kind: "autoopen-disabled", resolveWith: "refuse" };
    }
  }

  return null;
}
