# ts-libghostty Pass 1 Implementation Plan — Foundation + Terminal + Formatter

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** `docs/superpowers/specs/2026-04-22-ts-libghostty-design.md`

**Pass:** 1 of ~5. Pass 1 delivers byte-in → text-dump-out end-to-end with full ABI safety. Subsequent passes add effect callbacks (2), grid-reading via `RenderState` (3), `KeyEncoder` (4), and polish like modes/colors/viewport/`cellAt` (5).

**Goal:** Ship a working, testable v0.1.0 of `ts-libghostty` exposing `Terminal` (construction, `vtWrite`, `resize`, `reset`, `snapshot`, `mode`/`setMode`, lifecycle) and `Formatter` (text/VT/HTML dump), with the full native-boundary safety story from spec §5 (lazy dlopen, symbol manifest verification, struct-layout probe, use-after-close, APC bounds) and the full error hierarchy from spec §4.6.

**Architecture:** TypeScript on Bun ≥ 1.3.13. `bun:ffi` wraps a prebuilt `libghostty-vt.dylib` built from a pinned Ghostty commit. Build pipeline: clone Ghostty at pin, zig-build the dylib, compile a small C probe against the pinned headers to emit struct layout info, run a TS generator that parses `vt.h` for enum values + symbol manifest and merges in the probe output to produce a checked-in `src/internal/generated.ts`. Library loads lazily on first native use and verifies every declared symbol before exposing any usable object.

**Tech Stack:** Bun (runtime + `bun:ffi` + `bun test` + `bun pm pack`), Zig (for Ghostty's own build, provides libghostty-vt), C (the probe), TypeScript 5.x, GitHub Actions (CI on `macos-latest`).

**Pinned upstream:** Ghostty commit will be chosen at task start (see Task 2); record it in `package.json` `ghostty.commit`. Use a recent commit on `main` that definitely exposes `libghostty-vt` as a build target and the `ghostty_*` symbols referenced below. If a referenced symbol does not exist at the chosen pin, the symbol-manifest test in Task 20 will fail loud and the executor should record the actual name from `vendor/ghostty/include/ghostty/vt.h` and update the plan before continuing.

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

  .github/
    workflows/
      ci.yml
```

Each file has exactly one responsibility. `src/ffi.ts` is the only place that calls `dlopen`; every other source file uses the typed symbol table it exports. `src/internal/generated.ts` is the only place where raw C layout/enum values live; any binding code reads from it, never hand-codes an enum value.

---

## Task 1: Project scaffolding

**Files:**
- Create: `.gitignore`, `.gitattributes`, `.npmignore`, `package.json`, `tsconfig.json`, `README.md`, `LICENSE`, `LICENSE_GHOSTTY`

- [ ] **Step 1: Create `.gitignore`**

Contents:

```gitignore
node_modules/
bun.lockb
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
    "build:probe": "cc -O2 -I vendor/ghostty/include -o .tmp/probe-layout scripts/probe-layout.c && mkdir -p .tmp && .tmp/probe-layout > .tmp/layout.json",
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
    "module": "ESNext",
    "moduleResolution": "bundler",
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
    "verbatimModuleSyntax": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "test"]
}
```

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

- [ ] **Step 8: Create `README.md`** (stub; filled in Task 20)

Contents:

```markdown
# ts-libghostty

