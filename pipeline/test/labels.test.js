import assert from "node:assert/strict";
import test from "node:test";

import {
  getMissingPipelineLabels,
} from "../dist/providers/GithubProvider/GithubProvider.utils.js";
import { GITHUB_PIPELINE_LABELS } from "../dist/providers/GithubProvider/GithubProvider.constants.js";

const CONTRACT_LABELS = [
  "approved",
  "bug",
  "deploy-failed",
  "deployed",
  "feature",
  "in-analysis",
  "in-dev",
  "in-qa",
  "mvp",
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
  "to-approve",
];

test("pipeline labels catalog matches contract", () => {
  const names = GITHUB_PIPELINE_LABELS.map((label) => label.name).sort();

  assert.deepEqual(names, CONTRACT_LABELS);
});

test("pipeline label names are unique", () => {
  const names = GITHUB_PIPELINE_LABELS.map((label) => label.name);

  assert.equal(names.length, new Set(names).size);
});

test("getMissingPipelineLabels returns all when repo has none", () => {
  assert.equal(
    getMissingPipelineLabels([]).length,
    GITHUB_PIPELINE_LABELS.length,
  );
});

test("getMissingPipelineLabels skips existing names case-insensitively", () => {
  const names = getMissingPipelineLabels(["BUG", "needs-plan"]).map(
    (label) => label.name,
  );

  assert.equal(names.includes("bug"), false);
  assert.equal(names.includes("needs-plan"), false);
  assert.equal(names.includes("feature"), true);
});
