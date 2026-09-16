import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { JobStore } from "../dist/services/OrchestratorService/jobs.js";

function storeDir() {
  return mkdtempSync(join(tmpdir(), "job-store-"));
}

test("create is idempotent while the (issue, role) lock is held", async () => {
  const store = new JobStore(storeDir());
  const first = await store.create(1, "analyst");
  const second = await store.create(1, "analyst");

  assert.ok(first);
  assert.equal(second, null);
  assert.equal((await store.snapshot()).jobs.length, 1);
});

test("remove keeps journal rows and allows a new run", async () => {
  const dir = storeDir();
  const store = new JobStore(dir);
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

  const file = JSON.parse(readFileSync(join(dir, "jobs.json"), "utf8"));

  assert.equal(file.jobs.length, 2);
  assert.equal(file.jobs[0].agentId, "bc-old");
});

test("dropUnfinishedJobs marks running jobs error without deleting", async () => {
  const store = new JobStore(storeDir());
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
  const store = new JobStore(storeDir());
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
