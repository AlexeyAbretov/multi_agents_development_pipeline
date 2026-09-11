import type { FastifyInstance } from "fastify";
import type { Config } from "../config.js";
import { DeployRequestStore } from "../deploy-request-store.js";
import { DeployStore } from "../deploy-store.js";
import type { JobStore } from "../jobs.js";
import { mapJobToUiStatus } from "../rules.js";

export function registerApiRoutes(
  app: FastifyInstance,
  config: Config,
  store: JobStore,
): void {
  app.get("/api/jobs", async () => {
    const snap = await store.snapshot();
    const jobs = [...snap.jobs]
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map((job) => ({
        ...job,
        uiStatus: mapJobToUiStatus(job),
        issueUrl: config.GITHUB_REPO
          ? `https://github.com/${config.GITHUB_REPO}/issues/${job.issue}`
          : null,
        agentUrl: job.agentId
          ? `https://cursor.com/agents/${encodeURIComponent(job.agentId)}`
          : null,
      }));

    return {
      lastPollAt: snap.lastPollAt,
      githubRepo: config.GITHUB_REPO || null,
      jobs,
    };
  });

  app.get("/api/deploys", async () => {
    const deploys = new DeployStore(config.DATA_DIR).load().deploys;
    const requests = new DeployRequestStore(config.DATA_DIR).load().requests;

    return {
      deploys: [...deploys].sort((a, b) => b.at.localeCompare(a.at)),
      requests: [...requests].sort((a, b) => b.requestedAt.localeCompare(a.requestedAt)),
    };
  });
}
