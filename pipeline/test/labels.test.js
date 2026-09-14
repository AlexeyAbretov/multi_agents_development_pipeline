import assert from "node:assert/strict";
import test from "node:test";

import {
  GITHUB_PIPELINE_LABELS,
  missingPipelineLabels,
} from "../dist/providers/GithubProvider/GithubProvider.js";

const CONTRACT_LABELS = [
  "bug",
  "deploy-failed",
  "deployed",
  "feature",
  "in-analysis",
  "in-dev",
  "in-qa",
  "needs-human",
  "needs-plan",
  "p0",
  "p1",
  "p2",
  "p3",
  "qa-in-progress",
  "qa-passed",
  "ready-for-dev",
  "regression",
];

test("pipeline labels catalog matches contract", () => {
  const names = GITHUB_PIPELINE_LABELS.map((label) => label.name).sort();

  assert.deepEqual(names, CONTRACT_LABELS);
});

test("pipeline label names are unique", () => {
  const names = GITHUB_PIPELINE_LABELS.map((label) => label.name);

  assert.equal(names.length, new Set(names).size);
});

test("missingPipelineLabels returns all when repo has none", () => {
  assert.equal(
    missingPipelineLabels([]).length,
    GITHUB_PIPELINE_LABELS.length,
  );
});

test("missingPipelineLabels skips existing names case-insensitively", () => {
  const names = missingPipelineLabels(["BUG", "needs-plan"]).map(
    (label) => label.name,
  );

  assert.equal(names.includes("bug"), false);
  assert.equal(names.includes("needs-plan"), false);
  assert.equal(names.includes("feature"), true);
});
