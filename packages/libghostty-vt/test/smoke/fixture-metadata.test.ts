import { describe, test, expect } from "bun:test";
import { join } from "node:path";
import { listFixtures, loadFixtureManifest } from "../helpers/fixture-harness";
import { runMetadataFixture } from "../helpers/metadata-harness";

const FIXTURES_DIR = join(import.meta.dir, "..", "fixtures");
const UPDATE = process.env.UPDATE_FIXTURES === "1";

describe("fixture metadata replay", async () => {
  const manifest = await loadFixtureManifest(FIXTURES_DIR);
  const fixtures = await listFixtures(FIXTURES_DIR);

  for (const name of fixtures) {
    test(name, async () => {
      const geom = manifest[name];
      if (!geom) {
        throw new Error(`fixture ${name} missing in fixtures.json manifest`);
      }
      const result = await runMetadataFixture(FIXTURES_DIR, name, geom, { update: UPDATE });
      if (!result.pass) {
        console.error(`metadata mismatch for ${name}:\n${result.diff}`);
      }
      expect(result.pass).toBe(true);
    });
  }
});
