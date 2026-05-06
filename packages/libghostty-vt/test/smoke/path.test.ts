import { describe, expect, it } from "bun:test";
import { detectPlatform, SUPPORTED_PLATFORMS, resolveLibraryPath } from "../../src/internal/path";
import { LibraryNotFoundError, UnsupportedPlatformError } from "../../src/errors";

describe("platform detection", () => {
  it("detects current platform as a known string", () => {
    const p = detectPlatform();
    expect(typeof p).toBe("string");
    // darwin: "darwin-arm64"; linux: "linux-{x64,arm64}-{glibc,musl}"; win32: "win32-{arch}"
    expect(p).toMatch(/^(darwin|linux|win32)-(arm64|x64)(-\w+)?$/);
  });

  it("SUPPORTED_PLATFORMS includes at least darwin-arm64", () => {
    expect(SUPPORTED_PLATFORMS).toContain("darwin-arm64");
  });
});

describe("resolveLibraryPath", () => {
  const bundledFor = (platform: string) => `/pkg/prebuilds/${platform}/libghostty-vt.dylib`;

  it("prefers explicit override over env and bundled", () => {
    const path = resolveLibraryPath({
      override: "/custom/libghostty-vt.dylib",
      env: "/env/libghostty-vt.dylib",
      platform: "darwin-arm64",
      packageRoot: "/pkg",
      fileExists: () => true,
    });
    expect(path).toBe("/custom/libghostty-vt.dylib");
  });

  it("prefers env over bundled when no override", () => {
    const path = resolveLibraryPath({
      env: "/env/libghostty-vt.dylib",
      platform: "darwin-arm64",
      packageRoot: "/pkg",
      fileExists: () => true,
    });
    expect(path).toBe("/env/libghostty-vt.dylib");
  });

  it("falls back to bundled when neither override nor env set", () => {
    const path = resolveLibraryPath({
      platform: "darwin-arm64",
      packageRoot: "/pkg",
      fileExists: (p) => p === bundledFor("darwin-arm64"),
    });
    expect(path).toBe(bundledFor("darwin-arm64"));
  });

  // Error-class mapping per spec §4.6:
  //   missing explicit override           → LibraryNotFoundError
  //   missing GHOSTTY_VT_LIB               → LibraryNotFoundError
  //   no bundled + unknown platform        → UnsupportedPlatformError
  //   no bundled + supported platform      → LibraryNotFoundError (prebuild missing from package)

  it("missing explicit override throws LibraryNotFoundError", () => {
    expect(() =>
      resolveLibraryPath({
        override: "/does/not/exist.dylib",
        platform: "darwin-arm64",
        packageRoot: "/pkg",
        fileExists: () => false,
      }),
    ).toThrow(LibraryNotFoundError);
  });

  it("missing GHOSTTY_VT_LIB path throws LibraryNotFoundError", () => {
    expect(() =>
      resolveLibraryPath({
        env: "/does/not/exist.dylib",
        platform: "darwin-arm64",
        packageRoot: "/pkg",
        fileExists: () => false,
      }),
    ).toThrow(LibraryNotFoundError);
  });

  it("unsupported platform with no override throws UnsupportedPlatformError", () => {
    expect(() =>
      resolveLibraryPath({
        platform: "linux-x64",
        packageRoot: "/pkg",
        fileExists: () => false,
      }),
    ).toThrow(UnsupportedPlatformError);
  });

  it("unknown platform throws UnsupportedPlatformError", () => {
    expect(() =>
      resolveLibraryPath({
        platform: "plan9-mips",
        packageRoot: "/pkg",
        fileExists: () => false,
      }),
    ).toThrow(UnsupportedPlatformError);
  });

  it("supported platform with bundled prebuild missing throws LibraryNotFoundError", () => {
    expect(() =>
      resolveLibraryPath({
        platform: "darwin-arm64",
        packageRoot: "/pkg",
        fileExists: () => false,
      }),
    ).toThrow(LibraryNotFoundError);
  });
});
