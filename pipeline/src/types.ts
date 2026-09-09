export type Role = "analyst" | "developer" | "tester" | "release-manager";

export type JobStatus = "queued" | "running" | "finished" | "error" | "startup_error";

export type Job = {
  id: string;
  issue: number;
  role: Role;
  status: JobStatus;
  agentId: string | null;
  runId: string | null;
  error: string | null;
  /** Итог оркестратора: ready-for-dev, in-qa, qa-passed, released, needs-human, … */
  decision: string | null;
  createdAt: string;
  updatedAt: string;
};

/** UI-статус очереди (контракт AGENT_PIPELINE_PLAN UI). */
export type UiJobStatus = "queued" | "running" | "waiting-approval" | "failed" | "finished";

export function uiStatusForJob(job: Pick<Job, "status" | "decision" | "role">): UiJobStatus {
  if (job.status === "queued") {
    return "queued";
  }
  if (job.status === "running") {
    return "running";
  }
  if (job.status === "error" || job.status === "startup_error") {
    return "failed";
  }
  if (job.decision === "needs-human") {
    return "failed";
  }
  return "finished";
}