Unofficial TypeScript binding over [libghostty-vt](https://github.com/ghostty-org/ghostty),
the VT state machine extracted from [Ghostty](https://ghostty.org). For Bun.

**Status: pre-1.0, API unstable.** Pinned to Ghostty commit `<see package.json ghostty.commit>`.

**Platforms:** `darwin-arm64` (more on demand).

Full README filled in by Task 20.

## License

- `ts-libghostty` code: Apache-2.0 (see `LICENSE`).
- Redistributed `libghostty-vt.dylib` in `prebuilds/`: MIT (see `LICENSE_GHOSTTY`,
  matching upstream Ghostty's license at the pinned commit).
```

- [ ] **Step 9: Initialize Bun install**

```bash
bun install
```

Expected: creates `bun.lockb`, installs `@types/bun` and `typescript`. No other deps.

- [ ] **Step 10: Commit**

```bash
git add .gitignore .gitattributes .npmignore package.json tsconfig.json README.md LICENSE LICENSE_GHOSTTY bun.lockb
git commit -m "chore: project scaffolding for ts-libghostty"
```

---

## Task 2: Pin Ghostty and build `libghostty-vt.dylib`

**Files:**
- Create: `scripts/build-libghostty.sh`
- Modify: `package.json` (set `ghostty.commit`), `LICENSE_GHOSTTY` (replace with upstream text)
- Create: `prebuilds/darwin-arm64/` (directory)

This task picks the Ghostty commit the pass is bound to and produces the prebuilt dylib consumed by all later tasks.

- [ ] **Step 1: Pick the Ghostty commit**

Open `https://github.com/ghostty-org/ghostty` and copy the SHA of a recent commit on `main` that has `include/ghostty/vt.h` and exposes `libghostty-vt` as a Zig build target. Record it. Reasonable default: the tip of `main` at the time the task is executed.

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

## Task 3: Struct-layout probe

**Files:**
- Create: `scripts/probe-layout.c`
- Create: `.tmp/` (implicitly via the build script; not committed)

The probe is a tiny C program compiled against Ghostty's headers that emits struct sizes/alignments/offsets as JSON. This is the authoritative source for layout at runtime — no regex-parsing struct definitions in TypeScript.

- [ ] **Step 1: Write `scripts/probe-layout.c`**

The probe covers every struct the binding writes or reads in Pass 1. At Pass 1 that is just:

- `GhosttyTerminalOptions` (for `Terminal` construction; pass plain-struct style per spec §5.3)
- `GhosttyFormatterOptions` (for `Formatter` construction; verify whether sized or plain at the pin)

Actual field lists must be read from `vendor/ghostty/include/ghostty/vt.h` at the pinned commit. The skeleton below declares the structure; the executor fills in the exact `offsetof` calls for each field present at the pin.

Contents:

```c
/*
 * ts-libghostty struct-layout probe.
 * Compiled against the pinned Ghostty headers; emits JSON describing the
 * ABI of every struct the binding writes or reads.
 *
 * To add a struct: add a new probe_struct_<name>() function that prints one
 * JSON object into the array, then call it from main().
 */
#include <stdio.h>
#include <stddef.h>
#include <stdint.h>
#include <stdbool.h>

#include "ghostty/vt.h"

static int first_entry = 1;

static void begin_entry(void) {
  if (!first_entry) printf(",\n");
  first_entry = 0;
}

static void emit_struct(const char *name, size_t size, size_t align) {
  begin_entry();
  printf("  {\n");
  printf("    \"name\": \"%s\",\n", name);
  printf("    \"size\": %zu,\n", size);
  printf("    \"align\": %zu,\n", align);
  printf("    \"fields\": [");
}

static int first_field;

static void emit_field(const char *name, size_t offset, size_t size) {
  if (!first_field) printf(",");
  first_field = 0;
  printf("\n      {\"name\": \"%s\", \"offset\": %zu, \"size\": %zu}",
         name, offset, size);
}

static void end_struct(void) {
  printf("\n    ]\n  }");
}

/* ===== Probe each struct ===== */

static void probe_terminal_options(void) {
  /* Fill in from vt.h at the pinned commit.
   * The Go binding and spec reference: cols, rows, max_scrollback.
   * There may be more fields; enumerate them all from the header. */
  emit_struct("GhosttyTerminalOptions",
              sizeof(GhosttyTerminalOptions),
              _Alignof(GhosttyTerminalOptions));
  first_field = 1;
  emit_field("cols",           offsetof(GhosttyTerminalOptions, cols),           sizeof(((GhosttyTerminalOptions*)0)->cols));
  emit_field("rows",           offsetof(GhosttyTerminalOptions, rows),           sizeof(((GhosttyTerminalOptions*)0)->rows));
  emit_field("max_scrollback", offsetof(GhosttyTerminalOptions, max_scrollback), sizeof(((GhosttyTerminalOptions*)0)->max_scrollback));
  /* TODO executor: add any other fields present at the pin. */
  end_struct();
}

static void probe_formatter_options(void) {
  /* GhosttyFormatterOptions per vt.h. Check whether it uses the sized-struct
   * convention (first field is `size_t size`) or is plain. Add every field. */
  emit_struct("GhosttyFormatterOptions",
              sizeof(GhosttyFormatterOptions),
              _Alignof(GhosttyFormatterOptions));
  first_field = 1;
  /* Executor: enumerate fields from the pinned header. */
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

**Note for executor:** if `GhosttyTerminalOptions` or `GhosttyFormatterOptions` is named differently at the pinned commit, rename the probe accordingly and update the imports in Tasks 12 and 18.

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

## Task 4: Bindings generator

**Files:**
- Create: `scripts/gen-bindings.ts`, `src/internal/generated.ts`

The generator parses `vendor/ghostty/include/ghostty/vt.h` for enum values and a symbol manifest, merges the probe output for struct layout, and emits a checked-in `src/internal/generated.ts`.

- [ ] **Step 1: Write `scripts/gen-bindings.ts`**

Contents:

```typescript
/*
 * Parses vendor/ghostty/include/ghostty/vt.h for enum values and function
 * symbols, merges .tmp/layout.json (produced by probe-layout.c), and emits
 * src/internal/generated.ts.
 */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const ROOT = process.cwd();
const HEADER_DIR = join(ROOT, "vendor/ghostty/include/ghostty");
const PROBE_PATH = join(ROOT, ".tmp/layout.json");
const OUT_PATH = join(ROOT, "src/internal/generated.ts");

interface ProbeStruct {
  name: string;
  size: number;
  align: number;
  fields: { name: string; offset: number; size: number }[];
}

async function readAllHeaders(): Promise<string> {
  // Recursively read every .h file under HEADER_DIR and concatenate.
  const { readdir, stat } = await import("node:fs/promises");
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

// Parse `enum TAG { FOO = 1, BAR = 2, ... };` and `typedef enum { ... } TAG;`.
// Returns map of enum-tag -> array of {name, value}.
function parseEnums(src: string): Map<string, Array<{ name: string; value: number }>> {
  const out = new Map<string, Array<{ name: string; value: number }>>();
  const enumRe =
    /typedef\s+enum\s*(?:\w+\s*)?\{([^}]*)\}\s*(\w+)\s*;|enum\s+(\w+)\s*\{([^}]*)\}\s*;/g;
  let m: RegExpExecArray | null;
  while ((m = enumRe.exec(src)) !== null) {
    const tag = m[2] ?? m[3];
    const body = m[1] ?? m[4];
    if (!tag || !body) continue;
    const entries: Array<{ name: string; value: number }> = [];
    let implicit = 0;
    for (const rawLine of body.split(",")) {
      const line = rawLine.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*/g, "").trim();
      if (!line) continue;
      const eq = line.indexOf("=");
      if (eq >= 0) {
        const name = line.slice(0, eq).trim();
        const valueText = line.slice(eq + 1).trim();
        const value = Number(valueText);
        if (!Number.isFinite(value)) continue;
        entries.push({ name, value });
        implicit = value + 1;
      } else {
        const name = line.trim();
        entries.push({ name, value: implicit });
        implicit += 1;
      }
    }
    out.set(tag, entries);
  }
  return out;
}

// Parse `<ret> ghostty_xxx(...)` declarations and return the set of symbol names.
function parseSymbols(src: string): Set<string> {
  const out = new Set<string>();
  const re = /\b(ghostty_[A-Za-z0-9_]+)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const name = m[1];
    if (name) out.add(name);
  }
  return out;
}

