# ts-libghostty Pass 1 Implementation Plan — Foundation + Terminal + Formatter

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** `docs/superpowers/specs/2026-04-22-ts-libghostty-design.md`

**Pass:** 1 of ~5. Pass 1 delivers byte-in → text-dump-out end-to-end with full ABI safety. Subsequent passes add effect callbacks (2), grid-reading via `RenderState` (3), `KeyEncoder` (4), and polish like modes/colors/viewport/`cellAt` (5).

**Revision:** 2026-04-22 second pass after Codex review. Key structural change: **new Task 3 "ABI discovery"** inserted before any FFI implementation — it reads the pinned Ghostty headers and produces `docs/abi/2026-04-22-abi-discovery.md`, the authoritative reference that every subsequent task consumes instead of guessing at signatures. Other material changes: symbol manifest split into `declaredHeaderSymbols` (diagnostic) + `requiredSymbols` (what `dlopen` declares); struct probe emits `kind` per field and `isSized` per struct; `ModeName` is now a real generated string-literal union with `modeTagByName` lookup; `resultCodeByValue` is generated (no substring matching); path-resolution errors aligned to spec §4.6 (LibraryNotFoundError vs UnsupportedPlatformError); `cellPx` plumbed through constructor → resize → snapshot; `.js` relative imports for NodeNext emission; `Bun.Terminal`-style bug fixes (tarball path, `.tmp` mkdir, arm64 runner pin, tag-as-last-step). Full delta list in the Self-Review at the bottom of the plan.

**Goal:** Ship a working, testable v0.1.0 of `ts-libghostty` exposing `Terminal` (construction, `vtWrite`, `resize`, `reset`, `snapshot`, `mode`/`setMode`, lifecycle) and `Formatter` (text/VT/HTML dump), with the full native-boundary safety story from spec §5 (lazy dlopen, symbol manifest verification, struct-layout probe, use-after-close, APC bounds) and the full error hierarchy from spec §4.6.

**Architecture:** TypeScript on Bun ≥ 1.3.13. `bun:ffi` wraps a prebuilt `libghostty-vt.dylib` built from a pinned Ghostty commit. Build pipeline: clone Ghostty at pin, zig-build the dylib, compile a small C probe against the pinned headers to emit struct layout info, run a TS generator that parses `vt.h` for enum values + symbol manifest and merges in the probe output to produce a checked-in `src/internal/generated.ts`. Library loads lazily on first native use and verifies every declared symbol before exposing any usable object.

**Tech Stack:** Bun (runtime + `bun:ffi` + `bun test` + `bun pm pack`), Zig (for Ghostty's own build, provides libghostty-vt), C (the probe), TypeScript 5.4+, GitHub Actions (CI on a pinned arm64 macOS runner — see Task 20).

**Bun version gate:** workspace must run `bun >= 1.3.13`. Task 1 Step 9 fails fast on lower versions with a clear upgrade instruction. If you are below, upgrade Bun before starting (`curl -fsSL https://bun.sh/install | bash`).

**Pinned upstream:** Ghostty commit is pinned in **Task 2 Step 1** — the executor must pick a specific commit SHA before proceeding, and all downstream work consumes that choice via the ABI Discovery pass in Task 3. Do not start Task 2 without a chosen SHA. The pinned SHA is the only source of truth; any later reference to "the pin" or "upstream" means that commit.

**Module format.** TypeScript source uses `.js` relative import specifiers (the canonical TS→ESM pattern). `tsconfig.json` sets `moduleResolution: "bundler"`, `module: "ESNext"`, `allowImportingTsExtensions: false`. `tsc` emits to `dist/`; the tarball ships `src/` plus `dist/` plus `prebuilds/`. Tarball-smoke (Task 19) proves the emitted imports resolve in a clean install.

**ABI discovery is gated before FFI implementation.** Task 3 consumes the pinned Ghostty headers to produce a checked-in reference document enumerating the exact C signatures, struct fields, enum names, and ownership rules the binding depends on. Tasks 4 onward read from that doc. Every later task that historically carried a "verify at pin" note now simply references the discovery artifact.

**Out of scope for Pass 1 (deferred to later passes):** effect callbacks (`onWritePty`, `onBell`, `onTitleChanged`); `RenderState` + `RenderRow` + `RenderCell`; `KeyEncoder` + `KeyEvent`; `encodeFocus`; colors get/set; viewport scroll; `cellAt`; mouse and Kitty and OSC and paste.

---

## File structure

Files created in Pass 1:

```
ts-libghostty/
  .gitignore
  .gitattributes
  .npmignore
  package.json
  tsconfig.json
  README.md
  LICENSE                        # Apache-2.0 (ts-libghostty's own code)
  LICENSE_GHOSTTY                # Upstream MIT (because we redistribute compiled Ghostty)

  src/
    index.ts                     # public re-exports
    ffi.ts                       # lazy dlopen, symbol manifest, setLibraryPath/isLoaded/libraryInfo
    terminal.ts                  # Terminal class
    formatter.ts                 # Formatter class
    errors.ts                    # GhosttyError hierarchy
    types.ts                     # public supporting types used by Terminal/Formatter at Pass 1
    internal/
      path.ts                    # platform detection + prebuild path resolution
      sized-struct.ts            # private helpers for sized + plain struct marshaling
      marshal.ts                 # private string/buffer helpers
      generated.ts               # GENERATED — symbol manifest, enum values, struct layout (checked in)

  scripts/
    build-libghostty.sh          # clone Ghostty at pin + zig build libghostty-vt → prebuilds/
    probe-layout.c               # C probe: emits struct sizes/alignments/offsets as JSON
    gen-bindings.ts              # parses vt.h + merges probe output → generated.ts
    run-tarball-smoke.sh         # bun pm pack + install to temp dir + run a script

  prebuilds/
    darwin-arm64/
      libghostty-vt.dylib        # gitignored; produced by build-libghostty.sh

  test/
    helpers/
      platform.ts                # runtime platform detection for skip-on-wrong-platform
      fixture-harness.ts         # load .bin + replay via vtWrite + diff vs .expected.txt
    smoke/
      errors.test.ts
      path.test.ts
      ffi.test.ts
      terminal.test.ts
      formatter.test.ts
      abi.test.ts                # symbol resolution + struct layout match
    fixtures/
      hello-world.bin
      hello-world.expected.txt
    tarball/
      smoke.test.ts              # orchestrates the tarball install + import test

  docs/
    abi/
      2026-04-22-abi-discovery.md  # GENERATED in Task 3 — authoritative ABI reference

  .github/
    workflows/
      ci.yml
```

Each file has exactly one responsibility. `src/ffi.ts` is the only place that calls `dlopen`; every other source file uses the typed symbol table it exports. `src/internal/generated.ts` is the only place where raw C layout/enum values live; any binding code reads from it, never hand-codes an enum value. `docs/abi/2026-04-22-abi-discovery.md` is the only place where human-readable pinned-commit notes live.

---

## Task 1: Project scaffolding

**Files:**
- Create: `.gitignore`, `.gitattributes`, `.npmignore`, `package.json`, `tsconfig.json`, `README.md`, `LICENSE`, `LICENSE_GHOSTTY`

- [ ] **Step 1: Create `.gitignore`**

Contents:

```gitignore
node_modules/
dist/
vendor/
prebuilds/*/libghostty-vt.dylib
prebuilds/*/libghostty-vt.so
prebuilds/*/libghostty-vt.dll
*.log
.DS_Store
/tmp/
/.tmp/
```

Note: the Bun lockfile (`bun.lockb` on older Bun, `bun.lock` on ≥1.2) is **committed** — do not ignore it. Step 10 adds whichever lockfile exists after `bun install`.

- [ ] **Step 2: Create `.gitattributes`**

Contents:

```
prebuilds/** binary
*.dylib binary
*.so binary
*.dll binary
```

- [ ] **Step 3: Create `.npmignore`**

Contents (whitelist approach via `files:` in package.json is actually cleaner; we rely on that. This file exists only to block accidents):

```
vendor/
test/
scripts/
docs/
.github/
*.log
.DS_Store
```

- [ ] **Step 4: Create `package.json`**

Contents:

```json
{
  "name": "ts-libghostty",
  "version": "0.1.0",
  "description": "TypeScript binding over libghostty-vt. Unofficial community binding.",
  "license": "Apache-2.0",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  },
  "files": [
    "src/",
    "dist/",
    "prebuilds/",
    "LICENSE",
    "LICENSE_GHOSTTY",
    "README.md"
  ],
  "engines": {
    "bun": ">=1.3.13"
  },
  "scripts": {
    "build:libghostty": "bash scripts/build-libghostty.sh",
    "build:probe": "mkdir -p .tmp && cc -O2 -I vendor/ghostty/include -o .tmp/probe-layout scripts/probe-layout.c && .tmp/probe-layout > .tmp/layout.json",
    "build:bindings": "bun scripts/gen-bindings.ts",
    "build:native": "bun run build:libghostty && bun run build:probe && bun run build:bindings",
    "build:ts": "tsc -p tsconfig.json",
    "build": "bun run build:native && bun run build:ts",
    "test": "bun test test/smoke test/tarball/smoke.test.ts",
    "test:smoke": "bun test test/smoke",
    "test:tarball": "bash scripts/run-tarball-smoke.sh",
    "verify:generated": "bun run build:probe && bun run build:bindings && git diff --exit-code src/internal/generated.ts"
  },
  "ghostty": {
    "commit": "REPLACE_WITH_PINNED_COMMIT_IN_TASK_2"
  },
  "devDependencies": {
    "@types/bun": "latest",
    "typescript": "^5.4.0"
  }
}
```

- [ ] **Step 5: Create `tsconfig.json`**

Contents:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2023"],
    "types": ["bun"],
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "useDefineForClassFields": true,
    "verbatimModuleSyntax": false,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "allowImportingTsExtensions": false
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "test"]
}
```

Source code throughout this plan uses `.js` relative import specifiers (the canonical TS→ESM pattern for NodeNext). For example `import { X } from "./terminal.js"` — TypeScript resolves this to `./terminal.ts` at compile time; the emitted `dist/index.js` then imports `./terminal.js`, which exists. `verbatimModuleSyntax` is off because we mix value and type imports; use explicit `import type` where needed.

- [ ] **Step 6: Create `LICENSE` (Apache-2.0)**

Download the canonical Apache-2.0 text and drop at `LICENSE`. Copyright line at the top:

```
Copyright 2026 Prime Radiant (and contributors)
```

- [ ] **Step 7: Create `LICENSE_GHOSTTY`**

Copy the MIT license text from `https://github.com/ghostty-org/ghostty/blob/main/LICENSE` at the pinned commit (the actual file will be fetched in Task 2). For now, create the file with a placeholder header and a `TASK_2_REPLACE_WITH_UPSTREAM` marker that Task 2 overwrites:

```
TASK_2_REPLACE_WITH_UPSTREAM
```

Task 2 will replace this with the verbatim upstream MIT text once `vendor/ghostty/LICENSE` exists.

- [ ] **Step 8: Create `README.md`** (stub; filled in Task 21)

Contents:

```markdown
# ts-libghostty

Unofficial TypeScript binding over [libghostty-vt](https://github.com/ghostty-org/ghostty),
the VT state machine extracted from [Ghostty](https://ghostty.org). For Bun.

**Status: pre-1.0, API unstable.** Pinned to Ghostty commit `<see package.json ghostty.commit>`.

**Platforms:** `darwin-arm64` (more on demand).

Full README filled in by Task 21.

## License

- `ts-libghostty` code: Apache-2.0 (see `LICENSE`).
- Redistributed `libghostty-vt.dylib` in `prebuilds/`: MIT (see `LICENSE_GHOSTTY`,
  matching upstream Ghostty's license at the pinned commit).
```

- [ ] **Step 9: Verify Bun version and initialize install**

```bash
# Fail fast if Bun is below engines requirement.
bun --version
# Expect: 1.3.13 or higher. If lower: `curl -fsSL https://bun.sh/install | bash`
# and re-run this step.

bun install
```

Expected: installs `@types/bun` and `typescript` (no other deps); produces a lockfile — newer Bun emits `bun.lock`, older emits `bun.lockb`.

- [ ] **Step 10: Commit**

Detect whichever lockfile exists and stage it:

```bash
LOCK=$(ls bun.lock bun.lockb 2>/dev/null | head -n 1)
if [ -z "$LOCK" ]; then
  echo "bun install did not produce a lockfile" >&2
  exit 1
fi
git add .gitignore .gitattributes .npmignore package.json tsconfig.json README.md LICENSE LICENSE_GHOSTTY "$LOCK"
git commit -m "chore: project scaffolding for ts-libghostty"
```

---

## Task 2: Pin Ghostty and build `libghostty-vt.dylib`

**Files:**
- Create: `scripts/build-libghostty.sh`
- Modify: `package.json` (set `ghostty.commit`), `LICENSE_GHOSTTY` (replace with upstream text)
- Create: `prebuilds/darwin-arm64/` (directory)

This task picks the Ghostty commit the pass is bound to and produces the prebuilt dylib consumed by all later tasks.

- [ ] **Step 1: Pick the Ghostty commit (do not skip)**

Choose a specific commit SHA — not "tip of main." The commit must:

1. Have `include/ghostty/vt.h` and expose `libghostty-vt` as a Zig build target (both present on any recent `main` commit).
2. Be reproducible by SHA — browsing `main` at plan-execution time is fine for choosing, but record the exact SHA.

Capture the choice:

```bash
# Example — replace with your chosen SHA. MUST be a full 40-char commit.
CHOSEN="abcdef0123456789abcdef0123456789abcdef01"
bun -e "const j=await Bun.file('package.json').json(); j.ghostty={commit:process.env.C}; await Bun.write('package.json', JSON.stringify(j,null,2)+'\\n');" C=$CHOSEN
```

Verify:

```bash
bun -e 'console.log((await Bun.file("package.json").json()).ghostty.commit)'
# Expected: prints the exact 40-char SHA you chose.
```

This SHA drives Task 3's ABI discovery and every downstream reference. **Do not change it after Task 3 runs without re-running the ABI discovery pass.**

Update `package.json`:

```json
"ghostty": {
  "commit": "<full-40-char-sha>"
}
```

- [ ] **Step 2: Write `scripts/build-libghostty.sh`**

Contents:

```bash
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

# Build libghostty-vt.
# NOTE: Verify the exact build target with `zig build --help` inside vendor/ghostty
# on the pinned commit. The name below is the current target at recent commits;
# update if upstream renames it.
cd vendor/ghostty
zig build libghostty-vt -Doptimize=ReleaseFast
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
```

Make it executable:

```bash
chmod +x scripts/build-libghostty.sh
```

- [ ] **Step 3: Run the build**

```bash
bun run build:libghostty
```

Expected: Ghostty cloned to `vendor/ghostty`, zig build runs (takes minutes on first run), `prebuilds/darwin-arm64/libghostty-vt.dylib` exists, `LICENSE_GHOSTTY` updated with upstream MIT text.

Verify:

```bash
file prebuilds/darwin-arm64/libghostty-vt.dylib
# Expected: Mach-O 64-bit dynamically linked shared library arm64

