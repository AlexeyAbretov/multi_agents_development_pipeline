import assert from "node:assert/strict";
import test from "node:test";
import {
  inFlightKey,
  selectJobsToLaunch,
} from "../dist/services/OrchestratorService/dispatch.js";

test("selectJobsToLaunch starts every eligible role in the same tick", () => {
  const launched = selectJobsToLaunch(
    [
      { issue: { number: 1 }, role: "analyst" },
      { issue: { number: 2 }, role: "tester" },
      { issue: { number: 3 }, role: "developer" },
      { issue: { number: 4 }, role: "release-manager" },
      { issue: { number: 5 }, role: "developer" },
      { issue: { number: 6 }, role: "tester-regression" },
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
      "tester-regression:6",
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

test("mvp-queue developers start one at a time in list order", () => {
  const queue = "<!-- pipeline:mvp-queue:12,13 -->";
  const launched = selectJobsToLaunch(
    [
      {
        issue: {
          number: 13,
          body: queue,
          labels: ["feature", "ready-for-dev"],
        },
        role: "developer",
      },
      {
        issue: {
          number: 12,
          body: queue,
          labels: ["feature", "ready-for-dev"],
        },
        role: "developer",
      },
    ],
    new Set(),
  );

  assert.deepEqual(
    launched.map((item) => item.issue.number),
    [12],
  );
});

test("mvp-queue next developer starts after previous left in-dev", () => {
  const queue = "<!-- pipeline:mvp-queue:12,13 -->";
  const catalog = [
    { number: 12, body: queue, labels: ["feature", "in-qa"] },
    { number: 13, body: queue, labels: ["feature", "ready-for-dev"] },
  ];
  const launched = selectJobsToLaunch(
    [{ issue: catalog[1], role: "developer" }],
    new Set(),
    catalog,
  );

  assert.deepEqual(
    launched.map((item) => item.issue.number),
    [13],
  );
});

test("mvp-queue next developer waits while previous is in-dev", () => {
  const queue = "<!-- pipeline:mvp-queue:12,13 -->";
  const catalog = [
    { number: 12, body: queue, labels: ["feature", "in-dev"] },
    { number: 13, body: queue, labels: ["feature", "ready-for-dev"] },
  ];
  const launched = selectJobsToLaunch(
    [{ issue: catalog[1], role: "developer" }],
    new Set(),
    catalog,
  );

  assert.equal(launched.length, 0);
});

test("mvp-queue next developer waits on in-flight previous", () => {
  const queue = "<!-- pipeline:mvp-queue:12,13 -->";
  const launched = selectJobsToLaunch(
    [
      {
        issue: {
          number: 13,
          body: queue,
          labels: ["feature", "ready-for-dev"],
        },
        role: "developer",
      },
    ],
    new Set([inFlightKey(12, "developer")]),
  );

  assert.equal(launched.length, 0);
});

test("developers without mvp-queue still start in parallel", () => {
  const launched = selectJobsToLaunch(
    [
      {
        issue: { number: 20, labels: ["feature", "ready-for-dev"] },
        role: "developer",
      },
      {
        issue: { number: 21, labels: ["bug", "ready-for-dev"] },
        role: "developer",
      },
    ],
    new Set(),
  );

  assert.deepEqual(
    launched.map((item) => item.issue.number),
    [20, 21],
  );
});

test("mvp-queue does not serialize analysts or testers", () => {
  const queue = "<!-- pipeline:mvp-queue:12,13 -->";
  const launched = selectJobsToLaunch(
    [
      {
        issue: { number: 12, body: queue, labels: ["feature", "needs-plan"] },
        role: "analyst",
      },
      {
        issue: { number: 13, body: queue, labels: ["feature", "needs-plan"] },
        role: "analyst",
      },
      {
        issue: { number: 12, body: queue, labels: ["feature", "in-qa"] },
        role: "tester",
      },
    ],
    new Set(),
  );

  assert.deepEqual(
    launched.map((item) => `${item.role}:${item.issue.number}`),
    ["analyst:12", "analyst:13", "tester:12"],
  );
});

test("mvp-queue on a sibling still serializes developer", () => {
  const queue = "<!-- pipeline:mvp-queue:12,13 -->";
  const launched = selectJobsToLaunch(
    [
      {
        issue: { number: 13, labels: ["feature", "ready-for-dev"] },
        role: "developer",
      },
    ],
    new Set(),
    [
      { number: 12, body: queue, labels: ["feature", "in-dev"] },
      { number: 13, labels: ["feature", "ready-for-dev"] },
    ],
  );

  assert.equal(launched.length, 0);
});

test("mvp-queue plus group starts developers in the same stage", () => {
  const queue = "<!-- pipeline:mvp-queue:12+14,16 -->";
  const launched = selectJobsToLaunch(
    [
      {
        issue: {
          number: 14,
          body: queue,
          labels: ["feature", "ready-for-dev"],
        },
        role: "developer",
      },
      {
        issue: {
          number: 12,
          body: queue,
          labels: ["feature", "ready-for-dev"],
        },
        role: "developer",
      },
      {
        issue: {
          number: 16,
          body: queue,
          labels: ["feature", "ready-for-dev"],
        },
        role: "developer",
      },
    ],
    new Set(),
  );

  assert.deepEqual(
    launched.map((item) => item.issue.number),
    [14, 12],
  );
});

test("mvp-queue next stage waits until the whole previous stage left in-dev", () => {
  const queue = "<!-- pipeline:mvp-queue:12+14,16 -->";
  const catalog = [
    { number: 12, body: queue, labels: ["feature", "in-qa"] },
    { number: 14, body: queue, labels: ["feature", "in-dev"] },
    { number: 16, body: queue, labels: ["feature", "ready-for-dev"] },
  ];
  const blocked = selectJobsToLaunch(
    [{ issue: catalog[2], role: "developer" }],
    new Set(),
    catalog,
  );

  assert.equal(blocked.length, 0);

  catalog[1] = { ...catalog[1], labels: ["feature", "in-qa"] };
  const launched = selectJobsToLaunch(
    [{ issue: catalog[2], role: "developer" }],
    new Set(),
    catalog,
  );

  assert.deepEqual(
    launched.map((item) => item.issue.number),
    [16],
  );
});
