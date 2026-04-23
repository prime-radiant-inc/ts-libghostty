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

**Module format.** TypeScript source and tests use **extensionless relative imports** — e.g. `import { Terminal } from "./terminal"`. Under `moduleResolution: "bundler"` Bun resolves these to `.ts` files at dev/test time, and `bun build` resolves them to the emitted targets at build time. `tsc` is used only for `.d.ts` emission (`--emitDeclarationOnly`); `bun build --target bun --format esm` produces the `dist/*.js` JavaScript. This keeps `bun test` working directly against source files without a build step, and still produces a clean `dist/` for npm publication. Tarball-smoke (Task 19) proves the emitted artifact imports correctly in a clean install outside the repo.

**ABI discovery is gated before FFI implementation.** Task 3 consumes the pinned Ghostty headers to produce a checked-in reference document enumerating the exact C signatures, struct fields, enum names, and ownership rules the binding depends on. Tasks 4 onward read from that doc. **Task 3 Step 5 is a hard stop**: the executor must reconcile every later code snippet that carries an ABI-discovery dependency before beginning Task 4. Any mismatch between the discovery doc and a snippet is a plan-level bug fixed by editing the plan before execution.

**Binding symbol verification.** On first native use, `src/ffi.ts` dlopens the resolved library declaring the exact set of symbols in `requiredSymbols` (exported from `ffi.ts`), then verifies every one resolves to a callable. A missing required symbol raises `LibraryCompatibilityError` before any Terminal or Formatter can be constructed. `declaredHeaderSymbols` (generated from header parsing) is a diagnostic-only superset; Task 18 asserts `requiredSymbols ⊆ declaredHeaderSymbols` to catch drift between what the binding asks for and what the pinned header actually declares.

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
    "build:js": "bun build ./src/index.ts --outdir dist --target bun --format esm",
    "build:types": "tsc -p tsconfig.json",
    "build:ts": "bun run build:js && bun run build:types",
    "build": "bun run build:native && bun run build:ts",
    "test": "bun test test/smoke test/tarball/smoke.test.ts",
    "test:smoke": "bun test test/smoke",
    "test:tarball": "bash scripts/run-tarball-smoke.sh",
    "typecheck": "tsc --noEmit -p tsconfig.json",
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
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2023"],
    "types": ["bun"],
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "declaration": true,
    "declarationMap": true,
    "emitDeclarationOnly": true,
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

Source throughout this plan uses **extensionless relative imports** — e.g. `import { X } from "./terminal"`. Under `moduleResolution: "bundler"`:

- **At dev/test time** Bun resolves `./terminal` directly to `src/terminal.ts` when running `bun test` or `bun <script>.ts`.
- **At build time** `bun build` resolves and emits the JavaScript into `dist/`.
- **Declarations** come from `tsc` with `emitDeclarationOnly: true` — the compiler produces `.d.ts` files only; JavaScript emission is delegated to `bun build`.

This avoids the NodeNext `.js`-specifier hazard (where explicit extensions would mismatch `.ts` source files under `bun test`) and also avoids needing a separate test tsconfig.

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
mkdir -p .tmp
find vendor/ghostty/include/ghostty -name '*.h' -print | sort > .tmp/abi-headers.txt
grep -hE '^\s*ghostty_[A-Za-z0-9_]+\s*\(' vendor/ghostty/include -r | sort -u > .tmp/abi-symbol-decls.txt || true
# Also capture a more structured function-declaration listing. This filters to
# lines that look like complete declarations ending in `);`.
grep -hE '\bghostty_[A-Za-z0-9_]+\s*\([^;]*\)\s*(__attribute__[^;]*)?;' vendor/ghostty/include -r | sort -u > .tmp/abi-symbol-funcs.txt
wc -l .tmp/abi-headers.txt .tmp/abi-symbol-decls.txt .tmp/abi-symbol-funcs.txt
```

These files live in `.tmp/` and are **not** checked in — they are scratch input used to hand-write the reference doc in Step 3. The doc captures only what matters, verbatim.

- [ ] **Step 3: Write `docs/abi/2026-04-22-abi-discovery.md`**

The document answers every question below. If a question has no answer at the pin, record "NOT EXPOSED AT PIN" — this is a valid finding and downstream tasks handle it.

Use this template:

```markdown
# ts-libghostty ABI discovery

**Pinned commit:** <SHA>
**Date:** 2026-04-22
**Headers scanned:** every `*.h` under `vendor/ghostty/include/ghostty/` at the pinned commit. The raw list was captured in `.tmp/abi-headers.txt` during discovery; that file is not part of the artifact. Total count: `<N>` headers.

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

For each surprise recorded in §12 of the discovery doc that requires a snippet change, edit the relevant plan task before executing it.

Examples of what might change:

- Task 5 generator: `ModeTag` prefix is `GHOSTTY_MODE_TAG_` (not `GHOSTTY_MODE_`) → update the `MODE_TAG_PREFIX` constant.
- Task 5 generator: `GhosttyResult` values are non-contiguous or hex → verify the parser handles them; add entries to `RESULT_CODE_MAP` as needed.
- Task 4 probe: `GhosttyTerminalOptions` lacks `apc_max_bytes` → the conditional emits in the probe skip those fields; Task 11's constructor will naturally not wire them; Task 21 README notes that APC bounds use upstream default.
- Task 8 FFI: `ghostty_terminal_get_multi` takes a `GhosttyTerminalGetValue*` union array (not a flat byte buffer) → update the `SYMBOLS` signature in `src/ffi.ts` and rewrite Task 14's `snapshot()` implementation.
- Task 8 FFI: `ghostty_formatter_new` takes `(tag, &options, &out)` (not `(allocator, &options, &out)`) → update `SYMBOLS` and Task 16 `Formatter` constructor to match.
- Task 8 FFI: build identity is exposed via `ghostty_build_info_*` → add those symbols to `SYMBOLS`, populate `loadedIdentity` in `getLib()`, populate `LibraryCompatibilityError.actualCommit`. Otherwise narrow the compatibility claim in Task 21 README.

- [ ] **Step 5: RECONCILIATION CHECKPOINT (hard stop — do not skip)**

Before committing this task and before beginning Task 4, verify every snippet in the plan that carries an ABI-discovery dependency has been reconciled with the findings. Go through this checklist line by line. Tick every item: "matches discovery as written" or "snippet updated to match discovery." If any item is unchecked, **stop** and fix the plan before proceeding.

