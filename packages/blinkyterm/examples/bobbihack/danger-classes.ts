// Danger-class lookup tables for the v2 autopilot's route-cost model.
//
// Phase 1 ships the data; Phase 2 (`game-map.ts:pathfind`) wires it into
// the cost function. See spec
// `docs/superpowers/specs/2026-05-09-nethack-aware-autopilot.md`,
// §"Layer 2: route-cost model".
//
// The "danger class" set encodes the small handful of monster classes
// the v2 spec hard-grades as adjacency hazards regardless of color or
// pet status: dragons, liches, vampires, wraiths, demons. Per the
// `dragons-and-demons-are-class-level-danger-flags` zettel, the class
// letter alone is enough signal to detour around — even at the cost of
// a 5+ tile longer path.
//
// v3 may add classes after live-run traces show repeated unsafe steps
// against (say) elementals or specific snakes. v2 keeps the set small
// because the existing `monster_visible` interrupt is the safety net
// for everything outside.

import type { ClassifiedCell, MonsterClass } from "./cell-classifier";

// Hard-graded danger classes. v0 set; expandable.
export const DANGER_CLASS_FLAGS: ReadonlySet<MonsterClass> = new Set([
  "dragon",
  "lich",
  "vampire",
  "wraith",
  "demon",
]);

// Convenience: the corresponding glyph letters. Useful when the caller
// has the row text but not yet a `ClassifiedCell` (e.g. interrupt
// detectors). Derived once at module load.
export const DANGER_CLASS_LETTERS: ReadonlySet<string> = new Set([
  "D", // dragon
  "L", // lich
  "V", // vampire
  "W", // wraith
  "&", // demon
]);

// Cost multiplier for stepping ONTO this cell. v2 pathfind multiplies
// the base step cost (1 for cardinal, √2 for diagonal) by this weight.
//
// Schedule (per spec §"Layer 2"):
//   - empty / terrain only ............................ 1.0
//   - foreground = pet (displace, free) ............... 1.0
//   - foreground = monster, danger-class hostile ...... 20.0
//   - foreground = monster, generic hostile ........... 5.0
//   - foreground = unseen-monster (`I`) ............... 10.0
//   - foreground = warning, tier T .................... T * 4
//   - foreground = item ............................... 1.0  (m-prefix
//     bypasses pickup; v2 doesn't penalize traversal)
//   - foreground = player ............................. 1.0  (the
//     player's own cell never appears as a step target, but be
//     defensive)
//
// Returns 1.0 (no penalty) for null/undefined cells so callers can
// look up neighbors that fall outside the classified grid without a
// guard.
//
// `cell` is the *destination* cell — the one being stepped INTO.
// Adjacent-cell danger (e.g. an `&` next to the path) is handled by
// the route planner separately.
export function dangerWeight(
  cell: ClassifiedCell | null | undefined,
): number {
  if (cell === null || cell === undefined) return 1.0;
  const fg = cell.foreground;
  if (fg === null) return 1.0;
  switch (fg.kind) {
    case "player":
      return 1.0;
    case "item":
      return 1.0;
    case "unseen-monster":
      return 10.0;
    case "warning":
      return fg.tier * 4;
    case "monster":
      if (fg.pet) return 1.0;
      if (DANGER_CLASS_FLAGS.has(fg.class)) return 20.0;
      return 5.0;
  }
}
