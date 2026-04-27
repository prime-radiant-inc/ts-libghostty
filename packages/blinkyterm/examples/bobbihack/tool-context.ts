// Shared types for tool handlers. Each handler takes a ToolContext that
// carries the GameMap, abort signal, run state, and a sendKeysAndWait
// helper that performs the keystroke + frame-await dance.

import type { GameMap } from "./game-map";
import type { StatusLine } from "./parsers";

export interface RunState {
  gameOver: boolean;
  endReason: string | null;
}

export interface FrameAwaitResult {
  rows: string[];
  status: StatusLine;
  message: string;
  frameReason: string;
  screenAnsi: string;
}

export interface ToolContext {
  map: GameMap;
  runState: RunState;
  signal: AbortSignal;
  // Sends literal keystrokes to nethack and awaits the next quiesced frame.
  // Updates the GameMap as a side effect. The returned status/message/rows
  // are post-keystroke.
  sendKeysAndWait: (keys: string) => Promise<FrameAwaitResult>;
}
