import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const fixtureRoot = path.resolve(here, "..", "fixtures");

export function childFixture(name: string): string {
  return path.join(fixtureRoot, "children", name);
}