head -1 LICENSE_GHOSTTY
# Expected: "MIT License" or the upstream copyright line (should NOT be TASK_2_REPLACE_WITH_UPSTREAM)
```

- [ ] **Step 4: Commit**

The dylib is gitignored; only the LICENSE_GHOSTTY and build script change under git.

```bash
git add scripts/build-libghostty.sh LICENSE_GHOSTTY package.json
git commit -m "build: pin Ghostty commit and add libghostty-vt build script"
```

---

## Task 3: ABI discovery (pinned-commit reference)

**Files:**
- Create: `docs/abi/2026-04-22-abi-discovery.md`

This task reads the pinned Ghostty headers and produces a checked-in reference document enumerating exactly what the binding depends on. **Every subsequent task consumes this document; later tasks must not guess at C signatures, struct fields, enum names, or ownership rules.**

No code is written in this task. It produces prose + tables that unblock Tasks 4–17.

- [ ] **Step 1: Verify the pin is in place**

```bash
bun -e 'const c=(await Bun.file("package.json").json()).ghostty.commit; if (!/^[0-9a-f]{40}$/.test(c)) { console.error("package.json ghostty.commit is not a 40-char SHA"); process.exit(1); } console.log("pinned:", c);'
# Expected: "pinned: <40-char SHA>"
```

Also verify `vendor/ghostty` is at that SHA:

```bash
(cd vendor/ghostty && git rev-parse HEAD)
# Expected: same SHA as above
```

If either check fails, re-run Task 2.

- [ ] **Step 2: Enumerate header files and top-level symbols**

```bash
find vendor/ghostty/include/ghostty -name '*.h' -print | sort > .tmp/abi-headers.txt
grep -hE '^\s*ghostty_[A-Za-z0-9_]+\s*\(' vendor/ghostty/include -r | sort -u > .tmp/abi-symbol-decls.txt || true
# Also capture a more structured function-declaration listing. This filters to
# lines that look like complete declarations ending in `);`.
grep -hE '\bghostty_[A-Za-z0-9_]+\s*\([^;]*\)\s*(__attribute__[^;]*)?;' vendor/ghostty/include -r | sort -u > .tmp/abi-symbol-funcs.txt
wc -l .tmp/abi-headers.txt .tmp/abi-symbol-decls.txt .tmp/abi-symbol-funcs.txt
```

These counts are informational; they give the executor a sense of how much surface exists. Used to hand-write the reference doc in Step 3.

- [ ] **Step 3: Write `docs/abi/2026-04-22-abi-discovery.md`**

The document answers every question below. If a question has no answer at the pin, record "NOT EXPOSED AT PIN" — this is a valid finding and downstream tasks handle it.

Use this template:

```markdown
# ts-libghostty ABI discovery

**Pinned commit:** <SHA>
**Date:** 2026-04-22
**Headers scanned:** see `.tmp/abi-headers.txt`

## 1. Build target

- Exact zig build target name: `<e.g. libghostty-vt>`
- Exact output path: `<e.g. zig-out/lib/libghostty-vt.dylib>`
- Any required build flags: `<e.g. -Doptimize=ReleaseFast>`

## 2. Build identity / commit

Does libghostty expose its build commit via a C API? Look for `ghostty_build_info_*` or similar. Record:

- Function name (if any): `<e.g. ghostty_build_info_new>`
- Return shape: `<e.g. struct with commit_sha, version fields>`
- **If not exposed:** record "NOT EXPOSED AT PIN." Binding will narrow the compatibility guarantee accordingly.

## 3. GhosttyResult enum

| Name | Value |
|---|---|
| GHOSTTY_RESULT_OK | 0 |
| … | … |

## 4. GhosttyTerminal functions

For each function the binding calls, record exact C signature:

| Symbol | Signature |
|---|---|
| ghostty_terminal_new | `GhosttyResult ghostty_terminal_new(GhosttyAllocator* allocator, const GhosttyTerminalOptions* opts, GhosttyTerminal** out)` |
| ghostty_terminal_free | `void ghostty_terminal_free(GhosttyTerminal* term)` |
| ghostty_terminal_vt_write | `GhosttyResult ghostty_terminal_vt_write(GhosttyTerminal* term, const uint8_t* bytes, size_t len)` |
| ghostty_terminal_reset | `<exact signature>` |
| ghostty_terminal_resize | `<exact signature>` |
| ghostty_terminal_get_multi | `<exact signature — this is the trickiest, watch for the union value shape>` |
| ghostty_terminal_mode_get | `<exact signature>` |
| ghostty_terminal_mode_set | `<exact signature>` |

**ghostty_terminal_get_multi details** — since this drives `Terminal.snapshot()`, describe the full shape:

- Keys array element type: `<e.g. uint32_t (GhosttyTerminalGetKey enum)>`
- Values array element type: `<struct GhosttyTerminalGetValue with discriminated union, or per-key out param, etc.>`
- Sizeof one value slot: `<bytes>`
- String representation: `{ptr; len}` pair, separate out-param, or allocator-returned buffer?
- Does the caller free string values, or do they alias into the terminal until next mutating call?

## 5. GhosttyTerminalOptions struct

| Field name | C type | Offset (from probe) | Size | Kind (uint/int/bool/ptr) |
|---|---|---|---|---|
| cols | … | 0 | 4 | uint |
| rows | … | 4 | 4 | uint |
| max_scrollback | … | 8 | 4 | uint |
| apc_max_bytes | … | ? | ? | ? |
| apc_max_bytes_kitty | … | ? | ? | ? |
| … | … | … | … | … |

Sized-struct convention: **yes/no** (does the first field declare `size = sizeof(GhosttyTerminalOptions)`?)

## 6. GhosttyFormatter functions

| Symbol | Signature |
|---|---|
| ghostty_formatter_new | `<exact signature>` |
| ghostty_formatter_free | `<exact signature>` |
| ghostty_formatter_format | `<exact signature — in particular, who owns the returned buffer?>` |

**Output ownership:** who allocates the output buffer? Does the caller free via `ghostty_free`? Is there a separate `ghostty_formatter_output_free`? Record precisely — `Formatter.format()` depends on this.

## 7. GhosttyFormatterOptions struct

| Field name | C type | Offset | Size | Kind |
|---|---|---|---|---|
| … | … | … | … | … |

Sized-struct convention: yes/no. If sized, the struct writer auto-fills `size`.

How is the format (plain/vt/html) selected? Via:
- (a) a field in `GhosttyFormatterOptions`, or
- (b) a separate argument to `ghostty_formatter_new` (e.g. `GhosttyFormatterTag`)?

## 8. ModeTag enum

All `GHOSTTY_MODE_*` entries with their values. Also record the **exact prefix** — if upstream uses `GHOSTTY_MODE_TAG_` or something else, note it. The generator's name-stripping logic depends on this.

| Name | Value | TS ModeName (stripped + lowercased) |
|---|---|---|
| GHOSTTY_MODE_BRACKETED_PASTE | 42 | "bracketed_paste" |
| … | … | … |

## 9. GhosttyTerminalGetKey enum (for get_multi)

| Name | Value | Snapshot field | Value kind (u32/bool/string/...) |
|---|---|---|---|
| … | … | … | … |

List every key the Pass 1 snapshot needs. If a key is missing at the pin, record "NOT AT PIN" and the snapshot implementation returns the field as undefined.

## 10. GhosttyFormatterTag enum (if applicable)

| Name | Value |
|---|---|
| … | … |

## 11. Allocator protocol

- `ghostty_alloc` signature: `<...>`
- `ghostty_free` signature: `<...>`
- Is passing `NULL` for the allocator legal? What does it mean? (Typically: use default / libc malloc.)

## 12. Summary of surprises

Anything discovered that contradicts this plan's current assumptions. Examples:
- "Formatter uses sized-struct convention — writer must auto-write size field" / "does not"
- "TerminalOptions does not expose apc_max_bytes at this pin — Pass 1 ships with the default and documents limitation" / "exposes them as `apc_max_bytes_*`"
- "Title and pwd are alias pointers invalidated on next mutating call; snapshot must copy them immediately" / "…"
- "get_multi values are returned in a caller-allocated buffer where each slot is 24 bytes (u64 kind + 16-byte payload)"

Each surprise triggers one of three outcomes: (a) update the plan snippet in the corresponding task, (b) narrow Pass 1 scope by deferring that feature, or (c) proceed as planned because the assumption matched.
```

- [ ] **Step 4: Cross-reference surprises back into the plan**

For each surprise recorded in §12 of the discovery doc that requires a snippet change, edit the relevant plan task before executing it. This is the "plan lock" step — the plan and the discovery doc are now consistent.

Examples of what might change:

- Task 4 generator: `ModeTag` prefix is `GHOSTTY_MODE_TAG_` (not `GHOSTTY_MODE_`) → update `modeTagFromName`.
- Task 4 generator: `GhosttyResult` values are non-contiguous or hex → generator's `parseEnums` still works but verify.
- Task 5 probe: `GhosttyTerminalOptions` lacks `apc_max_bytes` → Task 11's constructor skips those fields; Pass 1 README notes that APC bounds use upstream default.
- Task 8 FFI: `ghostty_terminal_get_multi` takes a `GhosttyTerminalGetValue*` union array (not a flat byte buffer) → Task 14 snapshot rewrites accordingly.
- Task 8 FFI: `ghostty_formatter_new` takes `(tag, &options, &out)` (not `(allocator, &options, &out)`) → Task 16 `Formatter` constructor adjusts.
- Task 7 FFI: build identity is exposed via `ghostty_build_info_*` → wire into `libraryInfo()` and populate `LibraryCompatibilityError.actualCommit`. Otherwise narrow the claim in Task 21 README.

- [ ] **Step 5: Commit**

```bash
git add docs/abi/2026-04-22-abi-discovery.md
git commit -m "docs: ABI discovery for pinned Ghostty commit

Records exact C signatures, struct layouts, enum names, and ownership
rules the binding depends on. Subsequent tasks consume this doc rather
than guessing."
```

If any plan snippets were updated in Step 4, also commit those changes to the plan:

```bash
git add docs/superpowers/plans/2026-04-22-ts-libghostty-pass-1.md
git commit -m "plan: reconcile Pass 1 snippets with ABI discovery findings"
```

---

## Task 4: Struct-layout probe

**Files:**
- Create: `scripts/probe-layout.c`
- Create: `.tmp/` (implicitly via the build script; not committed)

The probe is a tiny C program compiled against Ghostty's headers that emits struct sizes/alignments/offsets as JSON. This is the authoritative source for layout at runtime — no regex-parsing struct definitions in TypeScript.

- [ ] **Step 1: Write `scripts/probe-layout.c`**

The probe covers every struct the binding writes or reads in Pass 1. Per ABI discovery §5 and §7, at Pass 1 that is:

- `GhosttyTerminalOptions` (for `Terminal` construction)
- `GhosttyFormatterOptions` (for `Formatter` construction)

Exact field lists come from ABI discovery (Task 3). Struct *names* may differ at the pin (some versions use suffixes); reconcile before writing the probe.

Each probed field emits: name, offset, size, **kind** (`"uint"`, `"int"`, `"bool"`, `"ptr"`, `"struct"`). The kind disambiguates fields of the same size at marshal time — e.g., a 1-byte `bool` vs. a 1-byte `uint8_t`. Each struct emits an **`isSized`** flag: true if the first field is literally `size_t size`, false otherwise. The TS-side struct writer (Task 9) auto-fills the `size` field when `isSized` is true.

Contents:

```c
/*
 * ts-libghostty struct-layout probe.
 * Compiled against the pinned Ghostty headers; emits JSON describing the
 * ABI of every struct the binding writes or reads.
 *
 * To add a struct: add a new probe_struct_<name>() function that prints one
 * JSON object into the array, then call it from main(). For each field use
 * the emit_field_<kind>() helper matching the C type.
 */
#include <stdio.h>
#include <stddef.h>
#include <stdint.h>
#include <stdbool.h>
#include <string.h>

#include "ghostty/vt.h"

static int first_entry = 1;

static void begin_entry(void) {
  if (!first_entry) printf(",\n");
  first_entry = 0;
}

static void emit_struct(const char *name, size_t size, size_t align, int is_sized) {
  begin_entry();
  printf("  {\n");
  printf("    \"name\": \"%s\",\n", name);
  printf("    \"size\": %zu,\n", size);
  printf("    \"align\": %zu,\n", align);
  printf("    \"isSized\": %s,\n", is_sized ? "true" : "false");
  printf("    \"fields\": [");
}

static int first_field;

static void emit_field(const char *name, size_t offset, size_t size, const char *kind) {
  if (!first_field) printf(",");
  first_field = 0;
  printf("\n      {\"name\": \"%s\", \"offset\": %zu, \"size\": %zu, \"kind\": \"%s\"}",
         name, offset, size, kind);
}

#define EMIT_UINT(S, F)   emit_field(#F, offsetof(S, F), sizeof(((S*)0)->F), "uint")
#define EMIT_INT(S, F)    emit_field(#F, offsetof(S, F), sizeof(((S*)0)->F), "int")
#define EMIT_BOOL(S, F)   emit_field(#F, offsetof(S, F), sizeof(((S*)0)->F), "bool")
#define EMIT_PTR(S, F)    emit_field(#F, offsetof(S, F), sizeof(((S*)0)->F), "ptr")
#define EMIT_STRUCT(S, F) emit_field(#F, offsetof(S, F), sizeof(((S*)0)->F), "struct")

static void end_struct(void) {
  printf("\n    ]\n  }");
}

/* ===== Probe each struct ===== */

static void probe_terminal_options(void) {
  /* FIELD LIST is authored from ABI discovery §5. Update per the pinned header.
   * `isSized` detection: if the first field at offset 0 is literally `size_t size`,
   * pass 1 as the fourth argument below. */
  const int is_sized = (offsetof(GhosttyTerminalOptions, size) == 0 &&
                        sizeof(((GhosttyTerminalOptions*)0)->size) == sizeof(size_t));
  emit_struct("GhosttyTerminalOptions",
              sizeof(GhosttyTerminalOptions),
              _Alignof(GhosttyTerminalOptions),
              is_sized);
  first_field = 1;
  /* If is_sized, emit the size field first. */
  if (is_sized) EMIT_UINT(GhosttyTerminalOptions, size);
  EMIT_UINT(GhosttyTerminalOptions, cols);
  EMIT_UINT(GhosttyTerminalOptions, rows);
  EMIT_UINT(GhosttyTerminalOptions, max_scrollback);
  /* If ABI discovery §5 shows apc_max_bytes / apc_max_bytes_kitty at the pin,
   * uncomment these lines and the constructor in Task 11 will wire them.
   * EMIT_UINT(GhosttyTerminalOptions, apc_max_bytes);
   * EMIT_UINT(GhosttyTerminalOptions, apc_max_bytes_kitty); */
  end_struct();
}

static void probe_formatter_options(void) {
  /* FIELD LIST is authored from ABI discovery §7. */
  const int is_sized = (offsetof(GhosttyFormatterOptions, size) == 0 &&
                        sizeof(((GhosttyFormatterOptions*)0)->size) == sizeof(size_t));
  emit_struct("GhosttyFormatterOptions",
              sizeof(GhosttyFormatterOptions),
              _Alignof(GhosttyFormatterOptions),
              is_sized);
  first_field = 1;
  if (is_sized) EMIT_UINT(GhosttyFormatterOptions, size);
  /* Executor: enumerate fields from the pinned header per ABI discovery §7.
   * For each bool-typed flag use EMIT_BOOL; for enum-typed format-tag fields
   * use EMIT_UINT. */
  end_struct();
}

