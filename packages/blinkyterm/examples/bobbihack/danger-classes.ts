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

import type { MonsterClass } from "./cell-classifier";

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
