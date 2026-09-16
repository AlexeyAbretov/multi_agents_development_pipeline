import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { JobStore } from "../dist/services/OrchestratorService/jobs.js";

import { MemoryMongo } from "./memory-mongo.js";

function storeDir() {
  return mkdtempSync(join(tmpdir(), "job-store-"));
}

async function makeStore() {
  const store = new JobStore(new MemoryMongo());

  await store.ensureIndexes();

  return store;
}

test("create is idempotent while the (issue, role) lock is held", async () => {
  const store = await makeStore();
  const first = await store.create(1, "analyst");
  const second = await store.create(1, "analyst");

  assert.ok(first);
  assert.equal(second, null);
  assert.equal((await store.snapshot()).jobs.length, 1);
});

test("remove keeps journal rows and allows a new run", async () => {
  const store = await makeStore();
  const first = await store.create(1, "analyst");

  assert.ok(first);
  await store.update(first.id, {
    status: "finished",
    agentId: "bc-old",
    runId: "run-old",
    decision: "needs-human",
  });

  assert.equal(await store.remove(1, "analyst"), true);
  assert.equal(await store.find(1, "analyst"), undefined);

  const second = await store.create(1, "analyst");

  assert.ok(second);
  assert.notEqual(second.id, first.id);

  const snap = await store.snapshot();

  assert.equal(snap.jobs.length, 2);
  assert.equal(snap.jobs[0].agentId, "bc-old");
  assert.equal(snap.jobs[0].cleared, true);
  assert.equal(snap.jobs[1].id, second.id);
});

test("dropUnfinishedJobs marks running jobs error without deleting", async () => {
  const store = await makeStore();
  const job = await store.create(1, "analyst");

  assert.ok(job);
  await store.update(job.id, {
    status: "running",
    agentId: "bc-live",
    runId: "run-live",
  });

  assert.equal(await store.dropUnfinishedJobs(), 1);
  assert.equal(await store.find(1, "analyst"), undefined);

  const [kept] = (await store.snapshot()).jobs;

  assert.equal(kept.agentId, "bc-live");
  assert.equal(kept.status, "error");
  assert.equal(kept.error, "dropped after restart");
  assert.equal(kept.cleared, true);

  const next = await store.create(1, "analyst");

  assert.ok(next);
  assert.equal((await store.snapshot()).jobs.length, 2);
});

test("create stores parentIssue for Related to # child bugs", async () => {
  const store = await makeStore();
  const child = await store.create(18, "analyst", 12);
  const root = await store.create(12, "tester");

  assert.ok(child);
  assert.ok(root);
  assert.equal(child.parentIssue, 12);
  assert.equal(root.parentIssue, null);

  const snap = await store.snapshot();

  assert.equal(snap.jobs[0].parentIssue, 12);
  assert.equal(snap.jobs[1].parentIssue, null);
});

test("importLegacyJson loads jobs.json once then ignores it", async () => {
  const dir = storeDir();
  const store = await makeStore();

  writeFileSync(
    join(dir, "jobs.json"),
    JSON.stringify({
      lastPollAt: "2026-01-01T00:00:00.000Z",
      jobs: [
        {
          id: "legacy-1",
          issue: 41,
          role: "tester",
          status: "finished",
          agentId: "bc-old",
          runId: "run-old",
          error: null,
          decision: "qa-passed",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:01.000Z",
        },
      ],
    }),
  );

  assert.equal(await store.importLegacyJson(dir), 1);
  assert.equal(await store.importLegacyJson(dir), 0);
  assert.equal(await store.lastPollAt(), "2026-01-01T00:00:00.000Z");

  const [job] = (await store.snapshot()).jobs;

  assert.equal(job.id, "legacy-1");
  assert.equal(job.issue, 41);
  assert.equal(job.decision, "qa-passed");
});
