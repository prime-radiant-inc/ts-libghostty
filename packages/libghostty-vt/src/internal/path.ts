import { existsSync } from "node:fs";
import { join } from "node:path";
import { LibraryNotFoundError, UnsupportedPlatformError } from "../errors";

export const SUPPORTED_PLATFORMS = ["darwin-arm64"] as const;
export type SupportedPlatform = (typeof SUPPORTED_PLATFORMS)[number];

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
