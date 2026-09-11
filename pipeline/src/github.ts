import { parseOwnerRepo, type Config } from "./config.js";
import type { GitHubRelease } from "./deploy-rules.js";
import { prFixesIssue } from "./rules.js";
import { isEmptySincePreviousRelease, previousReleaseTag } from "./schedule-rules.js";

export type GitHubMilestoneRef = {
  id: number;
  number: number;
  title: string;
  due_on: string | null;
};

export type GitHubIssue = {
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  labels: string[];
  milestone: GitHubMilestoneRef | null;
};

export type GitHubPull = {
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  headRef: string;
  baseRef: string;
};

type GitHubIssueRaw = {
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  pull_request?: unknown;
  labels: Array<string | { name: string }>;
  milestone?: {
    id: number;
    number: number;
    title: string;
    due_on: string | null;
  } | null;
};

function labelNames(labels: GitHubIssueRaw["labels"]): string[] {
  return labels.map((label) => (typeof label === "string" ? label : label.name));
}

function toGitHubIssue(item: GitHubIssueRaw): GitHubIssue {
  return {
    number: item.number,
    title: item.title,
    body: item.body,
    html_url: item.html_url,
    labels: labelNames(item.labels),
    milestone: item.milestone
      ? {
        id: item.milestone.id,
        number: item.milestone.number,
        title: item.milestone.title,
        due_on: item.milestone.due_on,
      }
      : null,
  };
}

function isTransientNetworkError(err: unknown): boolean {
  const parts: string[] = [];
  let current: unknown = err;

  for (let i = 0; i < 4 && current; i++) {
    if (current instanceof Error) {
      parts.push(current.message, current.name);
      current = current.cause;
    } else {
      parts.push(String(current));
      break;
    }
  }

  return /ENOTFOUND|EAI_AGAIN|ECONNRESET|ETIMEDOUT|UND_ERR_SOCKET|fetch failed/i.test(
    parts.join(" "),
  );
}

async function githubFetch(url: string | URL, init?: RequestInit): Promise<Response> {
  const attempts = 3;
  let last: unknown;

  for (let i = 0; i < attempts; i++) {
    try {
      return await fetch(url, init);
    } catch (err) {
      last = err;

      if (!isTransientNetworkError(err) || i === attempts - 1) {
        throw err;
      }

      await new Promise((resolve) => setTimeout(resolve, 400 * (i + 1)));
    }
  }

  throw last;
}

export class GitHubClient {
  constructor(private readonly config: Config) {}

  private repoPath(): { owner: string; repo: string } {
    const parsed = parseOwnerRepo(this.config.GITHUB_REPO);

    if (!parsed) {
      throw new Error(`Invalid GITHUB_REPO: ${this.config.GITHUB_REPO}`);
    }

    return parsed;
  }