async function main() {
  const src = await readAllHeaders();
  const enums = parseEnums(src);
  const symbols = parseSymbols(src);
  const probe: { structs: ProbeStruct[] } = JSON.parse(
    await readFile(PROBE_PATH, "utf8"),
  );

  const pkgJson = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8"));
  const pinned = pkgJson.ghostty?.commit ?? "unknown";

  const out: string[] = [];
  out.push("// GENERATED FILE — do not edit by hand.");
  out.push("// Regenerate with `bun run build:native`.");
  out.push(`// Pinned Ghostty commit: ${pinned}`);
  out.push("");

  out.push(`export const pinnedCommit = ${JSON.stringify(pinned)} as const;`);
  out.push("");

  out.push("// Symbol manifest: every ghostty_* function the binding calls must exist.");
  out.push("export const symbolManifest = [");
  for (const name of [...symbols].sort()) {
    out.push(`  ${JSON.stringify(name)},`);
  }
  out.push("] as const;");
  out.push("");

  out.push("// Struct layout (sizes/alignments/offsets) from probe-layout.c.");
  out.push("export interface StructLayout {");
  out.push("  size: number;");
  out.push("  align: number;");
  out.push("  fields: Record<string, { offset: number; size: number }>;");
  out.push("}");
  out.push("export const structLayouts: Record<string, StructLayout> = {");
  for (const s of probe.structs) {
    out.push(`  ${JSON.stringify(s.name)}: {`);
    out.push(`    size: ${s.size},`);
    out.push(`    align: ${s.align},`);
    out.push(`    fields: {`);
    for (const f of s.fields) {
      out.push(`      ${JSON.stringify(f.name)}: { offset: ${f.offset}, size: ${f.size} },`);
    }
    out.push(`    },`);
    out.push(`  },`);
  }
  out.push("};");
  out.push("");

  for (const [tag, entries] of [...enums.entries()].sort()) {
    out.push(`// enum ${tag}`);
    out.push(`export const ${tag}Values = {`);
    for (const e of entries) {
      out.push(`  ${JSON.stringify(e.name)}: ${e.value},`);
    }
    out.push(`} as const;`);
    out.push("");
  }

  await writeFile(OUT_PATH, out.join("\n") + "\n", "utf8");
  console.log(
    `wrote ${OUT_PATH}: ${symbols.size} symbols, ${enums.size} enums, ${probe.structs.length} structs`,
  );
}

