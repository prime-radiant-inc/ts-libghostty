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

# Resolve build target. Native builds infer from uname; cross-compile
# accepts a TARGET env var (used by Linux CI to build both glibc + musl
# variants from a single runner).
if [ -n "${TARGET:-}" ]; then
  case "$TARGET" in
    x86_64-linux-gnu) PLATFORM="linux-x64-glibc"; EXT="so"; ZIG_TARGET="$TARGET" ;;
    x86_64-linux-musl) PLATFORM="linux-x64-musl"; EXT="so"; ZIG_TARGET="$TARGET" ;;
    aarch64-linux-gnu) PLATFORM="linux-arm64-glibc"; EXT="so"; ZIG_TARGET="$TARGET" ;;
    aarch64-linux-musl) PLATFORM="linux-arm64-musl"; EXT="so"; ZIG_TARGET="$TARGET" ;;
    *) echo "Unsupported TARGET: $TARGET" >&2; exit 1 ;;
  esac
else
  UNAME_S=$(uname -s)
  UNAME_M=$(uname -m)
  case "$UNAME_S-$UNAME_M" in
    Darwin-arm64) PLATFORM="darwin-arm64"; EXT="dylib"; ZIG_TARGET="" ;;
    *)
      echo "Unsupported native platform: $UNAME_S-$UNAME_M. Cross-compile via TARGET env." >&2
      exit 1
      ;;
  esac
fi

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
ZIG_BUILD_ARGS=(install "-Demit-lib-vt=true" "-Doptimize=ReleaseFast")
if [ -n "$ZIG_TARGET" ]; then
  ZIG_BUILD_ARGS+=("-Dtarget=$ZIG_TARGET")
fi
"$ZIG" build "${ZIG_BUILD_ARGS[@]}"
cd "$ROOT"

# Discover the produced library. Cross-compile may put it under a
# triple-named subdir; native build puts it directly under zig-out/lib.
SRC=""
for cand in \
  "vendor/ghostty/zig-out/lib/libghostty-vt.$EXT" \
  "vendor/ghostty/zig-out/lib/libghostty-vt.$EXT".* \
  vendor/ghostty/zig-out/lib/*/libghostty-vt.$EXT \
  ; do
  if [ -f "$cand" ]; then SRC="$cand"; break; fi
done
if [ -z "$SRC" ]; then
  echo "build succeeded but libghostty-vt.$EXT not found" >&2
  find vendor/ghostty/zig-out -maxdepth 4 -type f >&2
  exit 1
fi

mkdir -p "prebuilds/$PLATFORM"

# Discover SONAME and construct the symlink chain. Linux .so files have an
# embedded SONAME (e.g., "libghostty-vt.so.0"); the shim's NEEDED entry
# resolves that name. The SOVERSION may change at any libghostty pin bump,
# so we never hardcode the .so.<n>.<n>.<n> filename.
#
# SONAME discovery: tries multiple tools because cross-builds happen on
# macOS hosts where readelf isn't installed by default. Order: readelf
# (Linux native and Linux containers), llvm-readelf (Xcode), then objdump
# -p as a last resort. Bail with an install hint if all three fail.
read_soname() {
  local lib="$1"
  if command -v readelf >/dev/null 2>&1; then
    readelf -d "$lib" 2>/dev/null | awk '/SONAME/ {gsub(/[\[\]]/, "", $NF); print $NF; exit}'
  elif command -v llvm-readelf >/dev/null 2>&1; then
    llvm-readelf -d "$lib" 2>/dev/null | awk '/SONAME/ {gsub(/[\[\]]/, "", $NF); print $NF; exit}'
  elif command -v objdump >/dev/null 2>&1; then
    objdump -p "$lib" 2>/dev/null | awk '/SONAME/ {print $2; exit}'
  else
    return 1
  fi
}

case "$EXT" in
  so)
    SONAME=$(read_soname "$SRC")
    if [ -z "$SONAME" ]; then
      echo "ERROR: could not read SONAME from $SRC" >&2
      echo "  Install a tool that can read ELF dynamic sections:" >&2
      echo "    Linux: apt-get install binutils (provides readelf)" >&2
      echo "    macOS: brew install binutils  (then re-run; binutils' readelf is at /opt/homebrew/opt/binutils/bin/readelf — add to PATH)" >&2
      echo "           OR: brew install llvm  (provides llvm-readelf)" >&2
      exit 1
    fi
    SRC_BASENAME=$(basename "$SRC")
    if [[ "$SRC_BASENAME" =~ ^libghostty-vt\.so\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
      FULL_NAME="$SRC_BASENAME"
    else
      FULL_NAME="$SONAME.0"  # synthetic; only matters for the symlink target
    fi
    cp "$SRC" "prebuilds/$PLATFORM/$FULL_NAME"
    (cd "prebuilds/$PLATFORM" && ln -sf "$FULL_NAME" "$SONAME")
    (cd "prebuilds/$PLATFORM" && ln -sf "$SONAME" "libghostty-vt.so")
    echo "installed prebuilds/$PLATFORM/libghostty-vt.so → $SONAME → $FULL_NAME"
    ;;
  dylib)
    cp "$SRC" "prebuilds/$PLATFORM/libghostty-vt.dylib"
    echo "installed prebuilds/$PLATFORM/libghostty-vt.dylib"
    ;;
esac

# Build the portability shim. Wraps four by-value entry points with pointer-
# taking variants so the binding can use a single FFI strategy across
# platforms. See docs/superpowers/specs/2026-05-06-linux-portability-design.md.
echo "==> building libghostty-vt-shim for $PLATFORM"
# Sanity check: shim.c includes ghostty/vt.h etc., which must be present in
# vendor/ghostty/include after the libghostty-vt build above.
if [ ! -f vendor/ghostty/include/ghostty/vt.h ]; then
  echo "ERROR: vendor/ghostty/include/ghostty/vt.h missing; libghostty-vt build did not check out headers" >&2
  exit 1
fi
SHIM_OUT="prebuilds/$PLATFORM/libghostty-vt-shim.$EXT"
case "$PLATFORM" in
  darwin-*)
    "$ZIG" cc -O2 -fPIC -shared \
      -I vendor/ghostty/include \
      -Wl,-install_name,@rpath/libghostty-vt-shim.$EXT \
      -Wl,-rpath,@loader_path \
      -L "prebuilds/$PLATFORM" -lghostty-vt \
      -o "$SHIM_OUT" \
      native/shim.c
    ;;
  linux-*)
    "$ZIG" cc -O2 -fPIC -shared \
      -target "$ZIG_TARGET" \
      -I vendor/ghostty/include \
      -Wl,-soname,libghostty-vt-shim.so \
      -Wl,-rpath,'$ORIGIN' \
      -L "prebuilds/$PLATFORM" -lghostty-vt \
      -o "$SHIM_OUT" \
      native/shim.c
    ;;
esac
echo "installed $SHIM_OUT"

# Copy upstream LICENSE into LICENSE_GHOSTTY.
cp vendor/ghostty/LICENSE LICENSE_GHOSTTY
echo "updated LICENSE_GHOSTTY from upstream"
