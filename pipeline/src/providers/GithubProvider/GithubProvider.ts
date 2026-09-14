import type { Config } from '@config';

import { GITHUB_PIPELINE_LABELS } from './GithubProvider.constants';
import type {
  GitHubIssue,
  GitHubIssueComment,
  GitHubIssueCommentRaw,
  GitHubIssueRaw,
  GitHubIssueRawWithState,
  GitHubIssueState,
  GitHubIssueWithState,
  GitHubMilestoneRef,
  GitHubMilestoneWithState,
  GitHubPull,
  GitHubPullWithMerged,
  GitHubRelease,
  PipelineLabel,
} from './GithubProvider.types';
import {
  convertRawIssuetoGitHubIssue,
  fixIssueWithPR,
  getMissingPipelineLabels,
  getPreviousReleaseTag,
  githubFetch,
  isEmptySincePreviousRelease,
  isOrchestratorJobComment,
} from './GithubProvider.utils';

export { GITHUB_PIPELINE_LABELS } from './GithubProvider.constants';

export class GitHubClient {
  constructor(private readonly config: Config) {}

  private repoPath(): { owner: string; repo: string } {
    const parsed = this.config.ownerRepo;

    if (!parsed) {
      throw new Error(`Invalid GITHUB_REPO: ${this.config.GITHUB_REPO}`);
    }

    return parsed;
  }

  private get headers(): HeadersInit {
    return {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${this.config.GITHUB_TOKEN}`,
      'User-Agent': 'llm-app-dev-orchestrator',
      'X-GitHub-Api-Version': '2022-11-28',
    };
  }

  async getOpenIssuesByLabel(label: string): Promise<GitHubIssue[]> {
    const { owner, repo } = this.repoPath();
    const url = new URL(`https://api.github.com/repos/${owner}/${repo}/issues`);

    url.searchParams.set('state', 'open');
    url.searchParams.set('labels', label);
    url.searchParams.set('per_page', '50');

    const response = await githubFetch(url, { headers: this.headers });

    if (!response.ok) {
      const text = await response.text();

      throw new Error(
        `GitHub issues ${response.status}: ${text.slice(0, 500)}`,
      );
    }

    const items = (await response.json()) as GitHubIssueRaw[];

    return items
      .filter((item) => !item.pull_request)
      .map(convertRawIssuetoGitHubIssue);
  }

  async findOpenFixPr(issue: number): Promise<GitHubPull | null> {
    const items = await this.getPrList('open');

    return items.find((pr) => fixIssueWithPR(pr, issue)) ?? null;
  }

  async findMergedFixPr(issue: number): Promise<GitHubPull | null> {
    const items = await this.getPrList('closed');

    return items.find((pr) => pr.merged && fixIssueWithPR(pr, issue)) ?? null;
  }

  async hasOpenFixPr(issue: number): Promise<boolean> {
    return (await this.findOpenFixPr(issue)) !== null;
  }

  async retargetPullBase(pr: number, base: string): Promise<void> {
    const { owner, repo } = this.repoPath();
    const response = await githubFetch(
      `https://api.github.com/repos/${owner}/${repo}/pulls/${pr}`,
      {
        method: 'PATCH',
        headers: { ...this.headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ base }),
      },
    );

    if (!response.ok) {
      const text = await response.text();

      throw new Error(
        `GitHub retarget PR ${response.status}: ${text.slice(0, 500)}`,
      );
    }
  }

  async closeIssue(issue: number): Promise<void> {
    const { owner, repo } = this.repoPath();
    const response = await githubFetch(
      `https://api.github.com/repos/${owner}/${repo}/issues/${issue}`,
      {
        method: 'PATCH',
        headers: { ...this.headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ state: 'closed' }),
      },
    );

