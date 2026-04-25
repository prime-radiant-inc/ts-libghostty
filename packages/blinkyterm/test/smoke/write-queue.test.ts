import { expect, test } from "bun:test";
import { WriteQueue } from "../../src/internal/write-queue";

test("WriteQueue serializes writes and handles partial writes", async () => {
  const written: string[] = [];
  const pty = {
    write(bytes: Uint8Array) {
      const take = Math.min(1, bytes.length);
      written.push(new TextDecoder().decode(bytes.subarray(0, take)));
      return take;
    },
  };
  const q = new WriteQueue(pty);
  await Promise.all([
    q.write(new TextEncoder().encode("ab")),
    q.write(new TextEncoder().encode("cd")),
  ]);
  expect(written.join("")).toBe("abcd");
});

test("WriteQueue waits for drain on zero progress", async () => {
  let blocked = true;
  const pty = {
    write(bytes: Uint8Array) {
      if (blocked) return 0;
      return bytes.length;
    },
  };
  const q = new WriteQueue(pty);
  const p = q.write(new TextEncoder().encode("x"));
  await Bun.sleep(0);
  blocked = false;
  q.notifyDrain();
  await p;
  expect(true).toBe(true);
});
