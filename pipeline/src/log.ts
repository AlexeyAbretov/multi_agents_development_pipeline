import type { FastifyBaseLogger } from 'fastify';

type JobLogFields = {
  issue: number | null;
  role: string | null;
  agentId: string | null;
  runId: string | null;
};

const emptyFields: JobLogFields = {
  issue: null,
  role: null,
  agentId: null,
  runId: null,
};

export function jobLog(
  logger: FastifyBaseLogger,
  fields: Partial<JobLogFields>,
  msg: string,
): void {
  logger.info({ ...emptyFields, ...fields }, msg);
}