    if (!response.ok) {
      const text = await response.text();

      throw new Error(
        `GitHub close issue ${response.status}: ${text.slice(0, 500)}`,
      );
    }
  }

  private async getPrList(
    state: GitHubIssueState,
  ): Promise<GitHubPullWithMerged[]> {
    const { owner, repo } = this.repoPath();
    const url = new URL(`https://api.github.com/repos/${owner}/${repo}/pulls`);

    url.searchParams.set('state', state);
    url.searchParams.set('per_page', '50');

    const response = await githubFetch(url, { headers: this.headers });

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
      headRef: pr.head?.ref ?? '',
      baseRef: pr.base?.ref ?? '',
      merged: Boolean(pr.merged_at),
    }));
  }

  async commentOnIssue(issue: number, body: string): Promise<void> {
    const { owner, repo } = this.repoPath();
    const response = await githubFetch(
      `https://api.github.com/repos/${owner}/${repo}/issues/${issue}/comments`,
      {
        method: 'POST',
        headers: { ...this.headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ body }),
      },
    );

    if (!response.ok) {
      const text = await response.text();

      throw new Error(
        `GitHub comment ${response.status}: ${text.slice(0, 500)}`,
      );
    }
  }

  async listIssueComments(issue: number): Promise<GitHubIssueComment[]> {
    const { owner, repo } = this.repoPath();
    const url = new URL(
      `https://api.github.com/repos/${owner}/${repo}/issues/${issue}/comments`,
    );

    url.searchParams.set('per_page', '100');

    const response = await githubFetch(url, { headers: this.headers });

    if (!response.ok) {
      const text = await response.text();

      throw new Error(
        `GitHub comments ${response.status}: ${text.slice(0, 500)}`,
      );
    }

    const items = (await response.json()) as GitHubIssueCommentRaw[];

    return items
      .filter((item) => !isOrchestratorJobComment(item.body))
      .map((item) => ({
        id: item.id,
        user: item.user?.login ?? 'unknown',
        body: item.body ?? '',
        createdAt: item.created_at,
      }));
  }

  async getIssue(issue: number): Promise<GitHubIssueWithState> {
    const { owner, repo } = this.repoPath();
    const response = await githubFetch(
      `https://api.github.com/repos/${owner}/${repo}/issues/${issue}`,
      { headers: this.headers },
    );

    if (!response.ok) {
      const text = await response.text();

      throw new Error(
        `GitHub get issue ${response.status}: ${text.slice(0, 500)}`,
      );
    }

    const item = (await response.json()) as GitHubIssueRawWithState;

    return {
      ...convertRawIssuetoGitHubIssue(item),
      state: item.state,
    };
  }

  async updateIssueBody(issue: number, body: string): Promise<void> {
    const { owner, repo } = this.repoPath();
    const response = await githubFetch(
      `https://api.github.com/repos/${owner}/${repo}/issues/${issue}`,
      {
        method: 'PATCH',
        headers: { ...this.headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ body }),
      },
    );

    if (!response.ok) {
      const text = await response.text();

      throw new Error(
        `GitHub update issue ${response.status}: ${text.slice(0, 500)}`,
      );
    }
  }

  async getRepoLabels(): Promise<string[]> {
    const { owner, repo } = this.repoPath();
    const names: string[] = [];

    for (let page = 1; ; page++) {
      const url = new URL(
        `https://api.github.com/repos/${owner}/${repo}/labels`,
      );

      url.searchParams.set('per_page', '100');
      url.searchParams.set('page', String(page));

      const response = await githubFetch(url, { headers: this.headers });

      if (!response.ok) {
        const text = await response.text();

        throw new Error(
          `GitHub labels ${response.status}: ${text.slice(0, 500)}`,
        );
      }

      const items = (await response.json()) as Array<{ name: string }>;

      names.push(...items.map((item) => item.name));

      if (items.length < 100) {
        break;
      }
    }

    return names;
  }

  async createRepoLabel(label: PipelineLabel): Promise<void> {
    const { owner, repo } = this.repoPath();
    const response = await githubFetch(
      `https://api.github.com/repos/${owner}/${repo}/labels`,
      {
        method: 'POST',
        headers: { ...this.headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: label.name,
          color: label.color,
          description: label.description,
        }),
      },
    );

    if (response.status === 422) {
      return;
    }

    if (!response.ok) {
      const text = await response.text();
      const accepted = response.headers.get('X-Accepted-GitHub-Permissions');
      const hint =
        response.status === 403
          ? ' Fine-grained PAT needs Issues: Read and write on this repo.'
          : '';
      const extra = accepted ? ` accepted: ${accepted}` : '';

      throw new Error(
        `GitHub create label ${response.status}: ` +
          `${text.slice(0, 500)}${hint}${extra}`,
      );
    }
  }

  async ensurePipelineLabels(): Promise<{
    created: string[];
    skipped: string[];
  }> {
    const existing = await this.getRepoLabels();
    const toCreate = getMissingPipelineLabels(existing);
    const created: string[] = [];

    for (const label of toCreate) {
      await this.createRepoLabel(label);
      created.push(label.name);
    }

    const createdSet = new Set(created);
    const skipped = GITHUB_PIPELINE_LABELS.map((label) => label.name).filter(
      (name) => !createdSet.has(name),
    );

    return { created, skipped };
  }

  async addIssueLabels(issue: number, labels: string[]): Promise<void> {
    if (labels.length === 0) {
      return;
    }

    const { owner, repo } = this.repoPath();
    const response = await githubFetch(
      `https://api.github.com/repos/${owner}/${repo}/issues/${issue}/labels`,
      {
        method: 'POST',
        headers: { ...this.headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ labels }),
      },
    );

    if (!response.ok) {
      const text = await response.text();

      throw new Error(
        `GitHub add labels ${response.status}: ${text.slice(0, 500)}`,
      );
    }
  }

  async removeIssueLabel(issue: number, label: string): Promise<void> {
    const { owner, repo } = this.repoPath();
    const encoded = encodeURIComponent(label);
    const response = await githubFetch(
      `https://api.github.com/repos/${owner}/${repo}/issues/${issue}/labels/${encoded}`,
      { method: 'DELETE', headers: this.headers },
    );

    if (response.status === 404) {
      return;
    }

    if (!response.ok) {
      const text = await response.text();

      throw new Error(
        `GitHub remove label ${response.status}: ${text.slice(0, 500)}`,
      );
    }
  }

  async setIssueAssignees(issue: number, assignees: string[]): Promise<void> {
    const { owner, repo } = this.repoPath();
    const response = await githubFetch(
      `https://api.github.com/repos/${owner}/${repo}/issues/${issue}/assignees`,
      {
        method: 'POST',
        headers: { ...this.headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ assignees }),
      },
    );

    if (!response.ok) {
      const text = await response.text();

      throw new Error(
        `GitHub assignees ${response.status}: ${text.slice(0, 500)}`,
      );
    }
  }

  async requestPullReviewers(pr: number, reviewers: string[]): Promise<void> {
    if (reviewers.length === 0) {
      return;
    }

    const { owner, repo } = this.repoPath();
    const response = await githubFetch(
      `https://api.github.com/repos/${owner}/${repo}/pulls/${pr}/requested_reviewers`,
      {
        method: 'POST',
        headers: { ...this.headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ reviewers }),
      },
    );

    // Author cannot review own PR — treat as soft skip.
    if (response.status === 422) {
      return;
    }

    if (!response.ok) {
      const text = await response.text();

      throw new Error(
        `GitHub request review ${response.status}: ${text.slice(0, 500)}`,
      );
    }
  }

  async findReleaseByTag(tag: string): Promise<{
    id: number;
    draft: boolean;
    html_url: string;
  } | null> {
    const { owner, repo } = this.repoPath();
    const published = await githubFetch(
      `https://api.github.com/repos/${owner}/${repo}/releases/tags/${encodeURIComponent(tag)}`,
      { headers: this.headers },
    );

    if (published.ok) {
      const item = (await published.json()) as {
        id: number;
        draft: boolean;
        html_url: string;
      };

      return { id: item.id, draft: item.draft, html_url: item.html_url };
    }

    if (published.status !== 404) {
      const text = await published.text();

      throw new Error(
        `GitHub release by tag ${published.status}: ${text.slice(0, 500)}`,
      );
    }

    // Drafts are not returned by /releases/tags/{tag} — list and match
    // tag_name.
    const url = new URL(
      `https://api.github.com/repos/${owner}/${repo}/releases`,
    );

    url.searchParams.set('per_page', '50');
    const listed = await githubFetch(url, { headers: this.headers });

    if (!listed.ok) {
      const text = await listed.text();

      throw new Error(
        `GitHub list releases ${listed.status}: ${text.slice(0, 500)}`,
      );
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
          method: 'PATCH',
          headers: { ...this.headers, 'Content-Type': 'application/json' },
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

        throw new Error(
          `GitHub publish draft release ${response.status}: ` +
            `${text.slice(0, 500)}`,
        );
      }

      const item = (await response.json()) as { id: number; html_url: string };

      return { id: item.id, html_url: item.html_url, created: true };
    }

    const response = await githubFetch(
      `https://api.github.com/repos/${owner}/${repo}/releases`,
      {
        method: 'POST',
        headers: { ...this.headers, 'Content-Type': 'application/json' },
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

      throw new Error(
        `GitHub create release ${response.status}: ${text.slice(0, 500)}`,
      );
    }

    const item = (await response.json()) as { id: number; html_url: string };

    return { id: item.id, html_url: item.html_url, created: true };
  }

  /**
   * Non-draft releases (published), including prereleases. Drafts are omitted
   * by this filter.
   */
  async getPublishedReleases(): Promise<GitHubRelease[]> {
    const { owner, repo } = this.repoPath();
    const url = new URL(
      `https://api.github.com/repos/${owner}/${repo}/releases`,
    );

    url.searchParams.set('per_page', '20');
    const response = await githubFetch(url, { headers: this.headers });

    if (!response.ok) {
      const text = await response.text();

      throw new Error(
        `GitHub list releases ${response.status}: ${text.slice(0, 500)}`,
      );
    }

    const items = (await response.json()) as Array<GitHubRelease>;

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
        method: 'PATCH',
        headers: { ...this.headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ body }),
      },
    );

    if (!response.ok) {
      const text = await response.text();

      throw new Error(
        `GitHub update release ${response.status}: ${text.slice(0, 500)}`,
      );
    }
  }

  async getOpenMilestones(): Promise<GitHubMilestoneRef[]> {
    const { owner, repo } = this.repoPath();
    const url = new URL(
      `https://api.github.com/repos/${owner}/${repo}/milestones`,
    );

    url.searchParams.set('state', 'open');
    url.searchParams.set('per_page', '50');
    const response = await githubFetch(url, { headers: this.headers });

    if (!response.ok) {
      const text = await response.text();

      throw new Error(
        `GitHub milestones ${response.status}: ${text.slice(0, 500)}`,
      );
    }

    const items = (await response.json()) as GitHubMilestoneRef[];

    return items.map((item) => ({
      id: item.id,
      number: item.number,
      title: item.title,
      due_on: item.due_on,
      description: item.description,
    }));
  }

  async findMilestoneByTitle(
    title: string,
  ): Promise<GitHubMilestoneWithState | null> {
    const { owner, repo } = this.repoPath();
    const url = new URL(
      `https://api.github.com/repos/${owner}/${repo}/milestones`,
    );

    url.searchParams.set('state', 'all');
    url.searchParams.set('per_page', '100');
    const response = await githubFetch(url, { headers: this.headers });

    if (!response.ok) {
      const text = await response.text();

      throw new Error(
        `GitHub milestones ${response.status}: ${text.slice(0, 500)}`,
      );
    }

    const items = (await response.json()) as GitHubMilestoneWithState[];

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
        method: 'POST',
        headers: { ...this.headers, 'Content-Type': 'application/json' },
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

      throw new Error(
        `GitHub create issue ${response.status}: ${text.slice(0, 500)}`,
      );
    }

    const item = (await response.json()) as GitHubIssueRaw;

    return convertRawIssuetoGitHubIssue(item);
  }

  async setIssueMilestone(issue: number, milestone: number): Promise<void> {
    const { owner, repo } = this.repoPath();
    const response = await githubFetch(
      `https://api.github.com/repos/${owner}/${repo}/issues/${issue}`,
      {
        method: 'PATCH',
        headers: { ...this.headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ milestone }),
      },
    );

    if (!response.ok) {
      const text = await response.text();

      throw new Error(
        `GitHub set issue milestone ${response.status}: ` +
          `${text.slice(0, 500)}`,
      );
    }
  }

  async closeMilestone(
    milestoneNumber: number,
    description?: string,
  ): Promise<void> {
    const { owner, repo } = this.repoPath();
    const payload: { state: 'closed'; description?: string } = {
      state: 'closed',
    };

    if (description !== undefined) {
      payload.description = description;
    }

    const response = await githubFetch(
      `https://api.github.com/repos/${owner}/${repo}/milestones/${milestoneNumber}`,
      {
        method: 'PATCH',
        headers: { ...this.headers, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      },
    );

    if (!response.ok) {
      const text = await response.text();

      throw new Error(
        `GitHub close milestone ${response.status}: ${text.slice(0, 500)}`,
      );
    }
  }

  async getMilestone(
    milestoneNumber: number,
  ): Promise<GitHubMilestoneWithState> {
    const { owner, repo } = this.repoPath();
    const response = await githubFetch(
      `https://api.github.com/repos/${owner}/${repo}/milestones/${milestoneNumber}`,
      { headers: this.headers },
    );

    if (!response.ok) {
      const text = await response.text();

      throw new Error(
        `GitHub get milestone ${response.status}: ${text.slice(0, 500)}`,
      );
    }

    const item = (await response.json()) as GitHubMilestoneWithState;

    return {
      id: milestoneNumber,
      number: item.number,
      title: item.title,
      description: item.description,
      state: item.state,
      due_on: item.due_on,
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
      { headers: this.headers },
    );

    if (response.status === 404) {
      return null;
    }

    if (!response.ok) {
      const text = await response.text();

      throw new Error(
        `GitHub compare ${response.status}: ${text.slice(0, 500)}`,
      );
    }

    const item = (await response.json()) as { ahead_by?: number };

    return typeof item.ahead_by === 'number' ? item.ahead_by : null;
  }

  async detectEmptySincePrevious(
    currentTag: string,
    head: string,
  ): Promise<{ empty: boolean; previousTag: string | null }> {
    const releases = await this.getPublishedReleases();
    const previousTag = getPreviousReleaseTag(releases, currentTag);

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

  async getOpenIssuesForMilestone(
    milestoneNumber: number,
  ): Promise<GitHubIssue[]> {
    const { owner, repo } = this.repoPath();
    const url = new URL(`https://api.github.com/repos/${owner}/${repo}/issues`);

    url.searchParams.set('state', 'open');
    url.searchParams.set('milestone', String(milestoneNumber));
    url.searchParams.set('per_page', '50');
    const response = await githubFetch(url, { headers: this.headers });

    if (!response.ok) {
      const text = await response.text();

      throw new Error(
        `GitHub milestone issues ${response.status}: ${text.slice(0, 500)}`,
      );
    }

    const items = (await response.json()) as GitHubIssueRaw[];

    return items
      .filter((item) => !item.pull_request)
      .map(convertRawIssuetoGitHubIssue);
  }

  /**
   * True if git tag exists or a release (draft/published) uses this tag_name.
   */
  async isTagOrReleaseExists(tag: string): Promise<boolean> {
    const { owner, repo } = this.repoPath();
    const ref = await githubFetch(
      `https://api.github.com/repos/${owner}/${repo}/git/ref/tags/${encodeURIComponent(tag)}`,
      { headers: this.headers },
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
