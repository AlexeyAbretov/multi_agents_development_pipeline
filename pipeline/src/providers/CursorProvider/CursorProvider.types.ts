export type CursorMilestone = {
  title: string;
  due_on: string | null;
};

export type CursorIssueComment = {
  user: string;
  body: string;
  createdAt: string;
};

export type CursorIssue = {
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  labels?: string[];
  milestone: CursorMilestone | null;
  comments?: CursorIssueComment[];
};

export type CursorPull = {
  number: number;
  title: string;
  html_url: string;
  headRef: string;
};

export type CursorTokenUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
};

export type CursorModelSelection = {
  id: string;
  params?: Array<{ id: string; value: string }>;
};

export type CursorRunResult = {
  agentId: string | null;
  runId: string | null;
  status: 'finished' | 'error' | 'startup_error';
  error: string | null;
  text: string | null;
  model: string | null;
  usage: CursorTokenUsage | null;
};

export type CursorRunStarted = {
  agentId: string;
  runId: string;
};
