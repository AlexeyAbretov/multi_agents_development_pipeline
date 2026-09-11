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

export type GitHubIssueRaw = {
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
