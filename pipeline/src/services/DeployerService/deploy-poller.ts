import type { FastifyBaseLogger } from 'fastify';

import type { Config } from '@config';
import { GitHubClient, LogClient } from '@providers';

import {
  appendDeployNote,
  releaseBodyHasDeployMarker,
  releasesToDeploy,
} from './deploy-rules';
import { runProductDeploy } from './deploy-run';
import { DeployStore } from './deploy-store';

export function startDeployPoller(
  config: Config,
  appLogger: FastifyBaseLogger,
  store: DeployStore,
): { stop: () => void } {
  const github = new GitHubClient(config);
  const logger = new LogClient(appLogger);
  let busy = false;

  const tick = (): void => {
    if (busy) {
      logger.job({}, 'deploy poll skip: previous tick still running');

      return;
    }

    busy = true;
    void pollOnce(config, logger, store, github).finally(() => {
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
  logger: LogClient,
  store: DeployStore,
  github: GitHubClient,
): Promise<void> {
  logger.job({}, 'deploy poll tick');

  if (!config.GITHUB_TOKEN || !config.GITHUB_REPO) {
    logger.job({}, 'deploy poll skip: GITHUB_TOKEN or GITHUB_REPO empty');

    return;
  }

  let releases;

  try {
    releases = await github.getPublishedReleases();
  } catch (err) {
    logger.error({ err }, 'github list releases failed');

    return;
  }

  const candidates = releasesToDeploy(releases, await store.deployedIds());
  const pending: typeof candidates = [];

  for (const release of candidates) {
    if (releaseBodyHasDeployMarker(release.body, release.id)) {
      continue;
    }

    if (await store.hasTag(release.tag_name)) {
      continue;
    }

    pending.push(release);
  }

  if (pending.length === 0) {
    logger.job({}, 'deploy: no new published releases');

    return;
  }

  for (const release of pending) {
    await handleRelease(config, logger, store, github, release);
  }
}

async function applyDeployLabels(
  github: GitHubClient,
  status: 'deployed' | 'deploy-failed',
  tag: string,
): Promise<number[]> {
  const labeled: number[] = [];
  const milestone = await github.findMilestoneByTitle(tag);
  const issues = milestone
    ? await github.getOpenIssuesForMilestone(milestone.number)
    : [];

  for (const issue of issues) {
    if (
      issue.labels.includes('deployed') ||
      issue.labels.includes('deploy-failed')
    ) {
      continue;
    }

    await github.removeIssueLabel(
      issue.number,
      status === 'deployed' ? 'deploy-failed' : 'deployed',
    );
    await github.addIssueLabels(issue.number, [status]);
    labeled.push(issue.number);
  }

  return labeled;
}

async function handleRelease(
  config: Config,
  logger: LogClient,
  store: DeployStore,
  github: GitHubClient,
  release: {
    id: number;
    tag_name: string;
    body: string | null;
    html_url: string;
  },
): Promise<void> {
  const fields = {
    issue: release.id,
    role: 'deployer',
    agentId: null,
    runId: null,
  };

  if ((await store.hasTag(release.tag_name)) || (await store.has(release.id))) {
    logger.job(fields, `deploy skip idempotent: ${release.tag_name}`);

    return;
  }

  logger.job(fields, `deploy start: ${release.tag_name} (${release.html_url})`);

  const result = await runProductDeploy(config, release.tag_name);
  const status = result.ok ? 'deployed' : 'deploy-failed';

  await store.record({
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
    logger.error(
      { err, releaseId: release.id },
      'github release body update failed',
    );
  }

  try {
    const labeled = await applyDeployLabels(github, status, release.tag_name);

    logger.job(
      fields,
      labeled.length
        ? `labels +${status} on ${labeled.map((n) => `#${n}`).join(', ')}`
        : `no open release issues to label (${status})`,
    );
  } catch (err) {
    logger.error({ err, releaseId: release.id }, 'github deploy labels failed');
  }

  logger.job(
    fields,
    result.ok
      ? `deploy ok: ${release.tag_name}`
      : `deploy failed: ${release.tag_name}`,
  );
}
