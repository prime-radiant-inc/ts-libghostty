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
//
// `GHOSTTY_ENUM_MAX_VALUE` is a documented ABI convention: every typed
// Ghostty enum terminates with `FOO_MAX_VALUE = GHOSTTY_ENUM_MAX_VALUE` to
// force `sizeof(enum) == sizeof(int)`. The macro expands to `INT_MAX`
// (2147483647) per vt/types.h line 69. We resolve it here so the parser does
// not reject every enum in the headers.
const GHOSTTY_ENUM_MAX_VALUE = 2147483647; // INT_MAX per vt/types.h
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
      else if (valueText === "GHOSTTY_ENUM_MAX_VALUE") value = GHOSTTY_ENUM_MAX_VALUE;
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

// --- By-value entry-point scanner ------------------------------------------

/**
 * Scan headers for function declarations with non-pointer struct args.
 * Returns a list of "<func-name>: <struct-type>" pairs. Used to generate
 * a static check in generated.ts so verify:generated trips on any new
 * by-value entry point that would need a shim wrapper.
 *
 * Heuristic regex; false positives are reviewed during pin-bump diff,
 * false negatives (silent miss) are the failure mode we're avoiding.
 */
function scanByValueEntryPoints(headerSrcConcat: string): string[] {
  const findings: string[] = [];
  const fnRegex = /(?:GhosttyResult|void|bool|size_t|uint\d+_t|int\d+_t)\s+(ghostty_[a-z_]+)\s*\(([^)]*)\)/g;
  const OPAQUE_OR_INTEGER_TYPEDEFS = new Set([
    // Pointer typedefs — passing "by value" passes a pointer in the C ABI.
    "GhosttyTerminal",
    "GhosttyFormatter",
    "GhosttyRenderState",
    "GhosttyRenderStateRowCells",
    "GhosttyRenderStateRowIterator",
    "GhosttyKeyEncoder",
    "GhosttyKeyEvent",
    "GhosttyKittyGraphics",
    "GhosttyKittyGraphicsImage",          // const struct*
    "GhosttyKittyGraphicsPlacementIterator",
    "GhosttySgrParser",
    "GhosttyOscParser",
    "GhosttyOscCommand",
    "GhosttyMouseEvent",
    "GhosttyMouseEncoder",
    // Integer typedefs (enum or typedef uint/int — always register-pass).
    "GhosttyCell",
    "GhosttyRow",
    "GhosttyResult",
    "GhosttyMode",
    "GhosttyKittyKeyFlags",
    "GhosttyMods",                        // typedef uint16_t
    "GhosttyBuildInfo",                   // typedef enum
    "GhosttySysOption",                   // typedef enum
    "GhosttySysLogLevel",                 // typedef enum
    "GhosttyFocusEvent",                  // typedef enum
    "GhosttyCellData",                    // typedef enum
    "GhosttyModeReportState",             // typedef enum
    "GhosttyKeyAction",                   // typedef enum
    "GhosttyKey",                         // typedef enum
    "GhosttyKeyEncoderOption",            // typedef enum
    "GhosttyKittyGraphicsData",           // typedef enum
    "GhosttyKittyGraphicsImageData",      // typedef enum
    "GhosttyKittyGraphicsPlacementData",  // typedef enum
    "GhosttyKittyGraphicsPlacementIteratorOption", // typedef enum
    "GhosttyMouseAction",                 // typedef enum
    "GhosttyMouseButton",                 // typedef enum
    "GhosttyMouseEncoderOption",          // typedef enum
    "GhosttyOscCommandData",              // typedef enum
    "GhosttyPointTag",                    // typedef enum
    "GhosttyRenderStateData",             // typedef enum
    "GhosttyRenderStateOption",           // typedef enum
    "GhosttyRenderStateRowData",          // typedef enum
    "GhosttyRenderStateRowOption",        // typedef enum
    "GhosttyRenderStateRowCellsData",     // typedef enum
    "GhosttyRowData",                     // typedef enum
    "GhosttySizeReportStyle",             // typedef enum
    "GhosttyTerminalData",                // typedef enum
    "GhosttyTerminalOption",              // typedef enum
    // Small structs that fit in registers on both AAPCS64 and SysV-amd64
    // (≤ 16 bytes, no hidden-pointer passing needed on either ABI).
    "GhosttyColorRgb",                    // 3 bytes — always register-pass
    "GhosttyMousePosition",               // 8 bytes — 2 floats, register-pass
    "GhosttySizeReportSize",              // 12 bytes — 4 integer fields, ≤ 16 B
    // 32-byte struct (2 ptr + 2 size_t). Would need a shim if added to ffi.ts,
    // but ghostty_sgr_unknown_full/partial are not currently exposed via FFI.
    // Remove from this list (and add a shim wrapper) before using these functions.
    "GhosttySgrUnknown",
  ]);
  let m: RegExpExecArray | null;
  while ((m = fnRegex.exec(headerSrcConcat)) !== null) {
    const fnName = m[1]!;
    const argList = m[2]!;
    for (const rawArg of argList.split(",")) {
      const arg = rawArg.trim();
      // Skip pointer args.
      if (arg.includes("*")) continue;
      // Match `<optional-const> Ghostty<Name> <argname>` exactly — a single
      // type word followed by an identifier, no `*`.
      const byValRe = /^(const\s+)?(Ghostty[A-Z][A-Za-z]+)\s+\w+$/;
      const mm = byValRe.exec(arg);
      if (mm && !OPAQUE_OR_INTEGER_TYPEDEFS.has(mm[2]!)) {
        findings.push(`${fnName}: ${mm[2]}`);
      }
    }
  }
  return findings;
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
    // Skip the structural `*_MAX_VALUE = GHOSTTY_ENUM_MAX_VALUE` sentinel —
    // it exists only to pin the enum to `int` size (see ABI discovery §3).
    if (e.name === "GHOSTTY_RESULT_MAX_VALUE") continue;
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
    // Negative numeric literals are not valid TS object keys; quote them.
    // Object.entries() already stringifies the key, so JSON.stringify gives
    // us "0", "-1", etc. consistently.
    out.push(`  ${JSON.stringify(v)}: ${JSON.stringify(code)},`);
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

  // Scan headers for by-value entry points that need shim wrappers.
  const byValueEntryPoints = scanByValueEntryPoints(src);
  byValueEntryPoints.sort();

  // Trip-wire: fail if the set of by-value entry points changes from what shim.c covers.
  // If this fires on a pin bump, add/remove shim wrappers in native/shim.c first, then
  // update EXPECTED_BY_VALUE below and re-run bun run build:bindings.
  const EXPECTED_BY_VALUE = new Set([
    "ghostty_terminal_new: GhosttyTerminalOptions",
    "ghostty_formatter_terminal_new: GhosttyFormatterTerminalOptions",
    "ghostty_terminal_grid_ref: GhosttyPoint",
    "ghostty_terminal_scroll_viewport: GhosttyTerminalScrollViewport",
  ]);
  const actual = new Set(byValueEntryPoints);
  const added = [...actual].filter(x => !EXPECTED_BY_VALUE.has(x));
  const removed = [...EXPECTED_BY_VALUE].filter(x => !actual.has(x));
  if (added.length > 0 || removed.length > 0) {
    console.error("By-value entry-point list has changed:");
    for (const a of added)   console.error(`  + ${a}  (NEEDS A SHIM WRAPPER)`);
    for (const r of removed) console.error(`  - ${r}  (REMOVE FROM SHIM)`);
    console.error("");
    console.error("If this is intentional (Ghostty pin bump):");
    console.error("  1. Add/remove the corresponding wrappers in native/shim.c");
    console.error("  2. Update EXPECTED_BY_VALUE in scripts/gen-bindings.ts");
    console.error("  3. Re-run bun run build:bindings");
    process.exit(1);
  }

  out.push(`\n/** By-value entry points detected in libghostty-vt headers.`);
  out.push(` * Each must have a corresponding _p wrapper in native/shim.c.`);
  out.push(` * If this list grows on a pin bump, add the new wrapper before merging.`);
  out.push(` * Auto-generated; do not hand-edit. */`);
  out.push(`export const byValueEntryPoints = [`);
  for (const ep of byValueEntryPoints) {
    out.push(`  ${JSON.stringify(ep)},`);
  }
  out.push(`] as const;`);

  await writeFile(OUT_PATH, out.join("\n") + "\n", "utf8");
  console.log(
    `wrote ${OUT_PATH}: ${declaredSymbols.length} declared symbols, ${enums.size} enums, ${probe.structs.length} structs, ${modeInfo.length} modes, ${byValueEntryPoints.length} by-value entry points`,
  );
}

await main();