- [ ] Task 4 `probe-layout.c` field lists match ABI discovery §5 and §7 (including or omitting `apc_max_bytes` per the pin) and reflect the `isSized` finding.
- [ ] Task 5 `MODE_TAG_PREFIX` constant matches ABI discovery §8.
- [ ] Task 5 `RESULT_CODE_MAP` covers every entry in ABI discovery §3 (no `WARNING: ... has no TS mapping` output from the generator on a real run).
- [ ] Task 8 `SYMBOLS` signatures match ABI discovery §4, §6, and §11 (every symbol's args and return type).
- [ ] Task 8 build-identity wiring: if ABI discovery §2 records a getter, `SYMBOLS` includes it and `getLib()` populates `loadedIdentity`; otherwise the Task 21 README's compat-claim paragraph narrows to "symbol + layout" only.
- [ ] Task 11 `Terminal` constructor call shape (`ghostty_terminal_new(...)`) matches ABI discovery §4.
- [ ] Task 14 `snapshot()` matches ABI discovery §4's `get_multi` shape (key array type, value slot size, string representation).
- [ ] Task 14 `SNAPSHOT_KEYS` uses only enum names that exist in ABI discovery §9. Fields marked "NOT AT PIN" in §9 are dropped from `SNAPSHOT_KEYS` and their corresponding snapshot fields are reported as `undefined`.
- [ ] Task 15 `modeTagByName` is consumed from generated — no prefix-string guessing remains.
- [ ] Task 16 `Formatter` constructor matches ABI discovery §6 (either allocator-first or tag-first; chosen branch in the implementation comments).
- [ ] Task 16 `Formatter.format` free path matches ABI discovery §6's ownership rules (`ghostty_free` vs. a dedicated free function).

When every box above is ticked, proceed.

- [ ] **Step 6: Commit**

```bash
git add docs/abi/2026-04-22-abi-discovery.md
git commit -m "docs: ABI discovery for pinned Ghostty commit

Records exact C signatures, struct layouts, enum names, and ownership
rules the binding depends on. Subsequent tasks consume this doc rather
than guessing."
```

If any plan snippets were updated during Step 4/5 reconciliation, also commit those changes to the plan:

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

- `GhosttyTerminalOptions` (for `Terminal` construction; 16 B, align 8, **not** sized)
- `GhosttyFormatterTerminalOptions` (for `Formatter` construction; 56 B, align 8, **sized**)
- `GhosttyFormatterTerminalExtra` (nested inside `GhosttyFormatterTerminalOptions.extra` at offset 16; 32 B, align 8, **sized**)
- `GhosttyFormatterScreenExtra` (nested inside `GhosttyFormatterTerminalExtra.screen` at offset 16; 16 B, align 8, **sized**)

Exact field lists come from ABI discovery §5 and §7. The nested `extra` / `screen` sub-structs are probed independently so `src/internal/sized-struct.ts` (Task 9) can compose them when writing the outer options buffer.

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
  /* FIELD LIST is authored from ABI discovery §5. At the pin this struct has
   * no `size` field — the first field is `cols:u16 @ 0`. Hardcode is_sized=0. */
  const int is_sized_options = 0;
  emit_struct("GhosttyTerminalOptions",
              sizeof(GhosttyTerminalOptions),
              _Alignof(GhosttyTerminalOptions),
              is_sized_options);
  first_field = 1;
  EMIT_UINT(GhosttyTerminalOptions, cols);           /* u16 @ 0 */
  EMIT_UINT(GhosttyTerminalOptions, rows);           /* u16 @ 2 */
  EMIT_UINT(GhosttyTerminalOptions, max_scrollback); /* u64 @ 8 (4 bytes pad @ 4-7) */
  /* NOTE: apc_max_bytes and apc_max_bytes_kitty are NOT fields on this struct.
   * They are set post-construction via ghostty_terminal_set(term,
   * GHOSTTY_TERMINAL_OPT_APC_MAX_BYTES, &limit) and ..._APC_MAX_BYTES_KITTY.
   * Pass 1 does not expose APC tuning — see Task 21 README APC footnote. */
  end_struct();
}

static void probe_formatter_terminal_options(void) {
  /* FIELD LIST is authored from ABI discovery §7. Sized struct (first field
   * is `size_t size`), 56 B, align 8. */
  const int is_sized = (offsetof(GhosttyFormatterTerminalOptions, size) == 0 &&
                        sizeof(((GhosttyFormatterTerminalOptions*)0)->size) == sizeof(size_t));
  emit_struct("GhosttyFormatterTerminalOptions",
              sizeof(GhosttyFormatterTerminalOptions),
              _Alignof(GhosttyFormatterTerminalOptions),
              is_sized);
  first_field = 1;
  EMIT_UINT(GhosttyFormatterTerminalOptions, size);       /* size_t @ 0 */
  EMIT_UINT(GhosttyFormatterTerminalOptions, emit);       /* u32 enum @ 8 (GhosttyFormatterFormat) */
  EMIT_BOOL(GhosttyFormatterTerminalOptions, unwrap);     /* bool @ 12 */
  EMIT_BOOL(GhosttyFormatterTerminalOptions, trim);       /* bool @ 13 (2 bytes pad @ 14-15) */
  EMIT_STRUCT(GhosttyFormatterTerminalOptions, extra);    /* struct(32) @ 16 */
  EMIT_PTR(GhosttyFormatterTerminalOptions, selection);   /* const GhosttySelection* @ 48 */
  end_struct();
}

static void probe_formatter_terminal_extra(void) {
  /* Nested inside GhosttyFormatterTerminalOptions.extra. 32 B, align 8, sized. */
  const int is_sized = (offsetof(GhosttyFormatterTerminalExtra, size) == 0 &&
                        sizeof(((GhosttyFormatterTerminalExtra*)0)->size) == sizeof(size_t));
  emit_struct("GhosttyFormatterTerminalExtra",
              sizeof(GhosttyFormatterTerminalExtra),
              _Alignof(GhosttyFormatterTerminalExtra),
              is_sized);
  first_field = 1;
  EMIT_UINT(GhosttyFormatterTerminalExtra, size);               /* size_t @ 0 */
  EMIT_BOOL(GhosttyFormatterTerminalExtra, palette);            /* bool @ 8 */
  EMIT_BOOL(GhosttyFormatterTerminalExtra, modes);              /* bool @ 9 */
  EMIT_BOOL(GhosttyFormatterTerminalExtra, scrolling_region);   /* bool @ 10 */
  EMIT_BOOL(GhosttyFormatterTerminalExtra, tabstops);           /* bool @ 11 (no underscore) */
  EMIT_BOOL(GhosttyFormatterTerminalExtra, pwd);                /* bool @ 12 */
  EMIT_BOOL(GhosttyFormatterTerminalExtra, keyboard);           /* bool @ 13 (2 bytes pad @ 14-15) */
  EMIT_STRUCT(GhosttyFormatterTerminalExtra, screen);           /* struct(16) @ 16 */
  end_struct();
}

static void probe_formatter_screen_extra(void) {
  /* Nested inside GhosttyFormatterTerminalExtra.screen. 16 B, align 8, sized. */
  const int is_sized = (offsetof(GhosttyFormatterScreenExtra, size) == 0 &&
                        sizeof(((GhosttyFormatterScreenExtra*)0)->size) == sizeof(size_t));
  emit_struct("GhosttyFormatterScreenExtra",
              sizeof(GhosttyFormatterScreenExtra),
              _Alignof(GhosttyFormatterScreenExtra),
              is_sized);
  first_field = 1;
  EMIT_UINT(GhosttyFormatterScreenExtra, size);            /* size_t @ 0 */
  EMIT_BOOL(GhosttyFormatterScreenExtra, cursor);          /* bool @ 8 */
  EMIT_BOOL(GhosttyFormatterScreenExtra, style);           /* bool @ 9 */
  EMIT_BOOL(GhosttyFormatterScreenExtra, hyperlink);       /* bool @ 10 */
  EMIT_BOOL(GhosttyFormatterScreenExtra, protection);      /* bool @ 11 */
  EMIT_BOOL(GhosttyFormatterScreenExtra, kitty_keyboard);  /* bool @ 12 */
  EMIT_BOOL(GhosttyFormatterScreenExtra, charsets);        /* bool @ 13 */
  end_struct();
}

