import { existsSync } from "node:fs";
import { join } from "node:path";
import { LibraryNotFoundError, UnsupportedPlatformError } from "../errors";

export const SUPPORTED_PLATFORMS = [
  "darwin-arm64",
  "linux-x64-glibc",
  "linux-x64-musl",
  "linux-arm64-glibc",
  "linux-arm64-musl",
] as const;
export type SupportedPlatform = (typeof SUPPORTED_PLATFORMS)[number];

/**
 * Detect glibc vs musl on Linux. Two strategies in priority order:
 *
 *   1. process.report.getReport().header.glibcVersionRuntime — Bun
 *      reproduces this Node.js API; on glibc systems it returns a non-
 *      empty version string, on musl it's missing or empty.
 *   2. ELF interpreter sniff — read the PT_INTERP segment from
 *      /proc/self/exe and string-match for "musl" vs "ld-linux".
 *
 * Strategy 1 is the fast path; strategy 2 is the correctness floor for
 * cases where Bun's process.report compat ever changes. If both fail
 * (e.g., /proc not mounted), we conservatively assume glibc — the more
 * common runtime — and let the dlopen failure provide a clear diagnostic.
 */
export function detectLibc(): "glibc" | "musl" {
  // Strategy 1: process.report
  try {
    const report = (process as any).report?.getReport?.();
    const v = report?.header?.glibcVersionRuntime;
    if (typeof v === "string" && v.length > 0) return "glibc";
  } catch {
    // fall through
  }
  // Strategy 2: ELF interpreter
  const interp = readElfInterpreter();
  if (interp) {
    if (interp.includes("musl")) return "musl";
    if (interp.includes("ld-linux") || interp.includes("ld-2.")) return "glibc";
  }
  return "glibc"; // conservative default
}

/**
 * Read the PT_INTERP segment of /proc/self/exe (the dynamic linker path).
 * Returns the interpreter string, or null on any failure.
 */
