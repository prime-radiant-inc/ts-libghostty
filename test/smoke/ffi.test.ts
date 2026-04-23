import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { join } from "node:path";
import * as ffi from "../../src/ffi";
import { LibraryCompatibilityError, LibraryNotFoundError } from "../../src/errors";

const BUNDLED = join(
  process.cwd(),
  "prebuilds/darwin-arm64/libghostty-vt.dylib",
);

describe("ffi", () => {
  beforeEach(() => {
    ffi._resetForTest();
  });

  it("isLoaded() is false before any native use", () => {
    expect(ffi.isLoaded()).toBe(false);
    expect(ffi.libraryInfo().loaded).toBe(false);
  });

  it("setLibraryPath is idempotent before load", () => {
    ffi.setLibraryPath(BUNDLED);
    ffi.setLibraryPath(BUNDLED);  // same path — ok
    expect(ffi.isLoaded()).toBe(false);
  });

  it("setLibraryPath throws after load", () => {
    ffi.setLibraryPath(BUNDLED);
    ffi.getLib();  // triggers load
    expect(ffi.isLoaded()).toBe(true);
    expect(() => ffi.setLibraryPath("/other.dylib")).toThrow(LibraryCompatibilityError);
  });

  it("missing library path throws LibraryNotFoundError", () => {
    ffi.setLibraryPath("/definitely/does/not/exist/libghostty-vt.dylib");
    expect(() => ffi.getLib()).toThrow(LibraryNotFoundError);
  });

  it("getLib() resolves the declared ghostty_terminal_new symbol", () => {
    ffi.setLibraryPath(BUNDLED);
    const lib = ffi.getLib();
    expect(typeof lib.symbols.ghostty_terminal_new).toBe("function");
  });

  it("libraryInfo() after load reports path and pinnedCommit", () => {
    ffi.setLibraryPath(BUNDLED);
    ffi.getLib();
    const info = ffi.libraryInfo();
    expect(info.loaded).toBe(true);
    expect(info.path).toBe(BUNDLED);
    expect(typeof info.pinnedCommit).toBe("string");
  });
});