  private headers(): HeadersInit {
    return {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${this.config.GITHUB_TOKEN}`,
      "User-Agent": "llm-app-dev-orchestrator",
      "X-GitHub-Api-Version": "2022-11-28",
    };
  }

  async listOpenIssuesByLabel(label: string): Promise<GitHubIssue[]> {
    const { owner, repo } = this.repoPath();
    const url = new URL(`https://api.github.com/repos/${owner}/${repo}/issues`);

    url.searchParams.set("state", "open");
    url.searchParams.set("labels", label);
    url.searchParams.set("per_page", "50");

    const response = await githubFetch(url, { headers: this.headers() });

    if (!response.ok) {
      const text = await response.text();

      throw new Error(`GitHub issues ${response.status}: ${text.slice(0, 500)}`);
    }

    const items = (await response.json()) as GitHubIssueRaw[];

    return items
      .filter((item) => !item.pull_request)
      .map(toGitHubIssue);
  }

  async findOpenFixPr(issue: number): Promise<GitHubPull | null> {
    const items = await this.listPulls("open");

    return items.find((pr) => prFixesIssue(pr, issue)) ?? null;
  }

  async findMergedFixPr(issue: number): Promise<GitHubPull | null> {
    const items = await this.listPulls("closed");

    return items.find((pr) => pr.merged && prFixesIssue(pr, issue)) ?? null;
  }

  async hasOpenFixPr(issue: number): Promise<boolean> {
    return (await this.findOpenFixPr(issue)) !== null;
  }

  async retargetPullBase(pr: number, base: string): Promise<void> {
    const { owner, repo } = this.repoPath();
    const response = await githubFetch(
      `https://api.github.com/repos/${owner}/${repo}/pulls/${pr}`,
      {
        method: "PATCH",
        headers: { ...this.headers(), "Content-Type": "application/json" },
        body: JSON.stringify({ base }),
      },
    );

    if (!response.ok) {
      const text = await response.text();

      throw new Error(`GitHub retarget PR ${response.status}: ${text.slice(0, 500)}`);
    }
  }

  async closeIssue(issue: number): Promise<void> {
    const { owner, repo } = this.repoPath();
    const response = await githubFetch(
      `https://api.github.com/repos/${owner}/${repo}/issues/${issue}`,
      {
        method: "PATCH",
        headers: { ...this.headers(), "Content-Type": "application/json" },
        body: JSON.stringify({ state: "closed" }),
      },
    );

    if (!response.ok) {
      const text = await response.text();

      throw new Error(`GitHub close issue ${response.status}: ${text.slice(0, 500)}`);
    }
  }

  private async listPulls(state: "open" | "closed"): Promise<Array<GitHubPull & { merged: boolean }>> {
    const { owner, repo } = this.repoPath();
    const url = new URL(`https://api.github.com/repos/${owner}/${repo}/pulls`);

    url.searchParams.set("state", state);
    url.searchParams.set("per_page", "50");

    const response = await githubFetch(url, { headers: this.headers() });

    if (!response.ok) {
      const text = await response.text();

      throw new Error(`GitHub pulls ${response.status}: ${text.slice(0, 500)}`);
    }

    const items = (await response.json()) as Array<{
      number: number;
      title: string;
      body: string | null;
      html_url: string;
      merged_at?: string | null;
      head?: { ref?: string };
      base?: { ref?: string };
    }>;

    return items.map((pr) => ({
      number: pr.number,
      title: pr.title,
      body: pr.body,
      html_url: pr.html_url,
      headRef: pr.head?.ref ?? "",
      baseRef: pr.base?.ref ?? "",
      merged: Boolean(pr.merged_at),
    }));
  }

  async commentOnIssue(issue: number, body: string): Promise<void> {
    const { owner, repo } = this.repoPath();
    const response = await githubFetch(
      `https://api.github.com/repos/${owner}/${repo}/issues/${issue}/comments`,
      {
        method: "POST",
        headers: { ...this.headers(), "Content-Type": "application/json" },
        body: JSON.stringify({ body }),
      },
    );

    if (!response.ok) {
      const text = await response.text();

      throw new Error(`GitHub comment ${response.status}: ${text.slice(0, 500)}`);
    }
  }

  async getIssue(issue: number): Promise<GitHubIssue & { state: "open" | "closed" }> {
    const { owner, repo } = this.repoPath();
    const response = await githubFetch(
      `https://api.github.com/repos/${owner}/${repo}/issues/${issue}`,
      { headers: this.headers() },
    );

    if (!response.ok) {
      const text = await response.text();

      throw new Error(`GitHub get issue ${response.status}: ${text.slice(0, 500)}`);
    }

    const item = (await response.json()) as GitHubIssueRaw & { state: "open" | "closed" };

    return {
      ...toGitHubIssue(item),
      state: item.state,
    };
  }

  async updateIssueBody(issue: number, body: string): Promise<void> {
    const { owner, repo } = this.repoPath();
    const response = await githubFetch(
      `https://api.github.com/repos/${owner}/${repo}/issues/${issue}`,
      {
        method: "PATCH",
        headers: { ...this.headers(), "Content-Type": "application/json" },
        body: JSON.stringify({ body }),
      },
    );

    if (!response.ok) {
      const text = await response.text();

      throw new Error(`GitHub update issue ${response.status}: ${text.slice(0, 500)}`);
    }
  }

  async addIssueLabels(issue: number, labels: string[]): Promise<void> {
    if (labels.length === 0) {
      return;
    }

    const { owner, repo } = this.repoPath();
    const response = await githubFetch(
      `https://api.github.com/repos/${owner}/${repo}/issues/${issue}/labels`,
      {
        method: "POST",
        headers: { ...this.headers(), "Content-Type": "application/json" },
        body: JSON.stringify({ labels }),
      },
    );

    if (!response.ok) {
      const text = await response.text();

      throw new Error(`GitHub add labels ${response.status}: ${text.slice(0, 500)}`);
    }
  }

  async removeIssueLabel(issue: number, label: string): Promise<void> {
    const { owner, repo } = this.repoPath();
    const encoded = encodeURIComponent(label);
    const response = await githubFetch(
      `https://api.github.com/repos/${owner}/${repo}/issues/${issue}/labels/${encoded}`,
      { method: "DELETE", headers: this.headers() },
    );

    if (response.status === 404) {
      return;
    }

    if (!response.ok) {
      const text = await response.text();

      throw new Error(`GitHub remove label ${response.status}: ${text.slice(0, 500)}`);
    }
  }

  async setIssueAssignees(issue: number, assignees: string[]): Promise<void> {
    const { owner, repo } = this.repoPath();
    const response = await githubFetch(
      `https://api.github.com/repos/${owner}/${repo}/issues/${issue}/assignees`,
      {
        method: "POST",
        headers: { ...this.headers(), "Content-Type": "application/json" },
        body: JSON.stringify({ assignees }),
      },
    );

    if (!response.ok) {
      const text = await response.text();

      throw new Error(`GitHub assignees ${response.status}: ${text.slice(0, 500)}`);
    }
  }

  /** Repo owner login — default assignee / reviewer for release approval. */
  releaseOwnerLogin(): string {
    return this.repoPath().owner;
  }

  async requestPullReviewers(pr: number, reviewers: string[]): Promise<void> {
    if (reviewers.length === 0) {
      return;
    }

    const { owner, repo } = this.repoPath();
    const response = await githubFetch(
      `https://api.github.com/repos/${owner}/${repo}/pulls/${pr}/requested_reviewers`,
      {
        method: "POST",
        headers: { ...this.headers(), "Content-Type": "application/json" },
        body: JSON.stringify({ reviewers }),
      },
    );

    // Author cannot review own PR — treat as soft skip.
    if (response.status === 422) {
      return;
    }

    if (!response.ok) {
      const text = await response.text();

      throw new Error(`GitHub request review ${response.status}: ${text.slice(0, 500)}`);
    }
  }

  async findReleaseByTag(tag: string): Promise<{ id: number; draft: boolean; html_url: string } | null> {
    const { owner, repo } = this.repoPath();
    const published = await githubFetch(
      `https://api.github.com/repos/${owner}/${repo}/releases/tags/${encodeURIComponent(tag)}`,
      { headers: this.headers() },
    );

    if (published.ok) {
      const item = (await published.json()) as { id: number; draft: boolean; html_url: string };

      return { id: item.id, draft: item.draft, html_url: item.html_url };
    }

    if (published.status !== 404) {
      const text = await published.text();

      throw new Error(`GitHub release by tag ${published.status}: ${text.slice(0, 500)}`);
    }

    // Drafts are not returned by /releases/tags/{tag} — list and match tag_name.
    const url = new URL(`https://api.github.com/repos/${owner}/${repo}/releases`);

    url.searchParams.set("per_page", "50");
    const listed = await githubFetch(url, { headers: this.headers() });

    if (!listed.ok) {
      const text = await listed.text();

      throw new Error(`GitHub list releases ${listed.status}: ${text.slice(0, 500)}`);
    }

    const items = (await listed.json()) as Array<{
      id: number;
      draft: boolean;
      html_url: string;
      tag_name: string;
    }>;
    const found = items.find((item) => item.tag_name === tag);

    if (!found) {
      return null;
    }

    return { id: found.id, draft: found.draft, html_url: found.html_url };
  }

  /**
   * Creates a **published** GitHub Release (creates the git tag). Never draft.
   * If a published release with this tag already exists, returns it unchanged.
   */
  async createPublishedRelease(params: {
    tag: string;
    name: string;
    body: string;
  }): Promise<{ id: number; html_url: string; created: boolean }> {
    const { owner, repo } = this.repoPath();
    const existing = await this.findReleaseByTag(params.tag);

    if (existing && !existing.draft) {
      return { id: existing.id, html_url: existing.html_url, created: false };
    }

    if (existing?.draft) {
      const response = await githubFetch(
        `https://api.github.com/repos/${owner}/${repo}/releases/${existing.id}`,
        {
          method: "PATCH",
          headers: { ...this.headers(), "Content-Type": "application/json" },
          body: JSON.stringify({
            tag_name: params.tag,
            name: params.name,
            body: params.body,
            draft: false,
            prerelease: false,
          }),
        },
      );

      if (!response.ok) {
        const text = await response.text();

        throw new Error(`GitHub publish draft release ${response.status}: ${text.slice(0, 500)}`);
      }

      const item = (await response.json()) as { id: number; html_url: string };

      return { id: item.id, html_url: item.html_url, created: true };
    }

    const response = await githubFetch(
      `https://api.github.com/repos/${owner}/${repo}/releases`,
      {
        method: "POST",
        headers: { ...this.headers(), "Content-Type": "application/json" },
        body: JSON.stringify({
          tag_name: params.tag,
          name: params.name,
          body: params.body,
          draft: false,
          prerelease: false,
          generate_release_notes: false,
        }),
      },
    );

    if (!response.ok) {
      const text = await response.text();

      throw new Error(`GitHub create release ${response.status}: ${text.slice(0, 500)}`);
    }

    const item = (await response.json()) as { id: number; html_url: string };

    return { id: item.id, html_url: item.html_url, created: true };
  }

  /** Non-draft releases (published), including prereleases. Drafts are omitted by this filter. */
  async listPublishedReleases(): Promise<GitHubRelease[]> {
    const { owner, repo } = this.repoPath();
    const url = new URL(`https://api.github.com/repos/${owner}/${repo}/releases`);

    url.searchParams.set("per_page", "20");
    const response = await githubFetch(url, { headers: this.headers() });

    if (!response.ok) {
      const text = await response.text();

      throw new Error(`GitHub list releases ${response.status}: ${text.slice(0, 500)}`);
    }

    const items = (await response.json()) as Array<{
      id: number;
      tag_name: string;
      name: string | null;
      body: string | null;
      html_url: string;
      draft: boolean;
      prerelease: boolean;
      published_at: string | null;
    }>;

    return items
      .filter((item) => !item.draft)
      .map((item) => ({
        id: item.id,
        tag_name: item.tag_name,
        name: item.name,
        body: item.body,
        html_url: item.html_url,
        draft: item.draft,
        prerelease: item.prerelease,
        published_at: item.published_at,
      }));
  }

  async updateReleaseBody(releaseId: number, body: string): Promise<void> {
    const { owner, repo } = this.repoPath();
    const response = await githubFetch(
      `https://api.github.com/repos/${owner}/${repo}/releases/${releaseId}`,
      {
        method: "PATCH",
        headers: { ...this.headers(), "Content-Type": "application/json" },
        body: JSON.stringify({ body }),
      },
    );

    if (!response.ok) {
      const text = await response.text();

      throw new Error(`GitHub update release ${response.status}: ${text.slice(0, 500)}`);
    }
  }

  async listOpenMilestones(): Promise<
    Array<{ id: number; number: number; title: string; due_on: string | null }>
  > {
    const { owner, repo } = this.repoPath();
    const url = new URL(`https://api.github.com/repos/${owner}/${repo}/milestones`);

    url.searchParams.set("state", "open");
    url.searchParams.set("per_page", "50");
    const response = await githubFetch(url, { headers: this.headers() });

    if (!response.ok) {
      const text = await response.text();

      throw new Error(`GitHub milestones ${response.status}: ${text.slice(0, 500)}`);
    }

    const items = (await response.json()) as Array<{
      id: number;
      number: number;
      title: string;
      due_on: string | null;
    }>;

    return items.map((item) => ({
      id: item.id,
      number: item.number,
      title: item.title,
      due_on: item.due_on,
    }));
  }

  async findMilestoneByTitle(
    title: string,
  ): Promise<{ id: number; number: number; title: string; due_on: string | null; state: string } | null> {
    const { owner, repo } = this.repoPath();
    const url = new URL(`https://api.github.com/repos/${owner}/${repo}/milestones`);

    url.searchParams.set("state", "all");
    url.searchParams.set("per_page", "100");
    const response = await githubFetch(url, { headers: this.headers() });

    if (!response.ok) {
      const text = await response.text();

      throw new Error(`GitHub milestones ${response.status}: ${text.slice(0, 500)}`);
    }

    const items = (await response.json()) as Array<{
      id: number;
      number: number;
      title: string;
      due_on: string | null;
      state: string;
    }>;

    return items.find((item) => item.title === title) ?? null;
  }

  async createIssue(params: {
    title: string;
    body: string;
    labels: string[];
    milestone: number;
  }): Promise<GitHubIssue> {
    const { owner, repo } = this.repoPath();
    const response = await githubFetch(
      `https://api.github.com/repos/${owner}/${repo}/issues`,
      {
        method: "POST",
        headers: { ...this.headers(), "Content-Type": "application/json" },
        body: JSON.stringify({
          title: params.title,
          body: params.body,
          labels: params.labels,
          milestone: params.milestone,
        }),
      },
    );

    if (!response.ok) {
      const text = await response.text();

      throw new Error(`GitHub create issue ${response.status}: ${text.slice(0, 500)}`);
    }

    const item = (await response.json()) as GitHubIssueRaw;

    return toGitHubIssue(item);
  }

  async setIssueMilestone(issue: number, milestone: number): Promise<void> {
    const { owner, repo } = this.repoPath();
    const response = await githubFetch(
      `https://api.github.com/repos/${owner}/${repo}/issues/${issue}`,
      {
        method: "PATCH",
        headers: { ...this.headers(), "Content-Type": "application/json" },
        body: JSON.stringify({ milestone }),
      },
    );

    if (!response.ok) {
      const text = await response.text();

      throw new Error(`GitHub set issue milestone ${response.status}: ${text.slice(0, 500)}`);
    }
  }

  async closeMilestone(milestoneNumber: number, description?: string): Promise<void> {
    const { owner, repo } = this.repoPath();
    const payload: { state: "closed"; description?: string } = { state: "closed" };

    if (description !== undefined) {
      payload.description = description;
    }

    const response = await githubFetch(
      `https://api.github.com/repos/${owner}/${repo}/milestones/${milestoneNumber}`,
      {
        method: "PATCH",
        headers: { ...this.headers(), "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      },
    );

    if (!response.ok) {
      const text = await response.text();

      throw new Error(`GitHub close milestone ${response.status}: ${text.slice(0, 500)}`);
    }
  }

  async getMilestone(
    milestoneNumber: number,
  ): Promise<{ number: number; title: string; description: string | null; state: string }> {
    const { owner, repo } = this.repoPath();
    const response = await githubFetch(
      `https://api.github.com/repos/${owner}/${repo}/milestones/${milestoneNumber}`,
      { headers: this.headers() },
    );

    if (!response.ok) {
      const text = await response.text();

      throw new Error(`GitHub get milestone ${response.status}: ${text.slice(0, 500)}`);
    }

    const item = (await response.json()) as {
      number: number;
      title: string;
      description: string | null;
      state: string;
    };

    return {
      number: item.number,
      title: item.title,
      description: item.description,
      state: item.state,
    };
  }

  /**
   * How many commits `head` is ahead of `base` (tag or branch).
   * `null` if compare failed (missing ref, network).
   */
  async commitsAhead(base: string, head: string): Promise<number | null> {
    const { owner, repo } = this.repoPath();
    const spec = `${encodeURIComponent(base)}...${encodeURIComponent(head)}`;
    const response = await githubFetch(
      `https://api.github.com/repos/${owner}/${repo}/compare/${spec}`,
      { headers: this.headers() },
    );

    if (response.status === 404) {
      return null;
    }

    if (!response.ok) {
      const text = await response.text();

      throw new Error(`GitHub compare ${response.status}: ${text.slice(0, 500)}`);
    }

    const item = (await response.json()) as { ahead_by?: number };

    return typeof item.ahead_by === "number" ? item.ahead_by : null;
  }

  async detectEmptySincePrevious(
    currentTag: string,
    head: string,
  ): Promise<{ empty: boolean; previousTag: string | null }> {
    const releases = await this.listPublishedReleases();
    const previousTag = previousReleaseTag(releases, currentTag);

    if (!previousTag) {
      return { empty: false, previousTag: null };
    }

    let aheadBy: number | null;

    try {
      aheadBy = await this.commitsAhead(previousTag, head);
    } catch {
      aheadBy = null;
    }

    return {
      empty: isEmptySincePreviousRelease({ previousTag, aheadBy }),
      previousTag,
    };
  }

  async listOpenIssuesForMilestone(milestoneNumber: number): Promise<GitHubIssue[]> {
    const { owner, repo } = this.repoPath();
    const url = new URL(`https://api.github.com/repos/${owner}/${repo}/issues`);

    url.searchParams.set("state", "open");
    url.searchParams.set("milestone", String(milestoneNumber));
    url.searchParams.set("per_page", "50");
    const response = await githubFetch(url, { headers: this.headers() });

    if (!response.ok) {
      const text = await response.text();

      throw new Error(`GitHub milestone issues ${response.status}: ${text.slice(0, 500)}`);
    }

    const items = (await response.json()) as GitHubIssueRaw[];

    return items
      .filter((item) => !item.pull_request)
      .map(toGitHubIssue);
  }

  /** True if git tag exists or a release (draft/published) uses this tag_name. */
  async tagOrReleaseExists(tag: string): Promise<boolean> {
    const { owner, repo } = this.repoPath();
    const ref = await githubFetch(
      `https://api.github.com/repos/${owner}/${repo}/git/ref/tags/${encodeURIComponent(tag)}`,
      { headers: this.headers() },
    );

    if (ref.ok) {
      return true;
    }

    if (ref.status !== 404) {
      const text = await ref.text();

      throw new Error(`GitHub tag ref ${ref.status}: ${text.slice(0, 500)}`);
    }

    const release = await this.findReleaseByTag(tag);

    return release !== null;
  }
}

export function jobComment(params: {
  jobId: string;
  role: string;
  agentId: string | null;
  runId: string | null;
  status: string;
  error?: string | null;
  decision?: string | null;
}): string {
  const lines = [
    `<!-- pipeline:job:${params.jobId} -->`,
    `Пайплайн: роль \`${params.role}\`, статус \`${params.status}\`.`,
    params.agentId ? `agentId: \`${params.agentId}\`` : "agentId: —",
    params.runId ? `runId: \`${params.runId}\`` : "runId: —",
  ];

  if (params.decision) {
    lines.push(`Решение: \`${params.decision}\`.`);
  }

  if (params.error) {
    lines.push(`Ошибка: ${params.error}`);
  }

  return lines.join("\n");
}

const GITHUB_COMMENT_MAX = 60_000;

export function agentResultComment(role: string, text: string): string {
  const header = `## Результат: ${role}\n\n`;
  const trimmed = text.trim() || "(пустой ответ агента)";

  if (header.length + trimmed.length <= GITHUB_COMMENT_MAX) {
    return header + trimmed;
  }

  const budget = GITHUB_COMMENT_MAX - header.length - 40;

  return `${header}${trimmed.slice(0, budget)}\n\n… (обрезано, полный текст в Cursor SDK)`;
}
