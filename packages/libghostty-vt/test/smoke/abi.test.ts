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
    // bun:ffi returns FFIType.cstring as a CString object (typeof "object",
    // constructor CString). String() coerces it to the full JSON payload.
    // Runtime shape: { [structName]: { size, align, fields: { [fieldName]:
    // { offset, size, type } } } } — note `fields` is a record keyed by
    // field name (not an array), and each field's kind is under `type`,
    // not `kind`. See .tmp/type_json.json for a captured sample.
    const parsed: Record<string, { size: number; align: number; fields: Record<string, { offset: number; size: number; type: string }> }> =
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
      for (const [fieldName, f] of Object.entries(runtime!.fields)) {
        const cf = checked!.fields[fieldName];
        expect(cf, `${name}.${fieldName} missing from checked-in layout`).toBeDefined();
        expect(cf!.offset).toBe(f.offset);
        expect(cf!.size).toBe(f.size);
      }
    }
  });
});
