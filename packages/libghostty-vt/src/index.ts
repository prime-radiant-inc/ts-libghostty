export { Terminal } from "./terminal";
export { Formatter } from "./formatter";
export { RenderState } from "./render-state";
export {
  GhosttyError,
  LibraryNotFoundError,
  UnsupportedPlatformError,
  LibraryCompatibilityError,
  UseAfterCloseError,
} from "./errors";
export type { GhosttyErrorCode } from "./errors";
export {
  setLibraryPath,
  isLoaded,
  libraryInfo,
} from "./ffi";
export type { LibraryInfo } from "./ffi";
export {
  modeNames,
} from "./internal/generated";
export type {
  RGB,
  PaletteIndex,
  CursorStyle,
  MouseTracking,
  ModeName,
  TerminalColors,
  TerminalOptions,
  TerminalSnapshot,
  FormatterOptions,
  UnderlineStyle,
  CellStyle,
  CellInfo,
  CellAtPoint,
  ViewportCursor,
  RenderRow,
  RenderCell,
} from "./types";
export { pinnedCommit } from "./internal/generated";
export { encodeFocus } from "./focus";

// Pass 4: keyboard input encoding
export {
  KeyEncoder,
  type KeyEvent,
  type Mods,
  type Key,
  type KeyEncoderOptions,
} from "./key-encoder";

export { EncodeError } from "./errors";
