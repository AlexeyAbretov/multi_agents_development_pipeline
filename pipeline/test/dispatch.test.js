import assert from "node:assert/strict";
import test from "node:test";
import { inFlightKey, selectJobsToLaunch } from "../dist/dispatch.js";

test("selectJobsToLaunch starts every eligible role in the same tick", () => {
  const launched = selectJobsToLaunch(
    [
      { issue: { number: 1 }, role: "analyst" },
      { issue: { number: 2 }, role: "tester" },
      { issue: { number: 3 }, role: "developer" },
      { issue: { number: 4 }, role: "release-manager" },
      { issue: { number: 5 }, role: "developer" },
    ],
    new Set(),
  );
  assert.deepEqual(
    launched.map((item) => `${item.role}:${item.issue.number}`),
    [
      "analyst:1",
      "tester:2",
      "developer:3",
      "release-manager:4",
      "developer:5",
    ],
  );
});

test("selectJobsToLaunch starts ready-for-dev even when other roles are in-flight", () => {
  const work = [
    { issue: { number: 10 }, role: "analyst" },
    { issue: { number: 11 }, role: "developer" },
    { issue: { number: 12 }, role: "tester" },
    { issue: { number: 13 }, role: "developer" },
  ];
  const launched = selectJobsToLaunch(
    work,
    new Set([inFlightKey(10, "analyst"), inFlightKey(12, "tester")]),
  );
  assert.deepEqual(
    launched.map((item) => `${item.role}:${item.issue.number}`),
    ["developer:11", "developer:13"],
  );
});

test("selectJobsToLaunch starts in-qa tester even when analyst or developer is in-flight", () => {
  const launched = selectJobsToLaunch(
    [
      { issue: { number: 30 }, role: "analyst" },
      { issue: { number: 31 }, role: "developer" },
      { issue: { number: 32 }, role: "tester" },
      { issue: { number: 33 }, role: "tester" },
    ],
    new Set([inFlightKey(30, "analyst"), inFlightKey(31, "developer")]),
  );
  assert.deepEqual(
    launched.map((item) => `${item.role}:${item.issue.number}`),
    ["tester:32", "tester:33"],
  );
});

test("selectJobsToLaunch skips an already running tester and still starts other in-qa", () => {
  const launched = selectJobsToLaunch(
    [
      { issue: { number: 40 }, role: "tester" },
      { issue: { number: 41 }, role: "tester" },
      { issue: { number: 42 }, role: "analyst" },
    ],
    new Set([inFlightKey(40, "tester")]),
  );
  assert.deepEqual(
    launched.map((item) => `${item.role}:${item.issue.number}`),
    ["tester:41", "analyst:42"],
  );
});

test("selectJobsToLaunch skips an already running developer and still starts others", () => {
  const launched = selectJobsToLaunch(
    [
      { issue: { number: 20 }, role: "developer" },
      { issue: { number: 21 }, role: "developer" },
      { issue: { number: 22 }, role: "analyst" },
    ],
    new Set([inFlightKey(20, "developer")]),
  );
  assert.deepEqual(
    launched.map((item) => `${item.role}:${item.issue.number}`),
    ["developer:21", "analyst:22"],
  );
});

test("selectJobsToLaunch de-duplicates the same (issue, role) pair", () => {
  const launched = selectJobsToLaunch(
    [
      { issue: { number: 7 }, role: "developer" },
      { issue: { number: 7 }, role: "developer" },
    ],
    new Set(),
  );
  assert.equal(launched.length, 1);
  assert.equal(launched[0]?.issue.number, 7);
});