int main(void) {
  printf("{\n  \"structs\": [\n");
  probe_terminal_options();
  probe_formatter_options();
  printf("\n  ]\n}\n");
  return 0;
}
```

**Note for executor:** `isSized` detection via `offsetof(S, size)` compiles only when the struct has a `size` member. If the struct at the pin does *not* have a `size` member, replace the guard with `const int is_sized = 0;`. ABI discovery §5 / §7 tells you which case applies.

- [ ] **Step 2: Run the probe**

```bash
mkdir -p .tmp
bun run build:probe
```

Expected: `.tmp/layout.json` exists and contains a JSON object with a `structs` array. Verify it parses:

```bash
bun -e 'console.log(JSON.parse(await Bun.file(".tmp/layout.json").text()))'
```

Expected: prints the parsed object with two struct entries.

- [ ] **Step 3: Commit**

```bash
git add scripts/probe-layout.c package.json
git commit -m "build: struct-layout probe for native ABI"
```

---

## Task 5: Bindings generator

**Files:**
- Create: `scripts/gen-bindings.ts`, `src/internal/generated.ts`

The generator parses Ghostty headers for enum values and a *declared* symbol list, merges the probe output for struct layout, and emits a checked-in `src/internal/generated.ts`. It produces the following artifacts, all backed by the ABI discovery findings in `docs/abi/2026-04-22-abi-discovery.md`:

- `pinnedCommit` — string constant.
- `declaredHeaderSymbols` — every `ghostty_*(` declaration found in headers (diagnostic only).
- `structLayouts` — from probe JSON: size, align, per-field offset+size+kind, and an `isSized` flag.
- Per-enum `...Values` maps (e.g., `GhosttyResultValues`, `ModeTagValues`).
- `resultCodeByValue` — reverse map from `GhosttyResult` numeric value to TypeScript error-code string.
- `modeNames` — `readonly string[]` of the TS-facing names (e.g., `"bracketed_paste"`), derived from `ModeTag` by stripping the upstream prefix (recorded in ABI discovery §8) and lowercasing.
- `ModeName` type alias — `typeof modeNames[number]` — giving consumers a real string-literal union.
- `modeTagByName` — `Record<ModeName, number>` for runtime lookup.
- `terminalGetKeyByName` — if the ABI discovery §9 enumerates the get-key enum, the generator emits a map from snapshot-field name to numeric key.
- `formatterTagByName` — if the ABI discovery §10 indicates a tag enum exists, mapped by format name ("plain"/"vt"/"html").

The runtime binding (`src/ffi.ts`) exports a separate `requiredSymbols` constant — the exact list of symbols `dlopen()` declares. The ABI smoke test (Task 18) asserts `requiredSymbols ⊆ declaredHeaderSymbols`. These two lists are never conflated.

- [ ] **Step 1: Write `scripts/gen-bindings.ts`**

Contents:

```typescript
/*
 * Parses Ghostty headers for enum values and declared function symbols,
 * merges .tmp/layout.json (from probe-layout.c), and emits
 * src/internal/generated.ts.
 *
 * The generator rejects enum values it cannot resolve to a concrete integer
 * (expressions, references to other enums, etc.). If rejection occurs for an
 * enum the binding depends on, extend the parser or move that enum to the
 * compiler-backed probe in Task 4.
 */
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

const ROOT = process.cwd();
const HEADER_DIR = join(ROOT, "vendor/ghostty/include/ghostty");
const PROBE_PATH = join(ROOT, ".tmp/layout.json");
const OUT_DIR = join(ROOT, "src/internal");
const OUT_PATH = join(OUT_DIR, "generated.ts");

// --- Probe input shape (matches probe-layout.c output) ---------------------
interface ProbeField {
  name: string;
  offset: number;
  size: number;
  kind: "uint" | "int" | "bool" | "ptr" | "struct";
}
interface ProbeStruct {
  name: string;
  size: number;
  align: number;
  isSized: boolean;                        // true when the first field is a `size_t size`
  fields: ProbeField[];
}

// --- Helpers ---------------------------------------------------------------
async function readAllHeaders(): Promise<string> {
  const acc: string[] = [];
  async function walk(dir: string) {
    for (const entry of await readdir(dir)) {
      const p = join(dir, entry);
      const s = await stat(p);
      if (s.isDirectory()) await walk(p);
      else if (p.endsWith(".h")) acc.push(await readFile(p, "utf8"));
    }
  }
  await walk(HEADER_DIR);
  return acc.join("\n");
}

function stripCommentsAndDirectives(src: string): string {
  // Strip /*...*/ block comments, // line comments, and #-directives (cheap approximation).
  return src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^\s*#[^\n]*$/gm, "")
    .replace(/\/\/[^\n]*/g, "");
}

// Parse an enum body into concrete {name, value} entries.
// Throws on any value we cannot resolve (expression, non-numeric, reference).
function parseEnumBody(tag: string, body: string): Array<{ name: string; value: number }> {
  const entries: Array<{ name: string; value: number }> = [];
  let implicit = 0;
  for (const rawLine of body.split(",")) {
    const line = rawLine.trim();
    if (!line) continue;
    const eq = line.indexOf("=");
    if (eq >= 0) {
      const name = line.slice(0, eq).trim();
      const valueText = line.slice(eq + 1).trim();
      let value: number;
      if (/^0x[0-9a-fA-F]+$/.test(valueText))      value = Number.parseInt(valueText, 16);
      else if (/^-?\d+$/.test(valueText))          value = Number.parseInt(valueText, 10);
      else {
        throw new Error(
          `enum ${tag}: cannot resolve value for ${name} = "${valueText}" ` +
          `— extend the parser or move this enum to the probe`,
        );
      }
      entries.push({ name, value });
      implicit = value + 1;
    } else {
      entries.push({ name: line, value: implicit });
      implicit += 1;
    }
  }
  return entries;
}

function parseEnums(src: string): Map<string, Array<{ name: string; value: number }>> {
  const clean = stripCommentsAndDirectives(src);
  const out = new Map<string, Array<{ name: string; value: number }>>();
  const enumRe =
    /typedef\s+enum\s*(?:\w+\s*)?\{([^}]*)\}\s*(\w+)\s*;|enum\s+(\w+)\s*\{([^}]*)\}\s*;/g;
  let m: RegExpExecArray | null;
  while ((m = enumRe.exec(clean)) !== null) {
    const tag = (m[2] ?? m[3]) as string;
    const body = (m[1] ?? m[4]) as string;
    if (!tag || !body) continue;
    out.set(tag, parseEnumBody(tag, body));
  }
  return out;
}

// Parse function declarations (not call-sites / comments / macros).
// Pattern: a return type, then `ghostty_xxx(... );` on one statement.
function parseDeclaredSymbols(src: string): string[] {
  const clean = stripCommentsAndDirectives(src);
  const out = new Set<string>();
  const re = /\b(ghostty_[A-Za-z0-9_]+)\s*\([^;{]*?\)\s*(?:__attribute__[^;]*)?;/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(clean)) !== null) {
    const name = m[1];
    if (name) out.add(name);
  }
  return [...out].sort();
}

// --- Prefix-aware mode-name generation -------------------------------------
// The upstream ModeTag prefix is recorded in docs/abi/2026-04-22-abi-discovery.md §8.
// Update this constant if upstream changes the prefix.
const MODE_TAG_PREFIX = "GHOSTTY_MODE_";

function derivedModeNames(modeTagEntries: Array<{ name: string; value: number }>) {
  return modeTagEntries
    .filter((e) => e.name.startsWith(MODE_TAG_PREFIX))
    .map((e) => ({
      tsName: e.name.slice(MODE_TAG_PREFIX.length).toLowerCase(),
      cName: e.name,
      value: e.value,
    }))
    .sort((a, b) => a.tsName.localeCompare(b.tsName));
}

// --- GhosttyResult → TS error code mapping ---------------------------------
// Hand-authored central table: each GhosttyResult C name maps to the TS
// GhosttyErrorCode string union. Names not in this table fall back to "unknown"
// and a warning is printed during generation.
const RESULT_CODE_MAP: Record<string, string> = {
  GHOSTTY_RESULT_OK: "ok",
  GHOSTTY_RESULT_OUT_OF_MEMORY: "out_of_memory",
  GHOSTTY_RESULT_INVALID_ARGUMENT: "invalid_argument",
  GHOSTTY_RESULT_UNINITIALIZED: "uninitialized",
};

// --- Main ------------------------------------------------------------------
async function main() {
  await mkdir(OUT_DIR, { recursive: true });

  const src = await readAllHeaders();
  const enums = parseEnums(src);
  const declaredSymbols = parseDeclaredSymbols(src);
  const probe: { structs: ProbeStruct[] } = JSON.parse(
    await readFile(PROBE_PATH, "utf8"),
  );

  const pkgJson = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8"));
  const pinned = pkgJson.ghostty?.commit ?? "unknown";
  if (!/^[0-9a-f]{40}$/.test(pinned)) {
    throw new Error(`package.json ghostty.commit must be a 40-char SHA, got "${pinned}"`);
  }

  const modeTagEntries = enums.get("ModeTag") ?? enums.get("GhosttyModeTag") ?? [];
  const modeInfo = derivedModeNames(modeTagEntries);
  if (modeInfo.length === 0) {
    console.warn("WARNING: no ModeTag entries found — ModeName union will be empty");
  }

  const resultEntries = enums.get("GhosttyResult") ?? [];
  const resultCodeByValue: Record<number, string> = {};
  for (const e of resultEntries) {
    const code = RESULT_CODE_MAP[e.name];
    if (code === undefined) {
      console.warn(`WARNING: GhosttyResult.${e.name} has no TS mapping — will fall back to "unknown"`);
      resultCodeByValue[e.value] = "unknown";
    } else {
      resultCodeByValue[e.value] = code;
    }
  }

  const out: string[] = [];
  out.push("// GENERATED FILE — do not edit by hand.");
  out.push("// Regenerate with `bun run build:native`.");
  out.push(`// Pinned Ghostty commit: ${pinned}`);
  out.push("");
  out.push(`export const pinnedCommit = ${JSON.stringify(pinned)} as const;`);
  out.push("");

  out.push("// DIAGNOSTIC: every ghostty_* function declared in a pinned header.");
  out.push("// Used by ABI-smoke to assert requiredSymbols ⊆ declaredHeaderSymbols.");
  out.push("export const declaredHeaderSymbols = [");
  for (const name of declaredSymbols) out.push(`  ${JSON.stringify(name)},`);
  out.push("] as const;");
  out.push("");

  out.push("export interface StructField { offset: number; size: number; kind: \"uint\" | \"int\" | \"bool\" | \"ptr\" | \"struct\"; }");
  out.push("export interface StructLayout { size: number; align: number; isSized: boolean; fields: Record<string, StructField>; }");
  out.push("export const structLayouts: Record<string, StructLayout> = {");
  for (const s of probe.structs) {
    out.push(`  ${JSON.stringify(s.name)}: {`);
    out.push(`    size: ${s.size}, align: ${s.align}, isSized: ${s.isSized},`);
    out.push(`    fields: {`);
    for (const f of s.fields) {
      out.push(`      ${JSON.stringify(f.name)}: { offset: ${f.offset}, size: ${f.size}, kind: ${JSON.stringify(f.kind)} },`);
    }
    out.push(`    },`);
    out.push(`  },`);
  }
  out.push("};");
  out.push("");

  for (const [tag, entries] of [...enums.entries()].sort()) {
    out.push(`// enum ${tag}`);
    out.push(`export const ${tag}Values = {`);
    for (const e of entries) out.push(`  ${JSON.stringify(e.name)}: ${e.value},`);
    out.push(`} as const;`);
    out.push("");
  }

  out.push("// GhosttyResult numeric → TS GhosttyErrorCode. Drives checkResult().");
  out.push("export const resultCodeByValue: Record<number, string> = {");
  for (const [v, code] of Object.entries(resultCodeByValue)) {
    out.push(`  ${v}: ${JSON.stringify(code)},`);
  }
  out.push("};");
  out.push("");

  out.push("// ModeTag → TS-facing name mapping.");
  out.push("export const modeNames = [");
  for (const m of modeInfo) out.push(`  ${JSON.stringify(m.tsName)},`);
  out.push("] as const;");
  out.push("export type ModeName = typeof modeNames[number];");
  out.push("export const modeTagByName: Record<ModeName, number> = {");
  for (const m of modeInfo) out.push(`  ${JSON.stringify(m.tsName)}: ${m.value},`);
  out.push("};");
  out.push("");

  // Formatter tag mapping (only if ABI discovery §10 says upstream uses a tag).
  // If the enum does not exist at the pin, emit an empty map — the formatter
  // constructor reads `docs/abi/` and either uses this map or selects format
  // via a field in GhosttyFormatterOptions.
  const formatterTag = enums.get("GhosttyFormatterTag") ?? [];
  out.push("export const formatterTagByName: Record<\"plain\" | \"vt\" | \"html\", number | null> = {");
  const ft = (human: string, cName: string) => {
    const hit = formatterTag.find((e) => e.name === cName);
    return hit ? `${hit.value}` : "null";
  };
  out.push(`  "plain": ${ft("plain", "GHOSTTY_FORMATTER_PLAIN")},`);
  out.push(`  "vt":    ${ft("vt",    "GHOSTTY_FORMATTER_VT")},`);
  out.push(`  "html":  ${ft("html",  "GHOSTTY_FORMATTER_HTML")},`);
  out.push("};");
  out.push("");

  await writeFile(OUT_PATH, out.join("\n") + "\n", "utf8");
  console.log(
    `wrote ${OUT_PATH}: ${declaredSymbols.length} declared symbols, ${enums.size} enums, ${probe.structs.length} structs, ${modeInfo.length} modes`,
  );
}

await main();
```

**Executor note:** The `RESULT_CODE_MAP` and the `MODE_TAG_PREFIX` constant must be reconciled with the ABI discovery doc. If the prefix is not `GHOSTTY_MODE_`, update the constant. If the discovery finds new `GHOSTTY_RESULT_*` entries not in `RESULT_CODE_MAP`, add them (and corresponding `GhosttyErrorCode` values in Task 6).

- [ ] **Step 2: Run the generator**

Prerequisites: Tasks 2–4 must have run (vendor exists, `.tmp/layout.json` exists).

```bash
bun run build:bindings
```

Expected output:

```
wrote .../src/internal/generated.ts: <N> declared symbols, <M> enums, <K> structs, <P> modes
```

If any `WARNING` lines appear, reconcile them with ABI discovery before proceeding.

- [ ] **Step 3: Sanity-check the generated file**

```bash
head -60 src/internal/generated.ts
grep -c 'ghostty_terminal_new\|ghostty_terminal_free\|ghostty_formatter_new\|ghostty_formatter_format' src/internal/generated.ts
# Expected: 4 (each symbol appears exactly once in declaredHeaderSymbols)

bun -e 'const g = await import("./src/internal/generated.js"); console.log({commit: g.pinnedCommit, modes: g.modeNames.length, resultCodes: Object.keys(g.resultCodeByValue).length});'
# Expected: commit is your pinned SHA; modes > 0; resultCodes > 0.
```

If anything is missing, the generator or ABI discovery is wrong — fix before proceeding.

- [ ] **Step 4: Commit**

```bash
git add scripts/gen-bindings.ts src/internal/generated.ts
git commit -m "build: bindings generator — declared symbols, modes, result codes, struct layouts"
```

---

## Task 6: Error hierarchy

**Files:**
- Create: `src/errors.ts`
- Create: `test/smoke/errors.test.ts`

TDD: write tests first, then implement.

- [ ] **Step 1: Write the failing test**

Create `test/smoke/errors.test.ts`:

```typescript
import { describe, expect, it } from "bun:test";
import {
  GhosttyError,
  LibraryNotFoundError,
  UnsupportedPlatformError,
  LibraryCompatibilityError,
  UseAfterCloseError,
} from "../../src/errors.js";

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
```

- [ ] **Step 2: Run the test — verify it fails**

```bash
bun test test/smoke/errors.test.ts
```

Expected: all tests fail (module does not exist).

- [ ] **Step 3: Implement `src/errors.ts`**

Contents:

```typescript
export type GhosttyErrorCode =
  | "ok"
  | "out_of_memory"
  | "invalid_argument"
  | "uninitialized"
  | "library_not_found"
  | "library_incompatible"
  | "unsupported_platform"
  | "use_after_close"
  | "unknown";

export interface GhosttyErrorOptions {
  code: GhosttyErrorCode;
  functionName?: string;
  cause?: unknown;
}

export class GhosttyError extends Error {
  readonly code: GhosttyErrorCode;
  readonly functionName?: string;

  constructor(message: string, opts: GhosttyErrorOptions) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = "GhosttyError";
    this.code = opts.code;
    if (opts.functionName !== undefined) this.functionName = opts.functionName;
  }
}

export class LibraryNotFoundError extends GhosttyError {
  readonly searchedPaths: string[];

  constructor(message: string, opts: { searchedPaths: string[]; cause?: unknown }) {
    super(message, { code: "library_not_found", cause: opts.cause });
    this.name = "LibraryNotFoundError";
    this.searchedPaths = [...opts.searchedPaths];
  }
}

export class UnsupportedPlatformError extends GhosttyError {
  readonly detectedPlatform: string;
  readonly supportedPlatforms: string[];

  constructor(
    message: string,
    opts: { detectedPlatform: string; supportedPlatforms: string[]; cause?: unknown },
  ) {
    super(message, { code: "unsupported_platform", cause: opts.cause });
    this.name = "UnsupportedPlatformError";
    this.detectedPlatform = opts.detectedPlatform;
    this.supportedPlatforms = [...opts.supportedPlatforms];
  }
}

export class LibraryCompatibilityError extends GhosttyError {
  readonly expectedCommit?: string;
  readonly actualCommit?: string;
  readonly details: string;

  constructor(
    message: string,
    opts: { expectedCommit?: string; actualCommit?: string; details: string; cause?: unknown },
  ) {
    super(message, { code: "library_incompatible", cause: opts.cause });
    this.name = "LibraryCompatibilityError";
    if (opts.expectedCommit !== undefined) this.expectedCommit = opts.expectedCommit;
    if (opts.actualCommit !== undefined) this.actualCommit = opts.actualCommit;
    this.details = opts.details;
  }
}

