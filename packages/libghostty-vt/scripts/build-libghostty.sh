#!/usr/bin/env bash
# Clone Ghostty at the pinned commit and build libghostty-vt.
# Produces prebuilds/<platform>/libghostty-vt.<ext>.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

COMMIT=$(bun -e 'console.log(JSON.parse(await Bun.file("package.json").text()).ghostty.commit)')
if [ -z "$COMMIT" ] || [ "$COMMIT" = "REPLACE_WITH_PINNED_COMMIT_IN_TASK_2" ]; then
  echo "package.json ghostty.commit is not set" >&2
  exit 1
fi

# Resolve platform.
UNAME_S=$(uname -s)
UNAME_M=$(uname -m)
case "$UNAME_S-$UNAME_M" in
  Darwin-arm64) PLATFORM="darwin-arm64"; EXT="dylib" ;;
  Darwin-x86_64) PLATFORM="darwin-x64"; EXT="dylib" ;;
  Linux-x86_64) PLATFORM="linux-x64"; EXT="so" ;;
  Linux-aarch64) PLATFORM="linux-arm64"; EXT="so" ;;
  *)
    echo "Unsupported build platform: $UNAME_S-$UNAME_M" >&2
    exit 1
    ;;
esac

# Clone or update vendor/ghostty at the pinned commit.
mkdir -p vendor
if [ ! -d vendor/ghostty/.git ]; then
  git clone https://github.com/ghostty-org/ghostty.git vendor/ghostty
fi
cd vendor/ghostty
git fetch --all --quiet
git checkout --quiet "$COMMIT"
cd "$ROOT"

# Resolve zig. On macOS Tahoe (26.x), the official ziglang.org zig 0.15.x
# tarballs (which mise installs) ship libSystem stubs that predate Tahoe and
# fail to link. Use Homebrew's zig@0.15 bottle, which is built against the
# Tahoe SDK. Per Ghostty PR #12363 this is the upstream-recommended fix until
# Ghostty migrates to zig 0.16. On Linux any zig 0.15.2 should work.
ZIG=""
if [ -x /opt/homebrew/opt/zig@0.15/bin/zig ]; then
  ZIG=/opt/homebrew/opt/zig@0.15/bin/zig
elif command -v zig >/dev/null 2>&1; then
  ZIG=$(command -v zig)
fi
if [ -z "$ZIG" ]; then
  echo "zig not found. On macOS: brew install zig@0.15  (Tahoe-compatible bottle)" >&2
  echo "                       Linux: install zig 0.15.2 via your package manager." >&2
  exit 1
fi
ZIG_VSN=$("$ZIG" version)
case "$ZIG_VSN" in
  0.15.*) ;;
  *)
    echo "zig at $ZIG is version $ZIG_VSN; Ghostty 1.3.x requires 0.15.x." >&2
    exit 1
    ;;
esac
echo "using zig $ZIG_VSN at $ZIG"

# Build libghostty-vt. Ghostty's build interface on main (post-v1.3.1) replaced
# the `lib-vt` step with `-Demit-lib-vt=true` option on the default `install`
# step. Check `zig build --help | grep lib-vt` if this stops working.
cd vendor/ghostty
"$ZIG" build install -Demit-lib-vt=true -Doptimize=ReleaseFast
cd "$ROOT"

# Locate the output and copy to prebuilds/.
mkdir -p "prebuilds/$PLATFORM"
# The path below matches recent Ghostty. If the build output moves, update here.
SRC="vendor/ghostty/zig-out/lib/libghostty-vt.$EXT"
if [ ! -f "$SRC" ]; then
  # Fallback: find any libghostty-vt.<ext> in zig-out.
  SRC=$(find vendor/ghostty/zig-out -name "libghostty-vt.$EXT" | head -n 1)
fi
if [ ! -f "$SRC" ]; then
  echo "build succeeded but libghostty-vt.$EXT not found" >&2
  exit 1
fi
cp "$SRC" "prebuilds/$PLATFORM/libghostty-vt.$EXT"
echo "installed prebuilds/$PLATFORM/libghostty-vt.$EXT"

# Copy upstream LICENSE into LICENSE_GHOSTTY.
cp vendor/ghostty/LICENSE LICENSE_GHOSTTY
echo "updated LICENSE_GHOSTTY from upstream"
