import assert from "node:assert/strict";
import test from "node:test";

import { envSchema } from "../dist/config/config.types.js";
import { parsePortsEnv, ports } from "../dist/config/ports.js";

test("ports.env defines distinct positive listen ports", () => {
  assert.ok(ports.ORCHESTRATOR_PORT > 0);
  assert.ok(ports.DEPLOYER_PORT > 0);
  assert.ok(ports.PIPELINE_UI_PORT > 0);
  assert.notEqual(ports.ORCHESTRATOR_PORT, ports.DEPLOYER_PORT);
  assert.notEqual(ports.ORCHESTRATOR_PORT, ports.PIPELINE_UI_PORT);
  assert.notEqual(ports.DEPLOYER_PORT, ports.PIPELINE_UI_PORT);
});

test("PORT defaults to ORCHESTRATOR_PORT from ports.env", () => {
  assert.equal(envSchema.parse({}).PORT, ports.ORCHESTRATOR_PORT);
});

test("parsePortsEnv rejects missing keys", () => {
  assert.throws(() => parsePortsEnv("ORCHESTRATOR_PORT=1\n"));
});
