export type CursorMilestone = {
  title: string;
  due_on: string | null;
};

export type CursorIssue = {
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  milestone: CursorMilestone | null;
};

export type CursorPull = {
  number: number;
  title: string;
  html_url: string;
  headRef: string;
};

export type CursorRunResult = {
  agentId: string | null;
  runId: string | null;
  status: 'finished' | 'error' | 'startup_error';
  error: string | null;
  text: string | null;
};

export type CursorRunStarted = {
  agentId: string;
  runId: string;
};
