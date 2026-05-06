import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { join } from "node:path";
import * as ffi from "../../src/ffi";
import { LibraryCompatibilityError, LibraryNotFoundError } from "../../src/errors";
import { detectPlatform } from "../../src/internal/path";

const platform = detectPlatform();
const ext = platform.startsWith("darwin-") ? "dylib" : "so";
const BUNDLED = join(process.cwd(), `prebuilds/${platform}/libghostty-vt.${ext}`);

describe("ffi", () => {
  beforeEach(() => {
    ffi._resetForTest();
  });

  it("isLoaded() is false before any native use", () => {
    expect(ffi.isLoaded()).toBe(false);
    expect(ffi.libraryInfo().loaded).toBe(false);
  });

  it("setLibraryPath is idempotent before load", () => {
    try {
      ffi.setLibraryPath(BUNDLED);
      ffi.setLibraryPath(BUNDLED);  // same path — ok
      expect(ffi.isLoaded()).toBe(false);
    } finally {
      ffi._resetForTest();
    }
  });

  it("setLibraryPath throws after load", () => {
    try {
      ffi.setLibraryPath(BUNDLED);
      ffi.getLib();  // triggers load
      expect(ffi.isLoaded()).toBe(true);
      expect(() => ffi.setLibraryPath("/other.dylib")).toThrow(LibraryCompatibilityError);
    } finally {
      ffi._resetForTest();
    }
  });

  it("missing library path throws LibraryNotFoundError", () => {
    try {
      ffi.setLibraryPath("/definitely/does/not/exist/libghostty-vt.dylib");
      expect(() => ffi.getLib()).toThrow(LibraryNotFoundError);
    } finally {
      ffi._resetForTest();
    }
  });

  it("getLib() resolves the declared ghostty_terminal_new symbol", () => {
    try {
      ffi.setLibraryPath(BUNDLED);
      const lib = ffi.getLib();
      expect(typeof lib.symbols.ghostty_terminal_new).toBe("function");
    } finally {
      ffi._resetForTest();
    }
  });

  it("libraryInfo() after load reports path and pinnedCommit", () => {
    try {
      ffi.setLibraryPath(BUNDLED);
      ffi.getLib();
      const info = ffi.libraryInfo();
      expect(info.loaded).toBe(true);
      expect(info.path).toBe(BUNDLED);
      expect(typeof info.pinnedCommit).toBe("string");
    } finally {
      ffi._resetForTest();
    }
  });

  it("Pass 4 — key encoder + event symbols are loaded", () => {
    try {
      ffi.setLibraryPath(BUNDLED);
      const lib = ffi.getLib();
      // Encoder lifecycle + ops
      expect(typeof lib.symbols.ghostty_key_encoder_new).toBe("function");
      expect(typeof lib.symbols.ghostty_key_encoder_free).toBe("function");
      expect(typeof lib.symbols.ghostty_key_encoder_setopt).toBe("function");
      expect(typeof lib.symbols.ghostty_key_encoder_setopt_from_terminal).toBe("function");
      expect(typeof lib.symbols.ghostty_key_encoder_encode).toBe("function");
      // Event lifecycle + setters
      expect(typeof lib.symbols.ghostty_key_event_new).toBe("function");
      expect(typeof lib.symbols.ghostty_key_event_free).toBe("function");
      expect(typeof lib.symbols.ghostty_key_event_set_action).toBe("function");
      expect(typeof lib.symbols.ghostty_key_event_set_key).toBe("function");
      expect(typeof lib.symbols.ghostty_key_event_set_mods).toBe("function");
      expect(typeof lib.symbols.ghostty_key_event_set_consumed_mods).toBe("function");
      expect(typeof lib.symbols.ghostty_key_event_set_composing).toBe("function");
      expect(typeof lib.symbols.ghostty_key_event_set_unshifted_codepoint).toBe("function");
      expect(typeof lib.symbols.ghostty_key_event_set_utf8).toBe("function");
    } finally {
      ffi._resetForTest();
    }
  });
});
