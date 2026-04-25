export type BlinkyTermErrorCode =
  | "spawn_failed"
  | "first_frame_timeout"
  | "exited"
  | "disposed"
  | "iterator_in_use";

export class BlinkyTermError extends Error {
  readonly code: BlinkyTermErrorCode;

  constructor(message: string, code: BlinkyTermErrorCode, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
    this.code = code;
  }
}

export class SpawnError extends BlinkyTermError {
  constructor(
    message: string,
    code: "spawn_failed" | "first_frame_timeout" = "spawn_failed",
    options?: ErrorOptions,
  ) {
    super(message, code, options);
  }
}

export class FirstFrameTimeoutError extends SpawnError {
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`Runner did not receive an initial frame within ${timeoutMs}ms`, "first_frame_timeout");
    this.name = "FirstFrameTimeoutError";
    this.timeoutMs = timeoutMs;
  }

  declare readonly code: "first_frame_timeout";
}

export class ExitedError extends BlinkyTermError {
  constructor(methodName: string) {
    super(`Runner.${methodName} cannot be used after the child has exited`, "exited");
  }
}

export class DisposedError extends BlinkyTermError {
  constructor(handleType: string) {
    super(`${handleType} has been disposed`, "disposed");
  }
}

export class IteratorInUseError extends BlinkyTermError {
  constructor() {
    super("Runner.frames() already has an active iterator", "iterator_in_use");
  }
}