int main(void) {
  printf("{\n  \"structs\": [\n");
  probe_terminal_options();
  probe_formatter_terminal_options();
  probe_formatter_terminal_extra();
  probe_formatter_screen_extra();
  printf("\n  ]\n}\n");
  return 0;
}
```

**Note for executor:** `isSized` detection via `offsetof(S, size)` compiles only when the struct has a `size` member. `GhosttyTerminalOptions` at this pin has no `size` field (first field is `cols:u16 @ 0`), so we hardcode `is_sized_options = 0`. The three formatter structs (`GhosttyFormatterTerminalOptions`, `GhosttyFormatterTerminalExtra`, `GhosttyFormatterScreenExtra`) all start with `size_t size`, so the `offsetof` detection is valid for them. ABI discovery §5 / §7 tells you which case applies if fields change upstream.

- [ ] **Step 2: Run the probe**

```bash
mkdir -p .tmp
bun run build:probe
```

Expected: `.tmp/layout.json` exists and contains a JSON object with a `structs` array. Verify it parses:

```bash
bun -e 'console.log(JSON.parse(await Bun.file(".tmp/layout.json").text()))'
```

Expected: prints the parsed object with four struct entries (`GhosttyTerminalOptions`, `GhosttyFormatterTerminalOptions`, `GhosttyFormatterTerminalExtra`, `GhosttyFormatterScreenExtra`).

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
- `modeNames` — `readonly string[]` of the TS-facing names (e.g., `"bracketed_paste"`), derived from the 41 `#define GHOSTTY_MODE_<NAME>` macros in `vendor/ghostty/include/ghostty/vt/modes.h` by stripping the upstream prefix (recorded in ABI discovery §8) and lowercasing. Names beginning with a digit are prefixed with an underscore (e.g. `GHOSTTY_MODE_132_COLUMN` → `_132_column`).
- `ModeName` type alias — `typeof modeNames[number]` — giving consumers a real string-literal union.
- `modeTagByName` — `Record<ModeName, number>` for runtime lookup. **Values are packed `uint16_t`s** computed as `value | (ansi ? 1<<15 : 0)` per ABI discovery §8, NOT raw enum indices.
- `terminalDataByName` — mapped from the `GhosttyTerminalData` enum (ABI discovery §9); snapshot-field name → numeric key.
- `formatterFormatByName` — mapped from the `GhosttyFormatterFormat` enum (ABI discovery §10), keyed by format name (`"plain"`/`"vt"`/`"html"`) to u32 enum values `0`/`1`/`2`.

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

// --- Mode-define parser ----------------------------------------------------
// Modes are NOT an enum at this pin. They are 41 `#define GHOSTTY_MODE_<NAME>
// (ghostty_mode_new(<value>, <ansi>))` macros declared in vt/modes.h. The
// MODE_TAG_PREFIX constant below is consumed by parseModeDefines() (not by an
// enum lookup). See docs/abi/2026-04-22-abi-discovery.md §8.
const MODE_TAG_PREFIX = "GHOSTTY_MODE_";
const MODES_HEADER_PATH = join(HEADER_DIR, "vt/modes.h");

// Names that begin with a digit (e.g. `132_column`) are not valid TS
// identifiers; we prefix them with `_` to make them usable as object keys and
// type-literal union members. One-line convention documented here.
function sanitizeTsModeName(raw: string): string {
  return /^[0-9]/.test(raw) ? `_${raw}` : raw;
}

interface ModeDefineEntry {
  tsName: string;  // TS-facing name, e.g. "bracketed_paste" or "_132_column"
  cName: string;   // original C macro name, e.g. "GHOSTTY_MODE_BRACKETED_PASTE"
  value: number;   // packed u16: `rawValue | (ansi ? 1<<15 : 0)`
  ansi: boolean;   // true for ANSI modes (bit 15 set), false for DEC private
}

async function parseModeDefines(): Promise<ModeDefineEntry[]> {
  const src = await readFile(MODES_HEADER_PATH, "utf8");
  const re =
    /#define\s+(GHOSTTY_MODE_\w+)\s+\(\s*ghostty_mode_new\(\s*(\d+)\s*,\s*(true|false)\s*\)\s*\)/g;
  const out: ModeDefineEntry[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const cName = m[1] as string;
    const rawValue = Number.parseInt(m[2] as string, 10);
    const ansi = m[3] === "true";
    const packed = (rawValue & 0x7fff) | (ansi ? 1 << 15 : 0);
    const stripped = cName.slice(MODE_TAG_PREFIX.length).toLowerCase();
    out.push({
      tsName: sanitizeTsModeName(stripped),
      cName,
      value: packed,
      ansi,
    });
  }
  return out.sort((a, b) => a.tsName.localeCompare(b.tsName));
}