export class UseAfterCloseError extends GhosttyError {
  readonly handleType: string;

  constructor(message: string, opts: { handleType: string; cause?: unknown }) {
    super(message, { code: "use_after_close", cause: opts.cause });
    this.name = "UseAfterCloseError";
    this.handleType = opts.handleType;
  }
}
```

- [ ] **Step 4: Run the test — verify it passes**

```bash
bun test test/smoke/errors.test.ts
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/errors.ts test/smoke/errors.test.ts
git commit -m "feat: error hierarchy (GhosttyError + 4 subclasses)"
```

---

## Task 7: Path resolution

**Files:**
- Create: `src/internal/path.ts`
- Create: `test/smoke/path.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/smoke/path.test.ts`:

```typescript
import { describe, expect, it } from "bun:test";
import { detectPlatform, SUPPORTED_PLATFORMS, resolveLibraryPath } from "../../src/internal/path.js";
import { LibraryNotFoundError, UnsupportedPlatformError } from "../../src/errors.js";

describe("platform detection", () => {
  it("detects current platform as a known string", () => {
    const p = detectPlatform();
    expect(typeof p).toBe("string");
    expect(p).toMatch(/^(darwin|linux|win32)-(arm64|x64)$/);
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
```

- [ ] **Step 2: Run the test — verify it fails**

```bash
bun test test/smoke/path.test.ts
```

Expected: module not found.

- [ ] **Step 3: Implement `src/internal/path.ts`**

Contents:

```typescript
import { existsSync } from "node:fs";
import { join } from "node:path";
import { LibraryNotFoundError, UnsupportedPlatformError } from "../errors.js";

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
```

- [ ] **Step 4: Run the test — verify it passes**

```bash
bun test test/smoke/path.test.ts
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/internal/path.ts test/smoke/path.test.ts
git commit -m "feat: platform detection and library path resolution"
```

---

## Task 8: FFI loader (lazy dlopen + symbol manifest verification)

**Files:**
- Create: `src/ffi.ts`
- Create: `test/smoke/ffi.test.ts`

This task owns the single global library load. It exposes:
- `setLibraryPath(path)` — override bundled path; throws after load.
- `isLoaded()` / `libraryInfo()` — diagnostics, do not trigger load.
- `getLib()` — internal-ish; returns the symbol table, triggers load on first call.

Every declared symbol is resolved up front. A missing symbol throws `LibraryCompatibilityError`.

- [ ] **Step 1: Write the failing test**

Create `test/smoke/ffi.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { join } from "node:path";
import * as ffi from "../../src/ffi.js";
import { LibraryCompatibilityError, LibraryNotFoundError } from "../../src/errors.js";

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
```

- [ ] **Step 2: Run the test — verify it fails**

```bash
bun test test/smoke/ffi.test.ts
```

Expected: module not found.

- [ ] **Step 3: Implement `src/ffi.ts`**

Contents:

```typescript
import { dlopen, FFIType } from "bun:ffi";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { LibraryCompatibilityError, LibraryNotFoundError } from "./errors.js";
import { resolveLibraryPath } from "./internal/path.js";
import { declaredHeaderSymbols, pinnedCommit } from "./internal/generated.js";

// ---- Symbol declarations ---------------------------------------------------
// Every symbol the binding dlopens is declared here with its bun:ffi signature.
// `requiredSymbols` (exported below) mirrors the keys of this object and is
// what Task 18's ABI smoke asserts against declaredHeaderSymbols.
//
// Signatures are taken from docs/abi/2026-04-22-abi-discovery.md §4, §6.
// If any disagrees with the pinned header, update the discovery doc, this
// table, and the probe in Task 4 together — not independently.

const SYMBOLS = {
  ghostty_terminal_new: {
    args: [FFIType.ptr, FFIType.ptr],   // (allocator_or_null, &options_struct) → GhosttyTerminal*
    returns: FFIType.ptr,
  },
  ghostty_terminal_free: {
    args: [FFIType.ptr],
    returns: FFIType.void,
  },
  ghostty_terminal_vt_write: {
    args: [FFIType.ptr, FFIType.ptr, FFIType.u64],   // (term, bytes, len)
    returns: FFIType.u32,                            // GhosttyResult
  },
  ghostty_terminal_reset: {
    args: [FFIType.ptr],
    returns: FFIType.u32,
  },
  ghostty_terminal_resize: {
    args: [FFIType.ptr, FFIType.u32, FFIType.u32],   // (term, cols, rows)
    returns: FFIType.u32,
  },
  ghostty_terminal_get_multi: {
    args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u64],  // (term, keys[], values[], count)
    returns: FFIType.u32,
  },
  ghostty_terminal_mode_get: {
    args: [FFIType.ptr, FFIType.u32],                // (term, mode_tag)
    returns: FFIType.bool,
  },
  ghostty_terminal_mode_set: {
    args: [FFIType.ptr, FFIType.u32, FFIType.bool],  // (term, mode_tag, value)
    returns: FFIType.u32,
  },
  ghostty_formatter_new: {
    args: [FFIType.ptr, FFIType.ptr, FFIType.ptr],   // (allocator, &options, &out)
    returns: FFIType.u32,
  },
  ghostty_formatter_free: {
    args: [FFIType.ptr],
    returns: FFIType.void,
  },
  ghostty_formatter_format: {
    args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr],  // (fmt, term, &buf, &len)
    returns: FFIType.u32,
  },
  ghostty_alloc: {
    args: [FFIType.ptr, FFIType.u64],
    returns: FFIType.ptr,
  },
  ghostty_free: {
    args: [FFIType.ptr, FFIType.ptr, FFIType.u64],
    returns: FFIType.void,
  },
} as const;

type Symbols = typeof SYMBOLS;
type DlopenResult = {
  symbols: { [K in keyof Symbols]: (...args: any[]) => any };
  close: () => void;
};

/** The exact list of symbols this binding dlopens. Exported so Task 18 can assert
 *  requiredSymbols ⊆ declaredHeaderSymbols without duplicating the list. */
export const requiredSymbols = Object.keys(SYMBOLS) as readonly (keyof Symbols)[];

// ---- State -----------------------------------------------------------------

let overridePath: string | undefined;
let loaded: DlopenResult | null = null;
let loadedPath: string | null = null;
let loadedIdentity: string | null = null;   // actual build identity if exposed by C

// ---- Public API ------------------------------------------------------------

/** Override the library path. Must be called before first native use. */
export function setLibraryPath(path: string): void {
  if (loaded) {
    throw new LibraryCompatibilityError(
      `setLibraryPath called after library already loaded from ${loadedPath}`,
      {
        details: `already loaded from ${loadedPath}`,
        expectedCommit: pinnedCommit,
      },
    );
  }
  overridePath = path;
}

/** Whether the library has been opened. Does not trigger load. */
export function isLoaded(): boolean {
  return loaded !== null;
}

export interface LibraryInfo {
  loaded: boolean;
  path: string | null;
  pinnedCommit: string;
  /**
   * The loaded library's own build identity (commit/version) if upstream
   * exposes it via C. `null` when not loaded or when upstream does not
   * expose identity at this pin — in which case compatibility verification
   * is limited to symbol + struct layout matching.
   */
  actualIdentity: string | null;
}

/** Cheap diagnostics — does not trigger load. */
export function libraryInfo(): LibraryInfo {
  return {
    loaded: loaded !== null,
    path: loadedPath,
    pinnedCommit,
    actualIdentity: loadedIdentity,
  };
}

/**
 * Get (and lazily load) the symbol table. First call resolves the library
 * path, opens it via dlopen declaring requiredSymbols, verifies every one
 * resolves, and (if upstream exposes build_info) verifies identity matches
 * the pinned commit.
 */
export function getLib(): DlopenResult {
  if (loaded) return loaded;

  const packageRoot = resolvePackageRoot();
  const path = resolveLibraryPath({
    override: overridePath,
    env: process.env["GHOSTTY_VT_LIB"],
    packageRoot,
  });
  // resolveLibraryPath already threw LibraryNotFoundError / UnsupportedPlatformError
  // if the file is missing; we need not re-check existsSync here.

  let opened: DlopenResult;
  try {
    opened = dlopen(path, SYMBOLS) as DlopenResult;
  } catch (e) {
    const msg = (e as Error).message ?? String(e);
    throw new LibraryCompatibilityError(
      `Failed to open ${path}: ${msg}`,
      {
        details: msg,
        expectedCommit: pinnedCommit,
        cause: e,
      },
    );
  }

  // Verify every required symbol is present. bun:ffi's dlopen can silently
  // produce null function pointers for absent symbols on some platforms;
  // this loop gives us a clear error pointing at the specific symbol.
  const missing: string[] = [];
  for (const name of requiredSymbols) {
    if (typeof (opened.symbols as any)[name] !== "function") missing.push(name as string);
  }
  if (missing.length > 0) {
    opened.close();
    throw new LibraryCompatibilityError(
      `Library at ${path} is missing ${missing.length} required symbols`,
      {
        details: `missing: ${missing.slice(0, 10).join(", ")}${missing.length > 10 ? ", ..." : ""}`,
        expectedCommit: pinnedCommit,
      },
    );
  }

  // Build-identity check. Wired here if ABI discovery §2 says upstream exposes
  // `ghostty_build_info_*` or equivalent. If NOT exposed, `loadedIdentity`
  // remains null and we document the weaker guarantee in the README (Task 21).
  //
  // Executor: if build_info IS available at the pin, expand the SYMBOLS table
  // with the build_info getters, add them to requiredSymbols, and populate
  // loadedIdentity below. The current stub leaves it null — a valid outcome
  // when upstream doesn't expose identity yet.
  loadedIdentity = null;

  loaded = opened;
  loadedPath = path;
  return loaded;
}

/**
 * @internal test-only hook to simulate fresh process state.
 * WARNING: tests must not call _resetForTest while a Terminal or Formatter
 * handle is open — their #handle pointers become dangling when the dylib
 * is unloaded.
 */
export function _resetForTest(): void {
  if (loaded) loaded.close();
  loaded = null;
  loadedPath = null;
  loadedIdentity = null;
  overridePath = undefined;
}

// ---- Helpers ---------------------------------------------------------------

function resolvePackageRoot(): string {
  // This file is at src/ffi.ts in dev, dist/ffi.js in production.
  // In both cases, package root is two levels up from this file's directory.
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..");
}
```

**Note for executor:** if a symbol's signature in `SYMBOLS` is wrong for the pinned Ghostty commit, `dlopen` will still succeed (it only checks existence), but subsequent calls will crash. Pass 1's ABI smoke test (Task 18) exercises each symbol end-to-end to catch this. Signatures should have been confirmed in Task 3's ABI discovery.

**Note on the two symbol lists:** `declaredHeaderSymbols` (from `src/internal/generated.ts`) is every `ghostty_*` declared in any header — used for diagnostics. `requiredSymbols` (exported from this file) is exactly what the binding dlopens. Every name in `requiredSymbols` must also appear in `declaredHeaderSymbols`. Task 18's ABI smoke enforces this relationship.

- [ ] **Step 4: Run the test — verify it passes**

```bash
bun test test/smoke/ffi.test.ts
```

Expected: all pass. If "missing symbol" errors occur, record the discrepancy and adjust the `SYMBOLS` table in `ffi.ts` to match the pinned header.

- [ ] **Step 5: Commit**

```bash
git add src/ffi.ts test/smoke/ffi.test.ts
git commit -m "feat: lazy FFI loader with symbol-manifest verification"
```

---

## Task 9: Internal helpers — struct marshaling and string helpers

**Files:**
- Create: `src/internal/sized-struct.ts`, `src/internal/marshal.ts`
- Create: `test/smoke/internal-helpers.test.ts` (at `test/smoke/` level, tests both)

- [ ] **Step 1: Write failing tests**

Create `test/smoke/internal-helpers.test.ts`:

```typescript
import { describe, expect, it } from "bun:test";
import { writeStruct } from "../../src/internal/sized-struct.js";
import { readCString, writeCString } from "../../src/internal/marshal.js";

const kind = (k: "uint" | "int" | "bool" | "ptr" | "struct") => k;

describe("writeStruct", () => {
  it("writes a plain (non-sized) struct matching the layout", () => {
    const layout = {
      size: 8,
      align: 4,
      isSized: false,
      fields: {
        a: { offset: 0, size: 4, kind: kind("uint") },
        b: { offset: 4, size: 4, kind: kind("uint") },
      },
    };
    const buf = writeStruct(layout, { a: 0x11223344, b: 0x55667788 });
    expect(buf.byteLength).toBe(8);
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    expect(view.getUint32(0, true)).toBe(0x11223344);
    expect(view.getUint32(4, true)).toBe(0x55667788);
  });

  it("zeros fields not present in input", () => {
    const layout = {
      size: 8, align: 4, isSized: false,
      fields: {
        a: { offset: 0, size: 4, kind: kind("uint") },
        b: { offset: 4, size: 4, kind: kind("uint") },
      },
    };
    const buf = writeStruct(layout, { a: 0xdeadbeef });
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    expect(view.getUint32(0, true)).toBe(0xdeadbeef);
    expect(view.getUint32(4, true)).toBe(0);
  });

  it("writes u8/u16/u32/u64 sizes correctly", () => {
    const layout = {
      size: 16, align: 8, isSized: false,
      fields: {
        a: { offset: 0, size: 1, kind: kind("uint") },
        b: { offset: 2, size: 2, kind: kind("uint") },
        c: { offset: 4, size: 4, kind: kind("uint") },
        d: { offset: 8, size: 8, kind: kind("uint") },
      },
    };
    const buf = writeStruct(layout, { a: 0x12, b: 0x3456, c: 0x789abcde, d: 0x1122334455667788n });
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    expect(view.getUint8(0)).toBe(0x12);
    expect(view.getUint16(2, true)).toBe(0x3456);
    expect(view.getUint32(4, true)).toBe(0x789abcde);
    expect(view.getBigUint64(8, true)).toBe(0x1122334455667788n);
  });

  it("writes bool fields as 0/1 based on the kind", () => {
    const layout = {
      size: 1, align: 1, isSized: false,
      fields: { flag: { offset: 0, size: 1, kind: kind("bool") } },
    };
    expect(new DataView(writeStruct(layout, { flag: true  }).buffer).getUint8(0)).toBe(1);
    expect(new DataView(writeStruct(layout, { flag: false }).buffer).getUint8(0)).toBe(0);
  });

  it("sized struct auto-fills the `size` field", () => {
    const layout = {
      size: 16, align: 8, isSized: true,
      fields: {
        size: { offset: 0, size: 8, kind: kind("uint") },
        cols: { offset: 8, size: 4, kind: kind("uint") },
      },
    };
    // User omits `size` — writer should set it to layout.size (16).
    const buf = writeStruct(layout, { cols: 80 });
    const view = new DataView(buf.buffer);
    expect(view.getBigUint64(0, true)).toBe(16n);
    expect(view.getUint32(8, true)).toBe(80);
  });

  it("rejects unsupported field kinds with a clear error", () => {
    const layout = {
      size: 8, align: 8, isSized: false,
      fields: { p: { offset: 0, size: 8, kind: kind("struct") } },
    };
    expect(() => writeStruct(layout, { p: 123 as any })).toThrow(/kind.*struct/i);
  });
});

describe("marshal string helpers", () => {
  it("readCString reads a NUL-terminated string from a Uint8Array", () => {
    const bytes = new Uint8Array([0x68, 0x69, 0x00, 0xff]); // "hi"
    expect(readCString(bytes, 0)).toBe("hi");
  });

  it("readCString with offset", () => {
    const bytes = new Uint8Array([0x00, 0x68, 0x69, 0x00]);
    expect(readCString(bytes, 1)).toBe("hi");
  });

  it("writeCString produces UTF-8 bytes + NUL", () => {
    const buf = writeCString("hi");
    expect(Array.from(buf)).toEqual([0x68, 0x69, 0x00]);
  });

  it("writeCString handles non-ASCII", () => {
    const buf = writeCString("é");
    // é = U+00E9 = 0xC3 0xA9 in UTF-8
    expect(Array.from(buf)).toEqual([0xc3, 0xa9, 0x00]);
  });
});
```

- [ ] **Step 2: Run — verify fail**

```bash
bun test test/smoke/internal-helpers.test.ts
```

Expected: module not found.

- [ ] **Step 3: Implement `src/internal/sized-struct.ts`**

Contents:

```typescript
import type { StructLayout } from "./generated.js";

/**
 * Build a byte buffer matching `layout`. Writes each provided field at its
 * declared offset using the width/kind from the probe. Unsupplied fields
 * default to zero. If the struct is sized (first field is `size_t size`),
 * the writer auto-fills that field with `layout.size` unless the caller
 * explicitly provides a value.
 *
 * Only supports `kind` in {"uint", "int", "bool"} — the kinds Pass 1's
 * option structs actually use. Pointer and nested-struct fields throw to
 * force an explicit design decision at extension time.
 */
export function writeStruct(
  layout: StructLayout,
  fields: Record<string, number | bigint | boolean>,
): Uint8Array {
  const buf = new Uint8Array(layout.size);
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

  for (const [name, spec] of Object.entries(layout.fields)) {
    let raw: number | bigint | boolean | undefined = fields[name];

    // Auto-fill `size` for sized structs if the caller didn't supply it.
    if (raw === undefined && layout.isSized && name === "size") {
      raw = BigInt(layout.size);
    }

    if (raw === undefined) continue;

    if (spec.kind === "ptr" || spec.kind === "struct") {
      throw new Error(
        `writeStruct: field "${name}" has kind "${spec.kind}" which requires explicit handling. ` +
        `Extend writeStruct or wrap this struct in a dedicated helper.`,
      );
    }

    const n =
      typeof raw === "boolean" ? (raw ? 1 : 0)
      : typeof raw === "bigint" ? raw
      : Number(raw);

    switch (spec.size) {
      case 1:
        view.setUint8(spec.offset, (typeof n === "bigint" ? Number(n) : n) & 0xff);
        break;
      case 2:
        view.setUint16(spec.offset, (typeof n === "bigint" ? Number(n) : n) & 0xffff, true);
        break;
      case 4:
        view.setUint32(spec.offset, ((typeof n === "bigint" ? Number(n) : n) >>> 0), true);
        break;
      case 8: {
        const big = typeof n === "bigint" ? n : BigInt(n);
        if (spec.kind === "int") {
          view.setBigInt64(spec.offset, BigInt.asIntN(64, big), true);
        } else {
          view.setBigUint64(spec.offset, BigInt.asUintN(64, big), true);
        }
        break;
      }
      default:
        throw new Error(`writeStruct: unsupported field size ${spec.size} for "${name}"`);
    }
  }

  return buf;
}
```

- [ ] **Step 4: Implement `src/internal/marshal.ts`**

Contents:

```typescript
import { toArrayBuffer, type Pointer } from "bun:ffi";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: false });

