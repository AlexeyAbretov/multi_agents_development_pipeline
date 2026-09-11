export type UiJobStatus = "queued" | "running" | "failed" | "finished";

export type PipelineJob = {
  id: string;
  issue: number;
  role: string;
  status: string;
  uiStatus: UiJobStatus;
  agentId: string | null;
  runId: string | null;
  error: string | null;
  decision: string | null;
  createdAt: string;
  updatedAt: string;
  issueUrl: string | null;
  agentUrl: string | null;
};

export type JobsResponse = {
  lastPollAt: string | null;
  githubRepo: string | null;
  jobs: PipelineJob[];
};

export type DeploysResponse = {
  deploys: Array<{
    releaseId: number;
    tag: string;
    status: string;
    mode: string;
    detail: string;
    at: string;
  }>;
  requests: Array<{
    tag: string;
    milestoneTitle: string;
    status: string;
    requestedAt: string;
  }>;
};

export async function fetchJobs(): Promise<JobsResponse> {
  const response = await fetch("/api/jobs");
  if (!response.ok) {
    throw new Error(`API /api/jobs: ${response.status}`);
  }
  return (await response.json()) as JobsResponse;
}

export async function fetchDeploys(): Promise<DeploysResponse> {
  const response = await fetch("/api/deploys");
  if (!response.ok) {
    throw new Error(`API /api/deploys: ${response.status}`);
  }
  return (await response.json()) as DeploysResponse;
}
