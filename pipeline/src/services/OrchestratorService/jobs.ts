import { randomUUID } from 'node:crypto';
import { readFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';

import type { Document } from 'mongodb';

import { isDuplicateKeyError, type MongodbClient } from '@providers';
import type { Role } from '@types';

import type { Job } from './OrchestratorService.types';

const DROPPED_AFTER_RESTART = 'dropped after restart';
const JOBS_COLLECTION = 'jobs';
const META_COLLECTION = 'meta';
const META_POLL_ID = 'poll';

type JobDocument = Job & Document;

type PollMeta = Document & {
  _id: string;
  lastPollAt: string | null;
};

type LegacyStoreFile = {
  lastPollAt?: string | null;
  jobs?: Job[];
};

export class JobStore {
  constructor(private readonly mongo: MongodbClient) {}

  private jobsCol() {
    return this.mongo.collection<JobDocument>(JOBS_COLLECTION);
  }

  private metaCol() {
    return this.mongo.collection<PollMeta>(META_COLLECTION);
  }

  private toJob(doc: JobDocument): Job {
    return {
      id: doc.id,
      issue: doc.issue,
      role: doc.role,
      status: doc.status,
      agentId: doc.agentId,
      runId: doc.runId,
      error: doc.error,
      decision: doc.decision ?? null,
      createdAt: doc.createdAt,
      updatedAt: doc.updatedAt,
      cleared: doc.cleared === true,
      parentIssue: doc.parentIssue ?? null,
    };
  }

  async ensureIndexes(): Promise<void> {
    await this.jobsCol().createIndex({ id: 1 }, { unique: true });
    await this.jobsCol().createIndex(
      { issue: 1, role: 1 },
      {
        unique: true,
        name: 'active_issue_role',
        partialFilterExpression: { cleared: false },
      },
    );
  }

  async find(issue: number, role: Role): Promise<Job | undefined> {
    const doc = await this.jobsCol().findOne(
      { issue, role, cleared: false },
      { sort: { createdAt: -1 } },
    );

    return doc ? this.toJob(doc) : undefined;
  }

  async create(
    issue: number,
    role: Role,
    parentIssue?: number | null,
  ): Promise<Job | null> {
    const now = new Date().toISOString();
    const job: Job = {
      id: randomUUID(),
      issue,
      role,
      status: 'queued',
      agentId: null,
      runId: null,
      error: null,
      decision: null,
      createdAt: now,
      updatedAt: now,
      cleared: false,
      parentIssue: parentIssue ?? null,
    };

    try {
      await this.jobsCol().insertOne(job);

      return job;
    } catch (err) {
      if (isDuplicateKeyError(err)) {
        return null;
      }

      throw err;
    }
  }

  /** Release (issue, role) lock; keep journal rows (QA loop / re-plan). */
  async remove(issue: number, role: Role): Promise<boolean> {
    const result = await this.jobsCol().updateMany(
      { issue, role, cleared: false },
      { $set: { cleared: true } },
    );

    return result.modifiedCount > 0;
  }

  async removeRoles(issue: number, roles: Role[]): Promise<void> {
    for (const role of roles) {
      await this.remove(issue, role);
    }
  }

  async update(
    id: string,
    patch: Partial<
      Pick<Job, 'status' | 'agentId' | 'runId' | 'error' | 'decision'>
    >,
  ): Promise<Job | undefined> {
    const doc = await this.jobsCol().findOne({ id });

    if (!doc) {
      return undefined;
    }

    const job = this.toJob(doc);

    Object.assign(job, patch);

    if (job.decision === undefined) {
      job.decision = null;
    }

    job.updatedAt = new Date().toISOString();
    await this.jobsCol().replaceOne({ id }, job);

    return job;
  }

  async snapshot(): Promise<{ lastPollAt: string | null; jobs: Job[] }> {
    const [docs, lastPollAt] = await Promise.all([
      this.jobsCol().find().sort({ createdAt: 1 }).toArray(),
      this.lastPollAt(),
    ]);

    return {
      lastPollAt,
      jobs: docs.map((doc) => this.toJob(doc)),
    };
  }

  async setLastPollAt(iso: string): Promise<void> {
    await this.metaCol().updateOne(
      { _id: META_POLL_ID },
      { $set: { lastPollAt: iso } },
      { upsert: true },
    );
  }

  async dropUnfinishedJobs(): Promise<number> {
    const now = new Date().toISOString();
    const result = await this.jobsCol().updateMany(
      { status: { $in: ['running', 'queued'] } },
      {
        $set: {
          status: 'error',
          error: DROPPED_AFTER_RESTART,
          cleared: true,
          updatedAt: now,
        },
      },
    );

    return result.modifiedCount;
  }

  async lastPollAt(): Promise<string | null> {
    const meta = await this.metaCol().findOne({ _id: META_POLL_ID });

    return meta?.lastPollAt ?? null;
  }

  async importLegacyJson(dataDir: string): Promise<number> {
    const existing = await this.jobsCol().estimatedDocumentCount();

    if (existing > 0) {
      return 0;
    }

    const filePath = join(dataDir, 'jobs.json');
    let raw: string;

    try {
      raw = readFileSync(filePath, 'utf8');
    } catch {
      return 0;
    }

    const data = JSON.parse(raw) as LegacyStoreFile;
    const jobs = (data.jobs ?? []).map((job) => this.toJob(job));

    if (jobs.length === 0 && !data.lastPollAt) {
      return 0;
    }

    if (jobs.length > 0) {
      await this.jobsCol().insertMany(jobs);
    }

    if (data.lastPollAt) {
      await this.setLastPollAt(data.lastPollAt);
    }

    try {
      renameSync(filePath, `${filePath}.migrated`);
    } catch {
      // Jobs are already in MongoDB; leftover file is harmless.
    }

    return jobs.length;
  }
}
