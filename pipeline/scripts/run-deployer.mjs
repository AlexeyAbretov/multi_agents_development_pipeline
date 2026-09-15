import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const portsEnv = join(dirname(fileURLToPath(import.meta.url)), "../ports.env");
const deployerPort = /(?:^|\n)DEPLOYER_PORT=(\d+)/.exec(
  readFileSync(portsEnv, "utf8").replace(/\r/g, ""),
)?.[1];

if (!deployerPort) {
  throw new Error(`DEPLOYER_PORT missing in ${portsEnv}`);
}

/** PORT из .env.local не должен делить порт оркестратора. */
process.env.PORT = deployerPort;

const here = dirname(fileURLToPath(import.meta.url));
const entry = process.argv[2];

if (!entry) {
  console.error("usage: node scripts/run-deployer.mjs <entry>");
  process.exit(1);
}

await import(pathToFileURL(resolve(here, "..", entry)).href);
