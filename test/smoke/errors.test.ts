import { describe, expect, it } from "bun:test";
import {
  GhosttyError,
  LibraryNotFoundError,
  UnsupportedPlatformError,
  LibraryCompatibilityError,
  UseAfterCloseError,
} from "../../src/errors";

describe("GhosttyError hierarchy", () => {
  it("GhosttyError has code and optional functionName", () => {
    const e = new GhosttyError("bad things", { code: "unknown" });
    expect(e).toBeInstanceOf(Error);
    expect(e).toBeInstanceOf(GhosttyError);
    expect(e.name).toBe("GhosttyError");
    expect(e.code).toBe("unknown");
    expect(e.functionName).toBeUndefined();
    expect(e.message).toBe("bad things");

    const e2 = new GhosttyError("boom", { code: "invalid_argument", functionName: "ghostty_terminal_resize" });
    expect(e2.functionName).toBe("ghostty_terminal_resize");
  });

  it("LibraryNotFoundError carries searchedPaths and extends GhosttyError", () => {
    const e = new LibraryNotFoundError("not found", { searchedPaths: ["/a", "/b"] });
    expect(e).toBeInstanceOf(GhosttyError);
    expect(e).toBeInstanceOf(LibraryNotFoundError);
    expect(e.code).toBe("library_not_found");
    expect(e.searchedPaths).toEqual(["/a", "/b"]);
    expect(e.name).toBe("LibraryNotFoundError");
  });

  it("UnsupportedPlatformError carries detected and supported lists", () => {
    const e = new UnsupportedPlatformError("not supported", {
      detectedPlatform: "linux-x64",
      supportedPlatforms: ["darwin-arm64"],
    });
    expect(e).toBeInstanceOf(GhosttyError);
    expect(e.code).toBe("unsupported_platform");
    expect(e.detectedPlatform).toBe("linux-x64");
    expect(e.supportedPlatforms).toEqual(["darwin-arm64"]);
  });

  it("LibraryCompatibilityError carries commit info and details", () => {
    const e = new LibraryCompatibilityError("abi mismatch", {
      expectedCommit: "abc",
      actualCommit: "def",
      details: "missing symbol ghostty_terminal_new",
    });
    expect(e).toBeInstanceOf(GhosttyError);
    expect(e.code).toBe("library_incompatible");
    expect(e.details).toContain("missing symbol");
  });

  it("UseAfterCloseError carries the handle type name", () => {
    const e = new UseAfterCloseError("closed", { handleType: "Terminal" });
    expect(e).toBeInstanceOf(GhosttyError);
    expect(e.code).toBe("use_after_close");
    expect(e.handleType).toBe("Terminal");
  });
});
