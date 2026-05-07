#!/usr/bin/env bash
# Run libghostty-vt smoke tests in Linux containers via Docker/OrbStack.
# On Apple Silicon: arm64 runs natively; x64 via Rosetta 2.
#
# Prerequisite: prebuilds/ must contain matching binaries for each target.
# Run `bun run build:linux` first, or build inside the container by passing
# BUILD=1.

set -euo pipefail
PKG_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PKG_ROOT"

BUILD="${BUILD:-0}"

run_in_container() {
  local platform="$1" image="$2" prebuild_dir="$3"
  echo "==== $platform ($image) ===="
  if [ "$BUILD" = "1" ]; then
    # Build inside the container before running tests.
    docker run --rm --platform "$platform" \
      -v "$PWD:/work" -w /work \
      "$image" \
      bash -c "apk add --no-cache build-base bash git zig 2>/dev/null || apt-get update -qq && apt-get install -y -qq bash git build-essential 2>/dev/null; bun run build:libghostty && bun test test/smoke"
  else
    if [ ! -d "prebuilds/$prebuild_dir" ]; then
      echo "prebuilds/$prebuild_dir not present; build first or pass BUILD=1" >&2
      return 1
    fi
    docker run --rm --platform "$platform" \
      -v "$PWD:/work" -w /work \
      "$image" \
      bun test test/smoke
  fi
}

run_in_container linux/arm64 oven/bun:debian linux-arm64-glibc
run_in_container linux/arm64 oven/bun:alpine  linux-arm64-musl
run_in_container linux/amd64 oven/bun:debian linux-x64-glibc
run_in_container linux/amd64 oven/bun:alpine  linux-x64-musl
echo "==== all matrix cells passed ===="
