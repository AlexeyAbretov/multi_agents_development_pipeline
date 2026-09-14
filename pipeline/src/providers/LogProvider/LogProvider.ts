import type { FastifyBaseLogger } from 'fastify';

import { EMPTY_JOB_LOG_FIELDS } from './LogProvider.constants';
import type { JobLogFields } from './LogProvider.types';

export class LogClient {
  constructor(private readonly logger: FastifyBaseLogger) {}

  job(fields: Partial<JobLogFields>, msg: string): void {
    this.logger.info({ ...EMPTY_JOB_LOG_FIELDS, ...fields }, msg);
  }

  error(obj: object, msg: string): void {
    this.logger.error(obj, msg);
  }
}
