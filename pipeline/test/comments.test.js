import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { generateJobComment } from "../dist/providers/GithubProvider/GithubProvider.utils.js";
import {
  commentsForAgentRole,
  cursorModelSelection,
  formatCursorModel,
  loggedCursorModel,
  readCursorUsage,
  shouldAttachIssueComments,
} from "../dist/providers/CursorProvider/CursorProvider.utils.js";

const promptsDir = join(dirname(fileURLToPath(import.meta.url)), "../prompts");

const usage = {
  inputTokens: 12480,
  outputTokens: 3110,
  cacheReadTokens: 42600,
  cacheWriteTokens: 18200,
  totalTokens: 76390,
};

test("generateJobComment omits model and tokens until known", () => {
  const body = generateJobComment({
    jobId: "job-1",
    role: "analyst",
    agentId: "bc-1",
    runId: "run-1",
    status: "running",
  });

  assert.match(body, /<!-- pipeline:job:job-1 -->/);
  assert.equal(body.includes("model:"), false);
  assert.equal(body.includes("tokens:"), false);
});

test("generateJobComment appends model and tokens after the run", () => {
  const body = generateJobComment({
    jobId: "job-1",
    role: "analyst",
    agentId: "bc-1",
    runId: "run-1",
    status: "finished",
    decision: "ready-for-dev",
    model: "composer-2.5",
    usage,
  });

  assert.match(body, /model: `composer-2\.5`/);
  assert.match(
    body,
    /tokens: in=12480 out=3110 cacheR=42600 cacheW=18200 total=76390/,
  );
  assert.match(body, /Решение: `ready-for-dev`/);
});

test("formatCursorModel uses fallback and appends params", () => {
  assert.equal(formatCursorModel(undefined, "composer-2.5"), "composer-2.5");
  assert.equal(
    formatCursorModel(
      { id: "composer-2.5", params: [{ id: "fast", value: "true" }] },
      "unused",
    ),
    "composer-2.5 fast=true",
  );
});

test("cursorModelSelection disables Fast on composer and grok", () => {
  assert.deepEqual(cursorModelSelection("composer-2.5"), {
    id: "composer-2.5",
    params: [{ id: "fast", value: "false" }],
  });
  assert.deepEqual(cursorModelSelection("grok-4.6"), {
    id: "grok-4.6",
    params: [{ id: "fast", value: "false" }],
  });
  assert.deepEqual(cursorModelSelection("composer-2.5-fast"), {
    id: "composer-2.5-fast",
  });
  assert.deepEqual(cursorModelSelection("gpt-5.4"), { id: "gpt-5.4" });
});

test("loggedCursorModel keeps requested fast=false when live omits params", () => {
  const requested = cursorModelSelection("composer-2.5");

  assert.equal(
    loggedCursorModel({ id: "composer-2.5" }, requested),
    "composer-2.5 fast=false",
  );
  assert.equal(
    loggedCursorModel(
      { id: "composer-2.5", params: [{ id: "fast", value: "true" }] },
      requested,
    ),
    "composer-2.5 fast=true",
  );
});

test("shouldAttachIssueComments is analyst developer tester", () => {
  assert.equal(shouldAttachIssueComments("analyst"), true);
  assert.equal(shouldAttachIssueComments("developer"), true);
  assert.equal(shouldAttachIssueComments("tester"), true);
  assert.equal(shouldAttachIssueComments("tester-regression"), false);
  assert.equal(shouldAttachIssueComments("release-manager"), false);
});

test("commentsForAgentRole keeps last analyst plan for developer", () => {
  const comments = [
    { body: "human note" },
    { body: "## Результат: analyst\n\nплан v1" },
    { body: "## Результат: developer\n\nPR" },
    { body: "## Результат: analyst\n\nплан v2" },
    { body: "## Результат: tester\n\nqa" },
  ];

  assert.deepEqual(
    commentsForAgentRole("developer", comments).map((item) => item.body),
    ["human note", "## Результат: analyst\n\nплан v2"],
  );
  assert.deepEqual(
    commentsForAgentRole("tester", comments).map((item) => item.body),
    ["human note", "## Результат: analyst\n\nплан v2"],
  );
  assert.equal(commentsForAgentRole("analyst", comments).length, 5);
});

test("readCursorUsage prefers billed counts over live", async () => {
  const billed = await readCursorUsage({
    fetchBilled: async () => ({ usage }),
    live: { ...usage, totalTokens: 2 },
  });

  assert.equal(billed?.totalTokens, 76390);
});

test("readCursorUsage falls back to live when billed is empty", async () => {
  const live = await readCursorUsage({
    fetchBilled: async () => ({
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 0,
      },
    }),
    live: usage,
  });

  assert.equal(live?.totalTokens, 76390);
});

test("readCursorUsage falls back when billed fetch throws", async () => {
  const live = await readCursorUsage({
    fetchBilled: async () => {
      throw new Error("not settled");
    },
    live: usage,
  });

  assert.equal(live?.inputTokens, 12480);
});

test("tester prompt names tester and does not name tester-regression", () => {
  const prompt = readFileSync(join(promptsDir, "tester.md"), "utf8");

  assert.match(prompt, /роль `tester`/);
  assert.match(prompt, /Комментарии issue/);
  assert.match(prompt, /не вызывай `gh`/);
  assert.match(prompt, /gh pr diff/);
  assert.match(prompt, /не делай `npm install`/);
  assert.equal(prompt.includes("tester-regression"), false);
});

test("developer prompt says the plan is already in the message", () => {
  const prompt = readFileSync(join(promptsDir, "developer.md"), "utf8");

  assert.match(prompt, /Комментарии issue/);
  assert.match(prompt, /не вызывай `gh`/);
});

test("feature/bug prompts stay in the product repo", () => {
  const analyst = readFileSync(join(promptsDir, "analyst.md"), "utf8");
  const featurePart = analyst.split("## mvp")[0];
  const developer = readFileSync(join(promptsDir, "developer.md"), "utf8");
  const tester = readFileSync(join(promptsDir, "tester.md"), "utf8");

  assert.equal(featurePart.includes("AGENT_PIPELINE.md"), false);
  assert.equal(developer.includes("AGENT_PIPELINE.md"), false);
  assert.equal(tester.includes("AGENT_PIPELINE.md"), false);
  assert.match(analyst, /## mvp — стартовая задача проекта/);
  assert.match(analyst, /PIPELINE_MVP_TASKS:/);
  assert.match(analyst, /PIPELINE_LABELS: to-approve/);
});

test("tester-regression prompt names that role, not issue-QA", () => {
  const prompt = readFileSync(join(promptsDir, "tester-regression.md"), "utf8");

  assert.match(prompt, /роль `tester-regression`/);
  assert.match(prompt, /не issue-QA/i);
});
