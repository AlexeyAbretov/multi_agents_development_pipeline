import { existsSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Leftover JSON in dist/data (DATA_DIR=./dist/data) is imported
 * into MongoDB once — do not wipe the data folder with compiled JS. */
const KEEP = new Set(["data"]);
const dist = join(dirname(fileURLToPath(import.meta.url)), "..", "dist");

if (!existsSync(dist)) {
  process.exit(0);
}

for (const name of readdirSync(dist)) {
  if (KEEP.has(name)) {
    continue;
  }

  rmSync(join(dist, name), { recursive: true, force: true });
}
