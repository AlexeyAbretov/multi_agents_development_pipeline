import type { FastifyBaseLogger } from "fastify";
import type { Config } from "./config.js";
import { DeployRequestStore } from "./deploy-request-store.js";
import {
  appendDeployNote,
  releaseBodyHasDeployMarker,
  releasesToDeploy,
} from "./deploy-rules.js";
import { runProductDeploy } from "./deploy-run.js";
import { DeployStore } from "./deploy-store.js";
import { GitHubClient } from "./github.js";
import { jobLog } from "./log.js";

export function startDeployPoller(
  config: Config,
  logger: FastifyBaseLogger,
  store: DeployStore,
): { stop: () => void } {
  const github = new GitHubClient(config);
  const requests = new DeployRequestStore(config.DATA_DIR);
  let busy = false;

  const tick = (): void => {
    if (busy) {
      jobLog(logger, {}, "deploy poll skip: previous tick still running");
      return;
    }
    busy = true;
    void pollOnce(config, logger, store, requests, github).finally(() => {
      busy = false;
    });
  };

  tick();
  const timer = setInterval(tick, config.POLL_INTERVAL_MS);
  return {
    stop: () => {
      clearInterval(timer);
    },
  };
}

async function pollOnce(
  config: Config,
  logger: FastifyBaseLogger,
  store: DeployStore,
  requests: DeployRequestStore,
  github: GitHubClient,
): Promise<void> {
  jobLog(logger, {}, "deploy poll tick");

  if (!config.GITHUB_TOKEN || !config.GITHUB_REPO) {
    jobLog(logger, {}, "deploy poll skip: GITHUB_TOKEN or GITHUB_REPO empty");
    return;
  }

  await processScheduleRequests(config, logger, store, requests, github);

  let releases;
  try {
    releases = await github.listPublishedReleases();
  } catch (err) {
    logger.error({ err }, "github list releases failed");
    return;
  }

  const pending = releasesToDeploy(releases, store.deployedIds()).filter(
    (release) =>
      !releaseBodyHasDeployMarker(release.body, release.id) && !store.hasTag(release.tag_name),
  );

  if (pending.length === 0) {
    jobLog(logger, {}, "deploy: no new published releases");
    return;
  }

  for (const release of pending) {
    await handleRelease(config, logger, store, github, release);
  }
}

async function processScheduleRequests(
  config: Config,
  logger: FastifyBaseLogger,
  store: DeployStore,
  requests: DeployRequestStore,
  github: GitHubClient,
): Promise<void> {
  for (const request of requests.pending()) {
    const fields = { issue: request.milestoneId, role: "deployer", agentId: null, runId: null };
    if (store.hasTag(request.tag)) {
      requests.mark(request.tag, request.requestedAt, "skipped");
      jobLog(logger, fields, `schedule request skip: ${request.tag} already deployed`);
      continue;
    }

    const existing = await github.findReleaseByTag(request.tag);
    if (existing && !existing.draft) {
      // Prefer full release handle if published release exists.
      const published = (await github.listPublishedReleases()).find((item) => item.id === existing.id);
      if (published) {
        await handleRelease(config, logger, store, github, published);
        requests.mark(request.tag, request.requestedAt, "done");
        continue;
      }
    }

    jobLog(logger, fields, `schedule deploy start: ${request.tag}`);
    const result = await runProductDeploy(config, request.tag);
    const status = result.ok ? "deployed" : "deploy-failed";
    store.record({
      releaseId: existing?.id ?? 0,
      tag: request.tag,
      status,
      mode: config.DEPLOY_MODE,
      detail: `${result.detail}\n(source: schedule milestone ${request.milestoneTitle})`,
      at: new Date().toISOString(),
    });
    if (existing) {
      try {
        const full = (await github.listPublishedReleases()).find((item) => item.id === existing.id);
        const body = full?.body ?? null;
        await github.updateReleaseBody(
          existing.id,
          appendDeployNote(body, existing.id, status, result.detail),
        );
      } catch (err) {
        logger.error({ err, tag: request.tag }, "schedule release body update failed");
      }
    }
    try {
      await applyDeployLabels(github, status, request.tag);
    } catch (err) {
      logger.error({ err, tag: request.tag }, "schedule deploy labels failed");
    }
    requests.mark(request.tag, request.requestedAt, "done");
    jobLog(
      logger,
      fields,
      result.ok ? `schedule deploy ok: ${request.tag}` : `schedule deploy failed: ${request.tag}`,
    );
  }
}

async function applyDeployLabels(
  github: GitHubClient,
  status: "deployed" | "deploy-failed",
  tag: string,
): Promise<number[]> {
  const labeled: number[] = [];
  const milestone = await github.findMilestoneByTitle(tag);
  const issues = milestone ? await github.listOpenIssuesForMilestone(milestone.number) : [];
  for (const issue of issues) {
    if (issue.labels.includes("deployed") || issue.labels.includes("deploy-failed")) {
      continue;
    }
    await github.removeIssueLabel(issue.number, status === "deployed" ? "deploy-failed" : "deployed");
    await github.addIssueLabels(issue.number, [status]);
    labeled.push(issue.number);
  }
  return labeled;
}

async function handleRelease(
  config: Config,
  logger: FastifyBaseLogger,
  store: DeployStore,
  github: GitHubClient,
  release: {
    id: number;
    tag_name: string;
    body: string | null;
    html_url: string;
  },
): Promise<void> {
  const fields = { issue: release.id, role: "deployer", agentId: null, runId: null };
  if (store.hasTag(release.tag_name) || store.has(release.id)) {
    jobLog(logger, fields, `deploy skip idempotent: ${release.tag_name}`);
    return;
  }

  jobLog(logger, fields, `deploy start: ${release.tag_name} (${release.html_url})`);

  const result = await runProductDeploy(config, release.tag_name);
  const status = result.ok ? "deployed" : "deploy-failed";

  store.record({
    releaseId: release.id,
    tag: release.tag_name,
    status,
    mode: config.DEPLOY_MODE,
    detail: result.detail,
    at: new Date().toISOString(),
  });

  try {
    await github.updateReleaseBody(
      release.id,
      appendDeployNote(release.body, release.id, status, result.detail),
    );
  } catch (err) {
    logger.error({ err, releaseId: release.id }, "github release body update failed");
  }

  try {
    const labeled = await applyDeployLabels(github, status, release.tag_name);
    jobLog(
      logger,
      fields,
      labeled.length
        ? `labels +${status} on ${labeled.map((n) => `#${n}`).join(", ")}`
        : `no open release issues to label (${status})`,
    );
  } catch (err) {
    logger.error({ err, releaseId: release.id }, "github deploy labels failed");
  }

  jobLog(logger, fields, result.ok ? `deploy ok: ${release.tag_name}` : `deploy failed: ${release.tag_name}`);
}
