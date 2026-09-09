import type { FastifyBaseLogger } from "fastify";
import type { Config } from "./config.js";
import { DeployRequestStore } from "./deploy-request-store.js";
import { DeployStore } from "./deploy-store.js";
import { GitHubClient, type GitHubIssue } from "./github.js";
import { jobLog } from "./log.js";
import {
  blockedNoReleaseComment,
  bodyHasBlockedNoReleaseMarker,
  calendarDateInTimeZone,
  daysUntilDue,
  duplicateDueComment,
  isRegressionIssue,
  isReleaseWorkIssue,
  nothingToReleaseComment,
  regressionIssueBody,
  regressionIssueTitle,
  shouldNotifyBlockedNoRelease,
  tagFromMilestoneTitle,
  upsertNothingToReleaseDescription,
} from "./schedule-rules.js";
import { ScheduleStateStore } from "./schedule-state.js";

type Milestone = { id: number; number: number; title: string; due_on: string | null };

export function startSchedulePoller(
  config: Config,
  logger: FastifyBaseLogger,
): { stop: () => void } {
  const github = new GitHubClient(config);
  const deployStore = new DeployStore(config.DATA_DIR);
  const requests = new DeployRequestStore(config.DATA_DIR);
  const state = new ScheduleStateStore(config.DATA_DIR);
  let busy = false;

  const tick = (): void => {
    if (busy) {
      jobLog(logger, {}, "schedule skip: previous tick still running");
      return;
    }
    busy = true;
    void scheduleOnce(config, logger, github, deployStore, requests, state).finally(() => {
      busy = false;
    });
  };

  tick();
  const timer = setInterval(tick, config.SCHEDULE_INTERVAL_MS);
  return {
    stop: () => {
      clearInterval(timer);
    },
  };
}

async function scheduleOnce(
  config: Config,
  logger: FastifyBaseLogger,
  github: GitHubClient,
  deployStore: DeployStore,
  requests: DeployRequestStore,
  state: ScheduleStateStore,
): Promise<void> {
  jobLog(logger, {}, "schedule tick");

  if (!config.GITHUB_TOKEN || !config.GITHUB_REPO) {
    jobLog(logger, {}, "schedule skip: GITHUB_TOKEN or GITHUB_REPO empty");
    return;
  }

  let milestones: Milestone[];
  try {
    milestones = await github.listOpenMilestones();
  } catch (err) {
    logger.error({ err }, "github milestones failed");
    return;
  }

  const releaseMilestones = milestones.filter((item) => tagFromMilestoneTitle(item.title));
  const dueToday = releaseMilestones.filter(
    (item) => daysUntilDue(item.due_on, config.SCHEDULE_TZ) === 0,
  );
  const dueTomorrow = releaseMilestones.filter(
    (item) => daysUntilDue(item.due_on, config.SCHEDULE_TZ) === 1,
  );

  if (dueToday.length > 1) {
    await notifyDuplicateDue(config, logger, github, state, dueToday);
  }

  const skipped = new Set<number>();
  for (const milestone of [...dueTomorrow, ...dueToday]) {
    const skippedEmpty = await skipIfEmptyRelease(config, logger, github, milestone);
    if (skippedEmpty) {
      skipped.add(milestone.id);
      continue;
    }
    await ensureRegressionIssue(logger, github, milestone, dueToday.some((item) => item.id === milestone.id));
  }

  if (dueToday.length === 0 && dueTomorrow.length === 0) {
    jobLog(logger, {}, "schedule: no release milestones due today or tomorrow");
  }

  for (const milestone of dueToday) {
    if (skipped.has(milestone.id)) {
      continue;
    }
    await handleDueToday(config, logger, github, deployStore, requests, state, milestone);
  }
}

export async function closeEmptyRelease(
  github: GitHubClient,
  logger: FastifyBaseLogger,
  milestone: { id: number; number: number; title: string },
  previousTag: string,
): Promise<void> {
  const fields = {
    issue: milestone.number,
    role: "schedule",
    agentId: null,
    runId: null,
  };
  const comment = nothingToReleaseComment(milestone.title, previousTag, milestone.id);
  const issues = await github.listOpenIssuesForMilestone(milestone.number);
  const target =
    issues.find((issue) => isRegressionIssue(issue.labels, issue.body)) ?? issues[0] ?? null;
  if (target) {
    await github.commentOnIssue(target.number, comment);
    if (isRegressionIssue(target.labels, target.body)) {
      await github.closeIssue(target.number);
    }
  }
  const current = await github.getMilestone(milestone.number);
  await github.closeMilestone(
    milestone.number,
    upsertNothingToReleaseDescription(current.description, comment),
  );
  jobLog(
    logger,
    fields,
    `closed milestone ${milestone.title}: nothing to release since ${previousTag}`,
  );
}

async function skipIfEmptyRelease(
  config: Config,
  logger: FastifyBaseLogger,
  github: GitHubClient,
  milestone: Milestone,
): Promise<boolean> {
  const tag = tagFromMilestoneTitle(milestone.title);
  if (!tag) {
    return false;
  }
  try {
    const detected = await github.detectEmptySincePrevious(tag, config.CURSOR_STARTING_REF);
    if (!detected.empty || !detected.previousTag) {
      return false;
    }
    await closeEmptyRelease(github, logger, milestone, detected.previousTag);
    return true;
  } catch (err) {
    logger.error({ err, milestone: milestone.title }, "empty-release check failed");
    return false;
  }
}

