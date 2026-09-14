export type GitHubMilestoneRef = {
  id: number;
  number: number;
  title: string;
  due_on: string | null;
  description: string | null;
};

export type GitHubMilestoneWithState = GitHubMilestoneRef & {
  state: string;
};

export type GitHubIssue = {
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  labels: string[];
  milestone: GitHubMilestoneRef | null;
};

export type GitHubIssueState = 'open' | 'closed';

export type GitHubIssueWithState = GitHubIssue & {
  state: GitHubIssueState;
};

export type GitHubPull = {
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  headRef: string;
  baseRef: string;
};

export type GitHubPullWithMerged = GitHubPull & {
  merged: boolean;
};

export type GitHubRelease = {
  id: number;
  tag_name: string;
  name: string | null;
  body: string | null;
  html_url: string;
  draft: boolean;
  prerelease: boolean;
  published_at: string | null;
};

export type GitHubLabelRaw = string | { name: string };

export type PipelineLabel = {
  name: string;
  color: string;
  description: string;
};

export type GitHubIssueRaw = {
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  pull_request?: unknown;
  labels: GitHubLabelRaw[];
  milestone?: GitHubMilestoneRef | null;
};

export type GitHubIssueRawWithState = GitHubIssueRaw & {
  state: GitHubIssueState;
};