/** Read a NUL-terminated UTF-8 string from a Uint8Array starting at `offset`. */
export function readCString(bytes: Uint8Array, offset: number): string {
  let end = offset;
  while (end < bytes.length && bytes[end] !== 0) end++;
  return textDecoder.decode(bytes.subarray(offset, end));
}

/** Encode a JS string as a NUL-terminated UTF-8 byte buffer. */
export function writeCString(s: string): Uint8Array {
  const body = textEncoder.encode(s);
  const buf = new Uint8Array(body.length + 1);
  buf.set(body, 0);
  buf[body.length] = 0;
  return buf;
}

/** Copy bytes from a libghostty-owned pointer into a freshly-allocated Uint8Array. */
export function copyBytesFromPointer(ptr: Pointer, len: number): Uint8Array {
  // Bun's FFI `toArrayBuffer(ptr, offset, length)` returns a view over native
  // memory. Copy immediately into a new buffer so the caller can retain it.
  const view = new Uint8Array(toArrayBuffer(ptr, 0, len));
  const copy = new Uint8Array(len);
  copy.set(view);
  return copy;
}

export type { Pointer };  // re-export bun:ffi's Pointer type for callers
```

- [ ] **Step 5: Run — verify pass**

```bash
bun test test/smoke/internal-helpers.test.ts
```

Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/internal/sized-struct.ts src/internal/marshal.ts test/smoke/internal-helpers.test.ts
git commit -m "feat: internal helpers — struct writer and string marshaling"
```

---

## Task 10: Public types used at Pass 1

**Files:**
- Create: `src/types.ts`
- No tests (pure type definitions; compiled by `tsc` in Task 20).

- [ ] **Step 1: Write `src/types.ts`**

Contents:

```typescript
// Public supporting types used by Pass 1's classes (Terminal, Formatter).
// The full v0 type surface (RenderCell, Key, KittyFlags, etc.) lands in
// later passes.

// ModeName is the generated string-literal union (see src/internal/generated.ts).
// Re-exported here so consumers can import it alongside other types from "ts-libghostty".
export { modeNames, type ModeName } from "./internal/generated.js";

export type RGB = readonly [r: number, g: number, b: number];
export type PaletteIndex = { palette: number };

export type CursorStyle = "block" | "underline" | "bar";
export type MouseTracking = "none" | "x10" | "normal" | "button" | "any";

export interface TerminalOptions {
  cols: number;
  rows: number;
  maxScrollback?: number;
  cellPx?: { width: number; height: number };
  apcMaxBytes?: number;
  apcMaxBytesKitty?: number;
}

export interface TerminalSnapshot {
  cols: number;
  rows: number;
  pixelWidth: number;
  pixelHeight: number;
  cursor: { x: number; y: number; visible: boolean; style: CursorStyle };
  activeScreen: "primary" | "alternate";
  title?: string;
  pwd?: string;
  scrollbackRows: number;
  mouseTracking: MouseTracking;
}

export interface FormatterOptions {
  format: "plain" | "vt" | "html";
  palette?: boolean;
  modes?: boolean;
  scrollingRegion?: boolean;
  tabStops?: boolean;
  pwd?: boolean;
  keyboard?: boolean;
  cursor?: boolean;
  style?: boolean;
  hyperlink?: boolean;
  protection?: boolean;
  charsets?: boolean;
}
```

- [ ] **Step 2: Verify `tsc` accepts the file**

```bash
bun x tsc --noEmit -p tsconfig.json
```

Expected: no output / exit 0.

- [ ] **Step 3: Commit**

```bash
git add src/types.ts
git commit -m "feat: public types for Pass 1 (Terminal, Formatter options)"
```

---

## Task 11: Terminal construction + lifecycle

**Files:**
- Create: `src/terminal.ts` (construction + close + dispose + use-after-close only)
- Create: `test/smoke/terminal.test.ts` (construction/lifecycle subset)

This task lands the skeleton — construction, close, Symbol.dispose, use-after-close enforcement. Methods like `vtWrite`/`resize`/`reset`/`snapshot`/`mode`/`setMode` are stubbed to throw "not implemented" and get filled in by later tasks.

- [ ] **Step 1: Write the failing test**

Create `test/smoke/terminal.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Terminal } from "../../src/terminal.js";
import { UseAfterCloseError } from "../../src/errors.js";
import * as ffi from "../../src/ffi.js";

describe("Terminal lifecycle", () => {
  beforeEach(() => {
    // No need to reset ffi — load is shared across tests in the same process.
  });

  it("constructs with required options", () => {
    using term = new Terminal({ cols: 80, rows: 24 });
    expect(term).toBeDefined();
  });

  it("close() is idempotent", () => {
    const term = new Terminal({ cols: 80, rows: 24 });
    term.close();
    term.close();   // must not throw
  });

  it("Symbol.dispose closes", () => {
    let terminal: Terminal;
    {
      using term = new Terminal({ cols: 80, rows: 24 });
      terminal = term;
    }
    // After the `using` block, the handle is closed. Using it throws.
    expect(() => terminal.vtWrite(new Uint8Array([65]))).toThrow(UseAfterCloseError);
  });

  it("throws UseAfterCloseError on any method after close()", () => {
    const term = new Terminal({ cols: 80, rows: 24 });
    term.close();
    expect(() => term.vtWrite(new Uint8Array([65]))).toThrow(UseAfterCloseError);
    expect(() => term.snapshot()).toThrow(UseAfterCloseError);
    expect(() => term.resize(100, 30)).toThrow(UseAfterCloseError);
    expect(() => term.reset()).toThrow(UseAfterCloseError);
    expect(() => term.mode("bracketed_paste")).toThrow(UseAfterCloseError);
    expect(() => term.setMode("bracketed_paste", true)).toThrow(UseAfterCloseError);
  });

  it("constructor validates cols/rows > 0", () => {
    expect(() => new Terminal({ cols: 0, rows: 24 })).toThrow();
    expect(() => new Terminal({ cols: 80, rows: 0 })).toThrow();
    expect(() => new Terminal({ cols: -1, rows: 24 })).toThrow();
  });
});
```

- [ ] **Step 2: Run — verify fail**

```bash
bun test test/smoke/terminal.test.ts
```

Expected: module not found.

- [ ] **Step 3: Implement `src/terminal.ts`**

Contents:

```typescript
import type { Pointer } from "bun:ffi";
import { getLib } from "./ffi.js";
import { GhosttyError, UseAfterCloseError } from "./errors.js";
import { resultCodeByValue, structLayouts } from "./internal/generated.js";
import { writeStruct } from "./internal/sized-struct.js";
import type {
  ModeName,
  TerminalOptions,
  TerminalSnapshot,
} from "./types.js";

/**
 * Map a GhosttyResult numeric value returned from FFI into either success
 * or a thrown GhosttyError. Uses the generated resultCodeByValue map — no
 * string-substring guessing, no hardcoded numeric value.
 */
export function checkResult(result: number, functionName: string): void {
  const code = resultCodeByValue[result];
  if (code === "ok") return;
  throw new GhosttyError(
    `${functionName} returned non-OK GhosttyResult (code ${result}, mapped to "${code ?? "unknown"}")`,
    { code: (code ?? "unknown") as GhosttyError["code"], functionName },
  );
}

export class Terminal {
  #handle: Pointer | null = null;
  #cellPx: { width: number; height: number };

  constructor(opts: TerminalOptions) {
    if (!Number.isInteger(opts.cols) || opts.cols <= 0) {
      throw new GhosttyError("cols must be a positive integer", {
        code: "invalid_argument",
        functionName: "Terminal.constructor",
      });
    }
    if (!Number.isInteger(opts.rows) || opts.rows <= 0) {
      throw new GhosttyError("rows must be a positive integer", {
        code: "invalid_argument",
        functionName: "Terminal.constructor",
      });
    }

    this.#cellPx = {
      width: opts.cellPx?.width ?? 0,
      height: opts.cellPx?.height ?? 0,
    };

    const lib = getLib();
    const layout = structLayouts["GhosttyTerminalOptions"];
    if (!layout) {
      throw new GhosttyError(
        "generated.ts is missing GhosttyTerminalOptions layout — rerun gen-bindings",
        { code: "unknown", functionName: "Terminal.constructor" },
      );
    }

    // Only include fields that actually exist in the probed layout. Missing
    // fields are ignored silently by writeStruct.
    const fields: Record<string, number | bigint | boolean> = {
      cols: opts.cols,
      rows: opts.rows,
      max_scrollback: opts.maxScrollback ?? 1000,
    };
    if (layout.fields["apc_max_bytes"])
      fields["apc_max_bytes"] = opts.apcMaxBytes ?? (1 << 20);          // 1 MiB
    if (layout.fields["apc_max_bytes_kitty"])
      fields["apc_max_bytes_kitty"] = opts.apcMaxBytesKitty ?? 0;       // disabled

    const optBytes = writeStruct(layout, fields);

    // ghostty_terminal_new(...) signature per ABI discovery §4. The call
    // shape below is (allocator=null, &options) → GhosttyTerminal*. If the
    // actual signature is different (e.g. `(allocator, &options, &out)`),
    // update here and in src/ffi.ts SYMBOLS together.
    const handle = lib.symbols.ghostty_terminal_new(null, optBytes);
    if (!handle) {
      throw new GhosttyError("ghostty_terminal_new returned null", {
        code: "out_of_memory",
        functionName: "ghostty_terminal_new",
      });
    }
    this.#handle = handle;
  }

  /** @internal — for use by other classes in the package (e.g. Formatter). */
  get _handle(): Pointer {
    this.#assertOpen();
    return this.#handle!;
  }

  /** @internal — cellPx used by snapshot() to compute pixel dimensions. */
  get _cellPx(): { width: number; height: number } {
    return this.#cellPx;
  }

  close(): void {
    if (this.#handle === null) return;
    const lib = getLib();
    lib.symbols.ghostty_terminal_free(this.#handle);
    this.#handle = null;
  }

  [Symbol.dispose](): void {
    this.close();
  }

  // ---- Methods stubbed — real implementations in Tasks 12-15 ------------

  vtWrite(_bytes: Uint8Array): void {
    this.#assertOpen();
    throw new Error("Terminal.vtWrite not implemented yet (Task 12)");
  }

  resize(_cols: number, _rows: number, _cellPx?: { width: number; height: number }): void {
    this.#assertOpen();
    throw new Error("Terminal.resize not implemented yet (Task 13)");
  }

  reset(): void {
    this.#assertOpen();
    throw new Error("Terminal.reset not implemented yet (Task 13)");
  }

  snapshot(): TerminalSnapshot {
    this.#assertOpen();
    throw new Error("Terminal.snapshot not implemented yet (Task 14)");
  }

  mode(_name: ModeName): boolean {
    this.#assertOpen();
    throw new Error("Terminal.mode not implemented yet (Task 15)");
  }

  setMode(_name: ModeName, _value: boolean): void {
    this.#assertOpen();
    throw new Error("Terminal.setMode not implemented yet (Task 15)");
  }

  #assertOpen(): void {
    if (this.#handle === null) {
      throw new UseAfterCloseError("Terminal has been closed", {
        handleType: "Terminal",
      });
    }
  }
}
```

**Note for executor:** `checkResult` uses the generated `resultCodeByValue` map, so result-code interpretation is always driven by what the pinned header actually declares. If a result value comes back that isn't in the map, it falls through to `"unknown"` with the numeric value in the message.

- [ ] **Step 4: Run — verify pass**

```bash
bun test test/smoke/terminal.test.ts
```

Expected: all pass. If a stub-method test fails with "not implemented yet" that is still a test failure — ensure tests only exercise lifecycle concerns in this task.

- [ ] **Step 5: Commit**

```bash
git add src/terminal.ts test/smoke/terminal.test.ts
git commit -m "feat(terminal): construction, close, Symbol.dispose, use-after-close"
```

---

## Task 12: Terminal.vtWrite

**Files:**
- Modify: `src/terminal.ts` (implement `vtWrite`)
- Modify: `test/smoke/terminal.test.ts` (add vtWrite tests)

- [ ] **Step 1: Write the failing test (add to existing file)**

Append to `test/smoke/terminal.test.ts`:

```typescript
describe("Terminal.vtWrite", () => {
  it("accepts a Uint8Array and returns void", () => {
    using term = new Terminal({ cols: 80, rows: 24 });
    // "hello\r\n" — plain ASCII, should not throw
    const bytes = new TextEncoder().encode("hello\r\n");
    expect(term.vtWrite(bytes)).toBeUndefined();
  });

  it("accepts an empty Uint8Array", () => {
    using term = new Terminal({ cols: 80, rows: 24 });
    term.vtWrite(new Uint8Array(0));
  });

  it("accepts a long byte stream (1 MiB)", () => {
    using term = new Terminal({ cols: 80, rows: 24 });
    const big = new Uint8Array(1 << 20);
    big.fill(0x41);  // 'A'
    term.vtWrite(big);
  });

  it("throws UseAfterCloseError if called after close", () => {
    const term = new Terminal({ cols: 80, rows: 24 });
    term.close();
    expect(() => term.vtWrite(new Uint8Array([65]))).toThrow(UseAfterCloseError);
  });
});
```

- [ ] **Step 2: Run — verify fail**

```bash
bun test test/smoke/terminal.test.ts
```

Expected: new tests fail with "not implemented yet".

- [ ] **Step 3: Implement**

Replace the `vtWrite` stub in `src/terminal.ts`:

```typescript
  vtWrite(bytes: Uint8Array): void {
    this.#assertOpen();
    if (bytes.length === 0) return;
    const lib = getLib();
    const { ptr } = require("bun:ffi");
    // Pass zero-copy into ghostty_terminal_vt_write(term, bytes, len).
    const result = lib.symbols.ghostty_terminal_vt_write(
      this.#handle,
      ptr(bytes),
      BigInt(bytes.length),
    );
    checkResult(result, "ghostty_terminal_vt_write");
  }
```

