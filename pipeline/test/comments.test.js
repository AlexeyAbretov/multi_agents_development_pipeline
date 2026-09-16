import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { generateJobComment } from "../dist/providers/GithubProvider/GithubProvider.utils.js";
import {
  formatCursorModel,
  readCursorUsage,
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
  assert.equal(prompt.includes("tester-regression"), false);
});

test("tester-regression prompt names that role, not issue-QA", () => {
  const prompt = readFileSync(join(promptsDir, "tester-regression.md"), "utf8");

  assert.match(prompt, /роль `tester-regression`/);
  assert.match(prompt, /не issue-QA/i);
});
