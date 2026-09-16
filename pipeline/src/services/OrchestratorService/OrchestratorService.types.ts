import { Role } from '@types';

export type JobStatus =
  'queued' | 'running' | 'finished' | 'error' | 'startup_error';

export type Job = {
  id: string;
  issue: number;
  role: Role;
  status: JobStatus;
  agentId: string | null;
  runId: string | null;
  error: string | null;
  /** Итог оркестратора: ready-for-dev, to-approve, done, in-qa,
   * qa-passed, released, needs-human, … */
  decision: string | null;
  createdAt: string;
  updatedAt: string;
  /** Замок (issue, role) снят; запись журнала остаётся. */
  cleared?: boolean;
  /** Родитель дочернего бага (`Related to #N`); иначе null. */
  parentIssue?: number | null;
};

/** UI-статус очереди (контракт AGENT_PIPELINE_PLAN UI). */
export type UiJobStatus =
  'queued' | 'running' | 'failed' | 'finished' | 'clarification';
