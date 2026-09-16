import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ScheduleStateStore } from "../dist/services/OrchestratorService/schedule-state.js";

import { MemoryMongo } from "./memory-mongo.js";

function storeDir() {
  return mkdtempSync(join(tmpdir(), "schedule-store-"));
}

function makeStore() {
  return new ScheduleStateStore(new MemoryMongo());
}

test("blocked and duplicate-due flags persist", async () => {
  const store = makeStore();

  assert.equal(await store.wasBlockedNotified(7), false);
  await store.markBlockedNotified(7);
  await store.markBlockedNotified(7);
  assert.equal(await store.wasBlockedNotified(7), true);

  assert.equal(await store.wasDuplicateDueNotified("2026-09-16"), false);
  await store.markDuplicateDueNotified("2026-09-16");
  assert.equal(await store.wasDuplicateDueNotified("2026-09-16"), true);
});

test("importLegacyJson loads schedule-state.json once then ignores it", async () => {
  const dir = storeDir();
  const store = makeStore();

  writeFileSync(
    join(dir, "schedule-state.json"),
    JSON.stringify({
      blockedNotified: [3, 5],
      duplicateDueNotified: ["2026-01-01"],
    }),
  );

  assert.equal(await store.importLegacyJson(dir), 3);
  assert.equal(await store.importLegacyJson(dir), 0);
  assert.equal(await store.wasBlockedNotified(3), true);
  assert.equal(await store.wasBlockedNotified(5), true);
  assert.equal(await store.wasDuplicateDueNotified("2026-01-01"), true);
});
