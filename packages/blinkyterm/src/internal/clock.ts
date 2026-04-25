import type { Clock } from "../types";

export const realClock: Clock = {
  now: () => Date.now(),
  setTimeout(cb, ms) {
    const timer = setTimeout(cb, ms);
    return { clear: () => clearTimeout(timer) };
  },
};

interface FakeTimer {
  id: number;
  due: number;
  cb: () => void;
  cleared: boolean;
}

export function createFakeClock(start = 0): Clock & { advance(ms: number): void } {
  let now = start;
  let nextId = 1;
  const timers: FakeTimer[] = [];
  return {
    now: () => now,
    setTimeout(cb, ms) {
      const timer: FakeTimer = { id: nextId++, due: now + ms, cb, cleared: false };
      timers.push(timer);
      return { clear: () => { timer.cleared = true; } };
    },
    advance(ms) {
      const target = now + ms;
      while (true) {
        timers.sort((a, b) => a.due - b.due || a.id - b.id);
        const timer = timers.find((t) => !t.cleared && t.due <= target);
        if (!timer) break;
        timer.cleared = true;
        now = timer.due;
        timer.cb();
      }
      now = target;
    },
  };
}
