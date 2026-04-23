export type GhosttyErrorCode =
  | "ok"
  | "out_of_memory"
  | "invalid_argument"
  | "uninitialized"
  | "library_not_found"
  | "library_incompatible"
  | "unsupported_platform"
  | "use_after_close"
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