- [ ] **Step 4: Run — verify pass**

```bash
bun test test/smoke/terminal.test.ts
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/terminal.ts test/smoke/terminal.test.ts
git commit -m "feat(terminal): vtWrite — zero-copy byte ingestion"
```

---

## Task 13: Terminal.resize + Terminal.reset

**Files:**
- Modify: `src/terminal.ts`, `test/smoke/terminal.test.ts`

- [ ] **Step 1: Write failing tests**

Append to `test/smoke/terminal.test.ts`:

```typescript
describe("Terminal.resize", () => {
  it("accepts new cols/rows and returns void", () => {
    using term = new Terminal({ cols: 80, rows: 24 });
    term.resize(100, 30);
  });

  it("rejects zero or negative dimensions", () => {
    using term = new Terminal({ cols: 80, rows: 24 });
    expect(() => term.resize(0, 30)).toThrow();
    expect(() => term.resize(100, -1)).toThrow();
  });
});

describe("Terminal.reset", () => {
  it("returns void", () => {
    using term = new Terminal({ cols: 80, rows: 24 });
    term.vtWrite(new TextEncoder().encode("hello\r\n"));
    term.reset();
  });
});
```

- [ ] **Step 2: Run — verify fail**

```bash
bun test test/smoke/terminal.test.ts
```

Expected: new tests fail with "not implemented yet".

- [ ] **Step 3: Implement**

Replace stubs in `src/terminal.ts`:

```typescript
  resize(cols: number, rows: number, cellPx?: { width: number; height: number }): void {
    this.#assertOpen();
    if (!Number.isInteger(cols) || cols <= 0) {
      throw new GhosttyError("cols must be a positive integer", {
        code: "invalid_argument",
        functionName: "Terminal.resize",
      });
    }
    if (!Number.isInteger(rows) || rows <= 0) {
      throw new GhosttyError("rows must be a positive integer", {
        code: "invalid_argument",
        functionName: "Terminal.resize",
      });
    }
    if (cellPx !== undefined) {
      this.#cellPx = { width: cellPx.width, height: cellPx.height };
    }
    const lib = getLib();
    const result = lib.symbols.ghostty_terminal_resize(this.#handle, cols, rows);
    checkResult(result, "ghostty_terminal_resize");
  }

  reset(): void {
    this.#assertOpen();
    const lib = getLib();
    const result = lib.symbols.ghostty_terminal_reset(this.#handle);
    checkResult(result, "ghostty_terminal_reset");
  }
```

- [ ] **Step 4: Run — verify pass**

```bash
bun test test/smoke/terminal.test.ts
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/terminal.ts test/smoke/terminal.test.ts
git commit -m "feat(terminal): resize and reset"
```

---

## Task 14: Terminal.snapshot

**Files:**
- Modify: `src/terminal.ts`, `test/smoke/terminal.test.ts`

This wires `ghostty_terminal_get_multi` — a single FFI call to fetch all snapshot fields.

- [ ] **Step 1: Write failing tests**

Append to `test/smoke/terminal.test.ts`:

```typescript
describe("Terminal.snapshot", () => {
  it("returns cols/rows matching construction", () => {
    using term = new Terminal({ cols: 80, rows: 24 });
    const snap = term.snapshot();
    expect(snap.cols).toBe(80);
    expect(snap.rows).toBe(24);
  });

  it("returns cursor at (0,0) initially", () => {
    using term = new Terminal({ cols: 80, rows: 24 });
    const snap = term.snapshot();
    expect(snap.cursor.x).toBe(0);
    expect(snap.cursor.y).toBe(0);
  });

  it("cursor.x advances after writing characters", () => {
    using term = new Terminal({ cols: 80, rows: 24 });
    term.vtWrite(new TextEncoder().encode("hello"));
    const snap = term.snapshot();
    expect(snap.cursor.x).toBe(5);
    expect(snap.cursor.y).toBe(0);
  });

  it("cursor.y advances after CRLF", () => {
    using term = new Terminal({ cols: 80, rows: 24 });
    term.vtWrite(new TextEncoder().encode("hello\r\n"));
    const snap = term.snapshot();
    expect(snap.cursor.x).toBe(0);
    expect(snap.cursor.y).toBe(1);
  });

  it("activeScreen is 'primary' initially", () => {
    using term = new Terminal({ cols: 80, rows: 24 });
    expect(term.snapshot().activeScreen).toBe("primary");
  });

  it("activeScreen switches to 'alternate' on DECSET 1049", () => {
    using term = new Terminal({ cols: 80, rows: 24 });
    // ESC [ ? 1049 h
    term.vtWrite(new Uint8Array([0x1b, 0x5b, 0x3f, 0x31, 0x30, 0x34, 0x39, 0x68]));
    expect(term.snapshot().activeScreen).toBe("alternate");
  });
});
```

- [ ] **Step 2: Run — verify fail**

```bash
bun test test/smoke/terminal.test.ts
```

Expected: new tests fail with "not implemented yet".

- [ ] **Step 3: Implement**

The implementation uses `ghostty_terminal_get_multi`, which takes an array of keys and an array of output slots. Keys are values from the `GhosttyTerminalGetKey` enum (generated; names verified at pin time).

Add a helper at the top of `src/terminal.ts` after imports:

```typescript
// Map of snapshot field name → GhosttyTerminalGetKey enum NAME. Values come
// from GhosttyTerminalGetKeyValues at runtime; names are verified against the
// generated file. If a key is missing from the generated enum, the helper
// will throw a clear error rather than silently returning zero.
import { GhosttyTerminalGetKeyValues } from "./internal/generated.js";

const SNAPSHOT_KEYS: Array<{ name: string; key: keyof typeof GhosttyTerminalGetKeyValues; size: "u32" | "bool" | "string" }> = [
  { name: "cols", key: "GHOSTTY_TERMINAL_GET_COLS" as const, size: "u32" },
  { name: "rows", key: "GHOSTTY_TERMINAL_GET_ROWS" as const, size: "u32" },
  { name: "cursorX", key: "GHOSTTY_TERMINAL_GET_CURSOR_X" as const, size: "u32" },
  { name: "cursorY", key: "GHOSTTY_TERMINAL_GET_CURSOR_Y" as const, size: "u32" },
  { name: "cursorVisible", key: "GHOSTTY_TERMINAL_GET_CURSOR_VISIBLE" as const, size: "bool" },
  { name: "activeScreen", key: "GHOSTTY_TERMINAL_GET_ACTIVE_SCREEN" as const, size: "u32" },
  { name: "scrollbackRows", key: "GHOSTTY_TERMINAL_GET_SCROLLBACK_ROWS" as const, size: "u32" },
  { name: "title", key: "GHOSTTY_TERMINAL_GET_TITLE" as const, size: "string" },
  { name: "pwd", key: "GHOSTTY_TERMINAL_GET_PWD" as const, size: "string" },
  // Pixel dims and mouse tracking and cursor style added as enum entries are
  // confirmed present at the pin; see executor note below.
];
```

**Executor note:** replace the `GHOSTTY_TERMINAL_GET_*` names above with the exact names recorded in `docs/abi/2026-04-22-abi-discovery.md` §9. Any name missing from `GhosttyTerminalGetKeyValues` causes a compile error — consult the ABI discovery doc's "NOT AT PIN" column to know which snapshot fields to mark `undefined` instead of looking up.

Replace the `snapshot()` stub:

```typescript
  snapshot(): TerminalSnapshot {
    this.#assertOpen();
    const lib = getLib();
    const { read, ptr } = require("bun:ffi");

    // Build keys[] and values[] arrays.
    // keys[]: u32 array, length = SNAPSHOT_KEYS.length
    // values[]: opaque ptr array where each slot holds either:
    //   - a u32 for size: "u32" | "bool"
    //   - a (char *, size_t) pair for size: "string"
    //
    // The exact ABI of ghostty_terminal_get_multi is the union type
    // GhosttyTerminalGetValue in vt.h — verify at pin time. The shape
    // sketched below uses per-entry heap slots; replace with the actual
    // struct layout if different.

    const n = SNAPSHOT_KEYS.length;
    const keysBuf = new Uint32Array(n);
    for (let i = 0; i < n; i++) {
      const entry = SNAPSHOT_KEYS[i];
      if (!entry) continue;
      const v = GhosttyTerminalGetKeyValues[entry.key];
      if (v === undefined) {
        throw new GhosttyError(`GhosttyTerminalGetKey.${entry.key} is missing at the pinned Ghostty commit`, {
          code: "unknown",
          functionName: "Terminal.snapshot",
        });
      }
      keysBuf[i] = v;
    }

    // Allocate a values buffer large enough for the widest entry type.
    // For Pass 1 assume each slot is 16 bytes (enough for a u32, a bool, or
    // a {char*, size_t} pair). Refine after reading vt.h's actual struct.
    const SLOT_SIZE = 16;
    const valuesBuf = new Uint8Array(n * SLOT_SIZE);

    const result = lib.symbols.ghostty_terminal_get_multi(
      this.#handle,
      ptr(keysBuf),
      ptr(valuesBuf),
      BigInt(n),
    );
    checkResult(result, "ghostty_terminal_get_multi");

    const view = new DataView(valuesBuf.buffer);
    // Build the snapshot by reading each slot per its declared type.
    const raw: Record<string, number | boolean | string | undefined> = {};
    for (let i = 0; i < n; i++) {
      const entry = SNAPSHOT_KEYS[i];
      if (!entry) continue;
      const off = i * SLOT_SIZE;
      if (entry.size === "u32")    raw[entry.name] = view.getUint32(off, true);
      else if (entry.size === "bool") raw[entry.name] = view.getUint8(off) !== 0;
      else if (entry.size === "string") {
        // {char *ptr, size_t len} — little-endian 64-bit both fields.
        const strPtr = view.getBigUint64(off, true);
        const strLen = Number(view.getBigUint64(off + 8, true));
        if (strPtr === 0n || strLen === 0) raw[entry.name] = undefined;
        else {
          const bytes = new Uint8Array(read.buffer(Number(strPtr), 0, strLen));
          // Copy immediately — libghostty may invalidate on next vt_write.
          raw[entry.name] = new TextDecoder("utf-8").decode(new Uint8Array(bytes));
        }
      }
    }

    const activeScreenNum = raw.activeScreen as number | undefined;
    const activeScreen: "primary" | "alternate" =
      activeScreenNum === 1 ? "alternate" : "primary";

    const { width: cellW, height: cellH } = this.#cellPx;

    return {
      cols: raw.cols as number,
      rows: raw.rows as number,
      pixelWidth: (raw.cols as number) * cellW,
      pixelHeight: (raw.rows as number) * cellH,
      cursor: {
        x: raw.cursorX as number,
        y: raw.cursorY as number,
        visible: raw.cursorVisible as boolean,
        style: "block",  // Wired through in a later pass once GET_CURSOR_STYLE is confirmed present.
      },
      activeScreen,
      title: raw.title as string | undefined,
      pwd: raw.pwd as string | undefined,
      scrollbackRows: raw.scrollbackRows as number,
      mouseTracking: "none",  // Wired through once GET_MOUSE_TRACKING is confirmed present.
    };
  }
```

**Executor note:** `ghostty_terminal_get_multi`'s ABI may not match the `u32 keys[] / opaque values[]` shape sketched above. Read `ghostty/vt/terminal.h` at the pinned commit for the actual signature — it may take a union struct, an array of key/value pairs, or require per-key allocation via `ghostty_alloc`. Adjust the implementation to match. Tests will fail loudly if the shape is wrong.

- [ ] **Step 4: Run — verify pass**

```bash
bun test test/smoke/terminal.test.ts
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/terminal.ts test/smoke/terminal.test.ts
git commit -m "feat(terminal): snapshot via ghostty_terminal_get_multi"
```

---

## Task 15: Terminal.mode / setMode

**Files:**
- Modify: `src/terminal.ts`, `test/smoke/terminal.test.ts`

- [ ] **Step 1: Write failing tests**

Append to `test/smoke/terminal.test.ts`:

```typescript
describe("Terminal.mode / setMode", () => {
  it("setMode + mode round-trip for bracketed_paste", () => {
    using term = new Terminal({ cols: 80, rows: 24 });
    // The exact ModeName string is determined by the pinned header.
    // ModeTag.GHOSTTY_MODE_BRACKETED_PASTE likely maps to name "bracketed_paste".
    term.setMode("bracketed_paste", true);
    expect(term.mode("bracketed_paste")).toBe(true);
    term.setMode("bracketed_paste", false);
    expect(term.mode("bracketed_paste")).toBe(false);
  });

  it("throws on unknown ModeName", () => {
    using term = new Terminal({ cols: 80, rows: 24 });
    expect(() => term.mode("not_a_real_mode")).toThrow();
    expect(() => term.setMode("not_a_real_mode", true)).toThrow();
  });
});
```

- [ ] **Step 2: Run — verify fail**

```bash
bun test test/smoke/terminal.test.ts
```

Expected: new tests fail with "not implemented yet".

- [ ] **Step 3: Implement**

Add to the imports at the top of `src/terminal.ts`:

```typescript
import { modeTagByName } from "./internal/generated.js";
```

Add a helper near the top of the class-module (before the class):

```typescript
function modeTagFromName(name: ModeName): number {
  const v = (modeTagByName as Record<string, number | undefined>)[name];
  if (v === undefined) {
    throw new GhosttyError(`unknown ModeName: ${name}`, {
      code: "invalid_argument",
      functionName: "Terminal.mode",
    });
  }
  return v;
}
```

`modeTagByName` is generated from the pinned header (Task 5). There is no string-prefix guessing — the map is the source of truth.

Replace the `mode` and `setMode` stubs:

```typescript
  mode(name: ModeName): boolean {
    this.#assertOpen();
    const tag = modeTagFromName(name);
    const lib = getLib();
    return lib.symbols.ghostty_terminal_mode_get(this.#handle, tag);
  }

  setMode(name: ModeName, value: boolean): void {
    this.#assertOpen();
    const tag = modeTagFromName(name);
    const lib = getLib();
    const result = lib.symbols.ghostty_terminal_mode_set(this.#handle, tag, value);
    checkResult(result, "ghostty_terminal_mode_set");
  }
```

- [ ] **Step 4: Run — verify pass**

```bash
bun test test/smoke/terminal.test.ts
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/terminal.ts test/smoke/terminal.test.ts
git commit -m "feat(terminal): mode get/set"
```

---

## Task 16: Formatter class

**Files:**
- Create: `src/formatter.ts`, `test/smoke/formatter.test.ts`

- [ ] **Step 1: Write failing tests**

Create `test/smoke/formatter.test.ts`:

```typescript
import { describe, expect, it } from "bun:test";
import { Terminal } from "../../src/terminal.js";
import { Formatter } from "../../src/formatter.js";
import { UseAfterCloseError } from "../../src/errors.js";

describe("Formatter lifecycle", () => {
  it("constructs with format: 'plain'", () => {
    using fmt = new Formatter({ format: "plain" });
    expect(fmt).toBeDefined();
  });

  it("constructs with format: 'vt' and 'html'", () => {
    using a = new Formatter({ format: "vt" });
    using b = new Formatter({ format: "html" });
  });

  it("close() is idempotent", () => {
    const f = new Formatter({ format: "plain" });
    f.close();
    f.close();
  });

  it("throws UseAfterCloseError after close", () => {
    using term = new Terminal({ cols: 10, rows: 3 });
    const f = new Formatter({ format: "plain" });
    f.close();
    expect(() => f.format(term)).toThrow(UseAfterCloseError);
    expect(() => f.formatString(term)).toThrow(UseAfterCloseError);
  });
});

describe("Formatter.format / formatString", () => {
  it("formats an empty terminal as whitespace", () => {
    using term = new Terminal({ cols: 10, rows: 3 });
    using fmt = new Formatter({ format: "plain" });
    const s = fmt.formatString(term);
    expect(s).toContain(" ");  // blanks present; exact form depends on Formatter output rules
    expect(typeof s).toBe("string");
  });

  it("formats 'hello' after writing bytes", () => {
    using term = new Terminal({ cols: 10, rows: 3 });
    term.vtWrite(new TextEncoder().encode("hello"));
    using fmt = new Formatter({ format: "plain" });
    const s = fmt.formatString(term);
    expect(s).toContain("hello");
  });

  it("format() returns a Uint8Array", () => {
    using term = new Terminal({ cols: 10, rows: 3 });
    term.vtWrite(new TextEncoder().encode("hello"));
    using fmt = new Formatter({ format: "plain" });
    const bytes = fmt.format(term);
    expect(bytes).toBeInstanceOf(Uint8Array);
    const decoded = new TextDecoder().decode(bytes);
    expect(decoded).toContain("hello");
  });
});
```

