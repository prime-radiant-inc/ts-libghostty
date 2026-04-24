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

export async function loadFixtureManifest(
  fixturesDir: string,
): Promise<Record<string, { cols: number; rows: number }>> {
  const path = join(fixturesDir, "fixtures.json");
  const raw = await readFile(path, "utf8");
  return JSON.parse(raw);
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

  const manifest = await loadFixtureManifest(fixturesDir);
  const geom = manifest[name] ?? { cols: 80, rows: 24 };

  using term = new Terminal({ cols: geom.cols, rows: geom.rows });
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
