import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { DeployStore } from "../dist/services/DeployerService/deploy-store.js";

import { MemoryMongo } from "./memory-mongo.js";

function storeDir() {
  return mkdtempSync(join(tmpdir(), "deploy-store-"));
}

async function makeStore() {
  const store = new DeployStore(new MemoryMongo());

  await store.ensureIndexes();

  return store;
}

function sample(patch = {}) {
  return {
    releaseId: 10,
    tag: "v1.0.0",
    status: "deployed",
    mode: "stub",
    detail: "ok",
    at: "2026-01-01T00:00:00.000Z",
    ...patch,
  };
}

test("record replaces the same tag and releaseId", async () => {
  const store = await makeStore();

  await store.record(sample());
  await store.record(sample({ status: "deploy-failed", detail: "boom" }));

  const [row] = await store.list();

  assert.equal((await store.list()).length, 1);
  assert.equal(row.status, "deploy-failed");
  assert.equal(row.detail, "boom");
  assert.equal(await store.has(10), true);
  assert.equal(await store.hasTag("v1.0.0"), true);
  assert.equal(await store.hasSuccessfulTag("v1.0.0"), false);
});

test("has ignores releaseId 0", async () => {
  const store = await makeStore();

  await store.record(sample({ releaseId: 0, tag: "v0.0.1" }));

  assert.equal(await store.has(0), false);
  assert.equal((await store.deployedIds()).size, 0);
  assert.equal(await store.hasTag("v0.0.1"), true);
});

test("importLegacyJson loads deploys.json once then ignores it", async () => {
  const dir = storeDir();
  const store = await makeStore();

  writeFileSync(
    join(dir, "deploys.json"),
    JSON.stringify({ deploys: [sample()] }),
  );

  assert.equal(await store.importLegacyJson(dir), 1);
  assert.equal(await store.importLegacyJson(dir), 0);

  const [row] = await store.list();

  assert.equal(row.tag, "v1.0.0");
  assert.equal(row.releaseId, 10);
});