async function notifyDuplicateDue(
  config: Config,
  logger: FastifyBaseLogger,
  github: GitHubClient,
  state: ScheduleStateStore,
  dueToday: Milestone[],
): Promise<void> {
  const day = calendarDateInTimeZone(new Date(), config.SCHEDULE_TZ);
  if (state.wasDuplicateDueNotified(day)) {
    jobLog(logger, {}, `schedule: duplicate due already notified for ${day}`);
    return;
  }
  const titles = dueToday.map((item) => item.title);
  const comment = duplicateDueComment(day, titles);
  try {
    for (const milestone of dueToday) {
      const issues = await github.listOpenIssuesForMilestone(milestone.number);
      const target =
        issues.find((issue) => isRegressionIssue(issue.labels, issue.body)) ?? issues[0];
      if (target) {
        await github.commentOnIssue(target.number, comment);
      }
    }
    state.markDuplicateDueNotified(day);
    jobLog(logger, {}, `blocked: duplicate due today (${titles.join(", ")}); RM will not start`);
  } catch (err) {
    logger.error({ err }, "duplicate-due notify failed");
  }
}

async function ensureRegressionIssue(
  logger: FastifyBaseLogger,
  github: GitHubClient,
  milestone: Milestone,
  hotfix: boolean,
): Promise<void> {
  const tag = tagFromMilestoneTitle(milestone.title);
  if (!tag) {
    return;
  }
  const fields = {
    issue: milestone.number,
    role: "schedule",
    agentId: null,
    runId: null,
  };
  try {
    const issues = await github.listOpenIssuesForMilestone(milestone.number);
    const existing = issues.find((issue) => isRegressionIssue(issue.labels, issue.body));
    if (existing) {
      jobLog(logger, { ...fields, issue: existing.number }, `regression issue already exists #${existing.number}`);
      return;
    }
    const created = await github.createIssue({
      title: regressionIssueTitle(tag),
      body: regressionIssueBody(milestone.id, tag),
      labels: ["regression", "in-qa"],
      milestone: milestone.number,
    });
    const kind = hotfix ? "hotfix (due today)" : "T−1";
    await github.commentOnIssue(
      created.number,
      `Пайплайн: старт регресса \`main\` (${kind}) перед релизом \`${tag}\`.`,
    );
    jobLog(logger, { ...fields, issue: created.number }, `created regression issue #${created.number} (${kind})`);
  } catch (err) {
    logger.error({ err, milestone: milestone.title }, "ensure regression issue failed");
  }
}

async function handleDueToday(
  config: Config,
  logger: FastifyBaseLogger,
  github: GitHubClient,
  deployStore: DeployStore,
  requests: DeployRequestStore,
  state: ScheduleStateStore,
  milestone: Milestone,
): Promise<void> {
  const fields = {
    issue: milestone.number,
    role: "schedule",
    agentId: null,
    runId: null,
  };
  const tag = tagFromMilestoneTitle(milestone.title);
  if (!tag) {
    return;
  }

  let hasTag = false;
  try {
    hasTag = await github.tagOrReleaseExists(tag);
  } catch (err) {
    logger.error({ err, milestone: milestone.title }, "tag check failed");
    return;
  }

  if (hasTag) {
    if (deployStore.hasTag(tag)) {
      jobLog(logger, fields, `schedule skip: ${tag} already in deploys.json`);
      return;
    }
    const enqueued = requests.enqueue({
      tag,
      milestoneId: milestone.id,
      milestoneTitle: milestone.title,
    });
    if (enqueued) {
      jobLog(logger, fields, `schedule: queued deploy request for ${tag}`);
    } else {
      jobLog(logger, fields, `schedule: deploy request for ${tag} already pending/done`);
    }
    return;
  }

  let issues: GitHubIssue[];
  try {
    issues = await github.listOpenIssuesForMilestone(milestone.number);
  } catch (err) {
    logger.error({ err, milestone: milestone.title }, "milestone issues failed");
    return;
  }

  const regression = issues.find((issue) => isRegressionIssue(issue.labels, issue.body)) ?? null;
  const hasOpenWorkItems = issues.some((issue) => isReleaseWorkIssue(issue.labels));
  if (
    !shouldNotifyBlockedNoRelease({
      releaseExists: false,
      regressionLabels: regression?.labels ?? null,
      hasOpenWorkItems,
    })
  ) {
    jobLog(logger, fields, `schedule: ${tag} waiting for regression/RM (no published release yet)`);
    return;
  }

  if (state.wasBlockedNotified(milestone.id)) {
    jobLog(logger, fields, `blocked: no release for ${milestone.title} (already notified)`);
    return;
  }

  const target = regression ?? issues[0];
  if (!target) {
    jobLog(logger, fields, `blocked: no release for ${milestone.title} (no issues to comment)`);
    state.markBlockedNotified(milestone.id);
    return;
  }
  if (bodyHasBlockedNoReleaseMarker(target.body, milestone.id)) {
    state.markBlockedNotified(milestone.id);
    return;
  }
  try {
    await github.commentOnIssue(target.number, blockedNoReleaseComment(milestone.title, milestone.id));
    state.markBlockedNotified(milestone.id);
    jobLog(
      logger,
      fields,
      `blocked: no release for milestone ${milestone.title}; compose not touched`,
    );
  } catch (err) {
    logger.error({ err, milestone: milestone.title }, "blocked-no-release notify failed");
  }
}