function readElfInterpreter(): string | null {
  try {
    // We only need the first few KB to reach PT_INTERP (Bun is very large
    // overall, but PT_INTERP is in the program-header section near the
    // start of the ELF). Read 32 KB, more than enough.
    const fs = require("node:fs") as typeof import("node:fs");
    const fd = fs.openSync("/proc/self/exe", "r");
    try {
      const buf = Buffer.alloc(32 * 1024);
      const bytesRead = fs.readSync(fd, buf, 0, buf.length, 0);
      if (bytesRead < 64) return null;
      // ELF64 header layout: e_phoff @32 (8B), e_phentsize @54 (2B),
      // e_phnum @56 (2B). Iterate program headers; PT_INTERP type = 3.
      // Each Phdr: p_type @0 (4B), p_offset @8 (8B), p_filesz @32 (8B).
      const e_ident_class = buf.readUInt8(4);
      if (e_ident_class !== 2) return null; // not ELF64
      const e_phoff = Number(buf.readBigUInt64LE(32));
      const e_phentsize = buf.readUInt16LE(54);
      const e_phnum = buf.readUInt16LE(56);
      for (let i = 0; i < e_phnum; i++) {
        const off = e_phoff + i * e_phentsize;
        if (off + 56 > bytesRead) break;
        const p_type = buf.readUInt32LE(off);
        if (p_type !== 3) continue; // PT_INTERP
        const p_offset = Number(buf.readBigUInt64LE(off + 8));
        const p_filesz = Number(buf.readBigUInt64LE(off + 32));
        if (p_offset + p_filesz > bytesRead) {
          // Need a larger read; fall through.
          const buf2 = Buffer.alloc(p_offset + p_filesz);
          fs.readSync(fd, buf2, 0, buf2.length, 0);
          return buf2.subarray(p_offset, p_offset + p_filesz - 1).toString("utf8");
        }
        return buf.subarray(p_offset, p_offset + p_filesz - 1).toString("utf8");
      }
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    // /proc not mounted, file missing, parse error — return null.
  }
  return null;
}

export function detectPlatform(): string {
  const os =
    process.platform === "darwin" ? "darwin" :
    process.platform === "linux" ? "linux" :
    process.platform === "win32" ? "win32" :
    process.platform;
  const arch =
    process.arch === "arm64" ? "arm64" :
    process.arch === "x64" ? "x64" :
    process.arch;
  if (os === "linux") {
    return `${os}-${arch}-${detectLibc()}`;
  }
  return `${os}-${arch}`;
}

function libExtension(platform: string): string {
  if (platform.startsWith("darwin-")) return "dylib";
  if (platform.startsWith("win32-")) return "dll";
  return "so";
}

function isKnownPlatform(platform: string): platform is SupportedPlatform {
  return (SUPPORTED_PLATFORMS as readonly string[]).includes(platform);
}

export interface ResolveOptions {
  override?: string | undefined;                   // from setLibraryPath()
  env?: string | undefined;                         // process.env.GHOSTTY_VT_LIB
  platform?: string | undefined;                    // default detectPlatform()
  packageRoot: string;                              // directory containing prebuilds/
  fileExists?: ((path: string) => boolean) | undefined;
}

export function resolveLibraryPath(opts: ResolveOptions): string {
  const exists = opts.fileExists ?? ((p) => existsSync(p));
  const platform = opts.platform ?? detectPlatform();

  // Priority 1: explicit override (setLibraryPath). Missing → NotFound.
  if (opts.override) {
    if (!exists(opts.override)) {
      throw new LibraryNotFoundError(
        `setLibraryPath: file not found at ${opts.override}`,
        { searchedPaths: [opts.override] },
      );
    }
    return opts.override;
  }

  // Priority 2: GHOSTTY_VT_LIB env var. Missing → NotFound.
  if (opts.env) {
    if (!exists(opts.env)) {
      throw new LibraryNotFoundError(
        `GHOSTTY_VT_LIB: file not found at ${opts.env}`,
        { searchedPaths: [opts.env] },
      );
    }
    return opts.env;
  }

  // Priority 3: bundled prebuild. Two failure modes:
  //   - Unknown/unsupported platform → UnsupportedPlatformError.
  //   - Supported platform but prebuild missing from the package → LibraryNotFoundError
  //     (the prebuild should have shipped in the tarball; if it didn't, that's a packaging bug).
  const ext = libExtension(platform);
  const bundled = join(opts.packageRoot, "prebuilds", platform, `libghostty-vt.${ext}`);

  if (!isKnownPlatform(platform)) {
    throw new UnsupportedPlatformError(
      `No bundled libghostty-vt for ${platform}. Supported: ${SUPPORTED_PLATFORMS.join(", ")}. ` +
        `Set GHOSTTY_VT_LIB or call setLibraryPath() to override.`,
      {
        detectedPlatform: platform,
        supportedPlatforms: [...SUPPORTED_PLATFORMS],
      },
    );
  }

  if (!exists(bundled)) {
    throw new LibraryNotFoundError(
      `Bundled libghostty-vt missing at ${bundled}. ` +
        `This usually means the package tarball is incomplete — reinstall ts-libghostty, ` +
        `or override via GHOSTTY_VT_LIB / setLibraryPath().`,
      { searchedPaths: [bundled] },
    );
  }

  return bundled;
}

/**
 * Resolve the path to libghostty-vt-shim. Mirrors resolveLibraryPath() but
 * looks for `libghostty-vt-shim.<ext>` in the same prebuilds/ directory.
 *
 * The shim's runtime dependency on libghostty-vt is resolved by the OS
 * loader using the shim's own directory ($ORIGIN on Linux, @loader_path
 * on darwin), so the shim and the main library MUST live in the same
 * directory. If a caller uses setShimLibraryPath() to override, they
 * are responsible for ensuring the matching libghostty-vt is co-located.
 */
export function resolveShimLibraryPath(opts: ResolveOptions): string {
  const exists = opts.fileExists ?? ((p) => existsSync(p));
  const platform = opts.platform ?? detectPlatform();

  if (opts.override) {
    if (!exists(opts.override)) {
      throw new LibraryNotFoundError(
        `setShimLibraryPath: file not found at ${opts.override}`,
        { searchedPaths: [opts.override] },
      );
    }
    return opts.override;
  }

  if (opts.env) {
    if (!exists(opts.env)) {
      throw new LibraryNotFoundError(
        `GHOSTTY_VT_SHIM_LIB: file not found at ${opts.env}`,
        { searchedPaths: [opts.env] },
      );
    }
    return opts.env;
  }

  const ext = libExtension(platform);
  const bundled = join(opts.packageRoot, "prebuilds", platform, `libghostty-vt-shim.${ext}`);

  if (!isKnownPlatform(platform)) {
    throw new UnsupportedPlatformError(
      `No bundled libghostty-vt-shim for ${platform}. Supported: ${SUPPORTED_PLATFORMS.join(", ")}.`,
      {
        detectedPlatform: platform,
        supportedPlatforms: [...SUPPORTED_PLATFORMS],
      },
    );
  }

  if (!exists(bundled)) {
    throw new LibraryNotFoundError(
      `Bundled libghostty-vt-shim missing at ${bundled}. ` +
        `This usually means the package tarball is incomplete — reinstall libghostty-vt, ` +
        `or override via GHOSTTY_VT_SHIM_LIB / setShimLibraryPath().`,
      { searchedPaths: [bundled] },
    );
  }

  return bundled;
}