- [ ] **Step 2: Run — verify fail**

```bash
bun test test/smoke/formatter.test.ts
```

Expected: module not found.

- [ ] **Step 3: Implement `src/formatter.ts`**

Contents:

```typescript
import { ptr, toArrayBuffer, type Pointer } from "bun:ffi";
import { getLib } from "./ffi.js";
import { checkResult } from "./terminal.js";
import { GhosttyError, UseAfterCloseError } from "./errors.js";
import { formatterTagByName, structLayouts } from "./internal/generated.js";
import { writeStruct } from "./internal/sized-struct.js";
import { Terminal } from "./terminal.js";
import type { FormatterOptions } from "./types.js";

function formatTag(format: "plain" | "vt" | "html"): number {
  const v = formatterTagByName[format];
  if (v === null || v === undefined) {
    throw new GhosttyError(
      `No Ghostty formatter tag for "${format}" at pinned commit. ` +
      `If upstream selects format via a field in GhosttyFormatterOptions, ` +
      `update Formatter.constructor to set that field instead of calling a tag-typed constructor.`,
      { code: "unknown", functionName: "Formatter.constructor" },
    );
  }
  return v;
}

export class Formatter {
  #handle: Pointer | null = null;
  #tag: number;

  constructor(opts: FormatterOptions) {
    const lib = getLib();
    this.#tag = formatTag(opts.format);

    const layout = structLayouts["GhosttyFormatterOptions"];
    if (!layout) {
      throw new GhosttyError(
        "generated.ts missing GhosttyFormatterOptions layout — rerun gen-bindings",
        { code: "unknown", functionName: "Formatter.constructor" },
      );
    }

    // Only set fields the probe actually captured. Field names come from ABI
    // discovery §7 — they may not all match the spec's TS option names.
    const fields: Record<string, number | bigint | boolean> = {};
    const set = (cField: string, val: boolean) => {
      if (layout.fields[cField]) fields[cField] = val;
    };
    set("palette", opts.palette ?? false);
    set("modes", opts.modes ?? false);
    set("scrolling_region", opts.scrollingRegion ?? false);
    set("tab_stops", opts.tabStops ?? false);
    set("pwd", opts.pwd ?? false);
    set("keyboard", opts.keyboard ?? false);
    set("cursor", opts.cursor ?? false);
    set("style", opts.style ?? false);
    set("hyperlink", opts.hyperlink ?? false);
    set("protection", opts.protection ?? false);
    set("charsets", opts.charsets ?? false);

    // If upstream selects format via a field, set it.
    if (layout.fields["format"]) fields["format"] = this.#tag;

    const optBytes = writeStruct(layout, fields);

    // ghostty_formatter_new signature per ABI discovery §6.
    // Two common shapes — the executor must pick whichever the pin uses and
    // update src/ffi.ts SYMBOLS to match:
    //   (a) GhosttyResult ghostty_formatter_new(GhosttyAllocator* alloc,
    //                                           const GhosttyFormatterOptions* opts,
    //                                           GhosttyFormatter** out);
    //   (b) GhosttyResult ghostty_formatter_new(GhosttyFormatterTag tag,
    //                                           const GhosttyFormatterOptions* opts,
    //                                           GhosttyFormatter** out);
    // The code below assumes (a). For (b), replace `null` with `this.#tag`
    // and remove the `format` field write above.
    const outSlot = new BigUint64Array(1);
    const result = lib.symbols.ghostty_formatter_new(null, optBytes, ptr(outSlot));
    checkResult(result, "ghostty_formatter_new");

    const handle = outSlot[0];
    if (handle === 0n) {
      throw new GhosttyError("ghostty_formatter_new returned OK but out pointer is null", {
        code: "unknown",
        functionName: "ghostty_formatter_new",
      });
    }
    this.#handle = handle as Pointer;
  }

  close(): void {
    if (this.#handle === null) return;
    const lib = getLib();
    lib.symbols.ghostty_formatter_free(this.#handle);
    this.#handle = null;
  }

  [Symbol.dispose](): void {
    this.close();
  }

  format(term: Terminal): Uint8Array {
    this.#assertOpen();
    const lib = getLib();

    const outBufSlot = new BigUint64Array(1);
    const outLenSlot = new BigUint64Array(1);

    const result = lib.symbols.ghostty_formatter_format(
      this.#handle,
      term._handle,
      ptr(outBufSlot),
      ptr(outLenSlot),
    );
    checkResult(result, "ghostty_formatter_format");

    const bufPtr = outBufSlot[0];
    const len = Number(outLenSlot[0]);
    if (bufPtr === 0n || len === 0) return new Uint8Array(0);

    // Copy bytes immediately, then free the native buffer — in a try/finally
    // so that an exception thrown while copying cannot leak native memory.
    // ABI discovery §6 confirms whether ghostty_free is the correct free
    // function and what its argument shape is; update if different.
    try {
      const copy = new Uint8Array(len);
      copy.set(new Uint8Array(toArrayBuffer(Number(bufPtr), 0, len)));
      return copy;
    } finally {
      lib.symbols.ghostty_free(null, Number(bufPtr), BigInt(len));
    }
  }

  formatString(term: Terminal): string {
    return new TextDecoder("utf-8").decode(this.format(term));
  }

  #assertOpen(): void {
    if (this.#handle === null) {
      throw new UseAfterCloseError("Formatter has been closed", {
        handleType: "Formatter",
      });
    }
  }
}
```

**Executor note:** the `ghostty_formatter_new` signature is a known ABI-discovery decision (see §6). If the actual upstream signature does not match option (a) or (b) above, add a third branch to this implementation together with an update to `src/ffi.ts` SYMBOLS. Do not guess — the discovery doc is authoritative.

- [ ] **Step 4: Run — verify pass**

```bash
bun test test/smoke/formatter.test.ts
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/formatter.ts test/smoke/formatter.test.ts
git commit -m "feat: Formatter class (plain/vt/html, format + formatString)"
```

---

## Task 17: Fixture harness

**Files:**
- Create: `test/helpers/fixture-harness.ts`
- Create: `test/fixtures/hello-world.bin`, `test/fixtures/hello-world.expected.txt`
- Create: `test/smoke/fixtures.test.ts`

- [ ] **Step 1: Write the fixture files**

Create `test/fixtures/hello-world.bin` — raw bytes of the string `hello\r\n` (7 bytes: `68 65 6c 6c 6f 0d 0a`):

```bash
printf 'hello\r\n' > test/fixtures/hello-world.bin
```

Verify:

```bash
xxd test/fixtures/hello-world.bin
# Expected: 68656c6c 6f0d0a
```

Create `test/fixtures/hello-world.expected.txt` by running Formatter against the state after writing those bytes. For Pass 1 this is bootstrapped with `--update-fixtures`; see below.

For now write a placeholder:

```bash
echo "PLACEHOLDER_RUN_WITH_UPDATE_FIXTURES" > test/fixtures/hello-world.expected.txt
```

- [ ] **Step 2: Write the harness**

Create `test/helpers/fixture-harness.ts`:

```typescript
import { readFile, writeFile, readdir } from "node:fs/promises";
import { join, basename } from "node:path";
import { Terminal } from "../../src/terminal.js";
import { Formatter } from "../../src/formatter.js";

export interface FixtureResult {
  name: string;
  pass: boolean;
  expected: string;
  actual: string;
}

export async function runFixture(
  fixturesDir: string,
  name: string,
  opts: { update: boolean } = { update: false },
): Promise<FixtureResult> {
  const binPath = join(fixturesDir, `${name}.bin`);
  const txtPath = join(fixturesDir, `${name}.expected.txt`);

  const bin = new Uint8Array(await readFile(binPath));
  const expected = await readFile(txtPath, "utf8").catch(() => "");

  using term = new Terminal({ cols: 80, rows: 24 });
  term.vtWrite(bin);
  using fmt = new Formatter({ format: "plain" });
  const actual = fmt.formatString(term);

  if (opts.update) {
    await writeFile(txtPath, actual, "utf8");
    return { name, pass: true, expected: actual, actual };
  }

  return { name, pass: actual === expected, expected, actual };
}

export async function listFixtures(fixturesDir: string): Promise<string[]> {
  const entries = await readdir(fixturesDir);
  return entries
    .filter((e) => e.endsWith(".bin"))
    .map((e) => basename(e, ".bin"))
    .sort();
}
```

- [ ] **Step 3: Regenerate the expected text using --update**

Add a one-off script step in `package.json` `scripts`:

```json
"fixtures:update": "bun -e 'import(\"./test/helpers/fixture-harness.ts\").then(async m => { const names = await m.listFixtures(\"test/fixtures\"); for (const n of names) { const r = await m.runFixture(\"test/fixtures\", n, { update: true }); console.log(\"updated\", r.name); } })'"
```

Run:

```bash
bun run fixtures:update
```

Expected: `test/fixtures/hello-world.expected.txt` now contains the actual Formatter output. Inspect it:

```bash
head test/fixtures/hello-world.expected.txt
# Expected: first line contains "hello" followed by spaces out to col 80;
# remaining lines are blank padding out to row 24.
```

- [ ] **Step 4: Write the fixtures test**

Create `test/smoke/fixtures.test.ts`:

```typescript
import { describe, expect, it } from "bun:test";
import { listFixtures, runFixture } from "../helpers/fixture-harness.js";
import { join } from "node:path";

const DIR = join(process.cwd(), "test/fixtures");

// Pass 1 fixtures only verify formatter plumbing — byte stream in, text out.
// They do NOT prove semantic correctness of the VT state machine. Deeper
// semantic fixtures (render-state metadata JSON, styles, wide graphemes,
// malformed input, real-program captures) land with Pass 3 when RenderState
// exists and can be directly asserted against.
describe("formatter fixtures (plumbing-only)", () => {
  it("lists at least hello-world", async () => {
    const names = await listFixtures(DIR);
    expect(names).toContain("hello-world");
  });

  it("hello-world round-trips through vtWrite → Formatter", async () => {
    const result = await runFixture(DIR, "hello-world");
    if (!result.pass) {
      console.error("--- expected ---\n" + result.expected);
      console.error("--- actual ---\n" + result.actual);
    }
    expect(result.pass).toBe(true);
  });
});
```

- [ ] **Step 5: Run — verify pass**

```bash
bun test test/smoke/fixtures.test.ts
```

Expected: both tests pass.

- [ ] **Step 6: Commit**

```bash
git add test/helpers/fixture-harness.ts test/fixtures/ test/smoke/fixtures.test.ts package.json
git commit -m "test: fixture harness + hello-world fixture"
```

---

## Task 18: ABI smoke test

**Files:**
- Create: `test/smoke/abi.test.ts`

Tests that bind runtime behavior to the contracts captured by the generator + probe:

- `pinnedCommit` matches `package.json` `ghostty.commit`.
- Every symbol the binding dlopens (`requiredSymbols` exported from `ffi.ts`) is also declared in at least one header (`declaredHeaderSymbols`).
- Every struct the binding constructs has a layout entry in `structLayouts`.
- The loaded library resolves every `requiredSymbols` entry to a callable.
- The current `.tmp/layout.json` — produced by re-running `probe-layout` — matches the checked-in layouts. This catches any drift between the binding's expectations and the pinned header.

- [ ] **Step 1: Write `test/smoke/abi.test.ts`**

Contents:

```typescript
import { describe, expect, it } from "bun:test";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import {
  declaredHeaderSymbols,
  pinnedCommit,
  structLayouts,
} from "../../src/internal/generated.js";
import { getLib, requiredSymbols } from "../../src/ffi.js";

describe("ABI smoke", () => {
  it("pinnedCommit matches package.json ghostty.commit", async () => {
    const pkg = JSON.parse(await readFile(join(process.cwd(), "package.json"), "utf8"));
    expect(pinnedCommit).toBe(pkg.ghostty.commit);
  });

  it("requiredSymbols is a subset of declaredHeaderSymbols", () => {
    const declared = new Set(declaredHeaderSymbols);
    const missing = [...requiredSymbols].filter((s) => !declared.has(s));
    expect(missing).toEqual([]);
  });

  it("structLayouts contains the structs the binding constructs", () => {
    expect(structLayouts["GhosttyTerminalOptions"]).toBeDefined();
    expect(structLayouts["GhosttyTerminalOptions"]!.size).toBeGreaterThan(0);
    expect(structLayouts["GhosttyFormatterOptions"]).toBeDefined();
    expect(structLayouts["GhosttyFormatterOptions"]!.size).toBeGreaterThan(0);
  });

  it("library loads and every required symbol resolves to a callable", () => {
    const lib = getLib();
    const missing: string[] = [];
    for (const name of requiredSymbols) {
      if (typeof (lib.symbols as any)[name] !== "function") missing.push(name);
    }
    expect(missing).toEqual([]);
  });

  it("re-running the probe produces layouts matching the checked-in file", async () => {
    // The probe must have already been built in this session; the test
    // re-runs it fresh and compares. Any diff means the pinned headers
    // changed (vendor/ghostty was not at the expected commit), or
    // structLayouts was hand-edited.
    spawnSync("bun", ["run", "build:probe"], { stdio: "inherit" });
    const fresh = JSON.parse(await readFile(".tmp/layout.json", "utf8"));
    for (const s of fresh.structs) {
      const checked = structLayouts[s.name];
      expect(checked, `checked-in layout missing: ${s.name}`).toBeDefined();
      expect(checked!.size).toBe(s.size);
      expect(checked!.align).toBe(s.align);
      expect(checked!.isSized).toBe(s.isSized);
      for (const f of s.fields) {
        const cf = checked!.fields[f.name];
        expect(cf, `checked-in field missing: ${s.name}.${f.name}`).toBeDefined();
        expect(cf!.offset).toBe(f.offset);
        expect(cf!.size).toBe(f.size);
        expect(cf!.kind).toBe(f.kind);
      }
    }
  }, 60_000);
});
```

- [ ] **Step 2: Run — verify pass**

```bash
bun test test/smoke/abi.test.ts
```

Expected: all pass. If any fail, earlier tasks have drifted — fix before proceeding.

- [ ] **Step 3: Commit**

```bash
git add test/smoke/abi.test.ts
git commit -m "test: ABI smoke — symbol/struct/commit contracts"
```

---

## Task 19: Tarball smoke test

**Files:**
- Create: `scripts/run-tarball-smoke.sh`, `test/tarball/smoke.test.ts`

- [ ] **Step 1: Write `scripts/run-tarball-smoke.sh`**

Contents:

```bash
#!/usr/bin/env bash
# Pack the current package into a tarball, install it into a throwaway
# directory, and run a minimal import-and-use script. Exits non-zero on any
# failure.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# Ensure dist/ exists (the tarball relies on dist/ being built).
bun run build:ts

# Ensure tarball output directory exists.
mkdir -p "$ROOT/.tmp"

