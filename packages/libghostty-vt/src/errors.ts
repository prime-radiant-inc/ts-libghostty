import { resultCodeByValue } from "./internal/generated";

/**
 * Map a raw GhosttyResult integer to its string name ("ok", "out_of_space",
 * etc.). Falls back to "unknown" for unrecognised values.
 */
export function getResultCodeName(rc: number): GhosttyErrorCode {
  const name = resultCodeByValue[rc] ?? "unknown";
  return name as GhosttyErrorCode;
}

export type GhosttyErrorCode =
  // FFI result codes (per ABI discovery §3 / src/internal/generated.ts RESULT_CODE_MAP)
  | "ok"
  | "out_of_memory"
  | "invalid_value"
  | "out_of_space"
  | "no_value"
  // Binding-only codes
  | "library_not_found"
  | "library_incompatible"
  | "unsupported_platform"
  | "use_after_close"
  | "encode_failed"
  | "invalid_utf8"
  | "rect_size_mismatch"
  | "unknown";

export interface GhosttyErrorOptions {
  code: GhosttyErrorCode;
  functionName?: string;
  cause?: unknown;
}

export class GhosttyError extends Error {
  readonly code: GhosttyErrorCode;
  readonly functionName?: string;

  constructor(message: string, opts: GhosttyErrorOptions) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = "GhosttyError";
    this.code = opts.code;
    if (opts.functionName !== undefined) this.functionName = opts.functionName;
  }
}

export class LibraryNotFoundError extends GhosttyError {
  readonly searchedPaths: string[];

  constructor(message: string, opts: { searchedPaths: string[]; cause?: unknown }) {
    super(message, { code: "library_not_found", cause: opts.cause });
    this.name = "LibraryNotFoundError";
    this.searchedPaths = [...opts.searchedPaths];
  }
}

export class UnsupportedPlatformError extends GhosttyError {
  readonly detectedPlatform: string;
  readonly supportedPlatforms: string[];

  constructor(
    message: string,
    opts: { detectedPlatform: string; supportedPlatforms: string[]; cause?: unknown },
  ) {
    super(message, { code: "unsupported_platform", cause: opts.cause });
    this.name = "UnsupportedPlatformError";
    this.detectedPlatform = opts.detectedPlatform;
    this.supportedPlatforms = [...opts.supportedPlatforms];
  }
}

export class LibraryCompatibilityError extends GhosttyError {
  readonly expectedCommit?: string;
  readonly actualCommit?: string;
  readonly details: string;

  constructor(
    message: string,
    opts: { expectedCommit?: string; actualCommit?: string; details: string; cause?: unknown },
  ) {
    super(message, { code: "library_incompatible", cause: opts.cause });
    this.name = "LibraryCompatibilityError";
    if (opts.expectedCommit !== undefined) this.expectedCommit = opts.expectedCommit;
    if (opts.actualCommit !== undefined) this.actualCommit = opts.actualCommit;
    this.details = opts.details;
  }
}

export class UseAfterCloseError extends GhosttyError {
  readonly handleType: string;

  constructor(message: string, opts: { handleType: string; cause?: unknown }) {
    super(message, { code: "use_after_close", cause: opts.cause });
    this.name = "UseAfterCloseError";
    this.handleType = opts.handleType;
  }
}

export class EncodeError extends GhosttyError {
  constructor(message: string, opts: GhosttyErrorOptions) {
    super(message, opts);
    this.name = "EncodeError";
  }
}

export class RectSizeMismatch extends GhosttyError {
  readonly source: { cols: number; rows: number };
  readonly dest: { cols: number; rows: number };

  constructor(
    source: { cols: number; rows: number },
    dest: { cols: number; rows: number },
  ) {
    super(
      `RectSizeMismatch: source is ${source.cols}×${source.rows}, ` +
        `dest is ${dest.cols}×${dest.rows}. ` +
        `Resize the source program (terminal.resize) or the destination box.`,
      { code: "rect_size_mismatch" },
    );
    this.name = "RectSizeMismatch";
    this.source = { cols: source.cols, rows: source.rows };
    this.dest = { cols: dest.cols, rows: dest.rows };
  }
}
