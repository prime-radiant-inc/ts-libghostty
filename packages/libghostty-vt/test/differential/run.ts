#!/usr/bin/env bun
/*
 * Differential testing harness for libghostty-vt.
 *
 * For each file in test/differential/corpus/, runs the identical bytes through
 *   (a) the C oracle (.tmp/diff-oracle, built via cc against libghostty-vt)
 *   (b) this repository's TS binding (Terminal + Formatter with format=plain)
 * and bytewise-diffs the formatter output. Any divergence is a binding bug.
 *
 * See docs/2026-04-23-differential-testing-design.md for design rationale.
 *
 * Invocation (from repo root):
 *   bun test/differential/run.ts
 * Build the oracle first if missing / stale:
 *   cc -O2 -I vendor/ghostty/include -L prebuilds/darwin-arm64 -lghostty-vt \
 *      -Wl,-rpath,@loader_path/../prebuilds/darwin-arm64 \
 *      -o .tmp/diff-oracle scripts/diff-oracle.c
 * (This script does the build automatically if the oracle is absent or older
 * than the source.)
 */
import { readdir, readFile } from "node:fs/promises";
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Terminal, Formatter } from "../../src/index";

// Repo root: two levels up from this file.
const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), "..", "..");
const ORACLE_SRC = path.join(REPO_ROOT, "scripts", "diff-oracle.c");
const ORACLE_BIN = path.join(REPO_ROOT, ".tmp", "diff-oracle");
const CORPUS_DIR = path.join(REPO_ROOT, "test", "differential", "corpus");
const HEADERS_DIR = path.join(REPO_ROOT, "vendor", "ghostty", "include");
const DYLIB_DIR = path.join(REPO_ROOT, "prebuilds", "darwin-arm64");

// Same terminal geometry on both sides. Override per-fixture metadata is a
// future extension (see design memo §Risks).
const COLS = 80;
const ROWS = 24;

function buildOracleIfNeeded(): void {
  const srcMtime = existsSync(ORACLE_SRC) ? statSync(ORACLE_SRC).mtimeMs : 0;
  const binMtime = existsSync(ORACLE_BIN) ? statSync(ORACLE_BIN).mtimeMs : 0;
  if (binMtime > srcMtime && binMtime > 0) return;

  mkdirSync(path.join(REPO_ROOT, ".tmp"), { recursive: true });
  const args = [
    "-O2", "-Wall", "-Wextra",
    "-I", HEADERS_DIR,
    "-L", DYLIB_DIR, "-lghostty-vt",
    "-Wl,-rpath,@loader_path/../prebuilds/darwin-arm64",
    "-o", ORACLE_BIN,
    ORACLE_SRC,
  ];
  const r = spawnSync("cc", args, { stdio: "inherit" });
  if (r.status !== 0) {
    throw new Error(`cc failed building oracle (status=${r.status})`);
  }
}

async function listCorpus(): Promise<string[]> {
  const entries = await readdir(CORPUS_DIR);
  return entries
    .filter((e) => e.endsWith(".vt"))
    .sort()
    .map((e) => path.join(CORPUS_DIR, e));
}

type Format = "plain" | "vt" | "html";
const FORMATS: readonly Format[] = ["plain", "vt", "html"];

function runOracle(inputPath: string, format: Format): Buffer {
  const r = spawnSync(
    ORACLE_BIN,
    ["--cols", String(COLS), "--rows", String(ROWS), "--format", format, inputPath],
    { encoding: "buffer" },
  );
  if (r.status !== 0) {
    const stderr = r.stderr?.toString() ?? "";
    throw new Error(`oracle exit=${r.status} on ${inputPath} (${format}): ${stderr}`);
  }
  return r.stdout as Buffer;
}

function runBinding(input: Uint8Array, format: Format): Uint8Array {
  using term = new Terminal({ cols: COLS, rows: ROWS, maxScrollback: 0 });
  term.vtWrite(input);
  using fmt = new Formatter({ format, trim: true });
  return fmt.format(term);
}

function formatBytes(bytes: Uint8Array | Buffer): string {
  // Show first ~200 bytes as escaped text for human-readable diff output.
  const s = Buffer.from(bytes).toString("utf8");
  const truncated = s.length > 400 ? s.slice(0, 400) + "…<truncated>" : s;
  return JSON.stringify(truncated);
}

function unifiedDiff(a: Uint8Array | Buffer, b: Uint8Array | Buffer): string {
  // Write both sides to temp files and call system diff -u. Small, correct,
  // and no dep on a JS diff library.
  const tmpA = path.join(REPO_ROOT, ".tmp", "diff-oracle-out.bin");
  const tmpB = path.join(REPO_ROOT, ".tmp", "diff-binding-out.bin");
  writeFileSync(tmpA, a);
  writeFileSync(tmpB, b);
  const r = spawnSync("diff", ["-u", "--label", "oracle", "--label", "binding", tmpA, tmpB], {
    encoding: "utf8",
  });
  return r.stdout ?? "";
}

function bytesEqual(a: Uint8Array | Buffer, b: Uint8Array | Buffer): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

async function main() {
  buildOracleIfNeeded();
  const corpus = await listCorpus();
  if (corpus.length === 0) {
    console.error(`no corpus files in ${CORPUS_DIR}`);
    process.exit(2);
  }

  let passed = 0;
  let total = 0;
  const failures: { name: string; format: Format; oracle: Buffer; binding: Uint8Array; diff: string }[] = [];

  for (const file of corpus) {
    const name = path.basename(file);
    const input = await readFile(file);
    const bytes = new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    for (const format of FORMATS) {
      total++;
      const oracle = runOracle(file, format);
      const binding = runBinding(bytes, format);
      const label = `${name} [${format}]`;
      if (bytesEqual(oracle, binding)) {
        console.log(`  pass  ${label} (${oracle.length} bytes)`);
        passed++;
      } else {
        console.log(`  FAIL  ${label} (oracle=${oracle.length}B binding=${binding.length}B)`);
        failures.push({ name, format, oracle, binding, diff: unifiedDiff(oracle, binding) });
      }
    }
  }

  console.log();
  console.log(`${passed}/${total} pass`);
  if (failures.length > 0) {
    console.log();
    for (const f of failures) {
      console.log(`---- ${f.name} [${f.format}] ----`);
      console.log(`oracle:  ${formatBytes(f.oracle)}`);
      console.log(`binding: ${formatBytes(f.binding)}`);
      if (f.diff) {
        console.log(f.diff);
      }
      console.log();
    }
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