// --- GhosttyResult → TS error code mapping ---------------------------------
// Hand-authored central table: each GhosttyResult C name maps to the TS
// GhosttyErrorCode string union. Names not in this table fall back to "unknown"
// and a warning is printed during generation. Authoritative names/values from
// ABI discovery §3 (vt/types.h lines 74-86).
const RESULT_CODE_MAP: Record<string, string> = {
  GHOSTTY_SUCCESS: "ok",
  GHOSTTY_OUT_OF_MEMORY: "out_of_memory",
  GHOSTTY_INVALID_VALUE: "invalid_value",
  GHOSTTY_OUT_OF_SPACE: "out_of_space",
  GHOSTTY_NO_VALUE: "no_value",
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

  // Modes are not an enum at this pin — they are `#define` macros parsed
  // directly from vt/modes.h. See ABI discovery §8.
  const modeInfo = await parseModeDefines();
  if (modeInfo.length === 0) {
    console.warn("WARNING: no GHOSTTY_MODE_<NAME> defines found — ModeName union will be empty");
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

  // Expected library version checked at load time against ghostty_build_info.
  // Captured from package.json (ghostty.libraryVersion). At the pin this is
  // "0.1.0-dev". See ABI discovery §2.
  const expectedLibraryVersion = pkgJson.ghostty?.libraryVersion ?? "0.1.0-dev";
  out.push(`export const EXPECTED_LIBRARY_VERSION = ${JSON.stringify(expectedLibraryVersion)} as const;`);
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

  out.push("// Mode tags — parsed from #define GHOSTTY_MODE_<NAME> macros in vt/modes.h.");
  out.push("// Values are packed uint16: `rawValue | (ansi ? 1<<15 : 0)`. See ABI discovery §8.");
  out.push("export const modeNames = [");
  for (const m of modeInfo) out.push(`  ${JSON.stringify(m.tsName)},`);
  out.push("] as const;");
  out.push("export type ModeName = typeof modeNames[number];");
  out.push("export const modeTagByName: Record<ModeName, number> = {");
  for (const m of modeInfo) out.push(`  ${JSON.stringify(m.tsName)}: ${m.value},`);
  out.push("};");
  out.push("");

  // Formatter format enum (GhosttyFormatterFormat at this pin; see ABI §10).
  // The three constants have the `_FORMAT_` infix — GHOSTTY_FORMATTER_FORMAT_PLAIN/_VT/_HTML.
  const formatterFormat = enums.get("GhosttyFormatterFormat") ?? [];
  out.push("export const formatterFormatByName: Record<\"plain\" | \"vt\" | \"html\", number | null> = {");
  const ff = (cName: string) => {
    const hit = formatterFormat.find((e) => e.name === cName);
    return hit ? `${hit.value}` : "null";
  };
  out.push(`  "plain": ${ff("GHOSTTY_FORMATTER_FORMAT_PLAIN")},`);
  out.push(`  "vt":    ${ff("GHOSTTY_FORMATTER_FORMAT_VT")},`);
  out.push(`  "html":  ${ff("GHOSTTY_FORMATTER_FORMAT_HTML")},`);
  out.push("};");
  out.push("");

  await writeFile(OUT_PATH, out.join("\n") + "\n", "utf8");
  console.log(
    `wrote ${OUT_PATH}: ${declaredSymbols.length} declared symbols, ${enums.size} enums, ${probe.structs.length} structs, ${modeInfo.length} modes`,
  );
}

await main();
```

**Executor note:** `RESULT_CODE_MAP` mirrors ABI discovery §3. The 5 FFI result codes are `GHOSTTY_SUCCESS=0`, `GHOSTTY_OUT_OF_MEMORY=-1`, `GHOSTTY_INVALID_VALUE=-2`, `GHOSTTY_OUT_OF_SPACE=-3`, `GHOSTTY_NO_VALUE=-4` — negative signed values. If the discovery doc ever gains new entries, add them here and in Task 6's `GhosttyErrorCode` union. `MODE_TAG_PREFIX` is consumed only by `parseModeDefines()` above (not by any enum lookup) and stays `GHOSTTY_MODE_` per the pinned `vt/modes.h`.

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
grep -c 'ghostty_terminal_new\|ghostty_terminal_free\|ghostty_formatter_terminal_new\|ghostty_formatter_format_alloc' src/internal/generated.ts
# Expected: 4 (each symbol appears exactly once in declaredHeaderSymbols)

bun -e 'const g = await import("./src/internal/generated.ts"); console.log({commit: g.pinnedCommit, modes: g.modeNames.length, resultCodes: Object.keys(g.resultCodeByValue).length});'
# Expected: commit is your pinned SHA; modes === 41; resultCodes === 5.
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

    const e2 = new GhosttyError("boom", { code: "invalid_value", functionName: "ghostty_terminal_resize" });
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
  // FFI result codes (per ABI discovery §3 / src/internal/generated.ts RESULT_CODE_MAP)
  | "ok"
  | "out_of_memory"
  | "invalid_value"
  | "out_of_space"
  | "no_value"
  // Binding-only codes
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
import { detectPlatform, SUPPORTED_PLATFORMS, resolveLibraryPath } from "../../src/internal/path";
import { LibraryNotFoundError, UnsupportedPlatformError } from "../../src/errors";

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
```

- [ ] **Step 2: Run the test — verify it fails**

```bash
bun test test/smoke/ffi.test.ts
```

Expected: module not found.

- [ ] **Step 3: Implement `src/ffi.ts`**

Contents:

```typescript
import { dlopen, FFIType, ptr, toArrayBuffer } from "bun:ffi";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { LibraryCompatibilityError, LibraryNotFoundError } from "./errors";
import { resolveLibraryPath } from "./internal/path";
import {
  declaredHeaderSymbols,
  EXPECTED_LIBRARY_VERSION,
  pinnedCommit,
} from "./internal/generated";

// ---- Symbol declarations ---------------------------------------------------
// Every symbol the binding dlopens is declared here with its bun:ffi signature.
// `requiredSymbols` (exported below) mirrors the keys of this object and is
// what Task 18's ABI smoke asserts against declaredHeaderSymbols.
//
// Signatures are taken from docs/abi/2026-04-22-abi-discovery.md §4, §6.
// If any disagrees with the pinned header, update the discovery doc, this
// table, and the probe in Task 4 together — not independently.

const SYMBOLS = {
  // GhosttyTerminalOptions (16 B) is passed by value. bun:ffi has no struct-
  // by-value, so on darwin-arm64 we split it into two u64s per AAPCS64 register
  // rules. Returns GhosttyResult (signed i32). See ABI discovery §4 + §12
  // Surprise 5.
  ghostty_terminal_new: {
    args: [FFIType.ptr, FFIType.ptr, FFIType.u64, FFIType.u64],  // (alloc, &out, opts_lo, opts_hi)
    returns: FFIType.i32,
  },
  ghostty_terminal_free: {
    args: [FFIType.ptr],
    returns: FFIType.void,
  },
  // Returns void (documented to never fail — ABI §4).
  ghostty_terminal_vt_write: {
    args: [FFIType.ptr, FFIType.ptr, FFIType.u64],   // (term, bytes, len)
    returns: FFIType.void,
  },
  // Returns void.
  ghostty_terminal_reset: {
    args: [FFIType.ptr],
    returns: FFIType.void,
  },
  // 5 args: (term, cols:u16, rows:u16, cell_width_px:u32, cell_height_px:u32).
  ghostty_terminal_resize: {
    args: [FFIType.ptr, FFIType.u16, FFIType.u16, FFIType.u32, FFIType.u32],
    returns: FFIType.i32,
  },
  // bool is an out-param (ptr), not the return. Returns GhosttyResult.
  ghostty_terminal_mode_get: {
    args: [FFIType.ptr, FFIType.u16, FFIType.ptr],   // (term, mode_tag, &out_bool)
    returns: FFIType.i32,
  },
  ghostty_terminal_mode_set: {
    args: [FFIType.ptr, FFIType.u16, FFIType.bool],  // (term, mode_tag, value)
    returns: FFIType.i32,
  },
  // (term, count, keys_ptr, values_ptr_array, out_written_ptr)
  ghostty_terminal_get_multi: {
    args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.ptr, FFIType.ptr],
    returns: FFIType.i32,
  },
  // GhosttyFormatterTerminalOptions (56 B) is passed via hidden pointer on
  // arm64 AAPCS64 (structs > 16 B are passed indirectly). We declare it as
  // FFIType.ptr and pass a pointer to the options bytes.
  ghostty_formatter_terminal_new: {
    args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr],  // (alloc, &out_fmt, term, &options)
    returns: FFIType.i32,
  },
  ghostty_formatter_free: {
    args: [FFIType.ptr],
    returns: FFIType.void,
  },
  ghostty_formatter_format_alloc: {
    args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr],  // (fmt, alloc, &out_ptr, &out_len)
    returns: FFIType.i32,
  },
  ghostty_alloc: {
    args: [FFIType.ptr, FFIType.u64],
    returns: FFIType.ptr,
  },
  // ghostty_free requires length — NOT a libc-style free. See ABI §11.
  ghostty_free: {
    args: [FFIType.ptr, FFIType.ptr, FFIType.u64],   // (allocator_or_null, ptr, len)
    returns: FFIType.void,
  },
  // Build identity. data is a GhosttyBuildInfo enum (c_int); out is typed per
  // the enum value (we use VERSION_STRING=5 → GhosttyString*). ABI §2.
  ghostty_build_info: {
    args: [FFIType.i32, FFIType.ptr],
    returns: FFIType.i32,
  },
  // Runtime struct-layout introspection — returns a null-terminated JSON
  // string describing every C-API struct's layout. Used by Task 18's ABI
  // smoke test to cross-check `structLayouts`. ABI §2 / §12 Surprise 15.
  ghostty_type_json: {
    args: [],
    returns: FFIType.cstring,
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

  // Build-identity check. ABI discovery §2 confirms `ghostty_build_info(data,
  // out)` is available at this pin and returns a semver string (e.g.
  // "0.1.0-dev") via `GHOSTTY_BUILD_INFO_VERSION_STRING=5`. This is NOT a git
  // commit SHA — upstream does not expose one — so this is a weaker check
  // than cryptographic commit verification. The Task 21 README narrows the
  // compatibility claim accordingly.
  //
  // The pinned expected value is captured in generated.ts as
  // EXPECTED_LIBRARY_VERSION; mismatch → LibraryCompatibilityError.
  //
  //   GhosttyString layout (ABI §2/§9): { uint8_t *ptr @ 0; size_t len @ 8 }
  //   Total 16 bytes. The ptr aliases into library-owned static storage;
  //   we decode as UTF-8 and copy into a JS string.
  const GHOSTTY_BUILD_INFO_VERSION_STRING = 5;
  const stringOut = new ArrayBuffer(16);
  const infoResult = (opened.symbols.ghostty_build_info as any)(
    GHOSTTY_BUILD_INFO_VERSION_STRING,
    ptr(new Uint8Array(stringOut)),
  );
  if (infoResult !== 0) {
    opened.close();
    throw new LibraryCompatibilityError(
      `ghostty_build_info(VERSION_STRING) failed with code ${infoResult}`,
      { details: `build_info result ${infoResult}`, expectedCommit: pinnedCommit },
    );
  }
  const sView = new DataView(stringOut);
  const sPtr = Number(sView.getBigUint64(0, true));
  const sLen = Number(sView.getBigUint64(8, true));
  if (sPtr === 0 || sLen === 0) {
    loadedIdentity = "";
  } else {
    const bytes = new Uint8Array(toArrayBuffer(sPtr, 0, sLen));
    loadedIdentity = new TextDecoder("utf-8").decode(bytes);
  }

  if (loadedIdentity !== EXPECTED_LIBRARY_VERSION) {
    opened.close();
    throw new LibraryCompatibilityError(
      `libghostty-vt version "${loadedIdentity}" does not match expected "${EXPECTED_LIBRARY_VERSION}"`,
      {
        details: `version mismatch: got "${loadedIdentity}", expected "${EXPECTED_LIBRARY_VERSION}"`,
        expectedCommit: pinnedCommit,
      },
    );
  }

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
import { writeStruct } from "../../src/internal/sized-struct";
import { readCString, writeCString } from "../../src/internal/marshal";

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
import type { StructLayout } from "./generated";

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
export { modeNames, type ModeName } from "./internal/generated";

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
bun run typecheck
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
import { Terminal } from "../../src/terminal";
import { UseAfterCloseError } from "../../src/errors";
import * as ffi from "../../src/ffi";

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
import { ptr, type Pointer } from "bun:ffi";
import { getLib } from "./ffi";
import { GhosttyError, UseAfterCloseError } from "./errors";
import { resultCodeByValue, structLayouts } from "./internal/generated";
import { writeStruct } from "./internal/sized-struct";
import type {
  ModeName,
  TerminalOptions,
  TerminalSnapshot,
} from "./types";

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
        code: "invalid_value",
        functionName: "Terminal.constructor",
      });
    }
    if (!Number.isInteger(opts.rows) || opts.rows <= 0) {
      throw new GhosttyError("rows must be a positive integer", {
        code: "invalid_value",
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

    // APC tuning (apc_max_bytes / apc_max_bytes_kitty) is NOT a field on
    // GhosttyTerminalOptions at this pin — it is set post-construction via
    // ghostty_terminal_set(term, GHOSTTY_TERMINAL_OPT_APC_MAX_BYTES, ...).
    // Pass 1 does not expose APC tuning (deferred to Pass 2+); the library
    // uses its upstream defaults. See Task 21 README APC footnote.
    const fields: Record<string, number | bigint | boolean> = {
      cols: opts.cols,
      rows: opts.rows,
      max_scrollback: BigInt(opts.maxScrollback ?? 1000),  // size_t
    };

    const optBytes = writeStruct(layout, fields);

    // ghostty_terminal_new passes GhosttyTerminalOptions BY VALUE. bun:ffi has
    // no struct-by-value, so on darwin-arm64 (AAPCS64) we split the 16-byte
    // options struct into two u64 register-sized args. The output handle is
    // written back through the 2nd arg (pointer-to-pointer). Return value is
    // GhosttyResult (signed i32). See ABI discovery §4 + §12 Surprise 5.
    const u64s = new BigUint64Array(optBytes.buffer, optBytes.byteOffset, 2);
    const outSlot = new BigUint64Array(1);

    const result = lib.symbols.ghostty_terminal_new(
      null,
      ptr(outSlot),
      u64s[0]!,
      u64s[1]!,
    );
    checkResult(result, "ghostty_terminal_new");

    const handleBig = outSlot[0]!;
    if (handleBig === 0n) {
      throw new GhosttyError("ghostty_terminal_new returned OK but out pointer is null", {
        code: "out_of_memory",
        functionName: "ghostty_terminal_new",
      });
    }
    this.#handle = Number(handleBig) as Pointer;
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

`ptr` is already imported in Task 11 — no import change needed here.

Replace the `vtWrite` stub in `src/terminal.ts`:

```typescript
  vtWrite(bytes: Uint8Array): void {
    this.#assertOpen();
    if (bytes.length === 0) return;
    const lib = getLib();
    // ghostty_terminal_vt_write returns void (documented to never fail — ABI §4).
    // Zero-copy: ptr(bytes) aliases the Uint8Array's backing buffer for the
    // duration of the call.
    lib.symbols.ghostty_terminal_vt_write(
      this.#handle,
      ptr(bytes),
      BigInt(bytes.length),
    );
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
        code: "invalid_value",
        functionName: "Terminal.resize",
      });
    }
    if (!Number.isInteger(rows) || rows <= 0) {
      throw new GhosttyError("rows must be a positive integer", {
        code: "invalid_value",
        functionName: "Terminal.resize",
      });
    }
    if (cellPx !== undefined) {
      this.#cellPx = { width: cellPx.width, height: cellPx.height };
    }
    const lib = getLib();
    // Signature per ABI §4: (term, cols:u16, rows:u16, cell_width_px:u32,
    // cell_height_px:u32) → GhosttyResult. cols/rows narrow to u16 at the
    // FFI layer; cellPx widths pass as u32.
    const result = lib.symbols.ghostty_terminal_resize(
      this.#handle,
      cols,
      rows,
      this.#cellPx.width,
      this.#cellPx.height,
    );
    checkResult(result, "ghostty_terminal_resize");
  }

  reset(): void {
    this.#assertOpen();
    const lib = getLib();
    // Returns void (ABI §4).
    lib.symbols.ghostty_terminal_reset(this.#handle);
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

The implementation uses `ghostty_terminal_get_multi`. Its `values` parameter is `void**` — an array of N caller-allocated output pointers, each pointing to a slot sized for its specific key's output type (ABI discovery §4 get_multi details + §9 per-key output types). This is NOT a flat byte buffer; each key has its own typed slot.

Add a helper at the top of `src/terminal.ts` after imports:

```typescript
// Map of snapshot field name → GhosttyTerminalData enum NAME + output slot
// kind. Values come from GhosttyTerminalDataValues at runtime; names are
// verified against the generated file. Each slot kind matches the per-key
// output type in ABI §9. If a key is missing from the generated enum, the
// helper throws a clear error rather than silently returning zero.
import { GhosttyTerminalDataValues } from "./internal/generated";

type SlotKind = "u16" | "bool" | "i32" | "size_t" | "string";

const SNAPSHOT_KEYS: Array<{ name: string; key: keyof typeof GhosttyTerminalDataValues; kind: SlotKind }> = [
  { name: "cols",           key: "GHOSTTY_TERMINAL_DATA_COLS"             as const, kind: "u16" },
  { name: "rows",           key: "GHOSTTY_TERMINAL_DATA_ROWS"             as const, kind: "u16" },
  { name: "cursorX",        key: "GHOSTTY_TERMINAL_DATA_CURSOR_X"         as const, kind: "u16" },
  { name: "cursorY",        key: "GHOSTTY_TERMINAL_DATA_CURSOR_Y"         as const, kind: "u16" },
  { name: "cursorVisible",  key: "GHOSTTY_TERMINAL_DATA_CURSOR_VISIBLE"   as const, kind: "bool" },
  { name: "activeScreen",   key: "GHOSTTY_TERMINAL_DATA_ACTIVE_SCREEN"    as const, kind: "i32" },
  { name: "scrollbackRows", key: "GHOSTTY_TERMINAL_DATA_SCROLLBACK_ROWS"  as const, kind: "size_t" },
  { name: "title",          key: "GHOSTTY_TERMINAL_DATA_TITLE"            as const, kind: "string" },
  { name: "pwd",            key: "GHOSTTY_TERMINAL_DATA_PWD"              as const, kind: "string" },
  // CURSOR_STYLE, MOUSE_TRACKING, WIDTH_PX/HEIGHT_PX, color data, and Kitty
  // fields are Pass 2+. See ABI §9 for the full enum.
];

function slotByteSize(kind: SlotKind): number {
  switch (kind) {
    case "u16":    return 2;
    case "bool":   return 1;
    case "i32":    return 4;
    case "size_t": return 8;
    case "string": return 16;  // GhosttyString: {uint8_t* ptr@0, size_t len@8}
  }
}
```

**Executor note:** The names above are verified against ABI discovery §9. Every key in `SNAPSHOT_KEYS` must be present in `GhosttyTerminalDataValues` (from `src/internal/generated.ts`); if a key is missing at a future pin, the runtime helper throws. Additional keys (CURSOR_STYLE 72 B, SCROLLBAR 24 B, COLOR_* 3 B, etc.) are deferred to Pass 2+.

At the top of `src/terminal.ts`, augment the `bun:ffi` import to include `toArrayBuffer` (`ptr` is already imported in Task 11):

```typescript
import { ptr, toArrayBuffer, type Pointer } from "bun:ffi";
```

Replace the `snapshot()` stub:

```typescript
  snapshot(): TerminalSnapshot {
    this.#assertOpen();
    const lib = getLib();

    const n = SNAPSHOT_KEYS.length;

    // Build the keys array (i32 each — GhosttyTerminalData is c_int-backed).
    const keysBuf = new Int32Array(n);
    // Allocate one typed slot per key. We keep the slot ArrayBuffers alive
    // via the `slots` array so the pointers we capture in `ptrArray` remain
    // valid for the duration of the FFI call.
    const slots: ArrayBuffer[] = new Array(n);
    const ptrArray = new BigUint64Array(n);

    for (let i = 0; i < n; i++) {
      const entry = SNAPSHOT_KEYS[i];
      if (!entry) continue;
      const v = GhosttyTerminalDataValues[entry.key];
      if (v === undefined) {
        throw new GhosttyError(`GhosttyTerminalData.${entry.key} is missing at the pinned Ghostty commit`, {
          code: "unknown",
          functionName: "Terminal.snapshot",
        });
      }
      keysBuf[i] = v;
      const slot = new ArrayBuffer(slotByteSize(entry.kind));
      slots[i] = slot;
      ptrArray[i] = BigInt(ptr(new Uint8Array(slot)));
    }

    const outWritten = new BigUint64Array(1);
    const result = lib.symbols.ghostty_terminal_get_multi(
      this.#handle,
      BigInt(n),
      ptr(keysBuf),
      ptr(ptrArray),
      ptr(outWritten),
    );
    checkResult(result, "ghostty_terminal_get_multi");

    // Decode each slot per its kind. String values (TITLE, PWD) are borrowed
    // — the ptr aliases into terminal-owned memory valid only until the next
    // mutating call. We copy them into JS strings immediately (ABI §4/§9).
    const raw: Record<string, number | boolean | string | undefined> = {};
    for (let i = 0; i < n; i++) {
      const entry = SNAPSHOT_KEYS[i];
      if (!entry) continue;
      const slot = slots[i];
      if (!slot) continue;
      const view = new DataView(slot);
      switch (entry.kind) {
        case "u16":
          raw[entry.name] = view.getUint16(0, true);
          break;
        case "bool":
          raw[entry.name] = view.getUint8(0) !== 0;
          break;
        case "i32":
          raw[entry.name] = view.getInt32(0, true);
          break;
        case "size_t":
          raw[entry.name] = Number(view.getBigUint64(0, true));
          break;
        case "string": {
          const strPtr = view.getBigUint64(0, true);
          const strLen = Number(view.getBigUint64(8, true));
          if (strPtr === 0n || strLen === 0) {
            raw[entry.name] = undefined;
          } else {
            // Copy immediately — borrowed pointer, invalidated by the next
            // mutating terminal call.
            const borrowed = new Uint8Array(
              toArrayBuffer(Number(strPtr), 0, strLen),
            );
            const copy = new Uint8Array(strLen);
            copy.set(borrowed);
            raw[entry.name] = new TextDecoder("utf-8").decode(copy);
          }
          break;
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
        style: "block",  // CURSOR_STYLE returns a 72 B GhosttyStyle struct; Pass 2+.
      },
      activeScreen,
      title: raw.title as string | undefined,
      pwd: raw.pwd as string | undefined,
      scrollbackRows: raw.scrollbackRows as number,
      mouseTracking: "none",  // MOUSE_TRACKING returns a bool; richer reporting is Pass 2+.
    };
  }
```

**Executor note:** `ghostty_terminal_get_multi`'s ABI is authoritatively recorded in `docs/abi/2026-04-22-abi-discovery.md` §4 and §9. The `values` parameter is `void**` — one pointer per key, each pointing to a typed slot sized per ABI §9. Do NOT replace this with a single flat byte buffer; that was the plan's original (incorrect) design.

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
import { modeTagByName } from "./internal/generated";
```

Add a helper near the top of the class-module (before the class):

```typescript
function modeTagFromName(name: ModeName): number {
  const v = (modeTagByName as Record<string, number | undefined>)[name];
  if (v === undefined) {
    throw new GhosttyError(`unknown ModeName: ${name}`, {
      code: "invalid_value",
      functionName: "Terminal.mode",
    });
  }
  return v;
}
```

`modeTagByName` is generated from the pinned header (Task 5). Values are **packed `uint16_t`s** (`value | (ansi ? 1<<15 : 0)`, per ABI §8), NOT enum indices. There is no string-prefix guessing — the map is the source of truth.

Replace the `mode` and `setMode` stubs. Per ABI §4, `ghostty_terminal_mode_get` writes the boolean value into an out-param and returns a `GhosttyResult`:

```typescript
  mode(name: ModeName): boolean {
    this.#assertOpen();
    const tag = modeTagFromName(name);
    const lib = getLib();
    const outBool = new Uint8Array(1);
    const result = lib.symbols.ghostty_terminal_mode_get(
      this.#handle,
      tag,
      ptr(outBool),
    );
    checkResult(result, "ghostty_terminal_mode_get");
    return outBool[0] !== 0;
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
import { Terminal } from "../../src/terminal";
import { Formatter } from "../../src/formatter";
import { UseAfterCloseError } from "../../src/errors";

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
import { getLib } from "./ffi";
import { checkResult } from "./terminal";
import { GhosttyError, UseAfterCloseError } from "./errors";
import { formatterFormatByName, structLayouts } from "./internal/generated";
import { writeStruct } from "./internal/sized-struct";
import { Terminal } from "./terminal";
import type { FormatterOptions } from "./types";

function formatEnum(format: "plain" | "vt" | "html"): number {
  const v = formatterFormatByName[format];
  if (v === null || v === undefined) {
    throw new GhosttyError(
      `No GhosttyFormatterFormat value for "${format}" at the pinned Ghostty commit.`,
      { code: "unknown", functionName: "Formatter.constructor" },
    );
  }
  return v;
}

// API note (Matt decision 3b): we keep the public API as
// `new Formatter(opts)` + `fmt.format(term)` / `fmt.formatString(term)`.
// Internally each call constructs a native formatter via
// ghostty_formatter_terminal_new (bound to a specific Terminal), invokes
// ghostty_formatter_format_alloc, copies the output into JS-owned memory,
// then frees the buffer and the formatter. The slight per-call native alloc
// cost buys us a simpler JS API that doesn't force users to thread a
// Terminal through the constructor. Formatter instances hold no native
// resources between calls; `close()` just flips a closed flag so subsequent
// calls throw UseAfterCloseError (mirroring Terminal's lifecycle contract).
export class Formatter {
  #opts: FormatterOptions;
  #closed = false;

  constructor(opts: FormatterOptions) {
    this.#opts = opts;
    // Validate format enum eagerly so construction errors surface here, not
    // on first format() call.
    formatEnum(opts.format);
  }

  close(): void {
    this.#closed = true;
  }

  [Symbol.dispose](): void {
    this.close();
  }

  format(term: Terminal): Uint8Array {
    this.#assertOpen();
    const lib = getLib();

    // Build GhosttyFormatterTerminalOptions (56 B, sized). The nested `extra`
    // sub-struct (32 B @ offset 16) itself contains a nested `screen`
    // sub-struct (16 B @ offset 16). All three layers are sized; writeStruct
    // auto-fills each `size` field. ABI §7 for authoritative field offsets.
    const outerLayout  = structLayouts["GhosttyFormatterTerminalOptions"];
    const extraLayout  = structLayouts["GhosttyFormatterTerminalExtra"];
    const screenLayout = structLayouts["GhosttyFormatterScreenExtra"];
    if (!outerLayout || !extraLayout || !screenLayout) {
      throw new GhosttyError(
        "generated.ts missing formatter options layouts — rerun gen-bindings",
        { code: "unknown", functionName: "Formatter.format" },
      );
    }

    const screenBytes = writeStruct(screenLayout, {
      cursor:         this.#opts.cursor         ?? false,
      style:          this.#opts.style          ?? false,
      hyperlink:      this.#opts.hyperlink      ?? false,
      protection:     this.#opts.protection     ?? false,
      kitty_keyboard: this.#opts.kittyKeyboard  ?? false,
      charsets:       this.#opts.charsets       ?? false,
    });

    const extraBytes = writeStruct(extraLayout, {
      palette:          this.#opts.palette         ?? false,
      modes:            this.#opts.modes           ?? false,
      scrolling_region: this.#opts.scrollingRegion ?? false,
      tabstops:         this.#opts.tabstops        ?? false,   // no underscore in the field name
      pwd:              this.#opts.pwd             ?? false,
      keyboard:         this.#opts.keyboard        ?? false,
      screen:           screenBytes,
    });

    const optsBytes = writeStruct(outerLayout, {
      emit:      formatEnum(this.#opts.format),
      unwrap:    this.#opts.unwrap ?? false,
      trim:      this.#opts.trim   ?? false,
      extra:     extraBytes,
      selection: 0n,  // null ptr — Pass 1 does not expose selection
    });

    // ghostty_formatter_terminal_new(alloc, &out_fmt, term, &opts_bytes).
    // 56 B options pass via hidden pointer on arm64 AAPCS64. ABI §6.
    const outFmt = new BigUint64Array(1);
    const r1 = lib.symbols.ghostty_formatter_terminal_new(
      null,
      ptr(outFmt),
      term._handle,
      ptr(optsBytes),
    );
    checkResult(r1, "ghostty_formatter_terminal_new");
    const fmtHandle = Number(outFmt[0]!) as Pointer;
    if (!fmtHandle) {
      throw new GhosttyError(
        "ghostty_formatter_terminal_new returned OK but out pointer is null",
        { code: "unknown", functionName: "ghostty_formatter_terminal_new" },
      );
    }

    try {
      const outPtr = new BigUint64Array(1);
      const outLen = new BigUint64Array(1);
      const r2 = lib.symbols.ghostty_formatter_format_alloc(
        fmtHandle,
        null,
        ptr(outPtr),
        ptr(outLen),
      );
      checkResult(r2, "ghostty_formatter_format_alloc");

      const bufPtr = outPtr[0]!;
      const len = Number(outLen[0]!);
      if (bufPtr === 0n || len === 0) return new Uint8Array(0);

      // Copy bytes immediately, then free the native buffer in finally so
      // an exception while copying cannot leak native memory. ghostty_free
      // requires the length (not a libc free — ABI §11).
      try {
        const copy = new Uint8Array(len);
        copy.set(new Uint8Array(toArrayBuffer(Number(bufPtr), 0, len)));
        return copy;
      } finally {
        lib.symbols.ghostty_free(null, Number(bufPtr), BigInt(len));
      }
    } finally {
      lib.symbols.ghostty_formatter_free(fmtHandle);
    }
  }

  formatString(term: Terminal): string {
    return new TextDecoder("utf-8").decode(this.format(term));
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new UseAfterCloseError("Formatter has been closed", {
        handleType: "Formatter",
      });
    }
  }
}
```

**Executor note:** the formatter constructor signature is unambiguous at this pin (ABI §6): `ghostty_formatter_terminal_new(alloc, &out, term, opts)` with options passed by value. On arm64 AAPCS64 the 56 B options are passed indirectly via a hidden pointer, which we match with `FFIType.ptr` and `ptr(optsBytes)` — no shim needed. `GhosttyFormatterTerminalOptions` is sized (first field `size_t size`); the nested `extra` (32 B) and `screen` (16 B) sub-structs are also sized. `writeStruct` fills each `size` field from the layout.

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
import { Terminal } from "../../src/terminal";
import { Formatter } from "../../src/formatter";

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
import { listFixtures, runFixture } from "../helpers/fixture-harness";
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
} from "../../src/internal/generated";
import { getLib, requiredSymbols } from "../../src/ffi";

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
    expect(structLayouts["GhosttyFormatterTerminalOptions"]).toBeDefined();
    expect(structLayouts["GhosttyFormatterTerminalOptions"]!.size).toBeGreaterThan(0);
    expect(structLayouts["GhosttyFormatterTerminalExtra"]).toBeDefined();
    expect(structLayouts["GhosttyFormatterScreenExtra"]).toBeDefined();
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

  it("ghostty_type_json() agrees with checked-in structLayouts (ABI §12 bonus check)", () => {
    // Runtime cross-check: libghostty exposes ghostty_type_json() which
    // returns a JSON string describing every C-API struct's layout. For
    // each struct we construct (GhosttyTerminalOptions and the formatter
    // options triple), assert size/align and each field's offset/size
    // agree. This catches any drift that sneaks past the compile-time
    // probe (e.g. the dylib shipping with a different layout than the
    // headers imply — which should never happen but has historically
    // caught real bugs in other FFI bindings).
    const lib = getLib();
    const jsonPtr = (lib.symbols as any).ghostty_type_json();
    // bun:ffi returns cstring as a JS string directly.
    const parsed: Record<string, { size: number; align: number; fields: Array<{ name: string; offset: number; size: number }> }> =
      JSON.parse(typeof jsonPtr === "string" ? jsonPtr : String(jsonPtr));

    const namesToCheck = [
      "GhosttyTerminalOptions",
      "GhosttyFormatterTerminalOptions",
      "GhosttyFormatterTerminalExtra",
      "GhosttyFormatterScreenExtra",
    ];
    for (const name of namesToCheck) {
      const runtime = parsed[name];
      const checked = structLayouts[name];
      expect(runtime, `ghostty_type_json is missing ${name}`).toBeDefined();
      expect(checked, `structLayouts is missing ${name}`).toBeDefined();
      expect(checked!.size).toBe(runtime!.size);
      expect(checked!.align).toBe(runtime!.align);
      for (const f of runtime!.fields) {
        const cf = checked!.fields[f.name];
        expect(cf, `${name}.${f.name} missing from checked-in layout`).toBeDefined();
        expect(cf!.offset).toBe(f.offset);
        expect(cf!.size).toBe(f.size);
      }
    }
  });
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
        run: bun run typecheck

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
bun run typecheck
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
export { Terminal } from "./terminal";
export { Formatter } from "./formatter";
export {
  GhosttyError,
  LibraryNotFoundError,
  UnsupportedPlatformError,
  LibraryCompatibilityError,
  UseAfterCloseError,
} from "./errors";
export type { GhosttyErrorCode } from "./errors";
export {
  setLibraryPath,
  isLoaded,
  libraryInfo,
} from "./ffi";
export type { LibraryInfo } from "./ffi";
export {
  modeNames,
} from "./internal/generated";
export type {
  RGB,
  PaletteIndex,
  CursorStyle,
  MouseTracking,
  ModeName,
  TerminalOptions,
  TerminalSnapshot,
  FormatterOptions,
} from "./types";
export { pinnedCommit } from "./internal/generated";
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

**Platforms (Pass 1):** `darwin-arm64` only. The current FFI layer relies on AAPCS64 register-split rules for passing Ghostty's by-value struct arguments without a C shim. Other platforms (Linux x64, darwin-x64, Windows) are on the roadmap — adding them will likely require a small C shim to bridge the struct-by-value boundary. See the design spec in the [source repository](https://github.com/REPLACE_WITH_REPO_URL) under `docs/superpowers/specs/`.

**APC tuning (Pass 1):** this release does not expose `apc_max_bytes` / `apc_max_bytes_kitty` tuning. The terminal uses upstream libghostty-vt defaults. Pass 2+ will add post-construction setters — `Terminal.setApcMaxBytes(n)` and `Terminal.setApcMaxBytesKitty(n)` — wrapping `ghostty_terminal_set(term, GHOSTTY_TERMINAL_OPT_APC_MAX_BYTES, ...)` if user demand surfaces.

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

**The loaded library's ABI must be compatible with the pinned Ghostty commit.** Pass 1 verifies compatibility through three channels: (1) every required FFI symbol must resolve at load time or `LibraryCompatibilityError` is thrown; (2) the checked-in struct layouts (`src/internal/generated.ts`) must match the probe output for the pinned headers, and the ABI smoke test additionally cross-checks them against `ghostty_type_json()` at runtime; (3) `ghostty_build_info(GHOSTTY_BUILD_INFO_VERSION_STRING)` must return the expected semver string (e.g. `0.1.0-dev`) — mismatch raises `LibraryCompatibilityError`. Note that `ghostty_build_info` returns **semver, not a git commit SHA** at this pin; we cannot cryptographically verify the dylib was built from our pinned commit via the C API alone. If upstream later exposes a commit SHA via `ghostty_build_info` or similar, this guarantee narrows accordingly. Until then, override libraries are best-effort — a library built from a compatible commit that happens to resolve all required symbols and match the expected semver can still disagree on enum values or callback shapes, with undefined runtime behavior.
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
bun run typecheck
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
- `structLayouts["GhosttyTerminalOptions"]` / `["GhosttyFormatterTerminalOptions"]` / `["GhosttyFormatterTerminalExtra"]` / `["GhosttyFormatterScreenExtra"]` — same key strings used in Tasks 11, 16, 18.
- All `.ts` source imports use `.js` suffix (NodeNext resolution); tests import the runtime modules via `.js` too.

No inconsistencies found.

---

**Plan complete and saved to `docs/superpowers/plans/2026-04-22-ts-libghostty-pass-1.md`.**
