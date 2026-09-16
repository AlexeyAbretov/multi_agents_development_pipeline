import type { PipelineJob, UiJobStatus } from "./api";

export type JobGroup = {
  issue: number;
  relatedIssues: number[];
  jobs: PipelineJob[];
  activeJobs: PipelineJob[];
  updatedAt: string;
};

const ACTIVE_STATUS_RANK: Record<UiJobStatus, number> = {
  running: 0,
  queued: 1,
  clarification: 2,
  failed: 3,
  finished: 4,
};

function groupIssue(job: PipelineJob, parentOf: Map<number, number>): number {
  return parentOf.get(job.issue) ?? job.parentIssue ?? job.issue;
}

function parentMap(jobs: PipelineJob[]): Map<number, number> {
  const parentOf = new Map<number, number>();

  for (const job of jobs) {
    if (job.parentIssue != null) {
      parentOf.set(job.issue, job.parentIssue);
    }
  }

  return parentOf;
}

export function isActiveJob(job: PipelineJob): boolean {
  return (
    !job.cleared &&
    (job.uiStatus === "running" || job.uiStatus === "queued")
  );
}

function sortJobs(left: PipelineJob, right: PipelineJob): number {
  const leftActive = isActiveJob(left);
  const rightActive = isActiveJob(right);

  if (leftActive !== rightActive) {
    return leftActive ? -1 : 1;
  }

  if (leftActive && rightActive) {
    const byRank =
      ACTIVE_STATUS_RANK[left.uiStatus] - ACTIVE_STATUS_RANK[right.uiStatus];

    if (byRank !== 0) {
      return byRank;
    }
  }

  return right.updatedAt.localeCompare(left.updatedAt);
}

export function groupJobsByIssue(jobs: PipelineJob[]): JobGroup[] {
  const parentOf = parentMap(jobs);
  const byIssue = new Map<number, PipelineJob[]>();

  for (const job of jobs) {
    const issue = groupIssue(job, parentOf);
    const group = byIssue.get(issue) ?? [];

    group.push(job);
    byIssue.set(issue, group);
  }

  const groups: JobGroup[] = [];

  for (const [issue, groupJobs] of byIssue) {
    const jobsSorted = [...groupJobs].sort(sortJobs);
    const related = [
      ...new Set(
        jobsSorted
          .map((job) => job.issue)
          .filter((number) => number !== issue),
      ),
    ].sort((a, b) => a - b);

    groups.push({
      issue,
      relatedIssues: related,
      jobs: jobsSorted,
      activeJobs: jobsSorted.filter(isActiveJob),
      updatedAt: jobsSorted[0]?.updatedAt ?? "",
    });
  }

  return groups.sort((left, right) => {
    const leftActive = left.activeJobs.length > 0;
    const rightActive = right.activeJobs.length > 0;

    if (leftActive !== rightActive) {
      return leftActive ? -1 : 1;
    }

    return right.updatedAt.localeCompare(left.updatedAt);
  });
}

export function rewriteIssueUrl(
  url: string | null,
  issue: number,
): string | null {
  if (!url) {
    return null;
  }

  return url.replace(/\/issues\/\d+\/?$/, `/issues/${issue}`);
}
