import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Role } from '@types';

import type { Job } from './OrchestratorService.types';

const DROPPED_AFTER_RESTART = 'dropped after restart';

type StoreFile = {
  lastPollAt: string | null;
  jobs: Job[];
};

function isPairLock(job: Job, issue: number, role: Role): boolean {
  return job.issue === issue && job.role === role && !job.cleared;
}

export class JobStore {
  private readonly dataDir: string;
  private readonly filePath: string;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(dataDir: string) {
    this.dataDir = dataDir;
    this.filePath = join(dataDir, 'jobs.json');
    mkdirSync(this.dataDir, { recursive: true });
  }

  private synchronized<T>(fn: () => T): Promise<T> {
    const next = this.chain.then(() => fn());

    this.chain = next.then(
      () => undefined,
      () => undefined,
    );

    return next;
  }

  private loadSync(): StoreFile {
    try {
      return JSON.parse(readFileSync(this.filePath, 'utf8')) as StoreFile;
    } catch {
      return { lastPollAt: null, jobs: [] };
    }
  }

  private saveSync(data: StoreFile): void {
    mkdirSync(this.dataDir, { recursive: true });

    const tmp = `${this.filePath}.tmp`;

    writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    renameSync(tmp, this.filePath);
  }

  find(issue: number, role: Role): Promise<Job | undefined> {
    return this.synchronized(() => {
      const held = this.loadSync().jobs.filter((job) =>
        isPairLock(job, issue, role),
      );

      return held.at(-1);
    });
  }

  create(issue: number, role: Role): Promise<Job | null> {
    return this.synchronized(() => {
      const data = this.loadSync();

      if (data.jobs.some((job) => isPairLock(job, issue, role))) {
        return null;
      }

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
      };

      data.jobs.push(job);
      this.saveSync(data);

      return job;
    });
  }

  /** Release (issue, role) lock; keep journal rows (QA loop / re-plan). */
  async remove(issue: number, role: Role): Promise<boolean> {
    return this.synchronized(() => {
      const data = this.loadSync();
      let changed = false;

      for (const job of data.jobs) {
        if (!isPairLock(job, issue, role)) {
          continue;
        }

        job.cleared = true;
        changed = true;
      }

      if (!changed) {
        return false;
      }

      this.saveSync(data);

      return true;
    });
  }

  async removeRoles(issue: number, roles: Role[]): Promise<void> {
    for (const role of roles) {
      await this.remove(issue, role);
    }
  }

  update(
    id: string,
    patch: Partial<
      Pick<Job, 'status' | 'agentId' | 'runId' | 'error' | 'decision'>
    >,
  ): Promise<Job | undefined> {
    return this.synchronized(() => {
      const data = this.loadSync();
      const job = data.jobs.find((item) => item.id === id);

      if (!job) {
        return undefined;
      }

      Object.assign(job, patch);

      if (job.decision === undefined) {
        job.decision = null;
      }

      job.updatedAt = new Date().toISOString();
      this.saveSync(data);

      return job;
    });
  }

  snapshot(): Promise<{ lastPollAt: string | null; jobs: Job[] }> {
    return this.synchronized(() => {
      const data = this.loadSync();

      return {
        lastPollAt: data.lastPollAt,
        jobs: data.jobs.map((job) => ({
          ...job,
          decision: job.decision ?? null,
        })),
      };
    });
  }

  setLastPollAt(iso: string): Promise<void> {
    return this.synchronized(() => {
      const data = this.loadSync();

      data.lastPollAt = iso;
      this.saveSync(data);
    });
  }

  async dropUnfinishedJobs(): Promise<number> {
    return this.synchronized(() => {
      const data = this.loadSync();
      const now = new Date().toISOString();
      let dropped = 0;

      for (const job of data.jobs) {
        if (job.status !== 'running' && job.status !== 'queued') {
          continue;
        }

        job.status = 'error';
        job.error = DROPPED_AFTER_RESTART;
        job.cleared = true;
        job.updatedAt = now;
        dropped += 1;
      }

      if (dropped === 0) {
        return 0;
      }

      this.saveSync(data);

      return dropped;
    });
  }

  lastPollAt(): Promise<string | null> {
    return this.synchronized(() => this.loadSync().lastPollAt);
  }
}
