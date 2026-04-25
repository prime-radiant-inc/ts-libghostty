export type UserKey = "quit";

/** Pure: maps a single stdin byte to a high-level user key, or null. */
export function parseStdinByte(byte: number): UserKey | null {
  // q, Q, Ctrl-C (0x03), Ctrl-D (0x04)
  if (byte === 0x71 || byte === 0x51) return "quit";
  if (byte === 0x03 || byte === 0x04) return "quit";
  return null;
}

export interface KeyStream {
  keys(): AsyncIterable<UserKey>;
  close(): void;
}

/**
 * Open stdin in raw mode and emit user keys until close() is called.
 * Restores the original mode on close.
 */
export function openKeyStream(): KeyStream {
  const stdin = process.stdin;
  const wasRaw = stdin.isRaw === true;
  stdin.setRawMode?.(true);
  stdin.resume();

  let closed = false;
  const queue: UserKey[] = [];
  const waiters: Array<(value: IteratorResult<UserKey>) => void> = [];

  const onData = (chunk: Buffer) => {
    for (const byte of chunk) {
      const key = parseStdinByte(byte);
      if (key === null) continue;
      const waiter = waiters.shift();
      if (waiter) waiter({ value: key, done: false });
      else queue.push(key);
    }
  };

  stdin.on("data", onData);

  const close = (): void => {
    if (closed) return;
    closed = true;
    stdin.off("data", onData);
    stdin.setRawMode?.(wasRaw);
    stdin.pause();
    while (waiters.length > 0) {
      waiters.shift()!({ value: undefined as never, done: true });
    }
  };

  const keys = (): AsyncIterable<UserKey> => ({
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<UserKey>> {
          if (queue.length > 0) {
            return Promise.resolve({ value: queue.shift()!, done: false });
          }
          if (closed) return Promise.resolve({ value: undefined as never, done: true });
          return new Promise((resolve) => waiters.push(resolve));
        },
        return(): Promise<IteratorResult<UserKey>> {
          close();
          return Promise.resolve({ value: undefined as never, done: true });
        },
      };
    },
  });

  return { keys, close };
}
