import { DisposedError } from "../errors";
import { makeDeferred, type Deferred } from "./deferred";

interface WritablePty {
  write(bytes: Uint8Array): number | void;
}

export class WriteQueue {
  readonly #pty: WritablePty;
  #tail: Promise<void> = Promise.resolve();
  #drain: Deferred<void> | null = null;
  #disposed = false;

  constructor(pty: WritablePty) {
    this.#pty = pty;
  }

  write(bytes: Uint8Array): Promise<void> {
    if (this.#disposed) return Promise.reject(new DisposedError("WriteQueue"));
    const copy = new Uint8Array(bytes);
    const run = this.#tail.then(() => this.#writeAll(copy));
    this.#tail = run.catch(() => {});
    return run;
  }

  notifyDrain(): void {
    this.#drain?.resolve();
    this.#drain = null;
  }

  dispose(): void {
    this.#disposed = true;
    this.#drain?.reject(new DisposedError("WriteQueue"));
    this.#drain = null;
  }

  async #writeAll(bytes: Uint8Array): Promise<void> {
    let offset = 0;
    while (offset < bytes.length) {
      if (this.#disposed) throw new DisposedError("WriteQueue");
      const chunk = bytes.subarray(offset);
      const ret = this.#pty.write(chunk);
      const n = typeof ret === "number" ? ret : chunk.length;
      if (n <= 0) {
        await this.#awaitDrain();
      } else {
        offset += n;
      }
    }
  }

  #awaitDrain(): Promise<void> {
    if (this.#drain === null) this.#drain = makeDeferred<void>();
    return this.#drain.promise;
  }
}
