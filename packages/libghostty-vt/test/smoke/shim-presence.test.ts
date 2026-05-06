import { describe, it, expect } from "bun:test";
import { libraryInfo } from "../../src";
import { Terminal } from "../../src";

describe("shim presence", () => {
  it("loads the shim alongside the main library", () => {
    // Construct a terminal to force lazy load.
    const t = new Terminal({ cols: 4, rows: 1 });
    try {
      const info = libraryInfo();
      expect(info.loaded).toBe(true);
      expect(info.path).toMatch(/libghostty-vt\.(dylib|so)/);
      expect(info.shimPath).toMatch(/libghostty-vt-shim\.(dylib|so)/);
    } finally {
      t.close();
    }
  });

  it("constructs a terminal via the shim's terminal_new_p path", () => {
    // If this works, the shim's ghostty_terminal_new_p wrapper succeeded.
    // The four-symbol shim is exercised by every Terminal lifecycle test;
    // this one is here to fail loud if the shim itself is broken.
    const t = new Terminal({ cols: 80, rows: 24 });
    expect(t).toBeDefined();
    t.close();
  });
});
