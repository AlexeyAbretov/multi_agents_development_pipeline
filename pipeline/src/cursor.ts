import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Agent, CursorAgentError } from "@cursor/sdk";
import type { Config } from "./config";
import type { GitHubIssue, GitHubPull } from "./providers";
import type { Role } from "./types";

type CursorRunResult = {
  agentId: string | null;
  runId: string | null;
  status: "finished" | "error" | "startup_error";
  error: string | null;
  text: string | null;
};

function loadPrompt(promptsDir: string, role: Role, issue: GitHubIssue): string {
  if (role === "tester" && issue.labels.includes("regression")) {
    return readFileSync(join(promptsDir, "tester-regression.md"), "utf8");
  }

  return readFileSync(join(promptsDir, `${role}.md`), "utf8");
}

function buildMessage(
  rolePrompt: string,
  issue: GitHubIssue,
  pull?: GitHubPull,
  role?: Role,
): string {
  const lines = [
    rolePrompt.trim(),
    "",
    "## Issue",
    `Номер: #${issue.number}`,
    `URL: ${issue.html_url}`,
    `Заголовок: ${issue.title}`,
    "",
    issue.body?.trim() || "(пустое описание)",
  ];

  if (issue.milestone) {
    lines.push(
      "",
      "## Milestone",
      `Title (tag): ${issue.milestone.title}`,
      `Due: ${issue.milestone.due_on ?? "(нет due)"}`,
    );
  }

  if (pull) {
    lines.push(
      "",
      "## Pull request",
      `Номер: #${pull.number}`,
      `URL: ${pull.html_url}`,
      `Ветка: ${pull.headRef}`,
      `Заголовок: ${pull.title}`,
    );

    if (role === "developer") {
      lines.push(
        "",
        `База твоего PR: \`${pull.headRef}\` — **не** \`main\`.`,
        `Открой PR командой \`gh pr create --base ${pull.headRef}\` (Cursor autoCreatePR часто целится в default branch — сразу смени base, если открылся в main).`,
      );
    }
  }

  return lines.join("\n");
}

export async function runCloudAgent(
  config: Config,
  role: Role,
  issue: GitHubIssue,
  onStarted: (ids: { agentId: string; runId: string }) => Promise<void>,
  pull?: GitHubPull,
): Promise<CursorRunResult> {
  let agentId: string | null = null;
  let runId: string | null = null;

  try {
    await using agent = await Agent.create({
      apiKey: config.CURSOR_API_KEY,
      model: { id: config.CURSOR_MODEL },
      cloud: {
        repos: [
          {
            url: config.CURSOR_REPO_URL,
            startingRef: pull?.headRef || config.CURSOR_STARTING_REF,
          },
        ],
        skipReviewerRequest: true,
        autoCreatePR: role === "developer",
        metadata: {
          issue: String(issue.number),
          role,
        },
      },
    });

    agentId = agent.agentId;
    const run = await agent.send(buildMessage(loadPrompt(config.PROMPTS_DIR, role, issue), issue, pull, role));

    runId = run.id;
    await onStarted({ agentId, runId });

    const result = await run.wait();

    if (result.status === "error") {
      return {
        agentId,
        runId,
        status: "error",
        error: result.error?.message ?? "run.status=error",
        text: result.result ?? null,
      };
    }

    if (result.status === "cancelled") {
      return {
        agentId,
        runId,
        status: "error",
        error: "run cancelled",
        text: result.result ?? null,
      };
    }

    return {
      agentId,
      runId,
      status: "finished",
      error: null,
      text: result.result ?? null,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const retryable =
      err instanceof CursorAgentError ? ` retryable=${String(err.isRetryable)}` : "";
    const status = runId ? "error" : "startup_error";

    return {
      agentId,
      runId,
      status,
      error: `${message}${retryable}`,
      text: null,
    };
  }
}
