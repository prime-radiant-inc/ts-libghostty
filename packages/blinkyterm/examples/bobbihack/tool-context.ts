// Shared types for tool handlers. Each handler takes a ToolContext that
// carries the GameMap, abort signal, run state, and a sendKeysAndWait
// helper that performs the keystroke + frame-await dance.

import type { GameMap } from "./game-map";
import type { StatusLine } from "./parsers";
import type { GlyphClass } from "./glyph-class";

export interface RunState {
  gameOver: boolean;
  endReason: string | null;
}

export interface FrameAwaitResult {
  rows: string[];
  // Parallel grid to `rows`: `glyphClass[y][x]` classifies the letter or
  // `@` glyph at (x, y), or `undefined` if `rows[y][x]` is not a tracked
  // glyph (terrain, items, cursor) or is the player's own `@`. Used by
  // the autopilot interrupt detector to ignore pet movement. See
  // ./glyph-class.ts for the classifier.
  glyphClass: ReadonlyArray<ReadonlyArray<GlyphClass | undefined>>;
  status: StatusLine;
  message: string;
  frameReason: string;
  screenAnsi: string;
}

export interface ToolContext {
  map: GameMap;
  runState: RunState;
  signal: AbortSignal;
  // Per-run journal directory: <runDir>/journal/. Used by the
  // journal_read / journal_write handlers (Phase 4) to load/store the
  // six fixed markdown sections (Character, Inventory, Knowledge,
  // Dungeon, Goals, Hypotheses).
  journalDir: string;
  // Sends literal keystrokes to nethack and awaits the next quiesced frame.
  // Updates the GameMap as a side effect. The returned status/message/rows
  // are post-keystroke.
  sendKeysAndWait: (keys: string) => Promise<FrameAwaitResult>;
  // Optional progress reporter. Tools that take many seconds (e.g.
  // autopilot_explore with a large stepCap) call this after each
  // internal step; the conductor relays it to the UI as a status-detail
  // update so the user sees "tool: autopilot_explore (47/150)" instead
  // of staring at a frozen "tool: autopilot_explore" for 30 seconds.
  // Tests can omit it; tools should treat it as best-effort.
  reportProgress?: (detail: string) => void;
}
