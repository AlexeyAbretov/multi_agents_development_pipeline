import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Job, Role } from "./types.js";

type StoreFile = {
  lastPollAt: string | null;
  jobs: Job[];
};

export class JobStore {
  private readonly filePath: string;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.filePath = join(dataDir, "jobs.json");
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
      return JSON.parse(readFileSync(this.filePath, "utf8")) as StoreFile;
    } catch {
      return { lastPollAt: null, jobs: [] };
    }
  }

  private saveSync(data: StoreFile): void {
    const tmp = `${this.filePath}.tmp`;

    writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
    renameSync(tmp, this.filePath);
  }

  find(issue: number, role: Role): Promise<Job | undefined> {
    return this.synchronized(() =>
      this.loadSync().jobs.find((job) => job.issue === issue && job.role === role),
    );
  }

  create(issue: number, role: Role): Promise<Job | null> {
    return this.synchronized(() => {
      const data = this.loadSync();

      if (data.jobs.some((job) => job.issue === issue && job.role === role)) {
        return null;
      }

      const now = new Date().toISOString();
      const job: Job = {
        id: randomUUID(),
        issue,
        role,
        status: "queued",
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

  /** Drop (issue, role) so a later cycle can run again (QA loop / re-plan). */
  async remove(issue: number, role: Role): Promise<boolean> {
    return this.synchronized(() => {
      const data = this.loadSync();
      const next = data.jobs.filter((job) => !(job.issue === issue && job.role === role));

      if (next.length === data.jobs.length) {
        return false;
      }

      data.jobs = next;
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
    patch: Partial<Pick<Job, "status" | "agentId" | "runId" | "error" | "decision">>,
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
        jobs: data.jobs.map((job) => ({ ...job, decision: job.decision ?? null })),
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
      const next = data.jobs.filter(
        (job) => job.status !== "running" && job.status !== "queued",
      );
      const dropped = data.jobs.length - next.length;

      if (dropped === 0) {
        return 0;
      }

      data.jobs = next;
      this.saveSync(data);

      return dropped;
    });
  }

  lastPollAt(): Promise<string | null> {
    return this.synchronized(() => this.loadSync().lastPollAt);
  }
}