# Pack. Resolve the resulting tarball path relative to $ROOT, then make it
# absolute before using it as `file:` in the downstream package.json.
PACK_OUTPUT=$(bun pm pack --destination "$ROOT/.tmp" 2>&1)
REL=$(echo "$PACK_OUTPUT" | tail -n 1 | awk '{print $NF}')
if [ -z "${REL:-}" ] || [ ! -f "$REL" ]; then
  # Fallback — `bun pm pack` output format may vary. Find the most-recently-
  # created .tgz in .tmp/.
  REL=$(ls -1t "$ROOT/.tmp"/*.tgz 2>/dev/null | head -n 1)
fi
if [ -z "${REL:-}" ] || [ ! -f "$REL" ]; then
  echo "bun pm pack did not produce a tarball" >&2
  echo "$PACK_OUTPUT" >&2
  exit 1
fi
TGZ=$(cd "$(dirname "$REL")" && pwd)/$(basename "$REL")
echo "packed: $TGZ"

# Install into a temp project outside the repo.
TMP=$(mktemp -d)
trap "rm -rf $TMP" EXIT
cd "$TMP"

cat > package.json <<EOF
{
  "name": "tarball-smoke",
  "type": "module",
  "dependencies": {
    "ts-libghostty": "file:$TGZ"
  }
}
EOF

bun install --silent

cat > run.ts <<'EOF'
import { Terminal, Formatter } from "ts-libghostty";

using term = new Terminal({ cols: 10, rows: 3 });
term.vtWrite(new TextEncoder().encode("hi"));
using fmt = new Formatter({ format: "plain" });
const s = fmt.formatString(term);
if (!s.includes("hi")) {
  console.error("expected 'hi' in output, got:", JSON.stringify(s));
  process.exit(1);
}
console.log("OK");
EOF

bun run.ts
```

Make executable:

```bash
chmod +x scripts/run-tarball-smoke.sh
```

- [ ] **Step 2: Write `test/tarball/smoke.test.ts`**

Contents:

```typescript
import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

describe("tarball smoke", () => {
  it("packs, installs, imports, and runs successfully", () => {
    const result = spawnSync("bash", [join(process.cwd(), "scripts/run-tarball-smoke.sh")], {
      stdio: "pipe",
      encoding: "utf8",
    });
    if (result.status !== 0) {
      console.error("stdout:", result.stdout);
      console.error("stderr:", result.stderr);
    }
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("OK");
  }, 120_000);  // up to 2 min for bun install in a fresh dir
});
```

- [ ] **Step 3: Run — verify pass**

```bash
bun run test:tarball
```

Expected: script prints `OK` and exits 0.

Then:

```bash
bun test test/tarball/smoke.test.ts
```

Expected: test passes.

- [ ] **Step 4: Commit**

```bash
git add scripts/run-tarball-smoke.sh test/tarball/smoke.test.ts
git commit -m "test: tarball smoke — pack, install, import, run"
```

---

## Task 20: CI workflow

**Files:**
- Create: `.github/workflows/ci.yml`

- [ ] **Step 1: Write `.github/workflows/ci.yml`**

Contents:

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  test:
    # macos-14 is Apple Silicon (arm64). `macos-latest` at GitHub Actions
    # currently resolves to macos-14 too, but we pin explicitly so that a
    # future remapping does not silently switch us to an unsupported arch.
    runs-on: macos-14
    steps:
      - uses: actions/checkout@v4

      - name: Verify runner is arm64
        run: |
          uname -m
          test "$(uname -m)" = "arm64"

      - name: Install Zig
        uses: mlugg/setup-zig@v1
        with:
          # Pin a specific Zig release rather than `master`. Any recent 0.13+
          # release should build Ghostty; bump as Ghostty's required version
          # changes. Recorded alongside the Ghostty pin.
          version: "0.13.0"

      - name: Install Bun
        uses: oven-sh/setup-bun@v2
        with:
          # Exact version, not a range — some setup-bun versions reject ranges.
          bun-version: "1.3.13"

      - name: bun install
        run: bun install --frozen-lockfile

      - name: Build libghostty
        run: bun run build:libghostty

      - name: Build probe and regenerate bindings
        run: bun run build:probe && bun run build:bindings

      - name: Verify generated.ts is up to date
        run: git diff --exit-code src/internal/generated.ts

      - name: Typecheck
        run: bun x tsc --noEmit -p tsconfig.json

      - name: Unit + smoke tests
        run: bun run test:smoke

      - name: Build TypeScript
        run: bun run build:ts

      - name: Tarball smoke
        run: bun run test:tarball
```

- [ ] **Step 2: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: macOS workflow — build, typecheck, test, tarball smoke"
```

CI will execute on the first push to a branch. Before pushing, verify locally:

```bash
bun install --frozen-lockfile
bun run build:native
bun run verify:generated
bun x tsc --noEmit -p tsconfig.json
bun run test:smoke
bun run build:ts
bun run test:tarball
```

All steps should pass.

---

## Task 21: Public re-exports + README

**Files:**
- Create: `src/index.ts`
- Modify: `README.md`

- [ ] **Step 1: Write `src/index.ts`**

Contents:

```typescript
export { Terminal } from "./terminal.js";
export { Formatter } from "./formatter.js";
export {
  GhosttyError,
  LibraryNotFoundError,
  UnsupportedPlatformError,
  LibraryCompatibilityError,
  UseAfterCloseError,
} from "./errors.js";
export type { GhosttyErrorCode } from "./errors.js";
export {
  setLibraryPath,
  isLoaded,
  libraryInfo,
} from "./ffi.js";
export type { LibraryInfo } from "./ffi.js";
export {
  modeNames,
} from "./internal/generated.js";
export type {
  RGB,
  PaletteIndex,
  CursorStyle,
  MouseTracking,
  ModeName,
  TerminalOptions,
  TerminalSnapshot,
  FormatterOptions,
} from "./types.js";
export { pinnedCommit } from "./internal/generated.js";
```

- [ ] **Step 2: Build the package to verify re-exports**

```bash
bun run build:ts
```

Expected: `dist/index.js`, `dist/index.d.ts` exist; `dist/index.d.ts` declares every exported identifier.

- [ ] **Step 3: Rewrite `README.md`**

Contents:

```markdown
# ts-libghostty

**Unofficial community TypeScript binding** over [libghostty-vt](https://github.com/ghostty-org/ghostty), the VT state machine from [Ghostty](https://ghostty.org). For Bun.

> **Status:** pre-1.0, API unstable. This binding tracks a pinned Ghostty commit
> and is published for experimentation. There is no guarantee of semver across
> 0.x releases. This package is not affiliated with or endorsed by the Ghostty
> project.

## Install

```bash
bun add ts-libghostty
```

**Platforms (Pass 1):** `darwin-arm64`. Other platforms are on the roadmap; see the design spec in the [source repository](https://github.com/REPLACE_WITH_REPO_URL) under `docs/superpowers/specs/`.

## Minimal example

```typescript
import { Terminal, Formatter } from "ts-libghostty";

using term = new Terminal({ cols: 80, rows: 24 });
term.vtWrite(new TextEncoder().encode("hello, world\r\n"));

using fmt = new Formatter({ format: "plain" });
console.log(fmt.formatString(term));
```

## Pass 1 surface

- `Terminal` — construction, `vtWrite`, `resize`, `reset`, `snapshot`, `mode`/`setMode`, lifecycle (`close`, `using`).
- `Formatter` — `plain`/`vt`/`html` dumps of a Terminal's current screen.
- `GhosttyError` + subclasses (`LibraryNotFoundError`, `UnsupportedPlatformError`, `LibraryCompatibilityError`, `UseAfterCloseError`).
- `setLibraryPath` / `isLoaded` / `libraryInfo` for diagnostics and out-of-tree library paths.

Effect callbacks (`onWritePty`, `onBell`, `onTitleChanged`), `RenderState` (per-cell grid reading), `KeyEncoder`, and polish features (modes beyond the simple get/set, color get/set, viewport scroll, `cellAt`) are on the roadmap for Passes 2–5.

## License

- `ts-libghostty` code: Apache-2.0 — see [LICENSE](./LICENSE).
- Redistributed `libghostty-vt.dylib` binary in `prebuilds/`: MIT, per upstream Ghostty at the pinned commit — see [LICENSE_GHOSTTY](./LICENSE_GHOSTTY).

## Pinned Ghostty

The installed package is bound to a specific Ghostty commit. You can inspect it programmatically:

```typescript
import { pinnedCommit, libraryInfo } from "ts-libghostty";
console.log("pinned commit:", pinnedCommit);
console.log("library info:", libraryInfo());
```

## Overriding the library path

Point the binding at a local libghostty-vt build:

```bash
export GHOSTTY_VT_LIB=/path/to/libghostty-vt.dylib
```

Or at runtime before first native use:

```typescript
import { setLibraryPath } from "ts-libghostty";
setLibraryPath("/path/to/libghostty-vt.dylib");
```

**The loaded library's ABI must match the pinned Ghostty commit.** At Pass 1 the binding detects ABI mismatches through two channels only: (1) any required symbol missing from the loaded library triggers a `LibraryCompatibilityError`; (2) the build-native pipeline refuses to produce a release when the re-run probe output differs from the checked-in layouts. If upstream exposes a build-identity/commit getter in a future pass, the binding will additionally compare it against `pinnedCommit` at load time. Until then, override libraries are best-effort — a library built from a compatible commit that happens to resolve all required symbols can still disagree on enum values or callback shapes, with undefined runtime behavior.
```

- [ ] **Step 4: Commit**

```bash
git add src/index.ts README.md
git commit -m "docs: README + public re-exports for Pass 1"
```

---

## Task 22: Final sanity run + version bump

**Files:**
- Modify: `package.json` (confirm version)

This is the release gate for Pass 1.

- [ ] **Step 1: Verify working tree is clean of unrelated changes**

```bash
git status
# Expect: working tree clean, or only trivial uncommitted edits you intend to
# roll into a final "release prep" commit below. If there are uncommitted
# changes you did NOT make, stop here and investigate — the next step
# destructively clears generated artifacts.
```

- [ ] **Step 2: Run the full pipeline from a clean state**

```bash
rm -rf node_modules dist .tmp vendor prebuilds/*/libghostty-vt.*
bun install --frozen-lockfile
bun run build:native
bun run verify:generated
bun x tsc --noEmit -p tsconfig.json
bun run test:smoke
bun run build:ts
bun run test:tarball
```

Expected: every step exits 0.

- [ ] **Step 3: Confirm `version` in package.json is `0.1.0`**

This is the Pass 1 release version. If it has drifted, set it back:

```json
"version": "0.1.0"
```

- [ ] **Step 4: Commit any final release-prep changes**

```bash
git status
# If anything is uncommitted, commit it now BEFORE tagging. Do not use
# --allow-empty; if there is nothing to commit, skip this step.
git add -A
git commit -m "chore: Pass 1 release prep"
```

- [ ] **Step 5: Tag the Pass 1 milestone as the last action**

```bash
git tag -a v0.1.0 -m "ts-libghostty Pass 1 — Terminal + Formatter"
```

The tag must be created *after* the final commit. Once tagged, the release is frozen — any further change requires a new commit + tag (e.g., `v0.1.1`).

Pass 1 is now ready for review and, once approved, publication.

---

## Self-Review

Running the skill's self-review checklist against the plan above.

### Spec coverage

Walked every applicable section of `docs/superpowers/specs/2026-04-22-ts-libghostty-design.md` and mapped to tasks. Pass 1 is a subset of v0; remaining v0 surface ships in Passes 2–5.

- §1–3 (summary, motivation, architecture) — informational; no task needed.
- §3.2 v0 scope — Pass 1 covers `Terminal` (with construction, `vtWrite`, `resize`, `reset`, `snapshot`, `mode`/`setMode`, lifecycle) and `Formatter`. Effect callbacks, `RenderState`, `KeyEncoder`, `encodeFocus`, colors get/set, viewport scroll, and `cellAt` are deferred to later passes — explicit in header.
- §4.1 Terminal — Tasks 11–15. `snapshot` returns pixel dimensions (Task 14). Deferred fields (`cellAt`, colors, viewport scroll) explicit.
- §4.2 RenderState — deferred to Pass 3; explicit in scope.
- §4.3 Formatter — Task 16.
- §4.4 KeyEncoder — deferred to Pass 4; explicit.
- §4.5 encodeFocus — deferred to Pass 4; explicit.
- §4.6 Error hierarchy — Task 6 (all five classes).
- §4.7 Supporting types — Task 10 (subset needed for Pass 1; `ModeName` is the generated string-literal union).
- §5.1 FFI layer — Task 8 (lazy dlopen, setLibraryPath lifecycle, `requiredSymbols` verification, `libraryInfo`, explicit build-identity narrowing).
- §5.2 String marshaling — Task 9.
- §5.3 Struct layout & sized-struct — Tasks 3 (ABI discovery), 4 (probe with kind + isSized), 5 (generator), 9 (writer auto-fills sized).
- §5.4 Effect callbacks — deferred to Pass 2; explicit.
- §5.5 Lifecycle — Task 11 (Symbol.dispose, idempotent close, use-after-close caught in TS before FFI).
- §5.6 Errors — Task 6 + generated `resultCodeByValue` + `checkResult` helper in Task 11.
- §5.7 Concurrency — documented in Task 21 (README); no code change beyond constructor.
- §5.8 Allocator — wrapped via `ghostty_free` in Task 16; public exposure deferred.
- §5.9 Memory safety (APC bounds) — Task 11 (constructor sets defaults when probed fields exist).
- §6 Repo layout — Task 1 (infra) + subsequent files match; adds `docs/abi/` and `test/tarball/`.
- §7 Build & distribution — Tasks 1, 2, 3, 4, 5, 20.
- §8 Testing (v0 gates) — **Pass 1 ships a subset only**: smoke tests across Tasks 6/7/8/9/11–15, formatter-text fixtures (Task 17), ABI smoke including probe-vs-checked-in layout comparison (Task 18), and tarball smoke (Task 19). The following v0 gates are deferred to the passes that introduce the surfaces they exercise: effect-callback tests (Pass 2), render-state metadata JSON fixtures (Pass 3), key-encoder goldens (Pass 4), malformed-input fuzzing / large-APC bound (Pass 2 together with effect wiring), real-program captures (Pass 3). The Pass 1 plan does **not** claim full v0 test coverage.
- §9 Versioning & pinning — Task 1 (package.json `ghostty.commit`), Task 2 (pin commit), Task 22 (tag after final commit).
- §10 Ghostty-bump process — tooling pieces (`build:libghostty`, probe, generator) are in place after Tasks 2–5; a dedicated `bump-ghostty.sh` wrapper is a post-Pass-1 ergonomics item rather than a correctness requirement.
- §11 Post-v0 roadmap — informational.
- §12 Attribution — covered in Task 21 README and LICENSE files.

**Gaps identified and fixed during the revision pass:**
- Pass 1 deferred surfaces now explicit in the plan header.
- `bump-ghostty.sh` noted as follow-on, not a Pass 1 blocker.
- Test-gate claim narrowed: Pass 1 delivers smoke + fixtures + ABI + tarball, not the full v0 matrix.

### Placeholder scan

Searched the plan for placeholder patterns. Findings:

- **`REPLACE_WITH_PINNED_COMMIT_IN_TASK_2`** in Task 1 Step 4 — intentional sentinel; explicitly resolved in Task 2 Step 1.
- **`TASK_2_REPLACE_WITH_UPSTREAM`** in Task 1 Step 7 — intentional sentinel replaced by Task 2 Step 3.
- **`REPLACE_WITH_REPO_URL`** in Task 21 README — intentional sentinel resolved when the repo is first pushed to GitHub; the executor replaces it with the public URL before committing.
- **"Executor note"** paragraphs in Tasks 4 (probe), 5 (generator), 11 (Terminal), 15 (mode), 16 (Formatter) — these reference ABI discovery findings (Task 3), not hand-wavy placeholders. Each note points at a specific section of `docs/abi/2026-04-22-abi-discovery.md` and calls out the two failure modes (compile error or ABI-smoke failure) that will surface discrepancies.
- **No "TBD", "TODO", or "fill in details"** remains in any concrete implementation step.

### Type consistency

Walked the type surface across tasks:

- `Pointer` — imported from `bun:ffi` everywhere (no redefinition in source files).
- `ModeName` — generated string-literal union in Task 5; re-exported from `src/types.ts` in Task 10; consumed by `Terminal.mode`/`setMode` in Task 15 and public re-export in Task 21.
- `TerminalOptions` / `TerminalSnapshot` / `FormatterOptions` — defined once in Task 10, imported by Tasks 11, 13, 14, 16, 21.
- `GhosttyErrorCode` — defined in Task 6, used in Task 11 (`checkResult`) and Task 16.
- `requiredSymbols` / `declaredHeaderSymbols` — distinct lists per §4 of Codex review; Task 8 exports `requiredSymbols`; Task 5 emits `declaredHeaderSymbols`; Task 18 asserts the subset relationship.
- `structLayouts["GhosttyTerminalOptions"]` / `["GhosttyFormatterOptions"]` — same key strings used in Tasks 11, 16, 18.
- All `.ts` source imports use `.js` suffix (NodeNext resolution); tests import the runtime modules via `.js` too.

No inconsistencies found.

---

**Plan complete and saved to `docs/superpowers/plans/2026-04-22-ts-libghostty-pass-1.md`.**