await main();
```

- [ ] **Step 2: Run the generator**

Prerequisites: Tasks 2 and 3 must have run (vendor exists, .tmp/layout.json exists).

```bash
bun run build:bindings
```

Expected output:

```
wrote /.../src/internal/generated.ts: <N> symbols, <M> enums, <K> structs
```

- [ ] **Step 3: Sanity-check the generated file**

```bash
head -40 src/internal/generated.ts
```

Expected: header comment with pinned commit, a sorted `symbolManifest` that includes at least `ghostty_terminal_new`, `ghostty_terminal_free`, `ghostty_terminal_vt_write`, `ghostty_formatter_new`, `ghostty_formatter_free`, `ghostty_formatter_format`, and a `GhosttyResultValues` constant with at least an `OK` entry. If any of those is missing, the generator is broken — do not proceed; investigate and fix before continuing.

- [ ] **Step 4: Commit**

```bash
git add scripts/gen-bindings.ts src/internal/generated.ts
git commit -m "build: bindings generator emits generated.ts from headers + probe"
```

---

## Task 5: Error hierarchy

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
} from "../../src/errors.ts";

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

## Task 6: Path resolution

**Files:**
- Create: `src/internal/path.ts`
- Create: `test/smoke/path.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/smoke/path.test.ts`:

```typescript
import { describe, expect, it } from "bun:test";
import { detectPlatform, SUPPORTED_PLATFORMS, resolveLibraryPath } from "../../src/internal/path.ts";
import { UnsupportedPlatformError } from "../../src/errors.ts";

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

  it("throws UnsupportedPlatformError when platform has no bundled dylib and no override", () => {
    expect(() =>
      resolveLibraryPath({
        platform: "linux-x64",
        packageRoot: "/pkg",
        fileExists: () => false,
      }),
    ).toThrow(UnsupportedPlatformError);
  });

  it("throws UnsupportedPlatformError for unknown platform", () => {
    expect(() =>
      resolveLibraryPath({
        platform: "plan9-mips",
        packageRoot: "/pkg",
        fileExists: () => false,
      }),
    ).toThrow(UnsupportedPlatformError);
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
import { UnsupportedPlatformError } from "../errors.ts";

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

  if (opts.override) {
    if (!exists(opts.override)) {
      throw new UnsupportedPlatformError(
        `setLibraryPath: file not found at ${opts.override}`,
        {
          detectedPlatform: platform,
          supportedPlatforms: [...SUPPORTED_PLATFORMS],
        },
      );
    }
    return opts.override;
  }

  if (opts.env) {
    if (!exists(opts.env)) {
      throw new UnsupportedPlatformError(
        `GHOSTTY_VT_LIB: file not found at ${opts.env}`,
        {
          detectedPlatform: platform,
          supportedPlatforms: [...SUPPORTED_PLATFORMS],
        },
      );
    }
    return opts.env;
  }

  const ext = libExtension(platform);
  const bundled = join(opts.packageRoot, "prebuilds", platform, `libghostty-vt.${ext}`);
  if (exists(bundled)) return bundled;

  throw new UnsupportedPlatformError(
    `No bundled libghostty-vt for ${platform}. Supported: ${SUPPORTED_PLATFORMS.join(", ")}. ` +
      `Set GHOSTTY_VT_LIB or call setLibraryPath() to override.`,
    {
      detectedPlatform: platform,
      supportedPlatforms: [...SUPPORTED_PLATFORMS],
    },
  );
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

## Task 7: FFI loader (lazy dlopen + symbol manifest verification)

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
import * as ffi from "../../src/ffi.ts";
import { LibraryCompatibilityError, LibraryNotFoundError } from "../../src/errors.ts";

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
import { dlopen, FFIType, suffix } from "bun:ffi";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { LibraryCompatibilityError, LibraryNotFoundError } from "./errors.ts";
import { detectPlatform, resolveLibraryPath } from "./internal/path.ts";
import { pinnedCommit, symbolManifest } from "./internal/generated.ts";

// ---- Symbol declarations ---------------------------------------------------
// Every symbol the binding uses is declared here with its bun:ffi signature.
// Must remain aligned with symbolManifest — Task 20 asserts overlap.
//
// NOTE: Concrete C signatures must be verified against vt.h at the pinned
// commit. Parameter/return types below reflect the public Ghostty API shape
// as of the spec's survey; adjust if the probe or symbol-manifest test fails.

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

// ---- State -----------------------------------------------------------------

let overridePath: string | undefined;
let loaded: DlopenResult | null = null;
let loadedPath: string | null = null;

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
}

/** Cheap diagnostics — does not trigger load. */
export function libraryInfo(): LibraryInfo {
  return {
    loaded: loaded !== null,
    path: loadedPath,
    pinnedCommit,
  };
}

/**
 * Get (and lazily load) the symbol table. First call resolves the library,
 * verifies every declared symbol is present, and throws on failure.
 */
export function getLib(): DlopenResult {
  if (loaded) return loaded;

  const packageRoot = resolvePackageRoot();
  let path: string;
  try {
    path = resolveLibraryPath({
      override: overridePath,
      env: process.env["GHOSTTY_VT_LIB"],
      packageRoot,
    });
  } catch (e) {
    // resolveLibraryPath throws UnsupportedPlatformError; rewrap as NotFound
    // if the caller expected a path but none was resolvable. Leave the
    // caller's discriminator intact otherwise.
    throw e;
  }

  if (!Bun.file(path).size && !overridePath && !process.env["GHOSTTY_VT_LIB"]) {
    throw new LibraryNotFoundError(
      `libghostty-vt not found at ${path}`,
      { searchedPaths: [path] },
    );
  }

  let opened: DlopenResult;
  try {
    opened = dlopen(path, SYMBOLS) as DlopenResult;
  } catch (e) {
    // Convert bun:ffi errors about missing symbols into LibraryCompatibilityError.
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

  // Verify every manifest symbol is present (belt-and-braces; dlopen already
  // throws on missing, but a separate check gives a clearer error).
  const missing: string[] = [];
  for (const name of symbolManifest) {
    if (!(name in opened.symbols) || typeof (opened.symbols as any)[name] !== "function") {
      missing.push(name);
    }
  }
  if (missing.length > 0) {
    opened.close();
    throw new LibraryCompatibilityError(
      `Library at ${path} is missing ${missing.length} expected symbols`,
      {
        details: `missing: ${missing.slice(0, 10).join(", ")}${missing.length > 10 ? ", ..." : ""}`,
        expectedCommit: pinnedCommit,
      },
    );
  }

  loaded = opened;
  loadedPath = path;
  return loaded;
}

/** @internal test-only hook to simulate fresh process state. */
export function _resetForTest(): void {
  if (loaded) loaded.close();
  loaded = null;
  loadedPath = null;
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

**Note for executor:** if a symbol's signature in `SYMBOLS` is wrong for the pinned Ghostty commit, `dlopen` will still succeed (it only checks existence), but subsequent calls will crash. Pass 1's ABI smoke test (Task 20) exercises each symbol to catch this.

**Note on `symbolManifest` vs `SYMBOLS`:** the symbol manifest is the set of symbols the HEADER declares; `SYMBOLS` is the set the BINDING uses. The binding may use a subset of the manifest, but every name in `SYMBOLS` must also be in the manifest. Task 20's ABI smoke test enforces this.

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

## Task 8: Internal helpers — struct marshaling and string helpers

**Files:**
- Create: `src/internal/sized-struct.ts`, `src/internal/marshal.ts`
- Create: `test/smoke/internal-helpers.test.ts` (at `test/smoke/` level, tests both)

- [ ] **Step 1: Write failing tests**

Create `test/smoke/internal-helpers.test.ts`:

```typescript
import { describe, expect, it } from "bun:test";
import { writeStruct } from "../../src/internal/sized-struct.ts";
import { readCString, writeCString } from "../../src/internal/marshal.ts";

describe("writeStruct", () => {
  it("writes a struct matching the layout", () => {
    // Synthetic layout: { a: u32 @ 0, b: u32 @ 4 }, size 8.
    const layout = {
      size: 8,
      align: 4,
      fields: {
        a: { offset: 0, size: 4 },
        b: { offset: 4, size: 4 },
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
      size: 8,
      align: 4,
      fields: {
        a: { offset: 0, size: 4 },
        b: { offset: 4, size: 4 },
      },
    };
    const buf = writeStruct(layout, { a: 0xdeadbeef });
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    expect(view.getUint32(0, true)).toBe(0xdeadbeef);
    expect(view.getUint32(4, true)).toBe(0);
  });

  it("writes u8/u16/u32/u64 sizes correctly", () => {
    const layout = {
      size: 16,
      align: 8,
      fields: {
        a: { offset: 0, size: 1 },
        b: { offset: 2, size: 2 },
        c: { offset: 4, size: 4 },
        d: { offset: 8, size: 8 },
      },
    };
    const buf = writeStruct(layout, { a: 0x12, b: 0x3456, c: 0x789abcde, d: 0x1122334455667788n });
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    expect(view.getUint8(0)).toBe(0x12);
    expect(view.getUint16(2, true)).toBe(0x3456);
    expect(view.getUint32(4, true)).toBe(0x789abcde);
    expect(view.getBigUint64(8, true)).toBe(0x1122334455667788n);
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
import type { StructLayout } from "./generated.ts";

/**
 * Build a byte buffer matching `layout`. Fields present in `fields` are
 * written at their declared offsets with widths 1/2/4/8. Fields not present
 * are left zero. No forward-compat "size" prefix is written here — that's
 * an upstream convention for specific sized structs handled by callers.
 */
export function writeStruct(
  layout: StructLayout,
  fields: Record<string, number | bigint | boolean>,
): Uint8Array {
  const buf = new Uint8Array(layout.size);
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

  for (const [name, spec] of Object.entries(layout.fields)) {
    if (!(name in fields)) continue;
    const raw = fields[name];
    if (raw === undefined) continue;

    switch (spec.size) {
      case 1: {
        const n = typeof raw === "boolean" ? (raw ? 1 : 0) : Number(raw);
        view.setUint8(spec.offset, n & 0xff);
        break;
      }
      case 2: {
        const n = typeof raw === "boolean" ? (raw ? 1 : 0) : Number(raw);
        view.setUint16(spec.offset, n & 0xffff, true);
        break;
      }
      case 4: {
        const n = typeof raw === "boolean" ? (raw ? 1 : 0) : Number(raw);
        view.setUint32(spec.offset, n >>> 0, true);
        break;
      }
      case 8: {
        const big = typeof raw === "bigint" ? raw : BigInt(raw as number | boolean | string);
        view.setBigUint64(spec.offset, BigInt.asUintN(64, big), true);
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
  // Bun's FFI exposes `toArrayBuffer(ptr, offset, length)` on the pointer,
  // which returns a view over native memory. Copy immediately into a new
  // buffer so the caller can retain it safely.
  const { toArrayBuffer } = require("bun:ffi");
  const view = new Uint8Array(toArrayBuffer(ptr, 0, len));
  const copy = new Uint8Array(len);
  copy.set(view);
  return copy;
}

export type Pointer = number | bigint;  // bun:ffi pointers
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

## Task 9: Public types used at Pass 1

**Files:**
- Create: `src/types.ts`
- No tests (pure type definitions; compiled by `tsc` in Task 19).

- [ ] **Step 1: Write `src/types.ts`**

Contents:

```typescript
// Public supporting types used by Pass 1's classes (Terminal, Formatter).
// The full v0 type surface (RenderCell, Key, KittyFlags, etc.) lands in
// later passes.

export type RGB = readonly [r: number, g: number, b: number];
export type PaletteIndex = { palette: number };

export type CursorStyle = "block" | "underline" | "bar";
export type MouseTracking = "none" | "x10" | "normal" | "button" | "any";

// ModeName is a string-literal union generated from vt.h.  Pass 1 exposes the
// actual list via a re-export from src/internal/generated.ts (see src/index.ts).
// Consumers import `ModeName` from the package; the concrete values are
// whatever the pinned Ghostty exposes.
export type ModeName = string;  // Narrowed by generated.ts at compile time via a
                                 // conditional re-export in src/index.ts.

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

## Task 10: Terminal construction + lifecycle

**Files:**
- Create: `src/terminal.ts` (construction + close + dispose + use-after-close only)
- Create: `test/smoke/terminal.test.ts` (construction/lifecycle subset)

This task lands the skeleton — construction, close, Symbol.dispose, use-after-close enforcement. Methods like `vtWrite`/`resize`/`reset`/`snapshot`/`mode`/`setMode` are stubbed to throw "not implemented" and get filled in by later tasks.

- [ ] **Step 1: Write the failing test**

Create `test/smoke/terminal.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Terminal } from "../../src/terminal.ts";
import { UseAfterCloseError } from "../../src/errors.ts";
import * as ffi from "../../src/ffi.ts";

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
import { getLib } from "./ffi.ts";
import { GhosttyError, UseAfterCloseError } from "./errors.ts";
import { structLayouts, GhosttyResultValues } from "./internal/generated.ts";
import { writeStruct } from "./internal/sized-struct.ts";
import type {
  ModeName,
  TerminalOptions,
  TerminalSnapshot,
} from "./types.ts";

// Map a GhosttyResult value returned from FFI into either success or a thrown error.
function checkResult(result: number, functionName: string): void {
  if (result === GhosttyResultValues.GHOSTTY_RESULT_OK) return;
  // Reverse-lookup the name for the error message; don't assume what it is.
  let name = "UNKNOWN";
  for (const [k, v] of Object.entries(GhosttyResultValues)) {
    if (v === result) { name = k; break; }
  }
  const code: GhosttyError["code"] =
    name.includes("OUT_OF_MEMORY") ? "out_of_memory" :
    name.includes("INVALID") ? "invalid_argument" :
    "unknown";
  throw new GhosttyError(`${functionName} returned ${name} (${result})`, {
    code,
    functionName,
  });
}

export class Terminal {
  #handle: Pointer | null = null;

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

    const lib = getLib();
    const layout = structLayouts["GhosttyTerminalOptions"];
    if (!layout) {
      throw new GhosttyError(
        "generated.ts is missing GhosttyTerminalOptions layout — rerun gen-bindings",
        { code: "unknown", functionName: "Terminal.constructor" },
      );
    }

    const optBytes = writeStruct(layout, {
      cols: opts.cols,
      rows: opts.rows,
      max_scrollback: opts.maxScrollback ?? 1000,
      // apc_max_bytes and apc_max_bytes_kitty: field names verified at pin time
      // in Task 3's probe; if present in layout.fields, wire them here.
      ...(layout.fields["apc_max_bytes"] && {
        apc_max_bytes: opts.apcMaxBytes ?? (1 << 20),   // 1 MiB default
      }),
      ...(layout.fields["apc_max_bytes_kitty"] && {
        apc_max_bytes_kitty: opts.apcMaxBytesKitty ?? 0, // disabled default
      }),
    });

    // ghostty_terminal_new(allocator=null, &options) → GhosttyTerminal*
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
    if (this.#handle === null) {
      throw new UseAfterCloseError("Terminal has been closed", {
        handleType: "Terminal",
      });
    }
    return this.#handle;
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

  // ---- Methods stubbed — real implementations in Tasks 11-14 ------------

  vtWrite(_bytes: Uint8Array): void {
    this.#assertOpen();
    throw new Error("Terminal.vtWrite not implemented yet (Task 11)");
  }

  resize(_cols: number, _rows: number, _cellPx?: { width: number; height: number }): void {
    this.#assertOpen();
    throw new Error("Terminal.resize not implemented yet (Task 12)");
  }

  reset(): void {
    this.#assertOpen();
    throw new Error("Terminal.reset not implemented yet (Task 12)");
  }

  snapshot(): TerminalSnapshot {
    this.#assertOpen();
    throw new Error("Terminal.snapshot not implemented yet (Task 13)");
  }

  mode(_name: ModeName): boolean {
    this.#assertOpen();
    throw new Error("Terminal.mode not implemented yet (Task 14)");
  }

  setMode(_name: ModeName, _value: boolean): void {
    this.#assertOpen();
    throw new Error("Terminal.setMode not implemented yet (Task 14)");
  }

  #assertOpen(): void {
    if (this.#handle === null) {
      throw new UseAfterCloseError("Terminal has been closed", {
        handleType: "Terminal",
      });
    }
  }
}

export type Pointer = number | bigint;
```

**Note for executor:** `GhosttyResultValues.GHOSTTY_RESULT_OK` assumes the enum entry is literally named `GHOSTTY_RESULT_OK`. If the pinned header names it differently (e.g., `GHOSTTY_OK`), the generated file will reflect that and the reference above must be updated. The failing test in this task will surface the discrepancy.

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

## Task 11: Terminal.vtWrite

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

## Task 12: Terminal.resize + Terminal.reset

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
  resize(cols: number, rows: number, _cellPx?: { width: number; height: number }): void {
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
    const lib = getLib();
    const result = lib.symbols.ghostty_terminal_resize(this.#handle, cols, rows);
    checkResult(result, "ghostty_terminal_resize");
    // cellPx wired through once the snapshot pixel dims are implemented in Task 13.
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

## Task 13: Terminal.snapshot

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
import { GhosttyTerminalGetKeyValues } from "./internal/generated.ts";

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

**Executor note:** the exact `GHOSTTY_TERMINAL_GET_*` names above are placeholders reflecting the naming pattern. Check the actual names in the generated file after Task 4 and correct this list before implementing. Any name that does not exist as a key in `GhosttyTerminalGetKeyValues` will cause a compile error — fix by using the correct name from the generated enum, or by adding a comment that the feature is deferred to a later pass if upstream does not expose it yet.

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

    const cellW = 0;   // Pass 1 does not plumb cellPx through yet; pixel dims
    const cellH = 0;   // default to zero. Populated in Task 11's resize when
                       // cellPx is stored.

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

## Task 14: Terminal.mode / setMode

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

Add near the top of `src/terminal.ts`:

```typescript
import { ModeTagValues } from "./internal/generated.ts";

// Map a ModeName (e.g. "bracketed_paste") into the numeric ModeTag value.
// Generated.ts contains entries like GHOSTTY_MODE_BRACKETED_PASTE = 42.
// We strip the prefix and lowercase to produce the TS-side name.
function modeTagFromName(name: string): number {
  const key = `GHOSTTY_MODE_${name.toUpperCase()}`;
  const v = (ModeTagValues as Record<string, number>)[key];
  if (v === undefined) {
    throw new GhosttyError(`unknown ModeName: ${name}`, {
      code: "invalid_argument",
      functionName: "Terminal.mode",
    });
  }
  return v;
}
```

**Executor note:** the `GHOSTTY_MODE_*` prefix is a guess at the upstream naming convention. Inspect the generated `ModeTagValues` and align `modeTagFromName` accordingly. If upstream uses a different prefix (e.g. `GHOSTTY_MODE_TAG_` or no prefix at all), update the transformation.

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

## Task 15: Formatter class

**Files:**
- Create: `src/formatter.ts`, `test/smoke/formatter.test.ts`

- [ ] **Step 1: Write failing tests**

Create `test/smoke/formatter.test.ts`:

```typescript
import { describe, expect, it } from "bun:test";
import { Terminal } from "../../src/terminal.ts";
import { Formatter } from "../../src/formatter.ts";
import { UseAfterCloseError } from "../../src/errors.ts";

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
    expect(s).toContain(" ");  // blanks present; exact form TBD by upstream
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
import { getLib } from "./ffi.ts";
import { GhosttyError, UseAfterCloseError } from "./errors.ts";
import {
  GhosttyFormatterTagValues,
  GhosttyResultValues,
  structLayouts,
} from "./internal/generated.ts";
import { writeStruct } from "./internal/sized-struct.ts";
import { Terminal } from "./terminal.ts";
import type { FormatterOptions } from "./types.ts";

function formatTag(format: "plain" | "vt" | "html"): number {
  const key =
    format === "plain" ? "GHOSTTY_FORMATTER_PLAIN" :
    format === "vt"    ? "GHOSTTY_FORMATTER_VT" :
                         "GHOSTTY_FORMATTER_HTML";
  const v = (GhosttyFormatterTagValues as Record<string, number>)[key];
  if (v === undefined) {
    throw new GhosttyError(`GhosttyFormatterTag.${key} missing at pinned commit`, {
      code: "unknown",
      functionName: "Formatter.constructor",
    });
  }
  return v;
}

export class Formatter {
  #handle: Pointer | null = null;

  constructor(opts: FormatterOptions) {
    const lib = getLib();
    const tag = formatTag(opts.format);

    // Build the GhosttyFormatterOptions struct per generated layout.
    const layout = structLayouts["GhosttyFormatterOptions"];
    if (!layout) {
      throw new GhosttyError(
        "generated.ts missing GhosttyFormatterOptions layout — rerun gen-bindings",
        { code: "unknown", functionName: "Formatter.constructor" },
      );
    }
    const optBytes = writeStruct(layout, {
      // Toggle fields per the spec's FormatterOptions. Field names must match
      // the upstream struct; the probe captured them in Task 3.
      palette:         opts.palette ?? false,
      modes:           opts.modes ?? false,
      scrolling_region: opts.scrollingRegion ?? false,
      tab_stops:       opts.tabStops ?? false,
      pwd:             opts.pwd ?? false,
      keyboard:        opts.keyboard ?? false,
      cursor:          opts.cursor ?? false,
      style:           opts.style ?? false,
      hyperlink:       opts.hyperlink ?? false,
      protection:      opts.protection ?? false,
      charsets:        opts.charsets ?? false,
    });

    // ghostty_formatter_new(tag-or-allocator, &options, &out).
    // NOTE: the first arg is either a tag value or an allocator handle,
    // per upstream; verify from vt.h at pin. The call below assumes
    // (allocator=null, &options, &out) and passes tag via the options struct.
    // If the actual signature is (tag, allocator, &options, &out), adjust.
    const outSlot = new BigUint64Array(1);
    const { ptr } = require("bun:ffi");
    const result = lib.symbols.ghostty_formatter_new(null, optBytes, ptr(outSlot));
    if (result !== GhosttyResultValues.GHOSTTY_RESULT_OK) {
      throw new GhosttyError(`ghostty_formatter_new returned ${result}`, {
        code: result === 1 ? "out_of_memory" : "unknown",
        functionName: "ghostty_formatter_new",
      });
    }
    this.#handle = outSlot[0];
    // Store the tag for format() dispatch.
    this.#tag = tag;
  }

  #tag: number = 0;

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
    const { ptr, read, toArrayBuffer } = require("bun:ffi");

    const outBufSlot = new BigUint64Array(1);
    const outLenSlot = new BigUint64Array(1);

    const result = lib.symbols.ghostty_formatter_format(
      this.#handle,
      term._handle,
      ptr(outBufSlot),
      ptr(outLenSlot),
    );
    if (result !== GhosttyResultValues.GHOSTTY_RESULT_OK) {
      throw new GhosttyError(`ghostty_formatter_format returned ${result}`, {
        code: result === 1 ? "out_of_memory" : "unknown",
        functionName: "ghostty_formatter_format",
      });
    }

    const bufPtr = outBufSlot[0];
    const len = Number(outLenSlot[0]);
    if (bufPtr === 0n || len === 0) return new Uint8Array(0);

    // Copy bytes immediately; the buffer is allocated by ghostty_alloc and
    // must eventually be freed via ghostty_free. Copy first, then free.
    const copy = new Uint8Array(len);
    copy.set(new Uint8Array(toArrayBuffer(Number(bufPtr), 0, len)));
    lib.symbols.ghostty_free(null, Number(bufPtr), BigInt(len));
    return copy;
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

type Pointer = number | bigint;
```

**Executor note:** Formatter's exact allocator/ABI is a known verify-at-pin item. Read `ghostty/vt/formatter.h` at the pinned commit and align the `ghostty_formatter_new` and `ghostty_formatter_format` calls. The structure captured in generated.ts will drive the struct marshaling.

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

## Task 16: Fixture harness

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
import { Terminal } from "../../src/terminal.ts";
import { Formatter } from "../../src/formatter.ts";

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
import { listFixtures, runFixture } from "../helpers/fixture-harness.ts";
import { join } from "node:path";

const DIR = join(process.cwd(), "test/fixtures");

describe("formatter fixtures", () => {
  it("lists at least hello-world", async () => {
    const names = await listFixtures(DIR);
    expect(names).toContain("hello-world");
  });

  it("hello-world matches", async () => {
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

## Task 17: ABI smoke test

**Files:**
- Create: `test/smoke/abi.test.ts`

Tests that bind implementation to layout/enum/symbol contracts:

- Every symbol in `SYMBOLS` (from `ffi.ts`) must be in `symbolManifest`.
- The loaded library resolves every name in the symbol manifest.
- Every struct referenced by the binding (`GhosttyTerminalOptions`, `GhosttyFormatterOptions`) is in `structLayouts`.
- `pinnedCommit` matches `package.json` `ghostty.commit`.

- [ ] **Step 1: Write `test/smoke/abi.test.ts`**

Contents:

```typescript
import { describe, expect, it } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pinnedCommit, symbolManifest, structLayouts } from "../../src/internal/generated.ts";
import { getLib } from "../../src/ffi.ts";

describe("ABI smoke", () => {
  it("pinnedCommit matches package.json ghostty.commit", async () => {
    const pkg = JSON.parse(await readFile(join(process.cwd(), "package.json"), "utf8"));
    expect(pinnedCommit).toBe(pkg.ghostty.commit);
  });

  it("symbolManifest contains every symbol the binding uses", () => {
    const required = [
      "ghostty_terminal_new",
      "ghostty_terminal_free",
      "ghostty_terminal_vt_write",
      "ghostty_terminal_reset",
      "ghostty_terminal_resize",
      "ghostty_terminal_get_multi",
      "ghostty_terminal_mode_get",
      "ghostty_terminal_mode_set",
      "ghostty_formatter_new",
      "ghostty_formatter_free",
      "ghostty_formatter_format",
      "ghostty_free",
    ];
    for (const name of required) {
      expect(symbolManifest).toContain(name);
    }
  });

  it("structLayouts contains the structs the binding constructs", () => {
    expect(structLayouts["GhosttyTerminalOptions"]).toBeDefined();
    expect(structLayouts["GhosttyTerminalOptions"]?.size).toBeGreaterThan(0);
    expect(structLayouts["GhosttyFormatterOptions"]).toBeDefined();
  });

  it("library loads and every manifest symbol resolves to a function", () => {
    const lib = getLib();
    let missing: string[] = [];
    for (const name of symbolManifest) {
      if (typeof (lib.symbols as any)[name] !== "function") missing.push(name);
    }
    expect(missing).toEqual([]);
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

## Task 18: Tarball smoke test

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

# Ensure dist/ exists.
bun run build:ts

# Pack.
TGZ=$(bun pm pack --destination "$ROOT/.tmp" 2>&1 | tail -n 1 | awk '{print $NF}')
if [ -z "${TGZ:-}" ] || [ ! -f "$TGZ" ]; then
  echo "bun pm pack did not produce a tarball" >&2
  exit 1
fi

# Install into a temp project.
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

## Task 19: CI workflow

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
    runs-on: macos-latest
    steps:
      - uses: actions/checkout@v4

      - name: Install Zig
        uses: mlugg/setup-zig@v1
        with:
          version: master

      - name: Install Bun
        uses: oven-sh/setup-bun@v2
        with:
          bun-version: '>=1.3.13'

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

## Task 20: Public re-exports + README

**Files:**
- Create: `src/index.ts`
- Modify: `README.md`

- [ ] **Step 1: Write `src/index.ts`**

Contents:

```typescript
export { Terminal } from "./terminal.ts";
export { Formatter } from "./formatter.ts";
export {
  GhosttyError,
  LibraryNotFoundError,
  UnsupportedPlatformError,
  LibraryCompatibilityError,
  UseAfterCloseError,
} from "./errors.ts";
export type { GhosttyErrorCode } from "./errors.ts";
export {
  setLibraryPath,
  isLoaded,
  libraryInfo,
} from "./ffi.ts";
export type { LibraryInfo } from "./ffi.ts";
export type {
  RGB,
  PaletteIndex,
  CursorStyle,
  MouseTracking,
  ModeName,
  TerminalOptions,
  TerminalSnapshot,
  FormatterOptions,
} from "./types.ts";
export { pinnedCommit } from "./internal/generated.ts";
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

**Platforms (Pass 1):** `darwin-arm64`. Other platforms planned — see [the roadmap](./docs/superpowers/specs/2026-04-22-ts-libghostty-design.md#11-post-v0-roadmap).

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

**The loaded library's ABI must match the pinned Ghostty commit.** Overriding with a library built from a different commit will typically fail with `LibraryCompatibilityError`; if the missing-symbol check passes anyway, runtime behavior is undefined.
```

- [ ] **Step 4: Commit**

```bash
git add src/index.ts README.md
git commit -m "docs: README + public re-exports for Pass 1"
```

---

## Task 21: Final sanity run + version bump

**Files:**
- Modify: `package.json` (confirm version)

This is the release gate for Pass 1.

- [ ] **Step 1: Run the full pipeline from a clean state**

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

- [ ] **Step 2: Confirm `version` in package.json is `0.1.0`**

This is the Pass 1 release version. If it has drifted, set it back:

```json
"version": "0.1.0"
```

- [ ] **Step 3: Tag the Pass 1 milestone**

```bash
git tag -a v0.1.0 -m "ts-libghostty Pass 1 — Terminal + Formatter"
```

- [ ] **Step 4: Commit any pending changes**

```bash
git status
# If anything uncommitted, commit it:
git add -A
git commit -m "chore: Pass 1 release prep" --allow-empty
```

Pass 1 is now ready for review and, once approved, publication.

---

## Self-Review

Running the skill's self-review checklist against the plan above.

### Spec coverage

Walked every section of `docs/superpowers/specs/2026-04-22-ts-libghostty-design.md` and mapped to tasks:

- §1–3 (summary, motivation, architecture) — informational; no task needed.
- §3.2 v0 scope — Pass 1 covers `Terminal` (partial, per Pass-1 scope statement at top of this plan) and `Formatter`; remaining v0 classes (`RenderState`, `KeyEncoder`, `encodeFocus`) deferred to later passes — explicitly called out in header.
- §4.1 Terminal — Tasks 10–14. `snapshot` includes pixel dimensions (Task 13). `cellAt`, colors, viewport scroll, modes beyond simple get/set — deferred to Pass 5; explicit in scope.
- §4.2 RenderState — deferred to Pass 3; explicit in scope.
- §4.3 Formatter — Task 15.
- §4.4 KeyEncoder — deferred to Pass 4; explicit.
- §4.5 encodeFocus — deferred to Pass 4; explicit.
- §4.6 Error hierarchy — Task 5 (all five classes).
- §4.7 Supporting types — Task 9 (subset needed for Pass 1).
- §5.1 FFI layer — Task 7 (lazy dlopen, setLibraryPath lifecycle, symbol manifest verification, libraryInfo).
- §5.2 String marshaling — Task 8.
- §5.3 Struct layout & sized-struct — Tasks 3 (probe), 4 (generator), 8 (writer).
- §5.4 Effect callbacks — deferred to Pass 2; explicit.
- §5.5 Lifecycle — Task 10 (Symbol.dispose, idempotent close, use-after-close).
- §5.6 Errors — Task 5 + `checkResult` helper in Task 10.
- §5.7 Concurrency — documented in Task 20 (README) and spec §5.7; no code change needed beyond constructor.
- §5.8 Allocator — wrapped via `ghostty_free` in Task 15; public exposure deferred.
- §5.9 Memory safety (APC bounds) — Task 10 (constructor sets defaults).
- §6 Repo layout — Task 1 (infra) + subsequent files match.
- §7 Build & distribution — Tasks 1, 2, 3, 4, 19.
- §8 Testing — partial v0 coverage in Pass 1: smoke (across tasks), formatter fixtures (Task 16), ABI smoke (Task 17), tarball smoke (Task 18). Full v0 gates (effect-callback tests, render-metadata, key-goldens, malformed-input fuzz, real-program captures) come with the passes that add the surfaces.
- §9 Versioning & pinning — Task 1 (package.json ghostty.commit), Task 2 (pin commit), Task 21 (tag release).
- §10 Ghostty-bump process — tooling is in place after Task 4; a `bump-ghostty.sh` wrapper is not strictly needed for Pass 1 and can be added when the first bump happens. Added as "post-Pass-1 ops" note for the team.
- §11 Post-v0 roadmap — informational.
- §12 Attribution — covered in Task 20 README and LICENSE files.

**Gaps identified and fixed:**
- Pass 1 deferred surfaces now explicit in the plan header.
- `bump-ghostty.sh` was in the spec but not strictly needed for Pass 1; noted as follow-on.

### Placeholder scan

Searched the plan for placeholder patterns. Findings and resolutions:

- **`TASK_2_REPLACE_WITH_UPSTREAM`** in Task 1 Step 7 — intentional sentinel replaced by Task 2 Step 3. Not a plan placeholder.
- **`REPLACE_WITH_PINNED_COMMIT_IN_TASK_2`** in Task 1 Step 4 — intentional; explicitly resolved in Task 2 Step 1.
- **"Executor note"** paragraphs throughout Tasks 3, 7, 10, 13, 14, 15 — these flag implementation-verification points (exact struct fields, symbol signatures, enum names at the pinned Ghostty commit). They are not placeholders in the sense of "fill in later"; they are explicit instructions to verify upstream details at execution time, with failure modes (failing tests) that surface discrepancies. Kept.
- **No "TBD", "TODO", or "fill in details"** in any concrete step.

### Type consistency

Walked the type surface across tasks:

- `Pointer` type — declared in both `src/terminal.ts` and `src/formatter.ts` as `number | bigint`. Consistent.
- `ModeName` — used consistently across Tasks 10, 14.
- `TerminalOptions` / `TerminalSnapshot` / `FormatterOptions` — defined once in Task 9, imported by Tasks 10, 13, 15.
- `GhosttyErrorCode` — defined in Task 5, used in Tasks 10, 15.
- `getLib()` return type — consistent across callers.
- `structLayouts["GhosttyTerminalOptions"]` / `["GhosttyFormatterOptions"]` — same key strings used in Tasks 10 and 15.
- FFI symbol names in `SYMBOLS` (Task 7) match the required list in Task 17's ABI smoke test.

No inconsistencies found.

---

**Plan complete and saved to `docs/superpowers/plans/2026-04-22-ts-libghostty-pass-1.md`.**
