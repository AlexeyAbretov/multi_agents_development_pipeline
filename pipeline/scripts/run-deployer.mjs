import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** PORT из .env.local не должен делить 3020 с оркестратором. */
process.env.PORT = "3021";

const here = dirname(fileURLToPath(import.meta.url));
const entry = process.argv[2];

if (!entry) {
  console.error("usage: node scripts/run-deployer.mjs <entry>");
  process.exit(1);
}

await import(pathToFileURL(resolve(here, "..", entry)).href);
